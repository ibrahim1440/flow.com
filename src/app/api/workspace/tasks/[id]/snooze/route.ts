import { wsRoute } from "@/lib/workspace/server/http";
import { snooze } from "@/lib/workspace/server/tasks";

/** POST { minutes: 15|30|60|120|240|1440 } — remind me again later; the deadline does not move. */
export const POST = wsRoute(({ actor, params, body }) => snooze(actor, params.id, body));
