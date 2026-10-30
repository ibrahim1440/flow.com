import type { Prisma as PrismaNS } from "@/generated/prisma/client";
import { Decimal, ZERO, roundMoney } from "../commissions/engine";
import { accrueForCollection } from "../commissions/accrual";
import { emitAutomationEvent } from "@/lib/automation/emit";
// Sales invoicing A2: the AR sub-ledger and the ledger postings of a receipt (approved → RECEIVED, reversed → reversal).
import { onCollectionApproved, onCollectionReversed, type ReceiptAllocation } from "@/lib/services/invoicing/ar";
import { defaultCollectionBranch, parseBranchId } from "@/lib/accounting/locations";
import { receiptSelfConfirmAllowed } from "./receipt-four-eyes";

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
  /**
   * What the customer still owes: the document less the approved collections. A pending
   * submission is somebody's claim, not a payment, so it does not reduce the debt.
   */
  unpaidGross: PrismaNS.Decimal;
  /**
   * How much MORE may be submitted right now: the unpaid balance less what is already
   * reserved by pending submissions. This is the submission ceiling, not a balance — the
   * two differ by exactly `pendingGross` and coincide only when nothing is pending.
   */
  availableToSubmitGross: PrismaNS.Decimal;
  /**
   * @deprecated The old name for `availableToSubmitGross`, kept so existing callers keep
   * working. It was labelled "outstanding" in the UI, which read as the unpaid balance and
   * was not: it is submission capacity. Use one of the two explicit fields above.
   */
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
  // Two different questions, and conflating them is how a reviewer reads submission
  // capacity as a debt. The debt ignores pending claims; the capacity does not.
  const unpaid = roundMoney(ceiling.minus(approvedGross));
  const available = roundMoney(unpaid.minus(pendingGross));
  const floor0 = (d: PrismaNS.Decimal) => (d.lessThan(0) ? ZERO : d);

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
    unpaidGross: floor0(unpaid),
    availableToSubmitGross: floor0(available),
    // Unchanged in value: the submission ceiling and its concurrency check still read the
    // same number they always did.
    remainingGross: floor0(available),
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
  /** «الموقع» (WP-B): absent = the branch the order's issued invoices share, else the order's, else the recorder's. */
  branchId?: unknown;
  /** «نسخ وتصحيح» (BATCH22 WP-D): the returned collection this one corrects. */
  replacesCollectionId?: string | null;
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
  // The ceiling itself is unchanged; only its wording, which used to call submission
  // capacity "outstanding" and so reported a number that was not the unpaid balance.
  if (input.amountGross.greaterThan(summary.availableToSubmitGross)) {
    throw {
      _appCode: 409,
      message:
        `Only ${summary.availableToSubmitGross.toFixed(2)} ${summary.document.currency} may still be ` +
        `submitted on this deal (unpaid balance ${summary.unpaidGross.toFixed(2)}, less what is already ` +
        "awaiting verification). Overpayment is not recorded here.",
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

  const given = await parseBranchId(tx, input.branchId);
  const branchId = given !== undefined ? given : await defaultCollectionBranch(tx, { orderId: order?.orderId ?? null, recorderId: input.submittedById });

  const created = await tx.salesCollection.create({
    data: {
      branchId,
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
      replacesCollectionId: input.replacesCollectionId ?? null,
    },
    select: { id: true },
  });

  await emitCollectionStatus(tx, created.id, null, "PENDING_VERIFICATION", input.submittedById);
  return { collectionId: created.id, replayed: false, amountTax: tax, amountNet: net };
}

export type DecisionResult = {
  status: CollectionStatusValue;
  replayed: boolean;
  collectionEventId: string | null;
  /** Commission actually posted by this decision, per employee. Empty on a replay. */
  commission: { employeeId: string; amount: string }[];
  /** «سند قبض»: the voucher number the confirmation took (null before / without one). */
  receiptNumber?: string | null;
  /** How the confirmation applied the money and whether it posted (null when nothing to apply / before go-live). */
  application?: { applied: string; posting: string; parts: { invoiceId: string; amount: string }[] } | null;
};

/** What the accountant edits at confirmation (BATCH22 WP-D), before the number is taken. Never the amount, the date,
 *  the method, the deal or the payer: those are the commission basis and the rep's claim. */
export type ConfirmFields = {
  depositAccountId?: string | null;
  memo?: string | null;
  allocation?: ReceiptAllocation;
  /** «الموقع» (WP-B): absent = keep the recorded one (or its default); null = «غير محدد». */
  branchId?: string | null;
};

const bi = (code: string, status: number, ar: string, en: string) => ({ _appCode: status, code, message: ar, errorEn: en });

/**
 * The deposit account of a confirmation: a postable, active, leaf cash or bank account, or the card-clearing account
 * (the CLEARING account mapped to the CARD_CLEARING role — not any clearing account; council ruling). The database
 * re-checks the coarse rule (sales_collection_receipt_guard).
 */
export async function assertDepositAccount(tx: Tx, accountId: string) {
  const a = await tx.account.findUnique({ where: { id: accountId }, select: { id: true, controlType: true, allowPosting: true, isActive: true, _count: { select: { children: true } }, roles: { select: { role: true } } } });
  const ok = !!a && a.isActive && a.allowPosting && a._count.children === 0
    && (a.controlType === "CASH" || a.controlType === "BANK" || (a.controlType === "CLEARING" && a.roles.some((r) => r.role === "CARD_CLEARING")));
  if (!ok) throw bi("DEPOSIT_ACCOUNT", 400, "حساب الإيداع يجب أن يكون حساب صندوق أو بنك أو تسوية بطاقات قابلًا للترحيل.", "The deposit account must be a postable cash, bank or card-clearing account.");
}

/**
 * Does the customer have an OPEN deal — one Sales can still collect against? An open deal (outcome OPEN), or a won deal
 * whose accepted quotation is not fully claimed yet. While one exists the money is Sales' to record (commission), so the
 * accountant's receipt for an invoice with no deal is refused (owner, 2026-10-29).
 */
export async function customerOpenDeal(tx: Pick<Tx, "$queryRaw">, customerId: string): Promise<{ id: string; title: string } | null> {
  const rows = await tx.$queryRaw<{ id: string; title: string }[]>`
    SELECT o."id", o."title" FROM "Opportunity" o
     WHERE o."customerId" = ${customerId}
       AND (o."outcome"::text = 'OPEN'
            OR (o."outcome"::text = 'WON' AND EXISTS (
                  SELECT 1 FROM (SELECT q."grandTotal" FROM "Quote" q WHERE q."opportunityId" = o."id" AND q."status" = 'ACCEPTED' ORDER BY q."revision" DESC LIMIT 1) q
                   WHERE q."grandTotal" - coalesce((SELECT sum(c."amountGross") FROM "SalesCollection" c WHERE c."opportunityId" = o."id" AND c."status" IN ('APPROVED', 'PENDING_VERIFICATION')), 0) > 0)))
     ORDER BY o."updatedAt" DESC LIMIT 1`;
  return rows[0] ?? null;
}

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
      opportunityId: string | null;
      customerId: string | null;
      orderId: string | null;
      amountGross: string;
      amountTax: string;
      currency: string;
      collectedAt: Date;
      collectionEventId: string | null;
      branchId: string | null;
      source: string;
      invoiceId: string | null;
      receiptNumber: string | null;
    }[]
  >`
    SELECT "id", "status"::text AS status, "submittedById", "opportunityId", "customerId",
           "orderId", "amountGross"::text, "amountTax"::text, "currency", "collectedAt",
           "collectionEventId", "branchId", "source", "invoiceId", "receiptNumber"
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
  input: { collectionId: string; actorId: string; confirm?: ConfirmFields },
): Promise<DecisionResult> {
  const row = await lockCollection(tx, input.collectionId);

  if (row.status === "APPROVED") {
    // A replayed approval. Behind the lock, so the first one has finished: report what it
    // did rather than doing it again.
    return { status: "APPROVED", replayed: true, collectionEventId: row.collectionEventId, commission: [], receiptNumber: row.receiptNumber };
  }
  if (row.status !== "PENDING_VERIFICATION") {
    throw {
      _appCode: 409,
      message: `This collection is ${row.status.toLowerCase().replace(/_/g, " ")} and can no longer be approved.`,
    };
  }
  const accountant = row.source === "ACCOUNTANT";
  const self = row.submittedById === input.actorId;
  // A Sales collection: never its own submitter, no exception. An accountant's receipt (no commission): a second person
  // whenever another eligible confirmer exists — the owner rule, receipt-four-eyes.ts (receiptSelfConfirmAllowed);
  // otherwise the recorder confirms it, flagged (sodBypass) and listed.
  if (self && (!accountant || !(await receiptSelfConfirmAllowed(tx, input.actorId)))) {
    throw accountant
      ? bi("SOD_SELF_CONFIRM", 403, "من سجّل سند القبض لا يؤكده؛ يؤكده شخص آخر.", "The person who recorded a receipt cannot confirm it. Ask another accountant.")
      : {
          _appCode: 403,
          message:
            "The person who recorded a collection cannot be the one who verifies it. " +
            "Ask another member of Finance.",
        };
  }
  if (accountant && row.customerId) {
    const open = await customerOpenDeal(tx, row.customerId);
    if (open) throw bi("CUSTOMER_HAS_OPEN_DEAL", 409, `للعميل صفقة مفتوحة («${open.title}»)؛ يُسجّل التحصيل من المبيعات على الصفقة.`, `The customer has an open deal ("${open.title}"); Sales records the collection on the deal.`);
  }
  const c = input.confirm ?? {};
  if (c.depositAccountId) await assertDepositAccount(tx, c.depositAccountId);
  const confirmBranch = await parseBranchId(tx, c.branchId);
  const memo = c.memo?.trim() ? c.memo.trim().slice(0, 500) : null;

  // One row into the commission engine's input table, stamped so it can never be confused
  // with a sandbox event. The unique key on (sourceSystem, externalRef) is the last line of
  // defence against a duplicate approval creating a second accrual. An accountant's receipt has no deal: no event.
  const event = accountant ? null : await tx.collectionEvent.create({
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

  // The database numbers the voucher here (sales_collection_receipt_guard: «RCT-YYYY-NNNNNN», gapless).
  const updated = await tx.salesCollection.update({
    where: { id: row.id },
    data: {
      status: "APPROVED",
      collectionEventId: event?.id ?? null,
      decidedById: input.actorId,
      decidedAt: new Date(),
      decisionReason: null,
      // «الموقع»: the accountant may set it at confirm (WP-D); a receipt recorded before the dimension existed takes its
      // default here, in the same write that decides it (frozen from now on — location_branch_frozen).
      ...(confirmBranch !== undefined ? { branchId: confirmBranch } : row.branchId ? {} : { branchId: await defaultCollectionBranch(tx, { orderId: row.orderId, recorderId: row.submittedById }) }),
      ...(c.depositAccountId ? { depositAccountId: c.depositAccountId } : {}),
      ...(memo ? { receiptMemo: memo } : {}),
      ...(accountant && self ? { sodBypass: true } : {}),
    },
    select: { receiptNumber: true },
  });

  const outcomes = event ? await accrueForCollection(tx, event.id, input.actorId) : [];
  // A2: apply the receipt to its open invoices and post it (a no-op before accounting's go-live).
  const application = await onCollectionApproved(tx, row.id, input.actorId, c.allocation !== undefined ? { allocation: c.allocation } : accountant ? { allocation: "AUTO" } : {});
  await emitCollectionStatus(tx, row.id, "PENDING_VERIFICATION", "APPROVED", input.actorId);

  return {
    status: "APPROVED",
    replayed: false,
    collectionEventId: event?.id ?? null,
    commission: outcomes.map((o) => ({ employeeId: o.employeeId, amount: o.delta.toFixed(2) })),
    receiptNumber: updated.receiptNumber,
    application,
  };
}

/** Finance does not agree. Nothing financial happens, and the reason is required. */
export async function rejectCollection(
  tx: Tx,
  input: { collectionId: string; actorId: string; reason: string; reasonCode?: "RETURN_FOR_CORRECTION" | null },
): Promise<DecisionResult> {
  const reason = input.reason?.trim() ?? "";
  if (input.reasonCode === "RETURN_FOR_CORRECTION" && reason.length < 10) {
    throw bi("REASON_REQUIRED", 400, "إعادة السند للتصحيح تحتاج سببًا واضحًا (10 أحرف على الأقل).", "Returning a receipt for correction needs a reason (at least 10 characters).");
  }
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
  if (row.submittedById === input.actorId && !(row.source === "ACCOUNTANT" && (await receiptSelfConfirmAllowed(tx, input.actorId)))) {
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
      decisionReasonCode: input.reasonCode ?? null,
    },
  });

  await emitCollectionStatus(tx, input.collectionId, row.status, "REJECTED", input.actorId);
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
  const accountant = row.source === "ACCOUNTANT";
  // Separation of duties, the same rule as approve and reject: whoever recorded the collection
  // does not undo it — a reversal moves their own commission. The screen hid the button
  // (collectionDecisionAbility → SELF_SUBMITTED) while this service accepted the request, so a
  // submitter holding `collection_reverse` could reverse their own receipt by calling the API.
  // An accountant's receipt keeps the sole-confirmer exception (receipt-four-eyes.ts).
  if (row.submittedById === input.actorId && !(accountant && (await receiptSelfConfirmAllowed(tx, input.actorId)))) {
    throw accountant
      ? bi("SOD_SELF_REVERSE", 403, "من سجّل سند القبض لا يعكسه؛ يعكسه شخص آخر.", "The person who recorded a receipt cannot reverse it. Ask another accountant.")
      : bi("SOD_SELF_REVERSE", 403, "من سجّل التحصيل لا يعكسه؛ يعكسه شخص آخر من المالية.", "The person who recorded a collection cannot be the one who reverses it. Ask another member of Finance.");
  }
  if (!row.collectionEventId && !accountant) {
    // The check constraint makes this unreachable; the guard is here so that if it ever
    // becomes reachable it fails loudly instead of silently skipping the correction.
    throw { _appCode: 500, message: "This approved collection has no commission event to reverse." };
  }

  const now = new Date();
  if (row.collectionEventId) {
    await tx.collectionEvent.update({
      where: { id: row.collectionEventId },
      data: { status: "REVERSED", reversedAt: now },
    });
  }

  // The sole-confirmer exception on the way back (council gate S6a) is listed as RECEIPT_SELF_REVERSED by
  // accounting/sod.ts from the row itself (reversedById = submittedById). The sodBypass flag is NOT written
  // here: it records the CONFIRMATION, and the batch-22 trigger freezes it once decided (release gate N3) —
  // writing it on a receipt another accountant confirmed would make the reversal fail.
  await tx.salesCollection.update({
    where: { id: row.id },
    data: {
      status: "REVERSED",
      reversedById: input.actorId,
      reversedAt: now,
      reversalReason: reason,
    },
  });

  const outcomes = row.collectionEventId ? await accrueForCollection(tx, row.collectionEventId, input.actorId) : [];
  // A2: the receipt's AR applications and every ledger posting of it are reversed with it.
  await onCollectionReversed(tx, row.id, reason, input.actorId);
  await emitCollectionStatus(tx, row.id, "APPROVED", "REVERSED", input.actorId);

  return {
    status: "REVERSED",
    replayed: false,
    collectionEventId: row.collectionEventId,
    commission: outcomes.map((o) => ({ employeeId: o.employeeId, amount: o.delta.toFixed(2) })),
    // A reversal keeps the voucher number (shown «معكوس»).
    receiptNumber: row.receiptNumber,
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

/**
 * ── Whether this person may decide THIS collection, and if not why ──
 *
 * The queue used to render each action behind a bare privilege flag, so an unavailable
 * action was an empty cell: a manager correctly without approval rights and a Finance user
 * whose privileges had not been granted looked identical, and so did a Finance user being
 * correctly refused their own submission. Three different situations, one blank space.
 *
 * Self-approval is decided here as well as in `approveCollection`, and the duplication is
 * deliberate: the service is the boundary and refuses regardless, while this exists so the
 * screen can say "you recorded this one" instead of offering a button that will 403.
 */
export type DecisionAbilityReason =
  | "OK"
  | "NO_PRIVILEGE"
  | "SELF_SUBMITTED"
  | "NOT_PENDING"
  | "NOT_APPROVED";

export type DecisionAbility = { allowed: boolean; reason: DecisionAbilityReason };

export function collectionDecisionAbility(input: {
  status: CollectionStatusValue;
  submittedById: string;
  actorId: string;
  canVerify: boolean;
  canReject: boolean;
  canReverse: boolean;
}): { approve: DecisionAbility; reject: DecisionAbility; reverse: DecisionAbility } {
  const self = input.submittedById === input.actorId;
  const pending = input.status === "PENDING_VERIFICATION";

  // Privilege first, then separation of duties, then the row's own state. A person told
  // "you recorded this one" when they also lack the privilege would fix the wrong thing.
  const decide = (can: boolean, stateOk: boolean, notReady: DecisionAbilityReason): DecisionAbility => {
    if (!can) return { allowed: false, reason: "NO_PRIVILEGE" };
    if (self) return { allowed: false, reason: "SELF_SUBMITTED" };
    if (!stateOk) return { allowed: false, reason: notReady };
    return { allowed: true, reason: "OK" };
  };

  return {
    approve: decide(input.canVerify, pending, "NOT_PENDING"),
    reject: decide(input.canReject, pending, "NOT_PENDING"),
    // A reversal undoes an approval, so it applies to an APPROVED row and to nothing else.
    reverse: decide(input.canReverse, input.status === "APPROVED", "NOT_APPROVED"),
  };
}


/** «إشعارات الحالات»: a collection entered a status (src/lib/automation, same transaction). */
async function emitCollectionStatus(tx: Tx, collectionId: string, from: string | null, to: string, actorId: string) {
  await emitAutomationEvent(tx, {
    eventType: "sales.collection_status_changed",
    subjectType: "SalesCollection",
    subjectId: collectionId,
    payload: { from, to },
    actorId,
  });
}
