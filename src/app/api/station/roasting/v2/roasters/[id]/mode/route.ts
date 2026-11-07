import { requireStation } from "@/lib/services/station/http";
import { v2Body, v2Run, v2Supervisor } from "@/lib/services/station/roast-v2-http";
import { setStationMode } from "@/lib/services/station/roast-v2";

type Params = { params: Promise<{ id: string }> };
/** PATCH {stationMode: "V1" | "V2"} — the per-roaster flag (production › manage_roasters). */
export async function PATCH(request: Request, { params }: Params) {
  const { user, error, station } = await requireStation();
  if (error) return error;
  const g = v2Supervisor(user, "manage_roasters", station);
  if (g.error) return g.error;
  const { id } = await params;
  const body = await v2Body(request);
  return v2Run(() => setStationMode(g.ctx.actor, id, body.stationMode));
}
