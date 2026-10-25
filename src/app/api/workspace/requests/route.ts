import { wsRoute } from "@/lib/workspace/server/http";
import { myRequests } from "@/lib/workspace/server/views";

/** GET — my own leave and advance requests, with who holds the next step. */
export const GET = wsRoute(({ actor }) => myRequests(actor));
