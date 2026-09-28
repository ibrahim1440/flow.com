import { accountingRoute, query } from "@/lib/accounting/http";
import { accountingDate, todayAccountingDate } from "@/lib/accounting/dates";
import { arAging } from "@/lib/accounting/receivables-reports";

export const GET = accountingRoute(null, ({ request }) => { const a = query(request).get("asOf"); return arAging(a ? accountingDate(a) : todayAccountingDate()); });
