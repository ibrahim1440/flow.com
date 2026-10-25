import { wsRoute } from "@/lib/workspace/server/http";
import { addComment } from "@/lib/workspace/server/tasks";

/** POST { body } — anyone who may see the task. */
export const POST = wsRoute(({ actor, params, body }) => addComment(actor, params.id, body), { status: 201 });
