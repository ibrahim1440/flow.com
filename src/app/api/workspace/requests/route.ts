import { wsRoute } from "@/lib/workspace/server/http";
import { myRequests } from "@/lib/workspace/server/views";

/**
 * GET — my own leave / advance requests and attendance corrections, with who holds the next step and the
 * pending count. Read by «اليوم · طلباتي المعلقة»; the requests themselves are followed in «خدماتي».
 */
export const GET = wsRoute(({ actor }) => myRequests(actor));
