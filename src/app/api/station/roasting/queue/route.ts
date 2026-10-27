import { NextResponse } from "@/lib/api-response";
import { handleDomainError } from "@/lib/api-error";
import { requireStation } from "@/lib/services/station/http";
import { stationQueue } from "@/lib/services/station/queue";
import { checkGreenReadinessSoon } from "@/lib/services/green-readiness";

/**
 * GET /api/station/roasting/queue[?roasterId=] — the roasting station's queue (R1/R5), the
 * selected roaster and the caller's own active roast. Polled with a version (H5): the ETag is the
 * content version, so an unchanged queue answers 304.
 */
export async function GET(request: Request) {
  const { user, error, station } = await requireStation();
  if (error) return error;
  try {
    // A paired device works on its station's roaster only (W2); a personal session picks one.
    const roasterId = station ? station.roasterId : new URL(request.url).searchParams.get("roasterId");
    const q = await stationQueue(user, { roasterId, fixedRoaster: !!station });
    // The supervisor's alert when coming roasts' green is at another site (after the response, throttled).
    checkGreenReadinessSoon(user);
    const etag = `"${q.version}"`;
    if (request.headers.get("if-none-match") === etag) return new NextResponse(null, { status: 304, headers: { ETag: etag } });
    return NextResponse.json(q, { headers: { ETag: etag, "Cache-Control": "no-store" } });
  } catch (err) {
    return handleDomainError(err);
  }
}
