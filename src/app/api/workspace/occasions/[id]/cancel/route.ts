import { wsRoute } from "@/lib/workspace/server/http";
import { cancelOccasion } from "@/lib/workspace/server/occasions";

export const POST = wsRoute(({ actor, params }) => cancelOccasion(actor, params.id));
