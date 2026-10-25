import { wsRoute } from "@/lib/workspace/server/http";
import { transitionTask } from "@/lib/workspace/server/tasks";

/** POST { action: start|hold|resume|complete|approve_review|return|cancel, version, reason? }. */
export const POST = wsRoute(({ actor, params, body }) => transitionTask(actor, params.id, body));
