import { wsRoute } from "@/lib/workspace/server/http";
import { today } from "@/lib/workspace/server/views";

/** GET /api/workspace/today — «اليوم»: counts, what needs action, today's schedule. Own data only. */
export const GET = wsRoute(({ actor }) => today(actor));
