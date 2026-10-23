import { NextResponse } from "@/lib/api-response";
import { handleDomainError } from "@/lib/api-error";
import { requireQualityStation } from "@/lib/services/station/http";
import { qcStationQueue } from "@/lib/services/qc/inspection";

/** GET /api/station/quality/queue — Q1 «بانتظار الفحص» (by the 48 h deadline), Q5 «المحجوزة», Q6 «سجل الجودة» (7 days). */
export async function GET() {
  const { error } = await requireQualityStation();
  if (error) return error;
  try {
    return NextResponse.json(await qcStationQueue(), { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return handleDomainError(err);
  }
}
