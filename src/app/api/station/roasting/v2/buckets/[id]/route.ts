import { requireStation } from "@/lib/services/station/http";
import { v2Body, v2Floor, v2Run } from "@/lib/services/station/roast-v2-http";
import { reweighBucket } from "@/lib/services/station/roast-v2";

type Params = { params: Promise<{ id: string }> };
/** PATCH {actualKg, reason} — re-weigh a prepared bucket (the difference is an adjustment at staging). */
export async function PATCH(request: Request, { params }: Params) {
  const { user, error, station } = await requireStation();
  if (error) return error;
  const g = { ctx: v2Floor(user, station) };
  const { id } = await params;
  const body = await v2Body(request);
  return v2Run(() => reweighBucket(g.ctx.actor, id, body));
}
