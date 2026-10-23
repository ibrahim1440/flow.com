import { NextResponse } from "@/lib/api-response";
import { handleDomainError } from "@/lib/api-error";
import { requireQualityStation } from "@/lib/services/station/http";
import { qcBatchDetail } from "@/lib/services/qc/inspection";

/**
 * GET /api/station/quality/batches/[id] — Q2 / Q3: the batch, the spec it is judged against (the
 * APPROVED profile version stored on it, or «المواصفة قيد المعايرة»), the roast loss for reference,
 * the earlier records and whether a sensory evaluation is due (the first of the profile today).
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { error } = await requireQualityStation();
  if (error) return error;
  const { id } = await params;
  try {
    const d = await qcBatchDetail(id);
    if (!d) return NextResponse.json({ error: "الدفعة غير موجودة.", errorEn: "Batch not found." }, { status: 404 });
    return NextResponse.json(d, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return handleDomainError(err);
  }
}
