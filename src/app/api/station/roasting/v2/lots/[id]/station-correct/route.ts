import { requireStation } from "@/lib/services/station/http";
import { v2Body, v2Floor, v2Key, v2Run } from "@/lib/services/station/roast-v2-http";
import { correctLot } from "@/lib/services/station/roast-v2";

type Params = { params: Promise<{ id: string }> };
/**
 * POST {roastedKg, reason, lossReason?} + Idempotency-Key — the roaster's own correction at the station (the owner's
 * decision): the one who recorded the lot or an operator of its roaster, the same Riyadh business day, a reason required,
 * the lot unused (409 LOT_IN_USE); the supervisors are notified. After that day: 403 CORRECTION_DAY_PASSED (the desk).
 */
export async function POST(request: Request, { params }: Params) {
  const { user, error, station } = await requireStation();
  if (error) return error;
  const ctx = v2Floor(user, station);
  const { id } = await params;
  const body = await v2Body(request);
  return v2Run(() => correctLot(ctx.actor, id, body, v2Key(request), "station"), 200, (r) => !r.replayed);
}
