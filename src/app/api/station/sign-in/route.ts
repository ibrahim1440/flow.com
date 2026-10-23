import { DEVICE_REQUIRED, DEVICE_REVOKED, StationError, currentDevice, deviceStation, stationPolicy } from "@/lib/services/station/guard";
import { stationSignIn } from "@/lib/services/station/session";

/**
 * POST /api/station/sign-in {employeeId, pin, stationId?} — S3 / S4. The device cookie, then the station PIN of
 * the SELECTED employee (never looked up by PIN). Opens a STATION session bound to this device; the
 * ERP APIs refuse it. Wrong PINs lock that employee on this device at the policy limit (D7).
 * W3: on a device that serves several stations, `stationId` is the station chosen before the
 * employee (its own by default); the session is bound to it and the assignment is checked there.
 */
export async function POST(request: Request) {
  const dev = await currentDevice();
  if (dev.state === "none" || dev.state === "unknown") return DEVICE_REQUIRED().response();
  if (dev.state === "revoked") return DEVICE_REVOKED().response();
  const raw = ((await request.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
  const station = await deviceStation(dev.device, typeof raw.stationId === "string" ? raw.stationId : null, dev.station);
  if (!station) return DEVICE_REQUIRED().response();
  try {
    return await stationSignIn(request, dev.device, station, raw, await stationPolicy());
  } catch (err) {
    if (err instanceof StationError) return err.response();
    throw err;
  }
}
