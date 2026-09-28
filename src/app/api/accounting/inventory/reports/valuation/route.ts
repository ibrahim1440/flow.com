import { accountingRoute, query } from "@/lib/accounting/http";
import { accountingDate, todayAccountingDate } from "@/lib/accounting/dates";
import { inventoryValuation } from "@/lib/accounting/inventory-reports";

export const GET = accountingRoute(null, ({ request }) => { const q = query(request); return inventoryValuation(q.get("asOf") ? accountingDate(q.get("asOf")) : todayAccountingDate(), q.get("locationId")); });
