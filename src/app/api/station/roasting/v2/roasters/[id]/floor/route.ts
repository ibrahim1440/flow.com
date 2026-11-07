import { requireStation } from "@/lib/services/station/http";
import { v2Floor, v2Run } from "@/lib/services/station/roast-v2-http";
import { fail, floorView } from "@/lib/services/station/roast-v2";

type Params = { params: Promise<{ id: string }> };
/** GET — the V2 floor (D12 R1–R13) in one read; a paired device reads its own roaster only. */
export async function GET(_request: Request, { params }: Params) {
  const { user, error, station } = await requireStation();
  if (error) return error;
  const g = { ctx: v2Floor(user, station) };
  const { id } = await params;
  return v2Run(async () => {
    if (g.ctx.stationRoasterId && g.ctx.stationRoasterId !== id) throw fail(403, "STATION_ROASTER_MISMATCH", "هذا الجهاز لحمّاصة أخرى.", "This device belongs to another roaster.");
    return floorView(id);
  });
}
