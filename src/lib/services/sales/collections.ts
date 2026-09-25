import type { Prisma as PrismaNS } from "@/generated/prisma/client";
import { Decimal, ZERO, roundMoney } from "../commissions/engine";
import { accrueForCollection } from "../commissions/accrual";

type Tx = PrismaNS.TransactionClient;

/**
 * Sales collections — the manual, finance-verified receipt.
 *
 * ── What this is, and what it is not ──
 * It is a durable internal record of "a salesperson says money arrived, and Finance either
 * agrees or does not". It is NOT an accounts-receivable subsystem, NOT a bank feed, and NOT
 * a reconciliation against a statement. Nothing in this file talks to a bank, and the source
 * stamp on every commission event it produces says so in one word:
 * `MANUAL_FINANCE_VERIFICATION`.
 *
 * ── Why it does not compute commission itself ──
 * There is already an engine that knows about tiers, split ownership, Riyadh period
 * boundaries, immutable plan versions and reversal arithmetic. Approving a collection
 * writes one row into that engine's input table and calls it. A second commission
 * calculation living here would disagree with the first one within a month.
 *
 * ── Why the salesperson never types the VAT ──
 * They know what arrived in the bank. They do not know, and should not have to work out,
 * which part of it was tax — and if they guess, the guess becomes somebody's commission
 * basis. The split is derived here from the accepted quotation the money is against.
 */

export const COLLECTION_SOURCE = "MANUAL_FINANCE_VERIFICATION";

export type CollectionStatusValue = "PENDING_VERIFICATION" | "APPROVED" | "REJECTED" | "REVERSED";
export type PaymentMethodValue = "BANK_TRANSFER" | "CASH" | "CHEQUE" | "POS_CARD" | "OTHER";

export const PAYMENT_METHODS: PaymentMethodValue[] = [
  "BANK_TRANSFER",
  "CASH",
  "CHEQUE",
  "POS_CARD",
  "OTHER",
];

/** Derived, never stored: two columns that can disagree are two columns that will. */
export type PaymentState = "UNPAID" | "PARTIALLY_COLLECTED" | "FULLY_COLLECTED";

export type EligibleDocument = {
  quoteId: string;
  quoteNumber: string;
  currency: string;
  /** The accepted quotation's own figures — the ceiling everything is measured against. */
  gross: PrismaNS.Decimal;
  tax: PrismaNS.Decimal;
  net: PrismaNS.Decimal;
};

/**
 * The accepted quotation a collection may be recorded against.
 *
 * One per deal by construction: `decideQuote` supersedes the previous revision when a new
 * one is accepted, so "the accepted quotation" is unambiguous. If somehow more than one is
 * accepted, the most recent revision is the live document and the older is history.
 */
export async function eligibleDocument(
  tx: Tx,
  opportunityId: string,
): Promise<EligibleDocument | null> {
  const quote = await tx.quote.findFirst({
    where: { opportunityId, status: "ACCEPTED" },
    orderBy: { revision: "desc" },
    select: { id: true, quoteNumber: true, currency: true, grandTotal: true, taxTotal: true },
  });
  if (!quote) return null;
  const gross = new Decimal(quote.grandTotal.toString());
  const tax = new Decimal(quote.taxTotal.toString());
  return {
    quoteId: quote.id,
    quoteNumber: quote.quoteNumber,
    currency: quote.currency,
    gross,
    tax,
    net: roundMoney(gross.minus(tax)),
  };
}

export type CollectionSummary = {
  document: EligibleDocument | null;
  /** Approved and not since reversed — the only figure that has produced commission. */
  approvedGross: PrismaNS.Decimal;
  approvedTax: PrismaNS.Decimal;
  approvedNet: PrismaNS.Decimal;
  /** Submitted and awaiting a decision. Reserved against the ceiling, not yet earned. */
  pendingGross: PrismaNS.Decimal;
  reversedGross: PrismaNS.Decimal;
  /** What may still be claimed: the document less what is approved and what is pending. */
  remainingGross: PrismaNS.Decimal;
  state: PaymentState;
};

/**
 * What has been collected against a deal, and what may still be.
 *
 * Pending submissions count against the ceiling. Two reps each submitting the full amount
 * and both being approved is the failure this prevents, and the check has to be on the way
 * in rather than at approval time, because by approval time somebody has been told a number.
 */
export async function collectionSummary(tx: Tx, opportunityId: string): Promise<CollectionSummary> {
  const document = await eligibleDocument(tx, opportunityId);

  const rows = await tx.salesCollection.findMany({
    where: { opportunityId, status: { in: ["APPROVED", "PENDING_VERIFICATION", "REVERSED"] } },
    select: { status: true, amountGross: true, amountTax: true, amountNet: true },
  });

  let approvedGross = ZERO;
  let approvedTax = ZERO;
  let approvedNet = ZERO;
  let pendingGross = ZERO;
  let reversedGross = ZERO;

  for (const r of rows) {
    const g = new Decimal(r.amountGross.toString());
    if (r.status === "APPROVED") {
      approvedGross = approvedGross.plus(g);
      approvedTax = approvedTax.plus(new Decimal(r.amountTax.toString()));
      approvedNet = approvedNet.plus(new Decimal(r.amountNet.toString()));
    } else if (r.status === "PENDING_VERIFICATION") {
      pendingGross = pendingGross.plus(g);
    } else {
      reversedGross = reversedGross.plus(g);
    }
  }

  approvedGross = roundMoney(approvedGross);
  approvedTax = roundMoney(approvedTax);
  approvedNet = roundMoney(approvedNet);
  pendingGross = roundMoney(pendingGross);
  reversedGross = roundMoney(reversedGross);

  const ceiling = document?.gross ?? ZERO;
  const remaining = roundMoney(ceiling.minus(approvedGross).minus(pendingGross));

  // Derived from approved money only. A pending claim does not make a deal "partially
  // collected" — nobody has agreed that anything arrived.
  const state: PaymentState =
    approvedGross.lessThanOrEqualTo(0)
      ? "UNPAID"
      : approvedGross.greaterThanOrEqualTo(ceiling) && ceiling.greaterThan(0)
        ? "FULLY_COLLECTED"
        : "PARTIALLY_COLLECTED";

  return {
    document,
    approvedGross,
    approvedTax,
    approvedNet,
    pendingGross,
    reversedGross,
    remainingGross: remaining.lessThan(0) ? ZERO : remaining,
    state,
  };
}

/**
 * Split a gross receipt into tax and net, using the document's own proportions.
 *
 * Proportional rather than rate-based on purpose: a quotation can carry lines at different
 * tax rates, or zero-rated lines beside standard ones, and there is then no single "the VAT
 * rate" to apply. The document's own tax-to-gross ratio is the only honest answer that does
 * not require re-pricing every line against a partial payment.
 *
 * The last collection is the exception, and it matters: when a payment brings the total to
 * exactly the document's gross, its tax is whatever is left of the document's tax. Without
 * that, a run of rounded proportions can leave the sum a cent away from the quotation, and
 * the one thing a finance screen must do is reconcile.
 */
export function allocate(
  gross: PrismaNS.Decimal,
  document: EligibleDocument,
  alreadyGross: PrismaNS.Decimal,
  alreadyTax: PrismaNS.Decimal,
): { tax: PrismaNS.Decimal; net: PrismaNS.Decimal } {
  const settles = roundMoney(alreadyGross.plus(gross)).equals(document.gross);
  const tax = settles
    ? roundMoney(document.tax.minus(alreadyTax))
    : document.gross.isZero()
      ? ZERO
      : roundMoney(gross.times(document.tax).dividedBy(document.gross));
  const safeTax = tax.lessThan(0) ? ZERO : tax.greaterThan(gross) ? gross : tax;
  return { tax: safeTax, net: roundMoney(gross.minus(safeTax)) };
}

export type SubmitInput = {
  opportunityId: string;
  amountGross: PrismaNS.Decimal;
  currency: string;
  collectedAt: Date;
  paymentMethod: PaymentMethodValue;
  referenceNumber: string | null;
  note: string | null;
  idempotencyKey: string;
  submittedById: string;
};

export type SubmitResult = {
  collectionId: string;
  replayed: boolean;
  amountTax: PrismaNS.Decimal;
  amountNet: PrismaNS.Decimal;
};

/**
 * Record a claimed receipt. Creates no commission — approval does that.
 *
 * Idempotent on (submitter, key). The unique index is the arbiter rather than a prior read:
 * a double-submitted form races, one insert wins, and the loser reads the winner's row.
 */
export async function submitCollection(tx: Tx, input: SubmitInput): Promise<SubmitResult> {
  const existing = await tx.salesCollection.findUnique({
    where: {
      submittedById_idempotencyKey: {
        submittedById: input.submittedById,
        idempotencyKey: input.idempotencyKey,
      },
    },
    select: { id: true, amountTax: true, amountNet: true },
  });
  if (existing) {
    return {
      collectionId: existing.id,
      replayed: true,
      amountTax: new Decimal(existing.amountTax.toString()),
      amountNet: new Decimal(existing.amountNet.toString()),
    };
  }

  if (input.amountGross.lessThanOrEqualTo(0)) {
    throw { _appCode: 400, message: "A collection has to be a positive amount." };
  }

  // The deal row is locked for the duration, so two submissions against the same deal
  // cannot both read the same remaining balance and both pass the ceiling check.
  const locked = await tx.$queryRaw<{ id: string; outcome: string; customerId: string | null }[]>`
    SELECT "id", "outcome"::text AS outcome, "customerId"
      FROM "Opportunity"
     WHERE "id" = ${input.opportunityId}
       FOR UPDATE
  `;
  const deal = locked[0];
  if (!deal) throw { _appCode: 404, message: "Deal not found." };

  const summary = await collectionSummary(tx, input.opportunityId);
  if (!summary.document) {
    throw {
      _appCode: 409,
      message:
        "There is no accepted quotation on this deal, so there is nothing to collect against. " +
        "Record the customer's acceptance first.",
    };
  }
  if (input.currency !== summary.document.currency) {
    throw {
      _appCode: 409,
      message:
        `This collection is in ${input.currency} but the quotation is in ${summary.document.currency}. ` +
        "There is no exchange-rate policy in this system, so it cannot be converted.",
    };
  }
  if (input.amountGross.greaterThan(summary.remainingGross)) {
    throw {
      _appCode: 409,
      message:
        `Only ${summary.remainingGross.toFixed(2)} ${summary.document.currency} is still outstanding on ` +
        "this deal, counting what is already awaiting verification. Overpayment is not recorded here.",
    };
  }

  const { tax, net } = allocate(
    input.amountGross,
    summary.document,
    summary.approvedGross.plus(summary.pendingGross),
    summary.approvedTax,
  );

  const order = await tx.opportunityOrder.findFirst({
    where: { opportunityId: input.opportunityId },
    orderBy: { createdAt: "asc" },
    select: { orderId: true },
  });

  const created = await tx.salesCollection.create({
    data: {
      opportunityId: input.opportunityId,
      quoteId: summary.document.quoteId,
      orderId: order?.orderId ?? null,
      customerId: deal.customerId,
      idempotencyKey: input.idempotencyKey,
      referenceNumber: input.referenceNumber?.trim() || null,
      amountGross: input.amountGross.toFixed(2),
      amountTax: tax.toFixed(2),
      amountNet: net.toFixed(2),
      currency: input.currency,
      paymentMethod: input.paymentMethod,
      collectedAt: input.collectedAt,
      note: input.note?.trim() || null,
      submittedById: input.submittedById,
    },
    select: { id: true },
  });

  return { collectionId: created.id, replayed: false, amountTax: tax, amountNet: net };
}

export type DecisionResult = {
  status: CollectionStatusValue;
  replayed: boolean;
  collectionEventId: string | null;
  /** Commission actually posted by this decision, per employee. Empty on a replay. */
  commission: { employeeId: string; amount: string }[];
};

/**
 * Lock one collection for a decision, and read the fields a decision needs.
 *
 * `FOR UPDATE` rather than an optimistic check: approve-racing-reject and
 * approve-racing-approve both have to resolve to one outcome, and the second caller has to
 * see the first one's result rather than its own stale read.
 */
async function lockCollection(tx: Tx, id: string) {
  const rows = await tx.$queryRaw<
    {
      id: string;
      status: string;
      submittedById: string;
      opportunityId: string;
      customerId: string | null;
      orderId: string | null;
      amountGross: string;
      amountTax: string;
      currency: string;
      collectedAt: Date;
      collectionEventId: string | null;
    }[]
  >`
    SELECT "id", "status"::text AS status, "submittedById", "opportunityId", "customerId",
           "orderId", "amountGross"::text, "amountTax"::text, "currency", "collectedAt",
           "collectionEventId"
      FROM "SalesCollection"
     WHERE "id" = ${id}
       FOR UPDATE
  `;
  const row = rows[0];
  if (!row) throw { _appCode: 404, message: "Collection not found." };
  return row;
}

/**
 * Finance agrees the money arrived. This is the ONLY thing that creates commission.
 *
 * The separation of duties is enforced here rather than by hiding a button: whoever
 * submitted a collection cannot be the one who verifies it, even if they happen to hold
 * both privileges. That rule has no emergency exception in this release, deliberately —
 * an exception nobody documented is how it stops being a rule.
 */
export async function approveCollection(
  tx: Tx,
  input: { collectionId: string; actorId: string },
): Promise<DecisionResult> {
  const row = await lockCollection(tx, input.collectionId);

  if (row.status === "APPROVED") {
    // A replayed approval. Behind the lock, so the first one has finished: report what it
    // did rather than doing it again.
    return { status: "APPROVED", replayed: true, collectionEventId: row.collectionEventId, commission: [] };
  }
  if (row.status !== "PENDING_VERIFICATION") {
    throw {
      _appCode: 409,
      message: `This collection is ${row.status.toLowerCase().replace(/_/g, " ")} and can no longer be approved.`,
    };
  }
  if (row.submittedById === input.actorId) {
    throw {
      _appCode: 403,
      message:
        "The person who recorded a collection cannot be the one who verifies it. " +
        "Ask another member of Finance.",
    };
  }

  // One row into the commission engine's input table, stamped so it can never be confused
  // with a sandbox event. The unique key on (sourceSystem, externalRef) is the last line of
  // defence against a duplicate approval creating a second accrual.
  const event = await tx.collectionEvent.create({
    data: {
      sourceSystem: COLLECTION_SOURCE,
      externalRef: row.id,
      status: "RECORDED",
      customerId: row.customerId,
      opportunityId: row.opportunityId,
      orderId: row.orderId,
      amountGross: row.amountGross,
      amountTax: row.amountTax,
      amountNonQualifying: "0",
      currency: row.currency,
      collectedAt: row.collectedAt,
      createdById: input.actorId,
    },
    select: { id: true },
  });

  await tx.salesCollection.update({
    where: { id: row.id },
    data: {
      status: "APPROVED",
      collectionEventId: event.id,
      decidedById: input.actorId,
      decidedAt: new Date(),
      decisionReason: null,
    },
  });

  const outcomes = await accrueForCollection(tx, event.id, input.actorId);

  return {
    status: "APPROVED",
    replayed: false,
    collectionEventId: event.id,
    commission: outcomes.map((o) => ({ employeeId: o.employeeId, amount: o.delta.toFixed(2) })),
  };
}

/** Finance does not agree. Nothing financial happens, and the reason is required. */
export async function rejectCollection(
  tx: Tx,
  input: { collectionId: string; actorId: string; reason: string },
): Promise<DecisionResult> {
  const reason = input.reason?.trim() ?? "";
  if (reason.length < 3) {
    throw { _appCode: 400, message: "Rejecting a collection needs a reason." };
  }

  const row = await lockCollection(tx, input.collectionId);
  if (row.status === "REJECTED") {
    return { status: "REJECTED", replayed: true, collectionEventId: null, commission: [] };
  }
  if (row.status !== "PENDING_VERIFICATION") {
    throw {
      _appCode: 409,
      message: `This collection is ${row.status.toLowerCase().replace(/_/g, " ")} and can no longer be rejected.`,
    };
  }
  if (row.submittedById === input.actorId) {
    throw {
      _appCode: 403,
      message: "The person who recorded a collection cannot be the one who decides it.",
    };
  }

  await tx.salesCollection.update({
    where: { id: row.id },
    data: {
      status: "REJECTED",
      decidedById: input.actorId,
      decidedAt: new Date(),
      decisionReason: reason,
    },
  });

  return { status: "REJECTED", replayed: false, collectionEventId: null, commission: [] };
}

/**
 * The money went back, or the approval was wrong.
 *
 * Never a delete and never an edit. The original row keeps every field it was approved
 * with, including who approved it and when; this adds the reversal on top. The commission
 * correction is the engine's own: marking the event REVERSED drops it out of the period's
 * cumulative base, and the recomputation posts the difference, which is negative.
 */
export async function reverseCollection(
  tx: Tx,
  input: { collectionId: string; actorId: string; reason: string },
): Promise<DecisionResult> {
  const reason = input.reason?.trim() ?? "";
  if (reason.length < 3) {
    throw { _appCode: 400, message: "Reversing a collection needs a reason." };
  }

  const row = await lockCollection(tx, input.collectionId);
  if (row.status === "REVERSED") {
    return { status: "REVERSED", replayed: true, collectionEventId: row.collectionEventId, commission: [] };
  }
  if (row.status !== "APPROVED") {
    throw {
      _appCode: 409,
      message: "Only an approved collection can be reversed.",
    };
  }
  if (!row.collectionEventId) {
    // The check constraint makes this unreachable; the guard is here so that if it ever
    // becomes reachable it fails loudly instead of silently skipping the correction.
    throw { _appCode: 500, message: "This approved collection has no commission event to reverse." };
  }

  const now = new Date();
  await tx.collectionEvent.update({
    where: { id: row.collectionEventId },
    data: { status: "REVERSED", reversedAt: now },
  });

  await tx.salesCollection.update({
    where: { id: row.id },
    data: {
      status: "REVERSED",
      reversedById: input.actorId,
      reversedAt: now,
      reversalReason: reason,
    },
  });

  const outcomes = await accrueForCollection(tx, row.collectionEventId, input.actorId);

  return {
    status: "REVERSED",
    replayed: false,
    collectionEventId: row.collectionEventId,
    commission: outcomes.map((o) => ({ employeeId: o.employeeId, amount: o.delta.toFixed(2) })),
  };
}

/**
 * ── Whether this person may record a collection on this deal, right now, and if not why ──
 *
 * One function, called by every surface that offers the action, because the alternative is
 * each screen re-deriving the rule from a privilege flag and a couple of amounts. That is
 * how the button came to be missing in the first place: the panel asked only "does the
 * caller hold the privilege, and is there a document?", so a reviewer whose role predated
 * the privilege got a blank space with nothing to read.
 *
 * This is NOT the authorisation boundary. `POST /api/sales/collections` re-checks ownership
 * and re-derives every amount behind a row lock, and refuses regardless of what any screen
 * decided to render. This exists so the screen can say the true reason instead of hiding.
 */
export type CollectionActionReason =
  | "OK"
  | "NO_PRIVILEGE"
  | "NOT_YOUR_DEAL"
  | "NO_ACCEPTED_DOCUMENT"
  | "NOTHING_OUTSTANDING";

export type CollectionAction = { available: boolean; reason: CollectionActionReason };

export function collectionAction(input: {
  hasSubmitPrivilege: boolean;
  /** True when the caller owns the deal, or holds a scope that covers other people's. */
  inScope: boolean;
  summary: Pick<CollectionSummary, "document" | "remainingGross">;
}): CollectionAction {
  // Ordered most-fundamental first, so the reason a person is shown is the one they would
  // have to fix first. Telling a rep "nothing outstanding" when they also lack the
  // privilege sends them to the wrong conversation.
  if (!input.hasSubmitPrivilege) return { available: false, reason: "NO_PRIVILEGE" };
  if (!input.inScope) return { available: false, reason: "NOT_YOUR_DEAL" };
  // A rejected, superseded or expired quotation is not an eligible document, and neither is
  // no quotation at all. `eligibleDocument` already made that judgement.
  if (!input.summary.document) return { available: false, reason: "NO_ACCEPTED_DOCUMENT" };
  if (input.summary.remainingGross.lessThanOrEqualTo(0)) {
    return { available: false, reason: "NOTHING_OUTSTANDING" };
  }
  return { available: true, reason: "OK" };
}
