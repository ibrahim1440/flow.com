import { NextResponse } from "@/lib/api-response";
import { handleDomainError } from "@/lib/api-error";
import { requireQualityStation, requiredKey } from "@/lib/services/station/http";
import { recordInspection } from "@/lib/services/qc/inspection";

/**
 * POST /api/station/quality/inspections + Idempotency-Key — Q3/Q4 «فحص بالقياس»: whole and ground
 * readings (device, scale), defects, sensory, optional cupping / moisture / density; under
 * calibration the documented manual decision; after a foreign-object hold the cleaning done. The
 * server judges against the batch's frozen spec: release, hold («محجوزة») or «بانتظار مقيّم آخر».
 * 201 new, 200 replayed (same key, same inspection); 422 when sensory is required and missing.
 */
export async function POST(request: Request) {
  const { user, error, station } = await requireQualityStation();
  if (error) return error;
  const k = requiredKey(request);
  if (k.error) return k.error;
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  try {
    const out = await recordInspection({ id: user.id, name: user.name }, k.key, body, { stationId: station?.id ?? null });
    return NextResponse.json(out, { status: out.replayed ? 200 : 201 });
  } catch (err) {
    return handleDomainError(err);
  }
}
