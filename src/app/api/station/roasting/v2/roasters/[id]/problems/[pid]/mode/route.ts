import { requireStation, requiredKey } from "@/lib/services/station/http";
import { v2Body, v2Floor, v2Run } from "@/lib/services/station/roast-v2-http";
import { setProblemModeV2 } from "@/lib/services/station/roast-v2";

type Params = { params: Promise<{ id: string; pid: string }> };
/**
 * POST {blocking: boolean} + Idempotency-Key — D16 P2, right after «إرسال»: «إيقاف التحميص» (true) or «متابعة التحميص ·
 * مشكلة بسيطة» (false). To minor: the reporter or a supervisor, never a PAUSE. Back to stop: anyone at the roaster (M1).
 */
export async function POST(request: Request, { params }: Params) {
  const { user, error, station } = await requireStation();
  if (error) return error;
  const k = requiredKey(request);
  if (k.error) return k.error;
  const g = { ctx: v2Floor(user, station) };
  const { id, pid } = await params;
  const body = await v2Body(request);
  return v2Run(() => setProblemModeV2(g.ctx.actor, id, pid, body, k.key));
}
