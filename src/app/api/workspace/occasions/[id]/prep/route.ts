import { wsRoute } from "@/lib/workspace/server/http";
import { planPrepTasks } from "@/lib/workspace/server/occasions";

/** POST { steps?: [{ title, daysBefore, assigneeId? }] } — once per confirmed occasion. */
export const POST = wsRoute(({ actor, params, body }) => planPrepTasks(actor, params.id, body), { status: 201 });
