import { wsRoute } from "@/lib/workspace/server/http";
import { badge } from "@/lib/workspace/server/views";

/** GET /api/workspace/badge — overdue + due today + waiting for my decision (the sidebar count). */
export const GET = wsRoute(({ actor }) => badge(actor));
