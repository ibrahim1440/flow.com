import { NextResponse } from "@/lib/api-response";
import { requireStation, requiredKey } from "@/lib/services/station/http";
import { startRoast } from "@/lib/services/station/claims";
import { scheduleError } from "@/lib/services/schedule/http";

/**
 * POST /api/station/roasting/start {itemType, itemId, roasterId?, slotId?} + Idempotency-Key — R2
 * «بدء التحميص»: claims the work for the caller and logs it. Moves no stock and creates no batch
 * (J-12). From a slot of today's schedule, the slot becomes IN_PROGRESS in the same transaction.
 * 201 on a new claim, 200 on a replay or when the caller already holds it.
 */
export async function POST(request: Request) {
  const { user, error, station } = await requireStation();
  if (error) return error;
  const k = requiredKey(request);
  if (k.error) return k.error;
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const itemType = body.itemType === "RoastCoffee" || body.itemType === "ProductionOrder" ? body.itemType : null;
  const itemId = typeof body.itemId === "string" && body.itemId ? body.itemId : null;
  if (!itemType || !itemId) return NextResponse.json({ error: "اختر الدفعة من الطابور.", errorEn: "Choose the batch from the queue." }, { status: 400 });
  // A paired device works on its station's roaster only (W2); a personal session names one.
  const roasterId = station ? station.roasterId : typeof body.roasterId === "string" && body.roasterId ? body.roasterId : null;
  const slotId = typeof body.slotId === "string" && body.slotId ? body.slotId : null;
  try {
    const out = await startRoast({ user, item: { type: itemType, id: itemId }, roasterId, key: k.key, slotId });
    return NextResponse.json(out, { status: out.replayed ? 200 : 201 });
  } catch (err) {
    // ScheduleError (the slot) keeps its code; everything else as before.
    return scheduleError(err);
  }
}
