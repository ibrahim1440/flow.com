import { requireStation } from "@/lib/services/station/http";
import { v2Body, v2Floor, v2Key, v2Run } from "@/lib/services/station/roast-v2-http";
import { NextResponse } from "@/lib/api-response";
import { chargeRun } from "@/lib/services/station/roast-v2";

/**
 * POST {roasterId, bucketId | barcode, productId?, scheduledSlotId?, profile?, ack?} + Idempotency-Key — «اشحن».
 * 409 DRUM_BUSY · 409 BASKET_NEEDS_WEIGHING · 409 BUCKET_NOT_PREPARED · 409 ROASTER_CAPACITY · 422 ACK_REQUIRED.
 * A paired station device charges its own roaster only.
 */
export async function POST(request: Request) {
  const { user, error, station } = await requireStation();
  if (error) return error;
  const g = { ctx: v2Floor(user, station) };
  const body = await v2Body(request);
  if (g.ctx.stationRoasterId && body.roasterId && body.roasterId !== g.ctx.stationRoasterId) {
    return NextResponse.json({ error: "هذا الجهاز لحمّاصة أخرى.", errorEn: "This device belongs to another roaster.", code: "STATION_ROASTER_MISMATCH" }, { status: 403 });
  }
  if (g.ctx.stationRoasterId) body.roasterId = g.ctx.stationRoasterId;
  return v2Run(() => chargeRun(g.ctx.actor, body, v2Key(request)), 200, (r) => !r.replayed);
}
