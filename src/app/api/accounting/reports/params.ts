import { accountingDate, todayAccountingDate } from "@/lib/accounting/dates";
import { AccountingError } from "@/lib/accounting/errors";

export function range(q: URLSearchParams) {
  const today = todayAccountingDate();
  const to = q.get("to") ? accountingDate(q.get("to")) : today;
  const from = q.get("from") ? accountingDate(q.get("from")) : new Date(Date.UTC(to.getUTCFullYear(), 0, 1));
  if (from > to) throw new AccountingError("The start date is after the end date.", 400);
  return { from, to, includeProvisional: q.get("provisional") !== "exclude" };
}
