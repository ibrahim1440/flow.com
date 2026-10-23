import { NextResponse } from "@/lib/api-response";
import { handleDomainError } from "@/lib/api-error";
import { requireQualityStation, requiredKey } from "@/lib/services/station/http";
import { requestException } from "@/lib/services/qc/exceptions";

/**
 * POST /api/station/quality/exceptions + Idempotency-Key — Q4 «طلب استثناء» for a held batch: reason
 * (مقبول بالتذوق / مناسب للخلط / موافقة العميل / أخرى), permitted use, the whole held quantity. The
 * request releases nothing; another person decides it in the ERP (QX). Never for foreign objects.
 */
export async function POST(request: Request) {
  const { user, error, station } = await requireQualityStation();
  if (error) return error;
  const k = requiredKey(request);
  if (k.error) return k.error;
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  try {
    const out = await requestException({ id: user.id, name: user.name }, k.key, body, { stationId: station?.id ?? null });
    return NextResponse.json(out, { status: out.replayed ? 200 : 201 });
  } catch (err) {
    return handleDomainError(err);
  }
}
