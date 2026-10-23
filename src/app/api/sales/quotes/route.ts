import { NextResponse } from "@/lib/api-response";
import { assertSalesAllowed } from "@/lib/services/customers/credit-db";
import { prisma, TX_OPTS } from "@/lib/db";
import { requireModule, requireSub } from "@/lib/auth-server";
import { handleDomainError } from "@/lib/api-error";
import { hasSubPrivilege, hasModuleAccess } from "@/lib/auth-shared";
import { seesAllSales } from "@/lib/services/sales/scope";

import {
  nextQuoteNumber, saveQuoteLines, parseLineInputs, QUOTE_CURRENCY,
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
  issuedAt: true, acceptedAt: true, createdAt: true, supersedesId: true,
  discountApprovedById: true, discountApprovedAt: true, discountApprovedPercent: true,
  discountRejectedAt: true,
  customer: { select: { id: true, name: true, nameAr: true } },
  opportunity: {
    select: { id: true, title: true, outcome: true, owner: { select: { id: true, name: true } } },
  },
  _count: { select: { lines: true, orderLinks: true } },
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
  const { user, error } = await requireModule("sales");
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
  const csv = url.searchParams.get("format") === "csv";
  const page = Math.max(1, Number(url.searchParams.get("page") ?? 1) || 1);
  const perPage = Math.min(100, Math.max(1, Number(url.searchParams.get("perPage") ?? 25) || 25));

  const scopeAll = seesAllSales(user.permissions);
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

    const where = {
      ...base,
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
        r.opportunity.title, r.opportunity.owner?.name ?? "", r.subtotal.toFixed(2), r.discountTotal.toFixed(2),
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
        pendingApproval: pendingIds.length,
        expiringSoon,
      },
      owners,
      scope: scopeAll ? "all" : "own",
      discountThresholdPercent: settings.effectiveThresholdPercent,
      can: {
        write: hasSubPrivilege(user.permissions, "sales", "quote_write"),
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
  const { user, error } = await requireSub("sales", "quote_write");
  if (error) return error;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const b = (body ?? {}) as Record<string, unknown>;

  const opportunityId = typeof b.opportunityId === "string" ? b.opportunityId : "";
  if (!opportunityId) {
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

  const rawLines = Array.isArray(b.lines) ? b.lines : [];
  if (rawLines.length > 100) {
    return NextResponse.json({ error: "A quotation may carry at most 100 lines." }, { status: 400 });
  }

  try {
    const deal = await prisma.opportunity.findFirst({
      where: {
        id: opportunityId,
        ...(seesAllSales(user.permissions) ? {} : { ownerId: user.id }),
      },
      select: { id: true, customerId: true, outcome: true },
    });
    if (!deal) return NextResponse.json({ error: "Deal not found." }, { status: 404 });
    if (deal.outcome === "LOST") {
      return NextResponse.json(
        { error: "This deal is lost. Reopen it before quoting again." },
        { status: 409 },
      );
    }

    const lines = parseLineInputs(rawLines);

    const result = await prisma.$transaction(async (tx) => {
      // «إيقاف البيع» (feat/credit-hold): no new quotation while the customer's sales are on hold.
      await assertSalesAllowed(tx, deal.customerId);
      const quoteNumber = await nextQuoteNumber(tx, new Date());
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
        },
        select: { id: true, quoteNumber: true, revision: true },
      });

      if (lines.length > 0) {
        const saved = await saveQuoteLines(tx, { quoteId: created.id, lines, threshold: await discountThreshold(tx) });
        return { quote: created, priced: saved.priced, needsDiscountApproval: saved.needsDiscountApproval };
      }
      return { quote: created, priced: null, needsDiscountApproval: false };
    }, TX_OPTS);

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
      },
      { status: 201 },
    );
  } catch (err) {
    return handleDomainError(err);
  }
}
