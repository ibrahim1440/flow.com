import { Prisma } from "@/generated/prisma/client";
import type { JournalEntryStatus } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { AccountingError } from "./errors";
import {
  assertAccountPostable,
  assertDebitEqualsCredit,
  assertLineExclusive,
  assertPeriodOpen,
  assertSetupComplete,
  assertTaxCategoryActive,
} from "./validation";
import { buildTaxCategorySnapshot } from "./tax-snapshot";
import { isPayrollLive, payrollAccountIds, payrollLockedRefusal } from "@/lib/hr/payroll-lock";
import { assertManualJournalsEnabled } from "./manual-journals";

/**
 * Phase 1 payroll lock (owner A-7 / A-8; independent review F1): while live payroll is off, no
 * journal touching a PAYROLL ACCOUNT (the HR posting map, PAYROLL_CASH excepted) and no journal of
 * the HR module is created, submitted, approved, posted or reversed here — for every account,
 * administrators included (409 PAYROLL_LOCKED). Ordinary journals are untouched. The database
 * refuses the posting too (hr_payroll_lock_guard on JournalEntry / JournalEntryLine).
 */
/** The HR module, however its name is cased or padded (the database compares lower(btrim(…)) too). */
const isHrModule = (sourceModule: string | null) => (sourceModule ?? "").trim().toLowerCase() === "hr";

async function assertNotPayrollJournal(tx: Prisma.TransactionClient, accountIds: string[], sourceModule: string | null) {
  if (await isPayrollLive(tx)) return;
  if (isHrModule(sourceModule) || (await payrollAccountIds(tx, accountIds)).length) {
    const r = payrollLockedRefusal("GL_PAYROLL_JOURNAL");
    throw new AccountingError(r.errorEn, 409, r.code, r.message);
  }
}

export type ManualJournalLineInput = {
  accountId: string;
  debit: number | string;
  credit: number | string;
  description?: string;
  taxCategoryId?: string;
};

export type CreateManualJournalEntryInput = {
  entryDate: Date;
  description?: string;
  lines: ManualJournalLineInput[];
};

// Manual entries only in S0 — Auto/Opening/Closing entries have no producer yet, and
// Reversal entries are created exclusively by reverseJournalEntry below.
export async function createManualJournalEntry(input: CreateManualJournalEntryInput, userId: string) {
  // Phase 1 (owner decision D1): manual journals are disabled for everyone (./manual-journals).
  await assertManualJournalsEnabled();
  await assertSetupComplete();

  if (!input.lines || input.lines.length < 2) {
    throw new AccountingError("A journal entry needs at least two lines.", 400);
  }

  const decimalLines = input.lines.map((l) => ({
    ...l,
    debit: new Prisma.Decimal(l.debit),
    credit: new Prisma.Decimal(l.credit),
  }));
  for (const line of decimalLines) assertLineExclusive(line);
  assertDebitEqualsCredit(decimalLines);

  return prisma.$transaction(async (tx) => {
    await assertManualJournalsEnabled(tx);
    const period = await tx.fiscalPeriod.findFirst({
      where: { startDate: { lte: input.entryDate }, endDate: { gte: input.entryDate } },
    });
    if (!period) throw new AccountingError("No fiscal period covers this entry date.", 400);
    assertPeriodOpen(period);

    const accountIds = [...new Set(decimalLines.map((l) => l.accountId))];
    await assertNotPayrollJournal(tx, accountIds, "manual");
    const accounts = await tx.account.findMany({ where: { id: { in: accountIds } } });
    if (accounts.length !== accountIds.length) {
      throw new AccountingError("One or more accounts were not found.", 400);
    }
    const accountById = new Map(accounts.map((a) => [a.id, a]));

    const childCounts = await tx.account.groupBy({
      by: ["parentId"],
      where: { parentId: { in: accountIds } },
      _count: { _all: true },
    });
    const childCountByParent = new Map(
      childCounts.filter((c) => c.parentId !== null).map((c) => [c.parentId as string, c._count._all]),
    );

    const taxCategoryIds = [...new Set(decimalLines.map((l) => l.taxCategoryId).filter((id): id is string => !!id))];
    const taxCategories = taxCategoryIds.length
      ? await tx.taxCategory.findMany({ where: { id: { in: taxCategoryIds } } })
      : [];
    const taxCategoryById = new Map(taxCategories.map((t) => [t.id, t]));

    for (const line of decimalLines) {
      const account = accountById.get(line.accountId)!;
      assertAccountPostable(account, childCountByParent.get(line.accountId) ?? 0);
      if (line.taxCategoryId) {
        const taxCategory = taxCategoryById.get(line.taxCategoryId);
        if (!taxCategory) throw new AccountingError("Tax category not found.", 400);
        assertTaxCategoryActive(taxCategory);
      }
    }

    const totalDebit = decimalLines.reduce((sum, l) => sum.add(l.debit), new Prisma.Decimal(0));
    const totalCredit = decimalLines.reduce((sum, l) => sum.add(l.credit), new Prisma.Decimal(0));

    return tx.journalEntry.create({
      data: {
        entryDate: input.entryDate,
        fiscalPeriodId: period.id,
        type: "MANUAL",
        status: "DRAFT",
        sourceModule: "manual",
        description: input.description,
        totalDebit,
        totalCredit,
        createdBy: userId,
        lines: {
          create: decimalLines.map((l) => ({
            accountId: l.accountId,
            debit: l.debit,
            credit: l.credit,
            description: l.description,
            taxCategorySnapshot: l.taxCategoryId
              ? buildTaxCategorySnapshot(taxCategoryById.get(l.taxCategoryId)!)
              : undefined,
          })),
        },
      },
      include: { lines: true },
    });
  });
}

async function transitionStatus(
  id: string,
  from: JournalEntryStatus[],
  to: JournalEntryStatus,
  stamp: Record<string, unknown>,
) {
  await assertManualJournalsEnabled();
  return prisma.$transaction(async (tx) => {
    await assertManualJournalsEnabled(tx);
    const entry = await tx.journalEntry.findUnique({ where: { id } });
    if (!entry) throw new AccountingError("Journal entry not found.", 404);
    if (!from.includes(entry.status)) {
      throw new AccountingError(`Cannot transition from ${entry.status} to ${to}.`, 409);
    }
    const lines = await tx.journalEntryLine.findMany({ where: { journalEntryId: id }, select: { accountId: true } });
    await assertNotPayrollJournal(tx, lines.map((l) => l.accountId), entry.sourceModule);
    return tx.journalEntry.update({ where: { id }, data: { status: to, ...stamp } });
  });
}

export async function submitJournalEntry(id: string, userId: string) {
  return transitionStatus(id, ["DRAFT"], "SUBMITTED", { submittedAt: new Date(), submittedBy: userId });
}

export async function approveJournalEntry(id: string, userId: string) {
  return transitionStatus(id, ["SUBMITTED"], "APPROVED", { approvedAt: new Date(), approvedBy: userId });
}

export async function postJournalEntry(id: string, userId: string) {
  await assertManualJournalsEnabled();
  await assertSetupComplete();
  return prisma.$transaction(async (tx) => {
    await assertManualJournalsEnabled(tx);
    const entry = await tx.journalEntry.findUnique({
      where: { id },
      include: { lines: true, fiscalPeriod: true },
    });
    if (!entry) throw new AccountingError("Journal entry not found.", 404);
    if (entry.status !== "APPROVED") {
      throw new AccountingError(`Only Approved entries can be posted (current status: ${entry.status}).`, 409);
    }
    assertPeriodOpen(entry.fiscalPeriod);
    assertDebitEqualsCredit(entry.lines);
    await assertNotPayrollJournal(tx, entry.lines.map((l) => l.accountId), entry.sourceModule);
    return tx.journalEntry.update({
      where: { id },
      data: { status: "POSTED", postedAt: new Date(), postedBy: userId },
    });
  });
}

// Reversal requires explicit permission (enforced at the route level) and a mandatory
// reason. The reversal entry posts immediately on creation rather than going through its
// own Draft -> Submit -> Approve cycle: the reversal action is already gated as a sensitive
// operation by the route guard. A separate approval queue for reversals is deferred to a
// future ApprovalRule engine (out of S0 scope).
export async function reverseJournalEntry(id: string, userId: string, reason: string) {
  await assertManualJournalsEnabled();
  const trimmedReason = reason?.trim();
  if (!trimmedReason) {
    throw new AccountingError("A reason is required to reverse a journal entry.", 400);
  }

  return prisma.$transaction(async (tx) => {
    await assertManualJournalsEnabled(tx);
    const original = await tx.journalEntry.findUnique({
      where: { id },
      include: { lines: true, reversedByEntry: true },
    });
    if (!original) throw new AccountingError("Journal entry not found.", 404);
    if (original.status !== "POSTED") {
      throw new AccountingError("Only Posted journal entries can be reversed.", 409);
    }
    if (original.reversedByEntry) {
      throw new AccountingError("This journal entry has already been reversed.", 409);
    }
    // A journal of the HR module is reversed only through HR (its linked reversal; the database
    // refuses anything else) — a refusal, never a 500 (independent review F7). While payroll is
    // locked it is PAYROLL_LOCKED, as is any journal on a payroll account.
    await assertNotPayrollJournal(tx, original.lines.map((l) => l.accountId), original.sourceModule);
    if (isHrModule(original.sourceModule)) {
      throw new AccountingError("A journal posted by HR is reversed only through HR.", 409, "HR_JOURNAL", "قيد الموارد البشرية لا يُعكس إلا من خلال الموارد البشرية.");
    }

    // The reversal always posts in the period covering today, never retroactively into the
    // original's period (which may since have been Locked or Closed).
    const today = new Date();
    const reversalPeriod = await tx.fiscalPeriod.findFirst({
      where: { startDate: { lte: today }, endDate: { gte: today } },
    });
    if (!reversalPeriod) throw new AccountingError("No fiscal period covers today's date.", 400);
    assertPeriodOpen(reversalPeriod);

    return tx.journalEntry.create({
      data: {
        entryDate: today,
        fiscalPeriodId: reversalPeriod.id,
        type: "REVERSAL",
        status: "POSTED",
        sourceModule: original.sourceModule,
        sourceDocumentId: original.sourceDocumentId,
        reversesEntryId: original.id,
        description: `Reversal of entry #${original.entryNo}`,
        reversalReason: trimmedReason,
        totalDebit: original.totalCredit,
        totalCredit: original.totalDebit,
        createdBy: userId,
        postedAt: today,
        postedBy: userId,
        lines: {
          create: original.lines.map((l) => ({
            accountId: l.accountId,
            debit: l.credit,
            credit: l.debit,
            description: l.description ? `Reversal: ${l.description}` : "Reversal",
            taxCategorySnapshot: l.taxCategorySnapshot ?? undefined,
          })),
        },
      },
      include: { lines: true },
    });
  });
}
