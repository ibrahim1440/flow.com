import { Prisma } from "@/generated/prisma/client";
import type { Account, FiscalPeriod, JournalEntryStatus, TaxCategory } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { AccountingError } from "./errors";

type DecimalLike = Prisma.Decimal | number | string;

// No financial movement may post while accounting setup is incomplete. There is no setup
// wizard in S0 — settings routes themselves are exempt so the singleton row can be configured.
export async function assertSetupComplete(): Promise<void> {
  const settings = await prisma.accountingSettings.findUnique({ where: { id: "singleton" } });
  if (!settings?.setupComplete) {
    throw new AccountingError("Accounting setup is not complete. Complete accounting settings before posting.", 409);
  }
}

export function assertDebitEqualsCredit(lines: { debit: DecimalLike; credit: DecimalLike }[]): void {
  let totalDebit = new Prisma.Decimal(0);
  let totalCredit = new Prisma.Decimal(0);
  for (const line of lines) {
    totalDebit = totalDebit.add(line.debit);
    totalCredit = totalCredit.add(line.credit);
  }
  if (!totalDebit.equals(totalCredit)) {
    throw new AccountingError(`Debit (${totalDebit.toString()}) must equal credit (${totalCredit.toString()}).`, 400);
  }
}

// Defense-in-depth alongside the DB-level CHECK constraint on JournalEntryLine.
export function assertLineExclusive(line: { debit: DecimalLike; credit: DecimalLike }): void {
  const debit = new Prisma.Decimal(line.debit);
  const credit = new Prisma.Decimal(line.credit);
  if (debit.lessThan(0) || credit.lessThan(0)) {
    throw new AccountingError("Debit and credit must not be negative.", 400);
  }
  const debitPositive = debit.greaterThan(0);
  const creditPositive = credit.greaterThan(0);
  if (debitPositive === creditPositive) {
    throw new AccountingError("Each journal line must have exactly one of debit or credit greater than zero.", 400);
  }
}

export function assertAccountPostable(account: Pick<Account, "isActive" | "allowPosting">, childAccountCount: number): void {
  if (!account.isActive) throw new AccountingError("Account is not active.", 400);
  if (!account.allowPosting) throw new AccountingError("Account does not allow posting.", 400);
  if (childAccountCount > 0) throw new AccountingError("Cannot post to a parent account.", 400);
}

export function assertPeriodOpen(period: Pick<FiscalPeriod, "status">): void {
  if (period.status !== "OPEN") {
    throw new AccountingError(`Fiscal period is ${period.status}, not Open. Posting is not allowed.`, 409);
  }
}

export function assertTaxCategoryActive(taxCategory: Pick<TaxCategory, "isActive"> | null | undefined): void {
  if (taxCategory && !taxCategory.isActive) {
    throw new AccountingError("Tax category is not active.", 400);
  }
}

// Application-layer immutability check. A DB-level trigger is proposed as a follow-up
// hardening step (see docs/migration-drift-and-db-constraints.md) but is not yet applied.
export function assertEditable(status: JournalEntryStatus): void {
  if (status === "POSTED" || status === "REVERSED") {
    throw new AccountingError("Posted or reversed journal entries cannot be edited. Use the reversal flow.", 409);
  }
}
