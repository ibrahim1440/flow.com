// Accounting dates are calendar days in Asia/Riyadh. JournalEntry.entryDate and FiscalPeriod
// start/end are timestamp columns (Accounting S0); they always hold UTC midnight of that
// Riyadh calendar day, so comparisons between them are plain date comparisons.
import { dbDate, dateStr, isDateString, riyadhDateString } from "@/lib/finance/dates";
import { AccountingError } from "./errors";

export { dateStr, isDateString };

/** "YYYY-MM-DD" → the stored representation. Refuses anything else. */
export function accountingDate(s: unknown): Date {
  if (!isDateString(s)) throw new AccountingError("Date must be a calendar date (YYYY-MM-DD).", 400);
  return dbDate(s);
}

/** The Riyadh calendar day an instant falls on, as the stored representation. */
export function accountingDateOf(at: Date): Date {
  return dbDate(riyadhDateString(at));
}

export function todayAccountingDate(): Date {
  return accountingDateOf(new Date());
}
