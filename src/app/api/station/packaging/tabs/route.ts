import { NextResponse } from "@/lib/api-response";
import { requirePackagingStation } from "@/lib/services/station/http";
import { stationTabsHeld } from "@/lib/station/access";

/**
 * GET /api/station/packaging/tabs — the tabs of the packaging station the caller may work in
 * («التعبئة»: packaging at edit; «تجهيز الطلبات»: dispatch at edit). On a paired device, from the
 * station employee's permissions (no privileged key); off a device, from the ERP session.
 */
export async function GET() {
  const { user, error, mode, station } = await requirePackagingStation();
  if (error) return error;
  return NextResponse.json({ tabs: stationTabsHeld(user.permissions, "PACKAGING"), mode, station: station ? { id: station.id, name: station.name, place: station.place } : null }, { headers: { "Cache-Control": "no-store" } });
}
