import { requireAnySub } from "@/lib/auth-server";
import { v2Run } from "@/lib/services/station/roast-v2-http";
import { listProblemsV2 } from "@/lib/services/station/roast-v2";

/**
 * GET /api/production/roast-problems — D16 E1 «بلاغات المحامص»: the open reports, then the last 30 days' ended ones. For
 * the report supervisors at the desk: production › manage_roasters or manage_schedule (the administrator holds both).
 */
export async function GET() {
  const { error } = await requireAnySub("production", ["manage_roasters", "manage_schedule"]);
  if (error) return error;
  return v2Run(() => listProblemsV2());
}
