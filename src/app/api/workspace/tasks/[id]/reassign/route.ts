import { wsRoute } from "@/lib/workspace/server/http";
import { reassignTask } from "@/lib/workspace/server/tasks";

/** POST { assigneeId, version, note? } — the asker, the assignee's manager or an assign_any holder. */
export const POST = wsRoute(({ actor, params, body }) => reassignTask(actor, params.id, body));
