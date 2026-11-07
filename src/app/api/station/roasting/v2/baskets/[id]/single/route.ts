import { requireStation } from "@/lib/services/station/http";
import { v2Floor, v2Run } from "@/lib/services/station/roast-v2-http";
import { sealSingle } from "@/lib/services/station/roast-v2";

type Params = { params: Promise<{ id: string }> };
/** POST — «سجّلها لحالها»: an open basket with one roast is weighed alone. */
export async function POST(_request: Request, { params }: Params) {
  const { user, error, station } = await requireStation();
  if (error) return error;
  const g = { ctx: v2Floor(user, station) };
  const { id } = await params;
  return v2Run(() => sealSingle(g.ctx.actor, id));
}
