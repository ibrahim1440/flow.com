import { wsRoute } from "@/lib/workspace/server/http";
import { links } from "@/lib/workspace/server/pickers";

/** GET ?q= — customers, leads and deals the caller may see, to link a task or an appointment. */
export const GET = wsRoute(({ actor, query }) => links(actor, query.get("q")));
