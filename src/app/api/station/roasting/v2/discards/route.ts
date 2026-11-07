import { requireStation } from "@/lib/services/station/http";
import { v2Run, v2Supervisor } from "@/lib/services/station/roast-v2-http";
import { discardsToReview } from "@/lib/services/station/roast-v2";

/** GET — discards waiting for a supervisor's review (`overdue` after 24 h). */
export async function GET() {
  const { user, error, station } = await requireStation();
  if (error) return error;
  const g = v2Supervisor(user, "manage_schedule", station);
  if (g.error) return g.error;
  return v2Run(() => discardsToReview(new Date(), g.ctx.stationRoasterId));
}
