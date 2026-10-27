import { wsRoute } from "@/lib/workspace/server/http";
import { today } from "@/lib/workspace/server/views";
import { checkGreenReadinessSoon } from "@/lib/services/green-readiness";

/**
 * GET /api/workspace/today — «اليوم»: counts, what needs action, today's schedule. Own data only. Also checks, after the
 * response and at most every few minutes, whether the coming roasts' green is at the production site (an alert with a
 * suggested transfer when it is not — lib/services/green-readiness.ts; the daily cron is the floor).
 */
export const GET = wsRoute(({ actor }) => {
  checkGreenReadinessSoon(actor);
  return today(actor);
});
