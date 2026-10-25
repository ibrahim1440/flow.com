import { wsRoute } from "@/lib/workspace/server/http";
import { people } from "@/lib/workspace/server/pickers";

/** GET ?purpose=assign|invite&q= — names and ids of colleagues (see pickers.ts for who appears). */
export const GET = wsRoute(({ actor, query }) => people(actor, query.get("purpose") ?? "invite", query.get("q")));
