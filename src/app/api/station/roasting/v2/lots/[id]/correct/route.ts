import { requireStation } from "@/lib/services/station/http";
import { v2Body, v2Key, v2Run, v2Supervisor } from "@/lib/services/station/roast-v2-http";
import { correctLot } from "@/lib/services/station/roast-v2";

type Params = { params: Promise<{ id: string }> };
/**
 * POST {roastedKg, reason, lossReason?} + Idempotency-Key — a supervisor's correction (production › manage_schedule):
 * the lot is reversed per component and its basket re-recorded as a new lot (correctsBatchId). 201, 200 on a replay.
 */
export async function POST(request: Request, { params }: Params) {
  const { user, error, station } = await requireStation();
  if (error) return error;
  const g = v2Supervisor(user, "manage_schedule", station);
  if (g.error) return g.error;
  const { id } = await params;
  const body = await v2Body(request);
  return v2Run(() => correctLot(g.ctx.actor, id, body, v2Key(request)), 200, (r) => !r.replayed);
}
