import { cookies } from "next/headers";
import { NextResponse } from "@/lib/api-response";
import { STATION_SESSION_COOKIE } from "@/lib/station/device";
import { DEVICE_REQUIRED, DEVICE_REVOKED, StationError, currentDevice, stationPolicy, stationSessionFor } from "@/lib/services/station/guard";
import { clearSessionCookie, endStationSession } from "@/lib/services/station/session";

/**
 * POST /api/station/sign-out {mode: "switch" | "sign_out", claims: "keep" | "release"} — S5 «إنهاء
 * جلستي والتبديل» (and a plain sign-out). Ends the station session; the device stays registered.
 * claims = "release" releases the outgoing employee's active task for a colleague (logged in their
 * name, no stock moves); the default keeps it (never released without their choice).
 */
export async function POST(request: Request) {
  const dev = await currentDevice();
  if (dev.state === "none" || dev.state === "unknown") return DEVICE_REQUIRED().response();
  if (dev.state === "revoked") return clearSessionCookie(DEVICE_REVOKED().response());
  const raw = ((await request.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
  const jar = await cookies();
  const live = await stationSessionFor(dev.device, jar.get(STATION_SESSION_COOKIE)?.value ?? null, { touch: false, policy: await stationPolicy() });
  if (!live) return clearSessionCookie(NextResponse.json({ ended: false }, { headers: { "Cache-Control": "no-store" } }));
  try {
    const out = await endStationSession(request, { device: dev.device, ...live }, raw.mode === "switch" ? "SWITCH" : "SIGN_OUT", raw.claims === "release" ? "release" : "keep");
    return clearSessionCookie(NextResponse.json({ ended: true, ...out }, { headers: { "Cache-Control": "no-store" } }));
  } catch (err) {
    if (err instanceof StationError) return err.response();
    throw err;
  }
}
