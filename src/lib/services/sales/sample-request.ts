// Requesting a stock sample, and the manager's decision on a second one — the TRANSACTIONS
// (docs/sales/SAMPLES_INVENTORY.md §2). The rules are pure, in sample-rules.ts; the issue is sample-issue.ts.
//
// «للعميل من كل محصول عيّنة واحدة»: one sample (one unit) of each coffee product per customer. A second sample of the
// same product is not refused — the customer may genuinely need it — but it waits for the sales manager:
//
//   requestStockSample (POST /api/sales/samples, a product in units)
//     1. lock the deal (FOR UPDATE) and re-read it: the scope, the outcome, and the arbiter for a double click;
//     2. the S3 replay window (SAMPLE_REQUEST_REPLAY_MS): the same request by the same person, still REQUESTED,
//        within two minutes IS this request — answered with the existing row, nothing written. Before the count, so
//        the retry of a FIRST request is never mistaken for a second sample;
//     3. a transaction-scoped advisory lock on (customer, product) — two deals of the same customer requesting the
//        same coffee at the same moment serialise here, so they cannot both be «the first»;
//     4. count the samples of this product for this customer that are not CANCELLED; any → `approvalRequired`.
//        A manager (lead_assign / admin) requesting it records their own approval on the row at creation;
//     5. insert, REQUESTED. A request awaiting approval is not in the dispatch queue (DISPATCHABLE_APPROVAL).
//
//   decideSampleApproval (POST /api/sales/samples/[id]/approval)
//     the sample row locked (FOR UPDATE); APPROVE records who / when / note and the request joins the dispatch queue;
//     DECLINE (a reason required) records who / when / reason and CANCELS the request — so it never counts and is
//     never issued. Idempotent: the same decision again answers the recorded one (`replayed`).
//
// Lock order: Opportunity → advisory (customer, product) → SampleShipment (insert); the decision locks the sample row
// alone; the issue locks the sample row then lots. Nothing locks a sample row and then waits for a deal or the
// advisory key, so no order is inverted.
import { prisma, TX_OPTS } from "@/lib/db";
import type { Permissions } from "@/lib/auth-shared";
import { Prisma } from "@/generated/prisma/client";
import { seesAllSales, NOT_FOUND_MESSAGE } from "./scope";
import {
  SAMPLE_REQUEST_REPLAY_MS, approvesSamples, sampleApprovalState, sampleOneUnitRefusal, type SampleApprovalState,
} from "./sample-rules";

type Tx = Prisma.TransactionClient;

export type SampleActor = { id: string; permissions: Permissions | Record<string, unknown>; role?: string | null };

const SAMPLE_SELECT = {
  id: true, status: true, quantity: true, unit: true, sentAt: true, fromStock: true,
  approvalRequired: true, approvedById: true, approvedAt: true, declinedAt: true, approvalNote: true,
} as const;
type SampleRow = Prisma.SampleShipmentGetPayload<{ select: typeof SAMPLE_SELECT }>;

export type RequestOutcome = {
  replayed: boolean;
  sample: SampleRow & { approval: SampleApprovalState };
  /** Samples of this product the customer already had (not cancelled) when this one was requested. */
  priorSamples: number;
};

const withState = (s: SampleRow) => ({ ...s, approval: sampleApprovalState(s) });

/**
 * The samples of a coffee product a customer already has — every one not CANCELLED, through any SKU of the product
 * and any deal of the customer. Without a customer the deal stands for the prospect. `exceptId`: the row itself.
 */
export async function priorSamplesOf(
  db: Tx | typeof prisma, who: { customerId: string | null; opportunityId: string }, productId: string, exceptId?: string,
): Promise<number> {
  return db.sampleShipment.count({
    where: {
      status: { not: "CANCELLED" },
      productSku: { productId },
      ...(who.customerId ? { opportunity: { customerId: who.customerId } } : { opportunityId: who.opportunityId }),
      ...(exceptId ? { id: { not: exceptId } } : {}),
    },
  });
}

/** The coffee products (ProductSKU.productId) a customer — or a customer-less deal — has had a sample of. */
export async function sampledProductIds(db: Tx | typeof prisma, who: { customerId: string | null; opportunityId: string }): Promise<string[]> {
  const rows = await db.sampleShipment.findMany({
    where: {
      status: { not: "CANCELLED" }, productSkuId: { not: null },
      ...(who.customerId ? { opportunity: { customerId: who.customerId } } : { opportunityId: who.opportunityId }),
    },
    select: { productSku: { select: { productId: true } } },
  });
  return [...new Set(rows.map((r) => r.productSku?.productId).filter((x): x is string => !!x))];
}

/**
 * Request a stock sample of `productSkuId` for a deal (see the file header). Throws coded refusals: 409
 * SAMPLE_ONE_UNIT (more than one unit), 404 (no such deal in the caller's scope), 409 (the deal is closed), 400 (no
 * such product).
 */
export async function requestStockSample(
  input: { opportunityId: string; productSkuId: string; units: number; description: string | null; approvalNote?: string | null },
  actor: SampleActor,
  db: typeof prisma = prisma,
): Promise<RequestOutcome> {
  const one = sampleOneUnitRefusal(input.units);
  if (one) throw one;
  return db.$transaction((tx) => requestStockSampleIn(tx, input, actor), TX_OPTS);
}

/**
 * The same request inside the caller's transaction — the customer page's «عيّنة» opens the deal (quick-deal) and
 * records the request as ONE write (council fix round 2, item 3), so a cancelled dialog leaves nothing behind.
 */
export async function requestStockSampleIn(
  tx: Prisma.TransactionClient,
  input: { opportunityId: string; productSkuId: string; units: number; description: string | null; approvalNote?: string | null },
  actor: SampleActor,
): Promise<RequestOutcome> {
  const one = sampleOneUnitRefusal(input.units);
  if (one) throw one;
  const manager = approvesSamples(actor.permissions);
  const quantity = new Prisma.Decimal(input.units);
  {
    // ── 1. The deal, locked and re-read ──
    const rows = await tx.$queryRaw<{ id: string; outcome: string; ownerId: string | null; customerId: string | null }[]>`
      SELECT "id", "outcome"::text AS "outcome", "ownerId", "customerId" FROM "Opportunity" WHERE "id" = ${input.opportunityId} FOR UPDATE`;
    const deal = rows[0];
    if (!deal || (!seesAllSales(actor.permissions) && deal.ownerId !== actor.id)) {
      throw { _appCode: 404, message: "Deal not found." };
    }
    if (deal.outcome !== "OPEN") {
      throw { _appCode: 409, message: `This deal is ${deal.outcome.toLowerCase()}; sending it a sample records nothing useful.` };
    }

    // ── 2. S3: the replay window — before the count, so a first request's retry is the first request ──
    const same = await tx.sampleShipment.findFirst({
      where: {
        opportunityId: input.opportunityId, productSkuId: input.productSkuId, quantity, unit: "UNIT", fromStock: true,
        status: "REQUESTED", createdById: actor.id,
        createdAt: { gte: new Date(Date.now() - SAMPLE_REQUEST_REPLAY_MS) },
      },
      orderBy: { createdAt: "desc" },
      select: SAMPLE_SELECT,
    });
    if (same) {
      const sku = await tx.productSKU.findUnique({ where: { id: input.productSkuId }, select: { productId: true } });
      const prior = sku ? await priorSamplesOf(tx, { customerId: deal.customerId, opportunityId: deal.id }, sku.productId, same.id) : 0;
      return { replayed: true, sample: withState(same), priorSamples: prior };
    }

    // ── 3. The product, and the (customer, product) key serialised ──
    const sku = await tx.productSKU.findUnique({ where: { id: input.productSkuId }, select: { id: true, productId: true } });
    if (!sku) throw { _appCode: 400, message: "That product does not exist." };
    const who = deal.customerId ? `customer:${deal.customerId}` : `deal:${deal.id}`;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`sample-first|${who}|${sku.productId}`}))`;

    // ── 4. Already sampled? Then a manager decides; a manager's own request carries the manager's approval ──
    const prior = await priorSamplesOf(tx, { customerId: deal.customerId, opportunityId: deal.id }, sku.productId);
    const approvalRequired = prior > 0;
    const selfApproved = approvalRequired && manager;
    const note = typeof input.approvalNote === "string" && input.approvalNote.trim() ? input.approvalNote.trim().slice(0, 500) : null;

    // ── 5. The request ──
    const created = await tx.sampleShipment.create({
      data: {
        opportunityId: input.opportunityId,
        productSkuId: input.productSkuId,
        description: input.description || null,
        quantity,
        unit: "UNIT",
        status: "REQUESTED",
        fromStock: true,
        createdById: actor.id,
        approvalRequired,
        ...(selfApproved ? { approvedById: actor.id, approvedAt: new Date(), approvalNote: note } : {}),
      },
      select: SAMPLE_SELECT,
    });
    return { replayed: false, sample: withState(created), priorSamples: prior };
  }
}

type LockedForDecision = {
  id: string; status: string; fromStock: boolean; approvalRequired: boolean;
  approvedAt: Date | null; declinedAt: Date | null; issuedAt: Date | null;
};

/**
 * The manager's decision on a second sample (see the file header). `decision`: APPROVE, or DECLINE (REJECT is the
 * same — the workspace inbox sends it) with a reason. Throws coded refusals; the caller has checked approvesSamples.
 */
export async function decideSampleApproval(
  sampleId: string, decision: "APPROVE" | "DECLINE", note: string | null, actor: SampleActor, db: typeof prisma = prisma,
) {
  if (!approvesSamples(actor.permissions)) {
    throw {
      _appCode: 403, code: "SAMPLE_APPROVER_ONLY",
      message: "اعتماد العيّنة الثانية لمدير المبيعات أو المدير فقط.",
      errorEn: "Only a sales manager or the administrator approves a second sample.",
    };
  }
  const reason = typeof note === "string" && note.trim() ? note.trim().slice(0, 500) : null;
  if (decision === "DECLINE" && !reason) {
    throw { _appCode: 400, code: "SAMPLE_DECLINE_REASON", message: "اذكر سبب رفض العيّنة؛ يقرؤه المندوب.", errorEn: "Give the reason for declining the sample; the rep reads it." };
  }
  return db.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<LockedForDecision[]>`
      SELECT "id", "status"::text AS "status", "fromStock", "approvalRequired", "approvedAt", "declinedAt", "issuedAt"
        FROM "SampleShipment" WHERE "id" = ${sampleId} FOR UPDATE`;
    const s = rows[0];
    if (!s) throw { _appCode: 404, message: NOT_FOUND_MESSAGE };
    if (!s.approvalRequired) {
      throw {
        _appCode: 409, code: "SAMPLE_NO_APPROVAL_NEEDED",
        message: "هذه أول عيّنة من المحصول لهذا العميل؛ لا تحتاج موافقة.", errorEn: "This is the customer's first sample of the product; it needs no approval.",
      };
    }
    const read = () => tx.sampleShipment.findUniqueOrThrow({ where: { id: s.id }, select: SAMPLE_SELECT });
    // The same decision again (a double click, a retry after a lost answer, two managers agreeing): the recorded one.
    if (decision === "APPROVE" && s.approvedAt) return { replayed: true, sample: withState(await read()) };
    if (decision === "DECLINE" && s.declinedAt) return { replayed: true, sample: withState(await read()) };
    if (s.approvedAt || s.declinedAt) {
      throw {
        _appCode: 409, code: "SAMPLE_APPROVAL_DECIDED",
        message: s.approvedAt ? "اعتُمدت هذه العيّنة مسبقًا؛ لإيقافها يلغي المندوب الطلب قبل صرفه." : "رُفضت هذه العيّنة مسبقًا وأُلغي طلبها.",
        errorEn: s.approvedAt ? "This sample was already approved; to stop it, the rep cancels the request before it is issued." : "This sample was already declined and its request cancelled.",
      };
    }
    if (s.status !== "REQUESTED" && s.status !== "PREPARING") {
      throw {
        _appCode: 409, code: "SAMPLE_NOT_WAITING",
        message: "لم يعد طلب العيّنة قائمًا (أُلغي).", errorEn: "The sample request is no longer open (it was cancelled).",
      };
    }
    const now = new Date();
    const data = decision === "APPROVE"
      ? { approvedById: actor.id, approvedAt: now, approvalNote: reason }
      : { declinedById: actor.id, declinedAt: now, approvalNote: reason, status: "CANCELLED" as const };
    await tx.sampleShipment.update({ where: { id: s.id }, data });
    return { replayed: false, sample: withState(await read()) };
  }, TX_OPTS);
}
