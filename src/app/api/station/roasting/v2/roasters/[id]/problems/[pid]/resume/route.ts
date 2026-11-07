import { requireStation, requiredKey } from "@/lib/services/station/http";
import { v2Body, v2Floor, v2Run } from "@/lib/services/station/roast-v2-http";
import { resumeProblemV2 } from "@/lib/services/station/roast-v2";

type Params = { params: Promise<{ id: string; pid: string }> };
/** POST {note?} + Idempotency-Key — «استئناف»: ends the problem (a MALFUNCTION by a supervisor; a PAUSE by the operator too). */
export async function POST(request: Request, { params }: Params) {
  const { user, error, station } = await requireStation();
  if (error) return error;
  const k = requiredKey(request);
  if (k.error) return k.error;
  const g = { ctx: v2Floor(user, station) };
  const { id, pid } = await params;
  const body = await v2Body(request);
  return v2Run(() => resumeProblemV2(g.ctx.actor, id, pid, body, k.key));
}
