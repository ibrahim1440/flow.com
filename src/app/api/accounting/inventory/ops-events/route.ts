import { accountingRoute, body, query } from "@/lib/accounting/http";
import { listOpsEvents, processPendingOpsEvents } from "@/lib/accounting/ops-integration";

// Operational stock events and their accounting state (the exception queue).
export const GET = accountingRoute(null, ({ request }) => { const q = query(request); return listOpsEvents({ status: q.get("status"), kind: q.get("kind"), sourceId: q.get("sourceId") }); });
export const POST = accountingRoute("events_process", async () => ({ results: await processPendingOpsEvents() }));
