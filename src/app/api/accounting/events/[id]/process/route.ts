import { accountingRoute } from "@/lib/accounting/http";
import { processEvent } from "@/lib/accounting/event-processor";

export const POST = accountingRoute("events_process", ({ params }) => processEvent(params.id));
