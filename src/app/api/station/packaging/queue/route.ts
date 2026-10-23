import { NextResponse } from "@/lib/api-response";
import { handleDomainError } from "@/lib/api-error";
import { requirePackagingStation } from "@/lib/services/station/http";
import { packagingQueue } from "@/lib/services/station/packaging";

/**
 * GET /api/station/packaging/queue — PA1 «دفعات جاهزة للتعبئة» (released batches only; the ones
 * waiting for QC as «غير متاحة») and P5 (material shortages, rejected batches). Polled with a
 * version (H5): an unchanged queue answers 304.
 */
export async function GET(request: Request) {
  const { error } = await requirePackagingStation("packaging");
  if (error) return error;
  try {
    const q = await packagingQueue();
    const etag = `"${q.version}"`;
    if (request.headers.get("if-none-match") === etag) return new NextResponse(null, { status: 304, headers: { ETag: etag } });
    return NextResponse.json(q, { headers: { ETag: etag, "Cache-Control": "no-store" } });
  } catch (err) {
    return handleDomainError(err);
  }
}
