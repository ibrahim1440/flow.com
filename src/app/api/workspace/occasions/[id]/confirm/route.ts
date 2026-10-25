import { wsRoute } from "@/lib/workspace/server/http";
import { confirmOccasion } from "@/lib/workspace/server/occasions";

/** POST { version } — the dates and source were reviewed. */
export const POST = wsRoute(({ actor, params, body }) => confirmOccasion(actor, params.id, body));
