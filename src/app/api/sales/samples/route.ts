import { NextResponse } from "@/lib/api-response";
import { prisma, TX_OPTS } from "@/lib/db";
import { requireModule, requireSub } from "@/lib/auth-server";
import { handleDomainError } from "@/lib/api-error";
import { seesAllSales } from "@/lib/services/sales/scope";
import { parseFiniteDecimal } from "@/lib/services/commissions/engine";
import {
  SAMPLE_STATUSES, isStockSample, requestKeyRefusal, sampleApprovalState, sampleOneUnitRefusal, sampleUnitRefusal, wholeUnits,
} from "@/lib/services/sales/sample-rules";
import { requestStockSampleIn } from "@/lib/services/sales/sample-request";
import { hasModuleAccess, hasSubPrivilege } from "@/lib/auth-shared";
import { customerInScope } from "@/lib/services/sales/customer-access";
import { actsForAccountOwner, resolveQuickDeal } from "@/lib/services/sales/quick-deal";

/**
 * Sample shipments.
 *
 * ── The CRM screen still does not move stock ──
 * The roastery has a packaging and inventory path with its own guards, its own reconciliation and its own audit
 * trail. A CRM screen that decremented a shelf would be a second way into the same inventory — exactly the defect
 * the packaging rework on this codebase was spent closing. So the rep's side of a sample is paper only:
 *
 *   · a STOCK sample (a product in units, 20261204090000_sample_inventory) is REQUESTED here. The request reserves
 *     nothing and deducts nothing; the dispatch department issues it (POST /api/deliveries/samples/[id]), and that
 *     issue — under the same lot guards as a delivery — is the one place the units leave the shelf;
 *   · a RECORD-ONLY sample (free text, kilograms, grams — and every row from before) is what it always was: what
 *     was promised and what came back, with no stock movement at all.
 *
 * That limit is stated in the response so nobody has to infer it from the absence of a stock movement.
 * docs/sales/SAMPLES_INVENTORY.md has the whole flow.
 */
const STOCK_NOTICE =
  "Recording a sample does not move stock. Issue the coffee through the normal inventory " +
  "and dispatch path; this is the follow-up record.";
const REQUEST_NOTICE =
  "Requesting a sample does not move stock. The dispatch department issues it from finished goods; " +
  "the stock leaves when they do.";
const REQUEST_NOTICE_AR = "طلب العيّنة لا يُحرّك المخزون. يصرفها قسم الشحن من المنتجات الجاهزة، وعندها فقط يخرج المخزون.";
// A second sample of the same product for the same customer (owner decision): said with the answer.
const APPROVAL_NOTICE =
  "This customer has already had a sample of this product. The request waits for the sales manager's approval; " +
  "dispatch sees it only once approved.";
const APPROVAL_NOTICE_AR = "سبق إرسال عيّنة من هذا المحصول لهذا العميل؛ الطلب بانتظار موافقة المدير ولا يصل إلى قسم الشحن قبلها.";

const STATUSES: readonly string[] = SAMPLE_STATUSES;

/** GET /api/sales/samples — outstanding samples, for the follow-up view. */
export async function GET(request: Request) {
  const { user, error } = await requireModule("sales");
  if (error) return error;

  const url = new URL(request.url);
  const status = url.searchParams.get("status");
  const scopeAll = seesAllSales(user.permissions);

  try {
    const rows = await prisma.sampleShipment.findMany({
      where: {
        ...(status && STATUSES.includes(status) ? { status: status as never } : {}),
        // Scoped through the deal, because a sample has no owner of its own — the deal does.
        ...(scopeAll ? {} : { opportunity: { ownerId: user.id } }),
      },
      orderBy: [{ status: "asc" }, { createdAt: "desc" }],
      take: 200,
      select: {
        id: true, description: true, quantity: true, unit: true, status: true,
        sentAt: true, feedbackAt: true, feedbackScore: true, feedbackNotes: true, createdAt: true,
        // Whether it is issued from stock, and when it was. Never its cost (management reporting only).
        fromStock: true, issuedAt: true,
        // «للعميل من كل محصول عيّنة واحدة» (20261205090000_sample_approval): a second sample's approval, on the request.
        approvalRequired: true, approvedAt: true, declinedAt: true, approvalNote: true,
        productSku: { select: { id: true, skuCode: true, name: true } },
        opportunity: {
          select: {
            id: true, title: true, outcome: true,
            customer: { select: { id: true, name: true } },
            owner: { select: { id: true, name: true } },
          },
        },
      },
    });

    return NextResponse.json({
      rows: rows.map((r) => ({ ...r, approval: sampleApprovalState(r) })),
      scope: scopeAll ? "all" : "own",
      notice: STOCK_NOTICE,
    });
  } catch (err) {
    return handleDomainError(err);
  }
}

/**
 * POST /api/sales/samples — request a stock sample for a deal (a product in whole units → REQUESTED), or record a
 * record-only sample being prepared or sent (free text without a product, in any unit, as before).
 *
 *   · a product in KG / GRAM is refused (400 SAMPLE_SKU_NEEDS_UNITS) — it used to become record-only silently;
 *   · «للعميل من كل محصول عيّنة واحدة» (owner decision; it replaces the per-request cap of 5 units and its
 *     SAMPLE_REQUEST_UNIT_CAP variable): a stock sample is ONE unit (409 SAMPLE_ONE_UNIT otherwise); a customer's
 *     second sample of the same coffee product is recorded REQUESTED with `approvalRequired` and stays out of the
 *     dispatch queue until a sales manager approves it (POST /api/sales/samples/[id]/approval); a manager's own
 *     second request records the manager's approval. `sample.approval` says which (NOT_NEEDED | PENDING | APPROVED);
 *     services/sales/sample-request.ts is the transaction;
 *   · idempotent: `requestKey` (8–128 chars) is accepted and the same stock request by the same rep, still REQUESTED,
 *     within two minutes answers the existing row (200, `replayed: true`) — under a row lock on the deal.
 */
export async function POST(request: Request) {
  const { user, error } = await requireSub("sales", "lead_write");
  if (error) return error;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const b = (body ?? {}) as Record<string, unknown>;

  // From the customer page (council fix round 2, item 3): `customerId` instead of a deal — the deal is chosen or opened
  // HERE, with the request, in one transaction (quick-deal), so opening and cancelling the dialog writes nothing.
  const opportunityIdIn = typeof b.opportunityId === "string" ? b.opportunityId : "";
  const customerId = !opportunityIdIn && typeof b.customerId === "string" && b.customerId ? b.customerId : "";
  if (!opportunityIdIn && !customerId) {
    return NextResponse.json({ error: "A sample belongs to a deal." }, { status: 400 });
  }
  if (customerId) {
    if (!hasModuleAccess(user.permissions, "customers")) return NextResponse.json({ error: "Insufficient permissions" }, { status: 403 });
    if (!(await customerInScope(user, customerId))) return NextResponse.json({ error: "Not found." }, { status: 404 });
  }

  const productSkuId = typeof b.productSkuId === "string" && b.productSkuId ? b.productSkuId : null;
  const description = typeof b.description === "string" ? b.description.trim() : "";
  if (!productSkuId && description.length < 2) {
    return NextResponse.json(
      { error: "Say what the sample is: pick a product, or describe it." },
      { status: 400 },
    );
  }

  const quantity = parseFiniteDecimal(b.quantity ?? 0);
  if (!quantity) return NextResponse.json({ error: "quantity is not a number." }, { status: 400 });
  if (quantity.lessThanOrEqualTo(0)) {
    return NextResponse.json({ error: "A sample quantity must be greater than zero." }, { status: 400 });
  }

  // A product is counted in units: with a product and no unit the unit is UNIT; free text keeps the old KG default.
  const unit = typeof b.unit === "string" && ["KG", "GRAM", "UNIT"].includes(b.unit) ? b.unit : productSkuId ? "UNIT" : "KG";
  // S2: a product in kilograms / grams no longer slips through as record-only — refused, said in both languages.
  const unitRefusal = sampleUnitRefusal({ unit, productSkuId });
  if (unitRefusal) return NextResponse.json(unitRefusal, { status: 400 });
  const keyRefusal = requestKeyRefusal(b.requestKey);
  if (keyRefusal) return NextResponse.json(keyRefusal, { status: 400 });
  const fromStock = isStockSample({ unit, productSkuId });
  let status: string;
  let units = 0;
  if (fromStock) {
    // A product in units is issued from stock, so the rep can only ask for it. «Sent» is what dispatch does.
    units = wholeUnits(quantity) ?? 0;
    if (!units) {
      return NextResponse.json(
        { error: "عيّنة المنتج تُطلب بعدد صحيح من العبوات (1 أو أكثر).", errorEn: "A product sample is requested in whole units (1 or more)." },
        { status: 400 },
      );
    }
    // One unit of each product (owner decision) — answered here before any read; the service checks it again.
    const one = sampleOneUnitRefusal(units);
    if (one) return NextResponse.json({ error: one.message, errorEn: one.errorEn, code: one.code }, { status: 409 });
    if (b.status !== undefined && b.status !== null && b.status !== "REQUESTED" && b.status !== "PREPARING") {
      return NextResponse.json(
        {
          error: "عيّنة المنتج تُطلب فقط؛ يصرفها قسم الشحن من المخزون ثم تصبح «مُرسلة».",
          errorEn: "A product sample can only be requested; dispatch issues it from stock and it then becomes sent.",
          code: "SAMPLE_SENT_BY_DISPATCH",
        },
        { status: 409 },
      );
    }
    status = "REQUESTED";
  } else {
    status = typeof b.status === "string" && ["PREPARING", "SENT"].includes(b.status) ? b.status : "PREPARING";
  }

  try {
    if (productSkuId) {
      const sku = await prisma.productSKU.findUnique({
        where: { id: productSkuId },
        select: { id: true, isActive: true, skuCode: true },
      });
      if (!sku) return NextResponse.json({ error: "That product does not exist." }, { status: 400 });
      if (!sku.isActive) {
        return NextResponse.json(
          { error: `"${sku.skuCode}" is inactive and cannot be sampled.` },
          { status: 400 },
        );
      }
    }

    // ── One transaction: the deal (from the customer page: chosen or opened now), then the request ──
    const SELECT = { id: true, status: true, quantity: true, unit: true, sentAt: true, fromStock: true } as const;
    const outcome = await prisma.$transaction(async (tx) => {
      let opportunityId = opportunityIdIn;
      if (customerId) {
        const q = await resolveQuickDeal(tx, {
          id: user.id, canOpenDeal: hasSubPrivilege(user.permissions, "sales", "lead_convert"), teamView: actsForAccountOwner(user),
        }, customerId, "sample");
        if (q.kind === "forbidden") throw { _appCode: 403, code: "NOT_ACCOUNT_OWNER", message: "هذا العميل له مندوب آخر — اطلب من مديرك أو من مندوبه.", errorEn: "This customer belongs to another rep." };
        if (q.kind === "none") throw { _appCode: 403, code: "NO_DEAL", message: "ما عندك صفقة مفتوحة مع هذا العميل، وما عندك صلاحية تفتح وحدة.", errorEn: "You have no open deal with this customer and may not open one." };
        if (q.kind !== "use" && q.kind !== "created") throw { _appCode: 409, code: "PICK_DEAL", message: "لهذا العميل أكثر من صفقة مفتوحة — اختر الصفقة.", errorEn: "This customer has several open deals: pick one." };
        opportunityId = q.opportunityId;
      }

      // ── A stock sample: the request, the one-per-product rule and the replay window ──
      if (fromStock && productSkuId) {
        const r = await requestStockSampleIn(tx, {
          opportunityId, productSkuId, units, description: description || null,
          approvalNote: typeof b.approvalNote === "string" ? b.approvalNote : null,
        }, { id: user.id, permissions: user.permissions });
        return { kind: "stock" as const, r, opportunityId };
      }

      // ── A record-only sample: as it always was ──
      // The sample and its follow-up are one write: a sample recorded as sent with no task behind it is the failure
      // the task exists to prevent, so the two commit together or not at all.
      const deal = await tx.opportunity.findUnique({ where: { id: opportunityId }, select: { outcome: true, ownerId: true } });
      if (!deal || (!seesAllSales(user.permissions) && deal.ownerId !== user.id)) return { kind: "notFound" as const };
      if (deal.outcome !== "OPEN") return { kind: "closed" as const, outcome: deal.outcome };

      const created = await tx.sampleShipment.create({
        data: {
          opportunityId,
          productSkuId,
          description: description || null,
          quantity,
          unit,
          status: status as never,
          sentAt: status === "SENT" ? new Date() : null,
          fromStock: false,
          createdById: user.id,
        },
        select: SELECT,
      });

      // A sample that nobody follows up is a sample that was given away. The task is created
      // with it rather than left to the rep's memory. (A stock sample gets its task when dispatch issues it.)
      if (status === "SENT" && b.createFollowUp !== false) {
        await tx.activity.create({
          data: {
            type: "SAMPLE_FOLLOW_UP",
            subject: `Follow up on sample: ${description || "product sample"}`,
            opportunityId,
            dueAt: new Date(Date.now() + 7 * 86400_000),
            ownerId: user.id,
          },
        });
      }
      return { kind: "created" as const, sample: created, opportunityId };
    }, TX_OPTS);

    if (outcome.kind === "stock") {
      const r = outcome.r;
      const pending = r.sample.approval === "PENDING";
      return NextResponse.json(
        {
          sample: r.sample, replayed: r.replayed, priorSamples: r.priorSamples, opportunityId: outcome.opportunityId,
          notice: pending ? APPROVAL_NOTICE : REQUEST_NOTICE, noticeAr: pending ? APPROVAL_NOTICE_AR : REQUEST_NOTICE_AR,
        },
        { status: r.replayed ? 200 : 201 },
      );
    }
    if (outcome.kind === "notFound") return NextResponse.json({ error: "Deal not found." }, { status: 404 });
    if (outcome.kind === "closed") {
      const deal = outcome;
      return NextResponse.json(
        { error: `This deal is ${deal.outcome.toLowerCase()}; sending it a sample records nothing useful.` },
        { status: 409 },
      );
    }
    return NextResponse.json({ sample: outcome.sample, opportunityId: outcome.opportunityId, notice: STOCK_NOTICE }, { status: 201 });
  } catch (err) {
    return handleDomainError(err);
  }
}
