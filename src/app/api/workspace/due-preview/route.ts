import { wsRoute } from "@/lib/workspace/server/http";
import { previewDue } from "@/lib/workspace/server/tasks";

/** POST { due: { quick, basis } | dueAt } → the computed deadline («يُستحق: …») before saving. */
export const POST = wsRoute(({ body }) => previewDue(body));
