import { NextResponse } from "@/lib/api-response";
import { DEVICE_REQUIRED, DEVICE_REVOKED, currentDevice } from "@/lib/services/station/guard";
import { stationRoster } from "@/lib/services/station/session";

/**
 * GET /api/station/roster — S2 «من يعمل الآن؟». The device cookie only (no person is signed in yet):
 * the employees assigned to this station who have set a station PIN — name, initials, the supervisor
 * label and whether their PIN is locked on this device. No other data (H1, UR-S18, D12).
 */
export async function GET() {
  const dev = await currentDevice();
  if (dev.state === "none" || dev.state === "unknown") return DEVICE_REQUIRED().response();
  if (dev.state === "revoked") return DEVICE_REVOKED().response();
  return NextResponse.json({ employees: await stationRoster(dev.device) }, { headers: { "Cache-Control": "no-store" } });
}
