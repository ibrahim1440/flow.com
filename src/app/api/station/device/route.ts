import { cookies } from "next/headers";
import { NextResponse } from "@/lib/api-response";
import { prisma } from "@/lib/db";
import { STATION_HOME, STATION_SESSION_COOKIE, stationInitials } from "@/lib/station/device";
import { currentDevice, stationPolicy, stationSessionFor } from "@/lib/services/station/guard";
import { clearDeviceCookies } from "@/lib/services/station/session";

/**
 * GET /api/station/device — what the station shell shows first (no ERP session involved):
 *   · no device cookie → { device: null }: S1 (activation), or the W1 personal sign-in;
 *   · a revoked device (or retired station) → { device: { state: "revoked" } } and the cookies are
 *     cleared (DS-15: «أُلغي تسجيل هذا الجهاز»);
 *   · an active device → its station, the idle policy and the station session, if one is live.
 * Reading it is not activity: it never extends a station session's idle clock.
 */
export async function GET() {
  const dev = await currentDevice();
  const noStore = { headers: { "Cache-Control": "no-store" } };
  if (dev.state === "none") return NextResponse.json({ device: null }, noStore);
  if (dev.state === "unknown") return clearDeviceCookies(NextResponse.json({ device: { state: "unknown" } }, noStore));
  if (dev.state === "revoked") return clearDeviceCookies(NextResponse.json({ device: { state: "revoked", name: dev.device.displayName } }, noStore));
  const policy = await stationPolicy();
  const jar = await cookies();
  const live = await stationSessionFor(dev.device, jar.get(STATION_SESSION_COOKIE)?.value ?? null, { touch: false, policy });
  const roaster = dev.station.roasterId ? await prisma.roaster.findUnique({ where: { id: dev.station.roasterId }, select: { id: true, name: true, status: true } }) : null;
  const supervisor = live ? (await prisma.stationAssignment.findUnique({ where: { stationId_employeeId: { stationId: dev.station.id, employeeId: live.employee.id } }, select: { supervisor: true } }))?.supervisor ?? null : null;
  return NextResponse.json({
    device: { state: "active", id: dev.device.id, name: dev.device.displayName },
    station: { id: dev.station.id, name: dev.station.name, type: dev.station.type, place: dev.station.place, roaster, home: STATION_HOME[dev.station.type] },
    policy: { idleMinutes: policy.idleMinutes },
    session: live && supervisor !== null
      ? { employee: { id: live.employee.id, name: live.employee.name, initials: stationInitials(live.employee.name), supervisor, preferredLanguage: live.employee.preferredLanguage === "en" ? "en" : "ar" } }
      : null,
    serverTime: new Date().toISOString(),
  }, noStore);
}
