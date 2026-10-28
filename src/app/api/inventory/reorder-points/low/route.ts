import { NextResponse } from "@/lib/api-response";
import { requireAnyModule } from "@/lib/auth-server";
import { handleDomainError } from "@/lib/api-error";
import { lowBySite } from "@/lib/services/stock-reorder";

/**
 * GET /api/inventory/reorder-points/low[?location=<id>] — «تحت حد إعادة الطلب» per location: every green lot / material
 * whose balance at a site is at or below that site's reorder point (20261117090000_locations_enhancements).
 */
export async function GET(request: Request) {
  const { error } = await requireAnyModule("inventory", "packaging", "production", "purchases");
  if (error) return error;
  try {
    return NextResponse.json({ low: await lowBySite(new URL(request.url).searchParams.get("location")) });
  } catch (err) {
    return handleDomainError(err);
  }
}
