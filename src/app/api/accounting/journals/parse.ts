import { AccountingError } from "@/lib/accounting/errors";
import { accountingDate } from "@/lib/accounting/dates";
import type { CreateManualJournalEntryInput, ManualJournalLineInput, ManualJournalType } from "@/lib/accounting/journal-service";

export function parseJournalBody(b: Record<string, unknown>): CreateManualJournalEntryInput {
  const entryDate = accountingDate(b.entryDate);
  if (b.description !== undefined && b.description !== null && typeof b.description !== "string") throw new AccountingError("description must be text.", 400);
  const type = (b.type ?? "MANUAL") as ManualJournalType;
  if (!["MANUAL", "ADJUSTMENT", "OPENING"].includes(type)) throw new AccountingError("type must be MANUAL, ADJUSTMENT or OPENING.", 400);
  if (!Array.isArray(b.lines)) throw new AccountingError("lines must be a list.", 400);
  const lines: ManualJournalLineInput[] = b.lines.map((raw, i) => {
    const l = (raw ?? {}) as Record<string, unknown>;
    if (typeof l.accountId !== "string" || !l.accountId) throw new AccountingError(`Line ${i + 1}: choose an account.`, 400);
    for (const k of ["debit", "credit"]) {
      if (l[k] !== undefined && l[k] !== null && typeof l[k] !== "string" && typeof l[k] !== "number") throw new AccountingError(`Line ${i + 1}: ${k} must be an amount.`, 400);
    }
    for (const k of ["description", "taxCategoryId", "branchId", "costCenterId"]) {
      if (l[k] !== undefined && l[k] !== null && typeof l[k] !== "string") throw new AccountingError(`Line ${i + 1}: ${k} must be text.`, 400);
    }
    return {
      accountId: l.accountId, debit: (l.debit as string) ?? "0", credit: (l.credit as string) ?? "0",
      description: (l.description as string) || undefined, taxCategoryId: (l.taxCategoryId as string) || undefined,
      branchId: (l.branchId as string) || null, costCenterId: (l.costCenterId as string) || null,
    };
  });
  return { entryDate, description: (b.description as string) ?? undefined, type, lines };
}
