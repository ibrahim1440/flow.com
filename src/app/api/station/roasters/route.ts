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
  const { user, error } = await requireStation();
  if (error) return error;
  try {
    return NextResponse.json({ roasters: await stationRoasters(user) }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return handleDomainError(err);
  }
}
