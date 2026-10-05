import { accountingRoute, query } from "@/lib/accounting/http";
import { accountingDate, todayAccountingDate } from "@/lib/accounting/dates";
import { apAging } from "@/lib/accounting/stage2-service";

export const GET = accountingRoute(null, async ({ request }) => {
  const q = query(request);
  return apAging(q.get("asOf") ? accountingDate(q.get("asOf")) : todayAccountingDate());
});
