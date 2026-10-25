import { wsRoute } from "@/lib/workspace/server/http";
import { getTask, updateTask } from "@/lib/workspace/server/tasks";

/** GET — the task, its checklist, comments, history and the actions the caller may take. PATCH — edit (version required). */
export const GET = wsRoute(({ actor, params }) => getTask(actor, params.id));
export const PATCH = wsRoute(({ actor, params, body }) => updateTask(actor, params.id, body));
