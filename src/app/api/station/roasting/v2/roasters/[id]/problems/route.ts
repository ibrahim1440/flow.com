import { requireStation, requiredKey } from "@/lib/services/station/http";
import { v2Body, v2Floor, v2Run } from "@/lib/services/station/roast-v2-http";
import { reportProblemV2 } from "@/lib/services/station/roast-v2";

type Params = { params: Promise<{ id: string }> };
/**
 * POST {kind: PAUSE|MALFUNCTION, reason: BURNER_STOPPED|IRREGULAR_HEAT|COOLING_PROBLEM|OTHER, note?, runId?} + Idempotency-Key —
 * «إبلاغ عن مشكلة» on a V2 roaster. No stock moves, the roaster's status is unchanged (D13); a charge is refused while open.
 */
export async function POST(request: Request, { params }: Params) {
  const { user, error, station } = await requireStation();
  if (error) return error;
  const k = requiredKey(request);
  if (k.error) return k.error;
  const g = { ctx: v2Floor(user, station) };
  const { id } = await params;
  const body = await v2Body(request);
  return v2Run(() => reportProblemV2(g.ctx.actor, id, body, k.key), 200, (r) => !r.replayed);
}
