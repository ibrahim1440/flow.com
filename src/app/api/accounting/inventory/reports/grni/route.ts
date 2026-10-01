import { accountingRoute, query } from "@/lib/accounting/http";
import { accountingDate, todayAccountingDate } from "@/lib/accounting/dates";
import { grniStatus } from "@/lib/accounting/inventory-reports";

export const GET = accountingRoute(null, ({ request }) => { const a = query(request).get("asOf"); return grniStatus(a ? accountingDate(a) : todayAccountingDate()); });
