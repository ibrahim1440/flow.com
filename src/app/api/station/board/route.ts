import { NextResponse } from "@/lib/api-response";
import { handleDomainError } from "@/lib/api-error";
import { boardSnapshot, requireBoardViewer } from "@/lib/services/station/board";

/**
 * GET /api/station/board — «لوحة الطلبات المباشرة» (D15, option C): every order on the board, its stage and the open
 * columns. Read-only. A board device (no employee session) or, off a device, an ERP session with the orders module
 * (services/station/board.ts). Polled every 10 s with a version (H5): an unchanged board answers 304 without a body, so a
 * wall screen costs one small request per poll. No customer, price or payment field is ever in the answer.
 */
export async function GET(request: Request) {
  const g = await requireBoardViewer();
  if (g.error) return g.error;
  try {
    const board = await boardSnapshot();
    const etag = `"${board.version}"`;
    if (request.headers.get("if-none-match") === etag) return new NextResponse(null, { status: 304, headers: { ETag: etag, "Cache-Control": "no-store" } });
    return NextResponse.json(board, { headers: { ETag: etag, "Cache-Control": "no-store" } });
  } catch (err) {
    return handleDomainError(err);
  }
}
