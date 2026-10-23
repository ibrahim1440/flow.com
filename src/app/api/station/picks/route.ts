import { NextResponse } from "@/lib/api-response";
import { handleDomainError } from "@/lib/api-error";
import { requirePackagingStation, requiredKey } from "@/lib/services/station/http";
import { recordPick } from "@/lib/services/station/prep";

/**
 * POST /api/station/picks {orderItemId, entry, units} + Idempotency-Key — P2 «تأكيد N وحدات من
 * اللوت»: the lot is matched again under the line's lock (W1), the units must be reserved on it for
 * this line and still to prepare; the pick is recorded (PreparationPick). No stock moves. 201 new,
 * 200 replayed; 409 for an ambiguous or wrong lot (nothing recorded).
 */
export async function POST(request: Request) {
  const { user, error, station } = await requirePackagingStation("preparation");
  if (error) return error;
  const k = requiredKey(request);
  if (k.error) return k.error;
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  if (typeof body.orderItemId !== "string" || !body.orderItemId) return NextResponse.json({ error: "اختر البند.", errorEn: "Choose the order line." }, { status: 400 });
  try {
    const out = await recordPick({ user, orderItemId: body.orderItemId, entry: body.entry, units: body.units, key: k.key, stationId: station?.id ?? null });
    return NextResponse.json(out, { status: out.replayed ? 200 : 201 });
  } catch (err) {
    return handleDomainError(err);
  }
}
