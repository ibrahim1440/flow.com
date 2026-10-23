import { NextResponse } from "@/lib/api-response";
import { handleDomainError } from "@/lib/api-error";
import { requireStation } from "@/lib/services/station/http";
import { stationRoasters } from "@/lib/services/station/queue";

/**
 * GET /api/station/roasters — the production roasters in service with their limits and whether the
 * caller is an assigned operator. Read by the ERP roast sheet («تسجيل دفعة») to pick the roaster and
 * warn before sending; POST /api/roasting-batches decides (D5, owner change 22 Oct 2026).
 */
export async function GET() {
  const { user, error, station } = await requireStation();
  if (error) return error;
  try {
    // A paired device lists its station's roaster only (W2).
    const roasters = (await stationRoasters(user)).filter((r) => !station || r.id === station.roasterId);
    return NextResponse.json({ roasters }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return handleDomainError(err);
  }
}
