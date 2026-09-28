import { accountingRoute, body, query } from "@/lib/accounting/http";
import { listCosting, processPendingCosting } from "@/lib/accounting/sales-costing";

export const GET = accountingRoute(null, ({ request }) => listCosting({ status: query(request).get("status") }));
export const POST = accountingRoute("events_process", async () => ({ results: await processPendingCosting() }));
