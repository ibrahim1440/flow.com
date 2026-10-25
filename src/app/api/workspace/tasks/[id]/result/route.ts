import { wsRoute } from "@/lib/workspace/server/http";
import { recordResult } from "@/lib/workspace/server/tasks";

/** POST { version, outcome, note?, next? } — a follow-up's result to the CRM timeline (one transaction). */
export const POST = wsRoute(({ actor, params, body }) => recordResult(actor, params.id, body));
