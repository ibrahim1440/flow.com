import { cookies } from "next/headers";
import { NextResponse } from "@/lib/api-response";
import { STATION_DEVICE_COOKIE } from "@/lib/station/device";
import { StationError } from "@/lib/services/station/guard";
import { activateDevice, setDeviceCookie } from "@/lib/services/station/session";

/**
 * POST /api/station/activate {deviceCode, activationCode} — S1 «تفعيل الجهاز». No session: the
 * one-time activation code the administrator issued for THIS device code (UR-14b) is the proof.
 * Sets the hq_station cookie (httpOnly, Secure, SameSite=Strict; 32 random bytes, kept hashed).
 */
export async function POST(request: Request) {
  const raw = ((await request.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
  try {
    const jar = await cookies();
    const { token, device } = await activateDevice(request, raw, jar.get(STATION_DEVICE_COOKIE)?.value ?? null);
    return setDeviceCookie(NextResponse.json({ activated: true, station: { name: device.station.name, type: device.station.type, place: device.station.place } }, { status: 200, headers: { "Cache-Control": "no-store" } }), token);
  } catch (err) {
    if (err instanceof StationError) return err.response();
    throw err;
  }
}
