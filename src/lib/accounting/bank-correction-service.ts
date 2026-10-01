// Correction of bank lines that have posted to the ledger: reversal and replacement, four-eyes.
//
//   request (bank_correction_request)  → PENDING, with the replacement data validated up front
//   approve (bank_correction_approve)  → in ONE transaction: APPROVED; the original (and a
//        transfer's other leg) is voided exactly as Finance voids a line — budget allocations and
//        payments reversed, matches released, obligations recomputed; for REPLACE a new line with
//        the corrected data is created (replacesTransactionId → original), reviewed and matched;
//        APPLIED. After commit the void event (mirror journal) and the new line's event post.
//   reject                              → REJECTED with a reason.
// The database enforces the rest (acc_guard_posted_bank_*, acc_guard_bank_correction): posted
// lines cannot be edited, a posted line is voided only under an APPROVED correction, the approver
// differs from the requester, and corrections are append-only.
import { Prisma, type BankTxnClass } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { ALL_CLASSES, classDirection, type TxnClass } from "@/lib/finance/classes";
import { reversePaymentsForTxn, reverseReceiptAllocations } from "@/lib/finance/server/allocation";
import { recomputeObligationStatus } from "@/lib/finance/server/obligations";
import { AccountingError } from "./errors";
import { auditAccounting } from "./audit";
import { accountingDate, todayAccountingDate } from "./dates";
import { dec, ZERO } from "./money";
import { processEvent, type ProcessOutcome } from "./event-processor";
import { postedBankLines } from "./bank-posted";
import { releaseCustomerReceipt } from "./receivables-service";

type Tx = Prisma.TransactionClient;
type Replacement = {
  txnDate: string; amount: string; classification: BankTxnClass; description: string | null; cashAccountId: string;
  splits: { finCategoryId: string; amount: string; costCenterId: string | null }[];
  matches: { targetType: "OBLIGATION"; targetId: string; amount: string }[];
};

const money = (v: unknown, field: string) => {
  if (typeof v !== "string" && typeof v !== "number") throw new AccountingError(`${field} is required.`, 400);
  const s = String(v).trim();
  if (!/^-?\d{1,13}(\.\d{1,2})?$/.test(s)) throw new AccountingError(`${field} must be an amount with at most 2 decimals.`, 400);
  return new Prisma.Decimal(s);
};

async function periodOpenOn(tx: Tx | typeof prisma, date: Date, what: string) {
  const p = await tx.fiscalPeriod.findFirst({ where: { startDate: { lte: date }, endDate: { gte: date } } });
  if (!p) throw new AccountingError(`No fiscal period covers ${date.toISOString().slice(0, 10)} (${what}).`, 409);
  if (p.status !== "OPEN") throw new AccountingError(`The period for ${date.toISOString().slice(0, 10)} is ${p.status.toLowerCase()} (${what}). Reopen it or choose an open date.`, 409);
}

async function validateReplacement(tx: Tx | typeof prisma, original: { cashAccountId: string; classification: string; transferPeerId: string | null }, raw: unknown): Promise<Replacement> {
  if (!raw || typeof raw !== "object") throw new AccountingError("A replacement needs the corrected line.", 400);
  const r = raw as Record<string, unknown>;
  if (original.classification === "INTERNAL_TRANSFER" || original.transferPeerId) {
    throw new AccountingError("A transfer is corrected by voiding both legs; record the correct transfer in Finance afterwards.", 400);
  }
  if (typeof r.txnDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(r.txnDate)) throw new AccountingError("Date is required (YYYY-MM-DD).", 400);
  const date = accountingDate(r.txnDate);
  await periodOpenOn(tx, date, "replacement date");
  const amount = money(r.amount, "Amount");
  if (amount.isZero()) throw new AccountingError("The amount cannot be zero.", 400);
  const classification = String(r.classification ?? original.classification) as TxnClass;
  if (!(ALL_CLASSES as readonly string[]).includes(classification) || classification === "UNCLASSIFIED" || classification === "INTERNAL_TRANSFER") {
    throw new AccountingError("Choose a classification (not a transfer).", 400);
  }
  const dir = classDirection(classification);
  if ((dir === "IN" && amount.isNegative()) || (dir === "OUT" && amount.isPositive())) throw new AccountingError("The amount's sign does not fit the classification.", 400);
  const cashAccountId = typeof r.cashAccountId === "string" && r.cashAccountId ? r.cashAccountId : original.cashAccountId;
  const acct = await tx.cashAccount.findUnique({ where: { id: cashAccountId } });
  if (!acct) throw new AccountingError("Cash account not found.", 404);
  if (!acct.glAccountId) throw new AccountingError(`Cash account ${acct.code} is not mapped to a ledger account.`, 409);

  const splitsIn = Array.isArray(r.splits) ? r.splits as Record<string, unknown>[] : [];
  if (splitsIn.length === 0 || splitsIn.length > 50) throw new AccountingError("Give 1–50 budget splits.", 400);
  const splits = splitsIn.map((s, i) => ({ finCategoryId: String(s.finCategoryId ?? ""), amount: money(s.amount, `Split ${i + 1} amount`), costCenterId: typeof s.costCenterId === "string" && s.costCenterId ? s.costCenterId : null }));
  const splitSum = splits.reduce((s, x) => s.add(x.amount), ZERO);
  if (!splitSum.equals(amount)) throw new AccountingError(`Splits (${splitSum.toFixed(2)}) must add up to the amount (${amount.toFixed(2)}).`, 400);
  const cats = await tx.finCategory.findMany({ where: { id: { in: splits.map((s) => s.finCategoryId) } } });
  if (cats.length !== new Set(splits.map((s) => s.finCategoryId)).size || cats.some((c) => !c.active)) throw new AccountingError("A split names an unknown or inactive budget category.", 400);

  const matchesIn = Array.isArray(r.matches) ? r.matches as Record<string, unknown>[] : [];
  const matches = matchesIn.map((m, i) => {
    if (m.targetType !== "OBLIGATION") throw new AccountingError(`Match ${i + 1}: only obligations (supplier bills) can be matched in a correction.`, 400);
    const a = money(m.amount, `Match ${i + 1} amount`);
    if (!a.isPositive()) throw new AccountingError(`Match ${i + 1}: the amount must be positive.`, 400);
    return { targetType: "OBLIGATION" as const, targetId: String(m.targetId ?? ""), amount: a };
  });
  if (matches.length && amount.isPositive()) throw new AccountingError("Obligations are matched to money paid out.", 400);
  const matched = matches.reduce((s, m) => s.add(m.amount), ZERO);
  if (matched.gt(amount.abs())) throw new AccountingError("Matches exceed the line amount.", 400);
  const obs = await tx.finObligation.findMany({ where: { id: { in: matches.map((m) => m.targetId) } } });
  for (const m of matches) {
    const o = obs.find((x) => x.id === m.targetId);
    if (!o) throw new AccountingError("A matched obligation was not found.", 404);
    if (o.status === "SUPERSEDED" || o.status === "CANCELLED") throw new AccountingError("A matched obligation is no longer live.", 409);
  }
  const description = typeof r.description === "string" ? r.description.trim().slice(0, 500) || null : null;
  return {
    txnDate: r.txnDate, amount: amount.toFixed(2), classification: classification as BankTxnClass, description, cashAccountId,
    splits: splits.map((s) => ({ ...s, amount: s.amount.toFixed(2) })), matches: matches.map((m) => ({ ...m, amount: m.amount.toFixed(2) })),
  };
}

export async function requestBankCorrection(transactionId: string, input: { kind?: unknown; reason?: unknown; replacement?: unknown }, userId: string) {
  const kind = input.kind === "REPLACE" ? "REPLACE" : input.kind === "VOID" ? "VOID" : null;
  if (!kind) throw new AccountingError("Choose VOID or REPLACE.", 400);
  const reason = typeof input.reason === "string" ? input.reason.trim() : "";
  if (reason.length < 5) throw new AccountingError("Give a reason (at least 5 characters).", 400);
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT 1 FROM "BankTransaction" WHERE "id" = ${transactionId} FOR UPDATE`;
    const t = await tx.bankTransaction.findUnique({ where: { id: transactionId } });
    if (!t) throw new AccountingError("Bank line not found.", 404);
    if (t.status === "VOID") throw new AccountingError("The line is already void.", 409);
    if (!(await postedBankLines(tx, [t.id])).size) throw new AccountingError("This line has not posted to the ledger; correct it in Finance → bank.", 409);
    const open = await tx.bankCorrection.findFirst({ where: { transactionId: { in: [t.id, ...(t.transferPeerId ? [t.transferPeerId] : [])] }, status: { in: ["PENDING", "APPROVED"] } } });
    if (open) throw new AccountingError(`Correction #${open.correctionNo} for this line is already waiting for a decision.`, 409);
    const replacement = kind === "REPLACE" ? await validateReplacement(tx, t, input.replacement) : null;
    const c = await tx.bankCorrection.create({ data: { transactionId: t.id, kind, reason, replacement: replacement ?? undefined, requestedBy: userId } });
    await auditAccounting(tx, { action: "bank.correction.requested", entityType: "BankCorrection", entityId: c.id, userId, after: c, refs: { transactionId: t.id } });
    return c;
  });
}

export async function rejectBankCorrection(id: string, userId: string, reason: unknown) {
  const r = typeof reason === "string" ? reason.trim() : "";
  if (r.length < 5) throw new AccountingError("Give a reason for the rejection (at least 5 characters).", 400);
  return prisma.$transaction(async (tx) => {
    const res = await tx.bankCorrection.updateMany({ where: { id, status: "PENDING" }, data: { status: "REJECTED", rejectedBy: userId, rejectedAt: new Date(), rejectReason: r } });
    if (res.count === 0) throw new AccountingError("This correction is no longer pending.", 409);
    const after = await tx.bankCorrection.findUniqueOrThrow({ where: { id } });
    await auditAccounting(tx, { action: "bank.correction.rejected", entityType: "BankCorrection", entityId: id, userId, after, reason: r });
    return after;
  });
}

/** Void a line exactly as Finance does, in the order the posted-line guard requires (VOID first, then matches). */
async function voidLine(tx: Tx, lineId: string, actorId: string, reason: string) {
  const line = await tx.bankTransaction.findUniqueOrThrow({ where: { id: lineId } });
  if (line.reconciliationId) throw new AccountingError("The line is part of a completed bank reconciliation in Finance; reopen that reconciliation first.", 409);
  const reversal = dec(line.amount).isPositive() ? await reverseReceiptAllocations(tx, actorId, lineId, reason) : await reversePaymentsForTxn(tx, actorId, lineId, reason);
  await tx.bankTransaction.update({ where: { id: lineId }, data: { status: "VOID", voidedAt: new Date(), voidedBy: actorId, voidReason: reason } });
  const matches = await tx.bankTransactionMatch.findMany({ where: { transactionId: lineId, active: true } });
  await tx.bankTransactionMatch.updateMany({ where: { transactionId: lineId, active: true }, data: { active: false, removedAt: new Date(), removedBy: actorId } });
  for (const m of matches.filter((x) => x.targetType === "OBLIGATION")) await recomputeObligationStatus(tx, m.targetId);
  await releaseCustomerReceipt(tx, lineId);
  await auditAccounting(tx, { action: "bank.line.voided_by_correction", entityType: "BankTransaction", entityId: lineId, userId: actorId, before: { status: line.status }, after: { status: "VOID" }, reason, refs: { reversal } });
}

export async function approveBankCorrection(id: string, userId: string) {
  const c0 = await prisma.bankCorrection.findUnique({ where: { id } });
  if (!c0) throw new AccountingError("Correction not found.", 404);
  if (c0.requestedBy === userId) throw new AccountingError("A correction is approved by someone other than the person who requested it.", 403);
  const applied = await prisma.$transaction(async (tx) => {
    // Claim the decision: of two concurrent approvals only one moves PENDING → APPROVED.
    const claim = await tx.bankCorrection.updateMany({ where: { id, status: "PENDING" }, data: { status: "APPROVED", approvedBy: userId, approvedAt: new Date() } });
    if (claim.count === 0) throw new AccountingError("This correction is no longer pending (it was decided meanwhile).", 409);
    const c = await tx.bankCorrection.findUniqueOrThrow({ where: { id } });
    await tx.$queryRaw`SELECT 1 FROM "BankTransaction" WHERE "id" = ${c.transactionId} OR "transferPeerId" = ${c.transactionId} ORDER BY "id" FOR UPDATE`;
    const t = await tx.bankTransaction.findUniqueOrThrow({ where: { id: c.transactionId } });
    if (t.status === "VOID") throw new AccountingError("The line was voided meanwhile.", 409);
    await periodOpenOn(tx, todayAccountingDate(), "the reversal is dated today");
    // Re-validate against the current state (obligations, periods, mappings may have changed).
    const rep = c.kind === "REPLACE" ? await validateReplacement(tx, t, c.replacement) : null;
    const reason = `Correction #${c.correctionNo}: ${c.reason}`;
    for (const lineId of [t.id, ...(t.transferPeerId ? [t.transferPeerId] : [])]) await voidLine(tx, lineId, userId, reason);

    let replacementId: string | null = null;
    if (rep) {
      const n = await tx.bankTransaction.create({
        data: {
          cashAccountId: rep.cashAccountId, branchKey: t.branchKey, txnDate: accountingDate(rep.txnDate), amount: dec(rep.amount), currency: t.currency,
          bankReference: t.bankReference, description: rep.description ?? t.description, counterparty: t.counterparty,
          status: "CONFIRMED", source: t.source, classification: rep.classification, reviewStatus: "NEEDS_REVIEW",
          replacesTransactionId: t.id, createdBy: userId,
          splits: { create: rep.splits.map((s) => ({ finCategoryId: s.finCategoryId, amount: dec(s.amount), costCenterId: s.costCenterId, note: reason.slice(0, 300) })) },
        },
      });
      for (const m of rep.matches) {
        await tx.bankTransactionMatch.create({ data: { transactionId: n.id, targetType: "OBLIGATION", targetId: m.targetId, amount: dec(m.amount), createdBy: userId } });
        await recomputeObligationStatus(tx, m.targetId);
      }
      // Reviewed last: this emits the line's posting event (after its splits and matches exist).
      await tx.bankTransaction.update({ where: { id: n.id }, data: { reviewStatus: "REVIEWED", reviewedBy: userId, reviewedAt: new Date(), reviewNote: reason.slice(0, 500) } });
      replacementId = n.id;
    }
    const done = await tx.bankCorrection.update({ where: { id }, data: { status: "APPLIED", appliedAt: new Date(), replacementTransactionId: replacementId } });
    await auditAccounting(tx, { action: "bank.correction.applied", entityType: "BankCorrection", entityId: id, userId, before: c, after: done, refs: { replacementId } });
    return { correction: done, voided: [t.id, ...(t.transferPeerId ? [t.transferPeerId] : [])], replacementId };
  });
  // Post the reversal and the replacement now (the processor would also pick them up later).
  const keys = [...applied.voided.map((v) => `bank:${v}:voided`), ...(applied.replacementId ? [`bank:${applied.replacementId}:confirmed`] : [])];
  const ledger: ProcessOutcome[] = [];
  for (const key of keys) {
    const ev = await prisma.accountingEvent.findUnique({ where: { idempotencyKey: key } });
    if (ev) ledger.push(await processEvent(ev.id));
  }
  return { ...applied, ledger };
}

export async function listBankCorrections(opts: { status?: string } = {}) {
  const where = opts.status && ["PENDING", "APPROVED", "REJECTED", "APPLIED"].includes(opts.status) ? { status: opts.status as "PENDING" } : {};
  const rows = await prisma.bankCorrection.findMany({ where, orderBy: { correctionNo: "desc" }, take: 200, include: { transaction: { include: { cashAccount: { select: { code: true, nameEn: true, nameAr: true } } } } } });
  const users = await prisma.employee.findMany({ where: { id: { in: [...new Set(rows.flatMap((r) => [r.requestedBy, r.approvedBy, r.rejectedBy].filter(Boolean) as string[]))] } }, select: { id: true, name: true } });
  const name = new Map(users.map((u) => [u.id, u.name]));
  return rows.map((r) => ({
    ...r, requestedByName: name.get(r.requestedBy) ?? null, approvedByName: r.approvedBy ? name.get(r.approvedBy) ?? null : null, rejectedByName: r.rejectedBy ? name.get(r.rejectedBy) ?? null : null,
    transaction: { id: r.transaction.id, txnDate: r.transaction.txnDate, amount: r.transaction.amount.toFixed(2), status: r.transaction.status, classification: r.transaction.classification, bankReference: r.transaction.bankReference, description: r.transaction.description, cashAccount: r.transaction.cashAccount },
  }));
}

/** Posted, non-void bank lines (newest first) for the correction screen, plus open supplier-bill obligations. */
export async function postedLinesForCorrection(q: string | null) {
  const evs = await prisma.accountingEvent.findMany({ where: { eventType: "bank.transaction.confirmed", status: "TRANSLATED" }, select: { sourceDocumentId: true }, orderBy: { createdAt: "desc" }, take: 2000 });
  const text = q?.trim();
  const lines = await prisma.bankTransaction.findMany({
    where: {
      id: { in: evs.map((e) => e.sourceDocumentId!).filter(Boolean) }, status: { not: "VOID" },
      ...(text ? { OR: [{ bankReference: { contains: text, mode: "insensitive" } }, { description: { contains: text, mode: "insensitive" } }, { counterparty: { contains: text, mode: "insensitive" } }] } : {}),
    },
    orderBy: [{ txnDate: "desc" }, { createdAt: "desc" }], take: 100,
    include: { cashAccount: { select: { code: true, nameAr: true, nameEn: true } }, splits: true, matches: { where: { active: true } }, corrections: { where: { status: { in: ["PENDING", "APPROVED"] } }, select: { id: true, correctionNo: true } } },
  });
  const openObs = await prisma.finObligation.findMany({ where: { sourceType: "SUPPLIER_BILL", status: { in: ["OPEN", "PARTIALLY_PAID"] } }, select: { id: true } });
  const bills = await prisma.supplierBill.findMany({ where: { status: "POSTED", obligationId: { in: openObs.map((o) => o.id) } }, select: { billNo: true, supplierInvoiceNo: true, totalGross: true, obligationId: true, supplierId: true }, orderBy: { billNo: "desc" }, take: 200 });
  const sup = new Map((await prisma.supplier.findMany({ where: { id: { in: bills.map((b) => b.supplierId) } }, select: { id: true, name: true } })).map((x) => [x.id, x.name]));
  return {
    lines: lines.map((t) => ({
      id: t.id, txnDate: t.txnDate, amount: t.amount.toFixed(2), classification: t.classification, bankReference: t.bankReference, description: t.description,
      cashAccount: t.cashAccount, transfer: !!t.transferPeerId, pendingCorrection: t.corrections[0]?.correctionNo ?? null,
      splits: t.splits.map((s) => ({ finCategoryId: s.finCategoryId, amount: s.amount.toFixed(2), costCenterId: s.costCenterId })),
      matches: t.matches.filter((m) => m.targetType === "OBLIGATION").map((m) => ({ targetType: "OBLIGATION", targetId: m.targetId, amount: m.amount.toFixed(2) })),
    })),
    obligations: bills.map((b) => ({ id: b.obligationId!, label: `ف-${b.billNo} · ${sup.get(b.supplierId) ?? ""} · ${b.supplierInvoiceNo}`, gross: b.totalGross.toFixed(2) })),
  };
}
