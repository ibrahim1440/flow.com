import { NextResponse } from "@/lib/api-response";
import { DEVICE_REQUIRED, DEVICE_REVOKED, currentDevice, deviceStation } from "@/lib/services/station/guard";
import { stationRoster } from "@/lib/services/station/session";

/**
 * GET /api/station/roster[?stationId=] — S2 «من يعمل الآن؟». The device cookie only (no person is signed in yet):
 * the employees assigned to this station who have set a station PIN — name, initials, the supervisor
 * label and whether their PIN is locked on this device. No other data (H1, UR-S18, D12).
 * W3: a device that serves several stations names the chosen one (its own by default); a station the
 * device does not serve is refused like an unknown device.
 */
export async function GET(request: Request) {
  const dev = await currentDevice();
  if (dev.state === "none" || dev.state === "unknown") return DEVICE_REQUIRED().response();
  if (dev.state === "revoked") return DEVICE_REVOKED().response();
  const wanted = new URL(request.url).searchParams.get("stationId");
  const station = await deviceStation(dev.device, wanted, dev.station);
  if (!station) return DEVICE_REQUIRED().response();
  return NextResponse.json({ employees: await stationRoster(dev.device, station.id) }, { headers: { "Cache-Control": "no-store" } });
}
