import { wsRoute } from "@/lib/workspace/server/http";
import { updateOccasion } from "@/lib/workspace/server/occasions";

export const PATCH = wsRoute(({ actor, params, body }) => updateOccasion(actor, params.id, body));
