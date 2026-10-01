import { accountingRoute, query } from "@/lib/accounting/http";
import { customersForReceivables } from "@/lib/accounting/receivables-reports";

export const GET = accountingRoute(null, ({ request }) => customersForReceivables(query(request).get("q")));
