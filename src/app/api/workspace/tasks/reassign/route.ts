import { wsRoute } from "@/lib/workspace/server/http";
import { bulkReassign } from "@/lib/workspace/server/tasks";

/** POST { taskIds[], assigneeId, note? } — each task re-checked as a single reassignment. */
export const POST = wsRoute(({ actor, body }) => bulkReassign(actor, body));
