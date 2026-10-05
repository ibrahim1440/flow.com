import { accountingRoute, query } from "@/lib/accounting/http";
import { reconcileRegister } from "@/lib/accounting/fixed-assets-service";
import { accountingDate, todayAccountingDate } from "@/lib/accounting/dates";

export const GET = accountingRoute(null, async ({ request }) => { const d = query(request).get("asOf"); return reconcileRegister(d ? accountingDate(d) : todayAccountingDate()); });
