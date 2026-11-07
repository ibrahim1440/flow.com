import { requireStation } from "@/lib/services/station/http";
import { v2Body, v2Floor, v2Key, v2Run } from "@/lib/services/station/roast-v2-http";
import { dropRun } from "@/lib/services/station/roast-v2";

type Params = { params: Promise<{ id: string }> };
/** POST {coolerPosition?} + Idempotency-Key — «نزّل». Never refused; pairs with the previous roast of the same coffee. */
export async function POST(request: Request, { params }: Params) {
  const { user, error, station } = await requireStation();
  if (error) return error;
  const g = { ctx: v2Floor(user, station) };
  const { id } = await params;
  const body = await v2Body(request);
  return v2Run(() => dropRun(g.ctx.actor, id, body, v2Key(request)));
}
