import { accountingRoute, query } from "@/lib/accounting/http";
import { balanceSheet } from "@/lib/accounting/reports";
import { accountingDate, todayAccountingDate } from "@/lib/accounting/dates";

// A balance sheet is as of one date: only `to` counts. (The report page also sends `from`, which for
// an as-of date before 1 January of the current year used to make the shared range check refuse it.)
export const GET = accountingRoute(null, ({ request }) => {
  const q = query(request);
  const asOf = q.get("to") ? accountingDate(q.get("to")) : todayAccountingDate();
  return balanceSheet({ asOf, includeProvisional: q.get("provisional") !== "exclude" });
});
