import { wsRoute } from "@/lib/workspace/server/http";
import { team } from "@/lib/workspace/server/views";

/** GET — the caller's team (HR direct reports, or everyone with workspace › team_view). */
export const GET = wsRoute(({ actor }) => team(actor));
