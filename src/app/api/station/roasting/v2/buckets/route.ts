import { requireStation } from "@/lib/services/station/http";
import { v2Body, v2Floor, v2Key, v2Run } from "@/lib/services/station/roast-v2-http";
import { saveBucket, stagingBuckets } from "@/lib/services/station/roast-v2";

/** GET — the prepared buckets waiting in staging (oldest first; `stale` after 72 h). */
export async function GET() {
  const { error } = await requireStation();
  if (error) return error;
  return v2Run(() => stagingBuckets());
}

/** POST {sessionId, greenBeanId, actualKg, plannedKg?, productId?, colorKey?} + Idempotency-Key — «احفظ السطل». */
export async function POST(request: Request) {
  const { user, error, station } = await requireStation();
  if (error) return error;
  const g = { ctx: v2Floor(user, station) };
  const body = await v2Body(request);
  return v2Run(() => saveBucket(g.ctx.actor, body, v2Key(request)), 200, (r) => !r.replayed);
}
