// Manual journals: draft → submitted → approved (by someone else) → posted; rejection sends an
// entry back to draft with a reason; correction of a posted entry is a reversal that goes
// through the same approval. Every transition is a conditional update (status in the WHERE
// clause), so two people pressing "approve" at once produce one approval and one 409.
// The database guard (ledger-core migration) enforces the same rules for any other writer.
import type { Prisma, JournalEntryStatus, JournalEntryType } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { AccountingError, databaseGuardMessage } from "./errors";
import { assertAccountPostable, assertLineExclusive, assertPeriodOpen, assertSetupComplete, assertTaxCategoryActive } from "./validation";
import { buildTaxCategorySnapshot } from "./tax-snapshot";
import { auditAccounting } from "./audit";
import { ZERO, parseAmount } from "./money";
import { todayAccountingDate } from "./dates";

type Tx = Prisma.TransactionClient;

export type ManualJournalLineInput = {
  accountId: string;
  debit: number | string;
  credit: number | string;
  description?: string;
  taxCategoryId?: string;
  branchId?: string | null;
  costCenterId?: string | null;
};

export type ManualJournalType = Extract<JournalEntryType, "MANUAL" | "ADJUSTMENT" | "OPENING">;

export type CreateManualJournalEntryInput = {
  entryDate: Date;
  description?: string;
  type?: ManualJournalType;
  lines: ManualJournalLineInput[];
};

const TX = { timeout: 20000 } as const;

/** Runs a ledger write; database guard refusals become 409s with the guard's own sentence. */
export async function ledgerTx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  try {
    return await prisma.$transaction(fn, TX);
  } catch (err) {
    if (err instanceof AccountingError) throw err;
    const guard = databaseGuardMessage(err);
    if (guard) throw new AccountingError(guard, 409);
    if (err && typeof err === "object" && (err as { code?: string }).code === "P2002") {
      throw new AccountingError("A record with these details already exists (for a reversal: one is already pending or posted).", 409);
    }
    throw err;
  }
}

async function buildLines(tx: Tx, entryType: string, rawLines: ManualJournalLineInput[]) {
  if (!Array.isArray(rawLines) || rawLines.length < 2) throw new AccountingError("A journal entry needs at least two lines.", 400);
  if (rawLines.length > 500) throw new AccountingError("A journal entry may have at most 500 lines.", 400);
  const lines = rawLines.map((l, i) => {
    const debit = parseAmount(l.debit === "" || l.debit === undefined || l.debit === null ? "0" : l.debit, `Line ${i + 1} debit`);
    const credit = parseAmount(l.credit === "" || l.credit === undefined || l.credit === null ? "0" : l.credit, `Line ${i + 1} credit`);
    const line = { ...l, debit, credit };
    try { assertLineExclusive(line); } catch (e) { throw new AccountingError(`Line ${i + 1}: ${(e as Error).message}`, 400); }
    return line;
  });
  const totalDebit = lines.reduce((s, l) => s.add(l.debit), ZERO);
  const totalCredit = lines.reduce((s, l) => s.add(l.credit), ZERO);
  if (!totalDebit.equals(totalCredit)) {
    throw new AccountingError(`Debits (${totalDebit.toFixed(2)}) must equal credits (${totalCredit.toFixed(2)}).`, 400, { totalDebit: totalDebit.toFixed(2), totalCredit: totalCredit.toFixed(2) });
  }

  const accountIds = [...new Set(lines.map((l) => l.accountId))];
  const accounts = await tx.account.findMany({ where: { id: { in: accountIds } }, include: { _count: { select: { children: true } } } });
  if (accounts.length !== accountIds.length) throw new AccountingError("One or more accounts were not found.", 400);
  const byId = new Map(accounts.map((a) => [a.id, a]));
  const taxIds = [...new Set(lines.map((l) => l.taxCategoryId).filter((x): x is string => !!x))];
  const taxes = taxIds.length ? await tx.taxCategory.findMany({ where: { id: { in: taxIds } } }) : [];
  const taxById = new Map(taxes.map((t) => [t.id, t]));
  const branchIds = [...new Set(lines.map((l) => l.branchId).filter((x): x is string => !!x))];
  const costIds = [...new Set(lines.map((l) => l.costCenterId).filter((x): x is string => !!x))];
  const [branches, costs] = await Promise.all([
    branchIds.length ? tx.finBranch.findMany({ where: { id: { in: branchIds }, active: true }, select: { id: true } }) : [],
    costIds.length ? tx.finCostCenter.findMany({ where: { id: { in: costIds }, active: true }, select: { id: true } }) : [],
  ]);
  if (branches.length !== branchIds.length) throw new AccountingError("A branch on a line is unknown or inactive.", 400);
  if (costs.length !== costIds.length) throw new AccountingError("A cost centre on a line is unknown or inactive.", 400);

  lines.forEach((l, i) => {
    const a = byId.get(l.accountId)!;
    try { assertAccountPostable(a, a._count.children); } catch (e) { throw new AccountingError(`Line ${i + 1} (${a.code}): ${(e as Error).message}`, 400); }
    if (entryType !== "REVERSAL" && a.controlKind !== "NONE" && !a.allowManualPosting) {
      throw new AccountingError(`Line ${i + 1}: ${a.code} is a control account; it is posted from its subledger, not by hand.`, 400);
    }
    if (l.taxCategoryId) {
      const t = taxById.get(l.taxCategoryId);
      if (!t) throw new AccountingError(`Line ${i + 1}: tax category not found.`, 400);
      assertTaxCategoryActive(t);
    }
  });

  return {
    totalDebit,
    totalCredit,
    create: lines.map((l, i) => ({
      lineNo: i + 1,
      accountId: l.accountId,
      debit: l.debit,
      credit: l.credit,
      description: l.description?.trim() || null,
      branchId: l.branchId || null,
      costCenterId: l.costCenterId || null,
      taxCategorySnapshot: l.taxCategoryId ? buildTaxCategorySnapshot(taxById.get(l.taxCategoryId)!) : undefined,
    })),
  };
}

async function openPeriodFor(tx: Tx, date: Date) {
  const period = await tx.fiscalPeriod.findFirst({ where: { startDate: { lte: date }, endDate: { gte: date } } });
  if (!period) throw new AccountingError(`No fiscal period covers ${date.toISOString().slice(0, 10)}.`, 400);
  assertPeriodOpen(period);
  return period;
}

export async function createManualJournalEntry(input: CreateManualJournalEntryInput, userId: string) {
  await assertSetupComplete();
  const type = input.type ?? "MANUAL";
  if (!["MANUAL", "ADJUSTMENT", "OPENING"].includes(type)) throw new AccountingError("Invalid journal type.", 400);
  return ledgerTx(async (tx) => {
    const period = await openPeriodFor(tx, input.entryDate);
    const built = await buildLines(tx, type, input.lines);
    const entry = await tx.journalEntry.create({
      data: {
        entryDate: input.entryDate, fiscalPeriodId: period.id, type, status: "DRAFT", sourceModule: "manual",
        description: input.description?.trim() || null, totalDebit: built.totalDebit, totalCredit: built.totalCredit,
        createdBy: userId, lines: { create: built.create },
      },
      include: { lines: true },
    });
    await auditAccounting(tx, { action: "journal.create", entityType: "journal", entityId: entry.id, userId, after: { entryNo: entry.entryNo, type, total: built.totalDebit.toFixed(2) } });
    return entry;
  });
}

export async function updateDraftJournalEntry(id: string, input: CreateManualJournalEntryInput, userId: string) {
  await assertSetupComplete();
  return ledgerTx(async (tx) => {
    const existing = await tx.journalEntry.findUnique({ where: { id } });
    if (!existing) throw new AccountingError("Journal entry not found.", 404);
    if (existing.status !== "DRAFT") throw new AccountingError(`Only a draft can be edited (this entry is ${existing.status}).`, 409);
    if (existing.type === "REVERSAL" || existing.type === "AUTO") throw new AccountingError("A reversal or automatic entry cannot be edited.", 409);
    const period = await openPeriodFor(tx, input.entryDate);
    const built = await buildLines(tx, existing.type, input.lines);
    await tx.journalEntryLine.deleteMany({ where: { journalEntryId: id } });
    const entry = await tx.journalEntry.update({
      where: { id },
      data: {
        entryDate: input.entryDate, fiscalPeriodId: period.id, description: input.description?.trim() || null,
        totalDebit: built.totalDebit, totalCredit: built.totalCredit, lines: { create: built.create },
      },
      include: { lines: true },
    });
    await auditAccounting(tx, { action: "journal.edit", entityType: "journal", entityId: id, userId, before: { total: existing.totalDebit.toFixed(2) }, after: { total: built.totalDebit.toFixed(2) } });
    return entry;
  });
}

export async function deleteDraftJournalEntry(id: string, userId: string) {
  return ledgerTx(async (tx) => {
    const existing = await tx.journalEntry.findUnique({ where: { id } });
    if (!existing) throw new AccountingError("Journal entry not found.", 404);
    if (existing.status !== "DRAFT") throw new AccountingError("Only a draft can be discarded.", 409);
    if (existing.type === "AUTO") throw new AccountingError("An automatic entry cannot be discarded.", 409);
    await tx.journalEntry.delete({ where: { id } });
    await auditAccounting(tx, { action: "journal.discard", entityType: "journal", entityId: id, userId, before: { entryNo: existing.entryNo, type: existing.type } });
    return { id, discarded: true };
  });
}

async function transition(tx: Tx, id: string, from: JournalEntryStatus[], to: JournalEntryStatus, data: Prisma.JournalEntryUpdateManyMutationInput) {
  const res = await tx.journalEntry.updateMany({ where: { id, status: { in: from } }, data: { ...data, status: to } });
  if (res.count === 0) {
    const e = await tx.journalEntry.findUnique({ where: { id }, select: { status: true } });
    if (!e) throw new AccountingError("Journal entry not found.", 404);
    throw new AccountingError(`The entry is ${e.status}; it cannot move to ${to}.`, 409);
  }
  return tx.journalEntry.findUniqueOrThrow({ where: { id }, include: { lines: true } });
}

export async function submitJournalEntry(id: string, userId: string) {
  return ledgerTx(async (tx) => {
    const entry = await transition(tx, id, ["DRAFT"], "SUBMITTED", { submittedAt: new Date(), submittedBy: userId });
    await auditAccounting(tx, { action: "journal.submit", entityType: "journal", entityId: id, userId });
    return entry;
  });
}

export async function approveJournalEntry(id: string, userId: string) {
  return ledgerTx(async (tx) => {
    const e = await tx.journalEntry.findUnique({ where: { id } });
    if (!e) throw new AccountingError("Journal entry not found.", 404);
    if (e.createdBy === userId || e.submittedBy === userId) {
      throw new AccountingError("You prepared or submitted this entry; someone else must approve it.", 403);
    }
    const entry = await transition(tx, id, ["SUBMITTED"], "APPROVED", { approvedAt: new Date(), approvedBy: userId });
    await auditAccounting(tx, { action: "journal.approve", entityType: "journal", entityId: id, userId });
    return entry;
  });
}

export async function rejectJournalEntry(id: string, userId: string, reason: string) {
  const why = reason?.trim();
  if (!why || why.length < 5) throw new AccountingError("A rejection needs a reason (at least 5 characters).", 400);
  return ledgerTx(async (tx) => {
    const e = await tx.journalEntry.findUnique({ where: { id } });
    if (!e) throw new AccountingError("Journal entry not found.", 404);
    if (e.createdBy === userId) throw new AccountingError("You prepared this entry; edit or discard it instead of rejecting it.", 403);
    const entry = await transition(tx, id, ["SUBMITTED", "APPROVED"], "DRAFT", {
      rejectedAt: new Date(), rejectedBy: userId, rejectionReason: why,
      submittedAt: null, submittedBy: null, approvedAt: null, approvedBy: null,
    });
    await auditAccounting(tx, { action: "journal.reject", entityType: "journal", entityId: id, userId, reason: why, before: { status: e.status } });
    return entry;
  });
}

export async function postJournalEntry(id: string, userId: string) {
  await assertSetupComplete();
  return ledgerTx(async (tx) => {
    const e = await tx.journalEntry.findUnique({ where: { id }, include: { fiscalPeriod: true } });
    if (!e) throw new AccountingError("Journal entry not found.", 404);
    if (e.status !== "APPROVED") throw new AccountingError(`Only an approved entry can be posted (this one is ${e.status}).`, 409);
    assertPeriodOpen(e.fiscalPeriod);
    const entry = await transition(tx, id, ["APPROVED"], "POSTED", { postedAt: new Date(), postedBy: userId });
    if (e.type === "REVERSAL" && e.reversesEntryId) {
      const flipped = await tx.journalEntry.updateMany({ where: { id: e.reversesEntryId, status: "POSTED" }, data: { status: "REVERSED" } });
      if (flipped.count !== 1) throw new AccountingError("The entry being reversed is no longer posted.", 409);
    }
    await auditAccounting(tx, { action: "journal.post", entityType: "journal", entityId: id, userId, refs: e.reversesEntryId ? { reverses: e.reversesEntryId } : undefined });
    return entry;
  });
}

/**
 * Ask for a posted entry to be reversed. Creates the mirror entry and submits it; it posts
 * only after a second person approves it. The unique reversesEntryId makes a second request
 * for the same entry fail while one is pending or posted.
 *
 * Entries produced by the posting engine are refused: they mirror a source document, and
 * reversing one here would leave the source saying one thing and the ledger another. They are
 * corrected in the source module (a commission reversal or adjustment), which posts its own
 * entry.
 */
export async function requestJournalReversal(id: string, userId: string, reason: string, date?: Date) {
  const why = reason?.trim();
  if (!why || why.length < 5) throw new AccountingError("A reversal needs a reason (at least 5 characters).", 400);
  await assertSetupComplete();
  return ledgerTx(async (tx) => {
    const original = await tx.journalEntry.findUnique({ where: { id }, include: { lines: { orderBy: { lineNo: "asc" } }, reversedByEntry: true } });
    if (!original) throw new AccountingError("Journal entry not found.", 404);
    if (original.status !== "POSTED") throw new AccountingError("Only a posted entry can be reversed.", 409);
    if (original.type === "AUTO") {
      throw new AccountingError(`This entry was posted automatically from ${original.sourceModule}; correct it in that module, which posts its own correcting entry.`, 409);
    }
    if (original.reversedByEntry) throw new AccountingError(`Entry #${original.entryNo} already has a reversal (#${original.reversedByEntry.entryNo}, ${original.reversedByEntry.status}).`, 409);
    const on = date ?? todayAccountingDate();
    if (on < original.entryDate) throw new AccountingError("A reversal cannot be dated before the entry it reverses.", 400);
    const period = await openPeriodFor(tx, on);
    const reversal = await tx.journalEntry.create({
      data: {
        entryDate: on, fiscalPeriodId: period.id, type: "REVERSAL", status: "DRAFT", sourceModule: original.sourceModule,
        sourceDocumentId: original.sourceDocumentId, reversesEntryId: original.id, description: `Reversal of entry #${original.entryNo}`,
        reversalReason: why, totalDebit: original.totalCredit, totalCredit: original.totalDebit, createdBy: userId,
        lines: {
          create: original.lines.map((l, i) => ({
            lineNo: i + 1, accountId: l.accountId, debit: l.credit, credit: l.debit,
            description: l.description ? `Reversal: ${l.description}` : "Reversal",
            taxCategorySnapshot: l.taxCategorySnapshot ?? undefined, branchId: l.branchId, costCenterId: l.costCenterId,
            partyType: l.partyType, partyId: l.partyId,
          })),
        },
      },
    });
    await tx.journalEntry.update({ where: { id: reversal.id }, data: { status: "SUBMITTED", submittedAt: new Date(), submittedBy: userId } });
    await auditAccounting(tx, { action: "journal.reversal_request", entityType: "journal", entityId: original.id, userId, reason: why, refs: { reversal: reversal.id } });
    return tx.journalEntry.findUniqueOrThrow({ where: { id: reversal.id }, include: { lines: true } });
  });
}

/** Kept for the existing route; a reversal is now a request that needs a second approval. */
export const reverseJournalEntry = (id: string, userId: string, reason: string, date?: Date) => requestJournalReversal(id, userId, reason, date);
