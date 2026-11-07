import { requireStation } from "@/lib/services/station/http";
import { v2Floor, v2Run } from "@/lib/services/station/roast-v2-http";
import { unpairBasket } from "@/lib/services/station/roast-v2";

type Params = { params: Promise<{ id: string }> };
/** POST — a pair not yet weighed becomes two singles. */
export async function POST(_request: Request, { params }: Params) {
  const { user, error, station } = await requireStation();
  if (error) return error;
  const g = { ctx: v2Floor(user, station) };
  const { id } = await params;
  return v2Run(() => unpairBasket(g.ctx.actor, id));
}
