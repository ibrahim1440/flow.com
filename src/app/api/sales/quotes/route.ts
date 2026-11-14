import { NextResponse } from "@/lib/api-response";
import { lockDealForQuote, prefillLines, reusableDraft } from "@/lib/services/sales/quote-prefill";
import { assertSalesAllowed } from "@/lib/services/customers/credit-db";
import { prisma, TX_OPTS } from "@/lib/db";
import { requireQuoteView, requireQuoteWrite, dealNotOpen } from "@/lib/services/sales/quote-guard";
import { canQuoteWithoutDeal, canWriteQuotes, quotesSeeAll, writesViaAccounting } from "@/lib/services/sales/quote-access";
import { handleDomainError } from "@/lib/api-error";
import { actsForAccountOwner, resolveQuickDeal } from "@/lib/services/sales/quick-deal";
import { customerInScope } from "@/lib/services/sales/customer-access";
import { NOT_FOUND_MESSAGE } from "@/lib/services/sales/scope";
import { hasSubPrivilege, hasModuleAccess } from "@/lib/auth-shared";

import {
  saveQuoteLines, parseLineInputs, validateLines, QUOTE_CURRENCY, createAccountingQuote, draftByKey, draftKeyOf, type SkuFacts,
} from "@/lib/services/sales/quotes";
import { readQuoteSettings, discountThreshold } from "@/lib/services/sales/quote-settings";
import { Decimal } from "@/lib/services/commissions/engine";
import { toCsv } from "@/lib/services/sales/csv";

const STATUSES = ["DRAFT", "ISSUED", "ACCEPTED", "REJECTED", "EXPIRED", "SUPERSEDED"];
/** The «needs discount approval» filter (Figma 181:1609 meta «يحتاج اعتماد خصم»). */
const APPROVAL_FILTERS = ["PENDING", "APPROVED", "REJECTED"] as const;
const CSV_MAX_ROWS = 5000;

const ROW_SELECT = {
  id: true, quoteNumber: true, revision: true, status: true, currency: true,
  validUntil: true, subtotal: true, discountTotal: true, taxTotal: true, grandTotal: true,
  issuedAt: true, acceptedAt: true, createdAt: true, supersedesId: true, channel: true,
  discountApprovedById: true, discountApprovedAt: true, discountApprovedPercent: true,
  discountRejectedAt: true,
  customer: { select: { id: true, name: true, nameAr: true } },
  opportunity: {
    select: { id: true, title: true, outcome: true, owner: { select: { id: true, name: true } } },
  },
  _count: { select: { lines: true, orderLinks: true } },
  // «افتح الطلب» on an accepted quotation already turned into an order (Figma page 10): its order's number.
  orderLinks: { take: 1, select: { order: { select: { orderNumber: true } } } },
} as const;

/**
 * GET /api/sales/quotes — the quotation list, scoped through the deal that owns it.
 *
 * Query: status, q (number / deal / customer), ownerId (the deal owner; only meaningful to a
 * caller who sees all sales), approval=PENDING|APPROVED|REJECTED (drafts by discount-approval
 * state), expiring=1 (issued, valid for at most 7 more days), includeSuperseded=1 (the «الكل»
 * view hides superseded revisions unless asked), page / perPage, format=csv (every matching row,
 * up to 5,000, same scope and filters).
 *
 * `counts` are per status over the same scope, search and owner filter — every tab's number is
 * the server's. `summary` is the header's facts over the caller's whole scope.
 */
export async function GET(request: Request) {
  // BATCH22 WP-E: the sales module or the accounting module (the accountant reads every quotation).
  const { user, error } = await requireQuoteView();
  if (error) return error;

  const url = new URL(request.url);
  const status = url.searchParams.get("status");
  const opportunityId = url.searchParams.get("opportunityId");
  const q = (url.searchParams.get("q") ?? "").trim();
  const ownerParam = (url.searchParams.get("ownerId") ?? "").trim();
  const approvalParam = (url.searchParams.get("approval") ?? "").toUpperCase();
  const approval = (APPROVAL_FILTERS as readonly string[]).includes(approvalParam) ? approvalParam : null;
  const expiring = url.searchParams.get("expiring") === "1";
  const includeSuperseded = url.searchParams.get("includeSuperseded") === "1";
  // The rep's segments (Figma page 10, 4 Nov 2026): «يحتاج منك», «المفتوحة», «المنتهية» — see STAGES below.
  const stageParam = url.searchParams.get("stage") ?? "";
  const csv = url.searchParams.get("format") === "csv";
  const page = Math.max(1, Number(url.searchParams.get("page") ?? 1) || 1);
  const perPage = Math.min(100, Math.max(1, Number(url.searchParams.get("perPage") ?? 25) || 25));

  const scopeAll = quotesSeeAll(user.permissions);
  // A rep sees their own deals only; an owner filter cannot widen that, so it is ignored.
  const ownerId = scopeAll && ownerParam ? ownerParam : null;

  try {
    const settings = await readQuoteSettings(prisma);
    const threshold = new Decimal(settings.effectiveThresholdPercent);
    const now = new Date();
    const weekAhead = new Date(now.getTime() + 7 * 86_400_000);

    // A quotation has no owner column; the deal it belongs to does. Scoping through the
    // relation keeps one definition of "mine" rather than a second, drifting copy.
    const scope = scopeAll ? {} : { opportunity: { ownerId: user.id } };
    const base = {
      ...scope,
      ...(ownerId ? { opportunity: { ownerId } } : {}),
      ...(opportunityId ? { opportunityId } : {}),
      ...(q
        ? {
            OR: [
              { quoteNumber: { contains: q, mode: "insensitive" as const } },
              { opportunity: { title: { contains: q, mode: "insensitive" as const } } },
              { customer: { name: { contains: q, mode: "insensitive" as const } } },
              { customer: { nameAr: { contains: q, mode: "insensitive" as const } } },
            ],
          }
        : {}),
    };

    // Drafts by discount-approval state: the arithmetic (discount ÷ subtotal against the
    // threshold, rounded exactly as `priceQuote` rounds) is one SQL expression over the stored
    // totals, scoped like everything else.
    const flagged = await prisma.$queryRaw<{ id: string; state: string }[]>`
      SELECT q."id",
             CASE WHEN q."discountApprovedById" IS NOT NULL AND q."discountApprovedPercent" IS NOT NULL
                       AND round(q."discountTotal" * 100 / q."subtotal", 6) <= q."discountApprovedPercent" THEN 'APPROVED'
                  WHEN q."discountRejectedAt" IS NOT NULL THEN 'REJECTED'
                  ELSE 'PENDING' END AS state
        FROM "Quote" q JOIN "Opportunity" o ON o."id" = q."opportunityId"
       WHERE q."status" = 'DRAFT' AND q."subtotal" > 0
         AND round(q."discountTotal" * 100 / q."subtotal", 6) > ${threshold.toString()}::numeric
         AND (${scopeAll} OR o."ownerId" = ${user.id})
    `;
    const stateOf = new Map(flagged.map((f) => [f.id, f.state]));
    const pendingIds = flagged.filter((f) => f.state === "PENDING").map((f) => f.id);

    // The rep's segments: what is waiting on the rep (a draft to finish, an accepted one to turn into an order, an issued
    // one past its date), what is still open, and what has ended (refused, lapsed, or already an order).
    const STAGES = {
      need: [{ status: "DRAFT" as const }, { status: "ACCEPTED" as const, orderLinks: { none: {} } }, { status: "ISSUED" as const, validUntil: { lt: now } }],
      open: [{ status: { in: ["DRAFT", "ISSUED"] as ("DRAFT" | "ISSUED")[] } }, { status: "ACCEPTED" as const, orderLinks: { none: {} } }],
      ended: [{ status: { in: ["REJECTED", "EXPIRED"] as ("REJECTED" | "EXPIRED")[] } }, { status: "ACCEPTED" as const, orderLinks: { some: {} } }],
      lost: [{ status: { in: ["REJECTED", "EXPIRED"] as ("REJECTED" | "EXPIRED")[] } }],
    };
    const stage = Object.hasOwn(STAGES, stageParam) ? (stageParam as keyof typeof STAGES) : null;

    const where = {
      ...base,
      // AND, so the segment's OR does not replace the search's.
      ...(stage ? { AND: [{ OR: STAGES[stage] }] } : {}),
      ...(status && STATUSES.includes(status)
        ? { status: status as never }
        : includeSuperseded || opportunityId ? {} : { status: { not: "SUPERSEDED" as never } }),
      ...(approval ? { id: { in: flagged.filter((f) => f.state === approval).map((f) => f.id) } } : {}),
      ...(expiring ? { status: "ISSUED" as never, validUntil: { gte: now, lte: weekAhead } } : {}),
    };

    if (csv) {
      const all = await prisma.quote.findMany({ where, orderBy: { createdAt: "desc" }, take: CSV_MAX_ROWS, select: ROW_SELECT });
      const header = [
        "quoteNumber", "revision", "status", "customer", "deal", "owner", "subtotal", "discountTotal",
        "taxTotal", "grandTotal", "currency", "validUntil", "issuedAt", "createdAt", "discountApproval",
      ];
      const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : "");
      const body = all.map((r) => [
        r.quoteNumber, r.revision, r.status, r.customer ? (r.customer.nameAr ?? r.customer.name) : "",
        r.opportunity?.title ?? "قسم المحاسبة", r.opportunity?.owner?.name ?? "", r.subtotal.toFixed(2), r.discountTotal.toFixed(2),
        r.taxTotal.toFixed(2), r.grandTotal.toFixed(2), r.currency, day(r.validUntil), day(r.issuedAt), day(r.createdAt),
        stateOf.get(r.id) ?? (r.discountApprovedById ? "APPROVED" : ""),
      ]);
      return new NextResponse(toCsv(header, body), {
        status: 200,
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="quotations-${scopeAll ? "all" : "mine"}-${now.toISOString().slice(0, 10)}.csv"`,
          "Cache-Control": "no-store",
        },
      });
    }

    const stageCount = (k: keyof typeof STAGES) => prisma.quote.count({ where: { ...base, AND: [{ OR: STAGES[k] }] } });
    const [needCount, openCount, endedCount, lostCount, openValue] = await Promise.all([
      stageCount("need"), stageCount("open"), stageCount("ended"), stageCount("lost"),
      prisma.quote.aggregate({ where: { ...scope, OR: STAGES.open }, _sum: { grandTotal: true } }),
    ]);
    const [rows, total, byStatus, scopeByStatus, expiringSoon, owners] = await Promise.all([
      prisma.quote.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * perPage,
        take: perPage,
        select: ROW_SELECT,
      }),
      prisma.quote.count({ where }),
      // Every tab's count: same scope, search and owner filter; the status is the tab's own.
      prisma.quote.groupBy({ by: ["status"], where: base, _count: { _all: true } }),
      // The header's facts: the caller's whole scope, no filter.
      prisma.quote.groupBy({ by: ["status"], where: scope, _count: { _all: true }, _sum: { grandTotal: true } }),
      prisma.quote.count({ where: { ...scope, status: "ISSUED", validUntil: { gte: now, lte: weekAhead } } }),
      scopeAll
        ? prisma.employee.findMany({
            where: { opportunitiesOwned: { some: { quotes: { some: {} } } } },
            select: { id: true, name: true },
            orderBy: { name: "asc" },
          })
        : Promise.resolve([]),
    ]);

    const counts: Record<string, number> = Object.fromEntries(STATUSES.map((s) => [s, 0]));
    for (const g of byStatus) counts[g.status] = g._count._all;
    // «الكل» is everything but the superseded revisions, which the footer counts on their own.
    counts.ALL = STATUSES.filter((s) => s !== "SUPERSEDED").reduce((a, s) => a + counts[s], 0);
    counts.NEED = needCount; counts.OPEN = openCount; counts.ENDED = endedCount; counts.LOST = lostCount;
    const issued = scopeByStatus.find((g) => g.status === "ISSUED");

    return NextResponse.json({
      rows: rows.map((r) => ({ ...r, discountApproval: stateOf.get(r.id) ?? (r.discountApprovedById ? "APPROVED" : "NOT_NEEDED") })),
      page,
      perPage,
      total,
      counts,
      summary: {
        issued: issued?._count._all ?? 0,
        issuedValue: (issued?._sum.grandTotal ?? new Decimal(0)).toFixed(2),
        openValue: (openValue._sum.grandTotal ?? new Decimal(0)).toFixed(2),
        pendingApproval: pendingIds.length,
        expiringSoon,
      },
      owners,
      scope: scopeAll ? "all" : "own",
      discountThresholdPercent: settings.effectiveThresholdPercent,
      can: {
        write: canWriteQuotes(user.permissions),
        viaAccounting: writesViaAccounting(user.permissions),
        approveDiscount: hasSubPrivilege(user.permissions, "sales", "quote_approve_discount"),
        createOrder: hasSubPrivilege(user.permissions, "orders", "create"),
        close: hasSubPrivilege(user.permissions, "sales", "deal_close"),
        createDeal: hasSubPrivilege(user.permissions, "sales", "lead_convert") && hasModuleAccess(user.permissions, "customers"),
      },
    });
  } catch (err) {
    return handleDomainError(err);
  }
}

/**
 * POST /api/sales/quotes — raise a draft quotation on a deal.
 *
 * Created as a DRAFT with its lines priced by the service. Nothing here accepts a total
 * from the client: a quotation whose grand total arrives in the request body is a quotation
 * whose price the browser decides.
 */
export async function POST(request: Request) {
  // sales › quote_write, or (accounting module and accounting › quotes_issue) — canWriteQuotes (BATCH22 WP-E).
  const { user, error } = await requireQuoteWrite();
  if (error) return error;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const b = (body ?? {}) as Record<string, unknown>;

  const opportunityId = typeof b.opportunityId === "string" ? b.opportunityId : "";
  // Abu Fahd R2 (M3): «عرض سعر» from the page of a customer with no open deal opens the UNSAVED editor; the deal is opened
  // at the first save that carries lines (`openDeal`), never on opening — an abandoned editor leaves no empty deal.
  const openDealFor = !opportunityId && b.openDeal === true && typeof b.customerId === "string" && b.customerId ? b.customerId : "";
  // «مسار المحاسب» (owner, 1 Nov 2026): the accounting section quotes a CUSTOMER directly — no deal, so nothing of it
  // reaches the pipeline or the commissions (channel ACCOUNTING). Only through accounting › quotes_issue.
  const accountingCustomerId = !opportunityId && !openDealFor && typeof b.customerId === "string" && b.customerId ? b.customerId : "";
  if (accountingCustomerId && !canQuoteWithoutDeal(user.permissions)) {
    return NextResponse.json({ error: "عرض السعر بدون صفقة من قسم المحاسبة فقط.", errorEn: "A quotation without a deal is issued from the accounting section only.", code: "DEAL_REQUIRED" }, { status: 403 });
  }
  if (!opportunityId && !accountingCustomerId && !openDealFor) {
    return NextResponse.json({ error: "A quotation belongs to a deal." }, { status: 400 });
  }
  if (typeof b.currency === "string" && b.currency !== QUOTE_CURRENCY) {
    return NextResponse.json(
      { error: `Only ${QUOTE_CURRENCY} quotations are supported; there is no exchange-rate policy configured.` },
      { status: 400 },
    );
  }

  let validUntil: Date | null = null;
  if (typeof b.validUntil === "string" && b.validUntil) {
    validUntil = new Date(b.validUntil);
    if (Number.isNaN(validUntil.getTime())) {
      return NextResponse.json({ error: "validUntil is not a date." }, { status: 400 });
    }
  }

  // Abu Fahd R3: the editor's session key — one editor session creates ONE draft (a second create returns the first).
  const draftKey = draftKeyOf(b.draftKey);
  const rawLines = Array.isArray(b.lines) ? b.lines : [];
  if (rawLines.length > 100) {
    return NextResponse.json({ error: "A quotation may carry at most 100 lines." }, { status: 400 });
  }

  if (openDealFor) {
    // Nothing to save yet: nothing is opened (the editor stays unsaved).
    if (rawLines.length === 0) return NextResponse.json({ quote: null, draft: true });
    return firstSaveOpeningDeal(user, openDealFor, rawLines, validUntil, draftKey, b.autosave !== true);
  }

  if (accountingCustomerId) {
    // P2 gate Q18 (ب4): the screens open the unsaved editor; an empty «deferred» ask creates nothing here either.
    if (rawLines.length === 0 && b.deferEmpty === true) return NextResponse.json({ quote: null, draft: true });
    try {
      const lines = parseLineInputs(rawLines);
      const result = await prisma.$transaction(async (tx) => {
        const known = draftKey ? await draftByKey(tx, draftKey, user.id) : null;
        if (known) return { ...(await resaveKnownDraft(tx, known, lines, user.id, b.autosave !== true)), reused: true };
        return { ...(await createAccountingQuote(tx, { customerId: accountingCustomerId, actorId: user.id, validUntil, lines, threshold: await discountThreshold(tx), draftKey })), reused: false };
      }, TX_OPTS);
      return NextResponse.json({
        quote: result.quote,
        totals: result.priced ? { subtotal: result.priced.subtotal.toFixed(2), discountTotal: result.priced.discountTotal.toFixed(2), taxTotal: result.priced.taxTotal.toFixed(2), grandTotal: result.priced.grandTotal.toFixed(2), effectiveDiscountPercent: result.priced.effectiveDiscountPercent.toString() } : null,
        needsDiscountApproval: false, reused: result.reused,
      }, { status: result.reused ? 200 : 201 });
    } catch (err) {
      return handleDomainError(err);
    }
  }

  try {
    const deal = await prisma.opportunity.findFirst({
      where: {
        id: opportunityId,
        ...(quotesSeeAll(user.permissions) ? {} : { ownerId: user.id }),
      },
      select: { id: true, customerId: true, outcome: true },
    });
    if (!deal) return NextResponse.json({ error: "Deal not found." }, { status: 404 });
    // The accountant quotes on an existing OPEN deal only; they never open one (the deal owner decides attribution).
    if (writesViaAccounting(user.permissions) && deal.outcome !== "OPEN") return dealNotOpen();
    if (deal.outcome === "LOST") {
      return NextResponse.json(
        { error: "This deal is lost. Reopen it before quoting again." },
        { status: 409 },
      );
    }

    // From the customer page («عرض سعر», council fix round 1 P0-7, round 2 item 2): reopen my latest DRAFT of this deal
    // (lines or not) instead of a second number — under a lock on the deal row, so two fast taps make one draft — and
    // start a new draft with the customer's usual items at the last issued prices.
    const fromCustomer = b.from === "customer";
    let lines = parseLineInputs(rawLines);

    const result = await prisma.$transaction(async (tx) => {
      // «إيقاف البيع» (feat/credit-hold): no new quotation while the customer's sales are on hold.
      await assertSalesAllowed(tx, deal.customerId);
      if (fromCustomer) {
        await lockDealForQuote(tx, opportunityId);
        const reuse = await reusableDraft(tx, opportunityId, user.id);
        if (reuse && reuse.lineCount > 0) return { quote: reuse.quote, priced: null, needsDiscountApproval: false, reused: true };
        // P2 gate A1 (ب4 on every entry point): no draft to reopen → nothing is created here, not even with the customer's
        // usual items; the unsaved editor shows them (GET …/draft?from=customer) and the first save numbers it.
        if (!reuse && rawLines.length === 0 && b.deferEmpty === true) return { deferred: true as const };
        if (rawLines.length === 0) {
          // A prefill that the line rules would refuse (an inactive SKU, a fraction of a bag) is dropped: the draft opens empty.
          const pre = parseLineInputs(await prefillLines(tx, deal.customerId));
          const ids = pre.map((l) => l.productSkuId).filter((x): x is string => !!x);
          const skuRows = ids.length ? await tx.productSKU.findMany({ where: { id: { in: ids } }, select: { id: true, isActive: true, unitOfMeasure: true, skuCode: true } }) : [];
          if (pre.length && validateLines(pre, new Map(skuRows.map((r) => [r.id, r as SkuFacts]))).length === 0) lines = pre;
        }
        if (reuse) {
          if (lines.length > 0) {
            const saved = await saveQuoteLines(tx, { quoteId: reuse.quote.id, lines, threshold: await discountThreshold(tx), actorId: user.id, notifyApprovers: b.autosave !== true });
            return { quote: reuse.quote, priced: saved.priced, needsDiscountApproval: saved.needsDiscountApproval, reused: true };
          }
          return { quote: reuse.quote, priced: null, needsDiscountApproval: false, reused: true };
        }
      }
      // P2 ب4 (owner decision, 13 Nov): the screens ask with `deferEmpty` — a quotation with no line yet is NOT created
      // (no row, no number); the editor opens unsaved (GET /api/sales/quotes/draft) and its first save creates it.
      if (lines.length === 0 && b.deferEmpty === true) return { deferred: true as const };
      // Abu Fahd R3: this editor session already created its draft (the autosave and the leave-save raced) → that one.
      const known = draftKey ? await draftByKey(tx, draftKey, user.id) : null;
      if (known) {
        const again = await resaveKnownDraft(tx, known, lines, user.id, b.autosave !== true);
        return { quote: again.quote, priced: again.priced, needsDiscountApproval: again.needsDiscountApproval, reused: true };
      }
      // Owner decision (quote-45 round): the draft is saved with its lines but takes its number only at issue.
      const quoteNumber = null;
      const created = await tx.quote.create({
        data: {
          quoteNumber,
          revision: 1,
          opportunityId,
          customerId: deal.customerId,
          status: "DRAFT",
          currency: QUOTE_CURRENCY,
          validUntil,
          createdById: user.id,
          draftKey,
        },
        select: { id: true, quoteNumber: true, revision: true },
      });

      if (lines.length > 0) {
        const saved = await saveQuoteLines(tx, { quoteId: created.id, lines, threshold: await discountThreshold(tx), actorId: user.id, notifyApprovers: b.autosave !== true });
        return { quote: created, priced: saved.priced, needsDiscountApproval: saved.needsDiscountApproval, reused: false };
      }
      return { quote: created, priced: null, needsDiscountApproval: false, reused: false };
    }, TX_OPTS);

    if ("deferred" in result) return NextResponse.json({ quote: null, draft: true, opportunityId }, { status: 200 });
    return NextResponse.json(
      {
        quote: result.quote,
        totals: result.priced
          ? {
              subtotal: result.priced.subtotal.toFixed(2),
              discountTotal: result.priced.discountTotal.toFixed(2),
              taxTotal: result.priced.taxTotal.toFixed(2),
              grandTotal: result.priced.grandTotal.toFixed(2),
              effectiveDiscountPercent: result.priced.effectiveDiscountPercent.toString(),
            }
          : null,
        needsDiscountApproval: result.needsDiscountApproval,
        reused: result.reused,
      },
      { status: result.reused ? 200 : 201 },
    );
  } catch (err) {
    return handleDomainError(err);
  }
}

/**
 * Abu Fahd R2 (M3) / gate R3 M1: the first save of an unsaved quotation opened from a customer with no open deal. The deal
 * (services/sales/quick-deal.ts, the same rule as the customer page's one tap: the caller's single open deal is used, one is
 * opened only with sales › lead_convert, for the account owner when a manager acts), the quotation and its lines are
 * written in ONE transaction: a save the line rules refuse (above 60 %, an inactive product, a line without a product or a
 * description) rolls the deal back too — no empty open deal at 0 is left behind.
 */
async function firstSaveOpeningDeal(
  user: NonNullable<Awaited<ReturnType<typeof requireQuoteWrite>>["user"]>,
  customerId: string, rawLines: unknown[], validUntil: Date | null, draftKey: string | null, notifyApprovers: boolean,
): Promise<Response> {
  if (!(await customerInScope(user, customerId))) return NextResponse.json({ error: NOT_FOUND_MESSAGE }, { status: 404 });
  try {
    const lines = parseLineInputs(rawLines);
    const result = await prisma.$transaction(async (tx) => {
      await assertSalesAllowed(tx, customerId);
      // Abu Fahd R3: this editor session already created its draft (and its deal) → that one, with the newer lines.
      const known = draftKey ? await draftByKey(tx, draftKey, user.id) : null;
      if (known) return { ...(await resaveKnownDraft(tx, known, lines, user.id, notifyApprovers)), reused: true };
      const r = await resolveQuickDeal(tx, { id: user.id, canOpenDeal: hasSubPrivilege(user.permissions, "sales", "lead_convert"), teamView: actsForAccountOwner(user) }, customerId, "quote", new Date());
      if (!((r.kind === "use" || r.kind === "created") && r.opportunityId)) {
        if (r.kind === "forbidden") throw { _appCode: 403, message: "هذا العميل له مندوب آخر — اطلب من مديرك أو من مندوبه.", errorEn: "This customer belongs to another rep.", code: "NOT_ACCOUNT_OWNER" };
        if (r.kind === "pick") throw { _appCode: 409, message: "عندك أكثر من صفقة مفتوحة مع هذا العميل — افتح عرض السعر من الصفقة.", errorEn: "You have several open deals with this customer — quote from the deal.", code: "PICK_DEAL" };
        throw { _appCode: 403, message: "ما عندك صفقة مفتوحة مع هذا العميل، وما عندك صلاحية تفتح وحدة. كلّم مديرك.", errorEn: "You have no open deal with this customer and may not open one.", code: "DEAL_REQUIRED" };
      }
      const created = await tx.quote.create({
        data: { quoteNumber: null, revision: 1, opportunityId: r.opportunityId, customerId, status: "DRAFT", currency: QUOTE_CURRENCY, validUntil, createdById: user.id, draftKey },
        select: { id: true, quoteNumber: true, revision: true },
      });
      // Refused lines throw here — and the whole transaction, the deal it may have opened included, is rolled back.
      const saved = await saveQuoteLines(tx, { quoteId: created.id, lines, threshold: await discountThreshold(tx), actorId: user.id, notifyApprovers });
      return { quote: created, priced: saved.priced, needsDiscountApproval: saved.needsDiscountApproval, reused: false };
    }, TX_OPTS);
    return NextResponse.json({
      quote: result.quote,
      totals: result.priced ? { subtotal: result.priced.subtotal.toFixed(2), discountTotal: result.priced.discountTotal.toFixed(2), taxTotal: result.priced.taxTotal.toFixed(2), grandTotal: result.priced.grandTotal.toFixed(2), effectiveDiscountPercent: result.priced.effectiveDiscountPercent.toString() } : null,
      needsDiscountApproval: result.needsDiscountApproval, reused: result.reused,
    }, { status: result.reused ? 200 : 201 });
  } catch (err) {
    return handleDomainError(err);
  }
}

/**
 * Abu Fahd R3: a second create of the same editor session lands on the draft the first one made — with the newer lines
 * (the leave-save carries what was on screen last). A draft already issued meanwhile is returned as it is.
 */
async function resaveKnownDraft(
  tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0],
  known: { id: string; quoteNumber: string | null; revision: number; status: string },
  lines: ReturnType<typeof parseLineInputs>, actorId: string, notifyApprovers: boolean,
) {
  const quote = { id: known.id, quoteNumber: known.quoteNumber, revision: known.revision };
  if (known.status !== "DRAFT" || lines.length === 0) return { quote, priced: null, needsDiscountApproval: false };
  const saved = await saveQuoteLines(tx, { quoteId: known.id, lines, threshold: await discountThreshold(tx), actorId, notifyApprovers });
  return { quote, priced: saved.priced, needsDiscountApproval: saved.needsDiscountApproval };
}
