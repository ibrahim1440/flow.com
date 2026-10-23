import { cookies } from "next/headers";
import { NextResponse } from "@/lib/api-response";
import { STATION_SESSION_COOKIE } from "@/lib/station/device";
import { DEVICE_REQUIRED, DEVICE_REVOKED, currentDevice, stationPolicy, stationSessionFor } from "@/lib/services/station/guard";
import { clearSessionCookie, endStationSession } from "@/lib/services/station/session";

/**
 * POST /api/station/lock {idle?: boolean} — S4 «قفل» (and the idle lock, D7). The session ends at
 * once (the next person, or the same one with their PIN, signs in again); the employee's task stays
 * theirs. The idle lock returns the device to the tiles (S2); «قفل» shows S4 for that employee.
 */
export async function POST(request: Request) {
  const dev = await currentDevice();
  if (dev.state === "none" || dev.state === "unknown") return DEVICE_REQUIRED().response();
  if (dev.state === "revoked") return clearSessionCookie(DEVICE_REVOKED().response());
  const raw = ((await request.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
  const jar = await cookies();
  const live = await stationSessionFor(dev.device, jar.get(STATION_SESSION_COOKIE)?.value ?? null, { touch: false, policy: await stationPolicy() });
  if (!live) return clearSessionCookie(NextResponse.json({ ended: false }, { headers: { "Cache-Control": "no-store" } }));
  const out = await endStationSession(request, { device: dev.device, ...live }, raw.idle === true ? "IDLE" : "LOCK", "keep");
  return clearSessionCookie(NextResponse.json({ ended: true, ...out }, { headers: { "Cache-Control": "no-store" } }));
}
