import { NextResponse } from "@/lib/api-response";
import { handleDomainError } from "@/lib/api-error";
import { requirePackagingStation } from "@/lib/services/station/http";
import { prepQueue } from "@/lib/services/station/prep";

/**
 * GET /api/station/prep/queue — P1 «طلبات للتجهيز» (order lines whose units are reserved on
 * finished-goods lots, oldest order first), P5 (orders on hold: the status wins) and the caller's
 * own claimed order (S5). Customers by name and order number only (F4). 304 when unchanged (H5).
 */
export async function GET(request: Request) {
  const { user, error } = await requirePackagingStation("preparation");
  if (error) return error;
  try {
    const q = await prepQueue(user);
    const etag = `"${q.version}"`;
    if (request.headers.get("if-none-match") === etag) return new NextResponse(null, { status: 304, headers: { ETag: etag } });
    return NextResponse.json(q, { headers: { ETag: etag, "Cache-Control": "no-store" } });
  } catch (err) {
    return handleDomainError(err);
  }
}
