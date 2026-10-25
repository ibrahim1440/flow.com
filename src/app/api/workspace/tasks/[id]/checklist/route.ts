import { wsRoute } from "@/lib/workspace/server/http";
import { changeChecklist } from "@/lib/workspace/server/tasks";

/** POST { add } | { toggle, done } | { remove }. */
export const POST = wsRoute(({ actor, params, body }) => changeChecklist(actor, params.id, body));
