import { cookies } from "next/headers";
import { NextResponse } from "@/lib/api-response";
import { prisma } from "@/lib/db";
import { STATION_HOME, STATION_SESSION_COOKIE, stationInitials } from "@/lib/station/device";
import { currentDevice, deviceStation, deviceStations, stationPolicy, stationSessionFor, type StationRow } from "@/lib/services/station/guard";
import { clearDeviceCookies } from "@/lib/services/station/session";

/**
 * GET /api/station/device — what the station shell shows first (no ERP session involved):
 *   · no device cookie → { device: null }: S1 (activation), or the W1 personal sign-in;
 *   · a revoked device (or retired station) → { device: { state: "revoked" } } and the cookies are
 *     cleared (DS-15: «أُلغي تسجيل هذا الجهاز»);
 *   · an active device → its station, the idle policy and the station session, if one is live;
 *     W3: `stations` — every station the device serves (its own and the linked ones), and `station`
 *     is the live session's station.
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
  // W3: the station in use — the live session's (its own or a linked one), else the device's own.
  const current = (live ? await deviceStation(dev.device, live.session.stationId, dev.station) : null) ?? dev.station;
  const view = async (st: StationRow) => {
    const roaster = st.roasterId ? await prisma.roaster.findUnique({ where: { id: st.roasterId }, select: { id: true, name: true, status: true } }) : null;
    return { id: st.id, name: st.name, type: st.type, place: st.place, roaster, home: STATION_HOME[st.type] };
  };
  const supervisor = live ? (await prisma.stationAssignment.findUnique({ where: { stationId_employeeId: { stationId: current.id, employeeId: live.employee.id } }, select: { supervisor: true } }))?.supervisor ?? null : null;
  const served = await deviceStations(dev.device, dev.station);
  return NextResponse.json({
    device: { state: "active", id: dev.device.id, name: dev.device.displayName },
    station: await view(current),
    // Every station this device serves (one for most devices): S2 asks which, before the employee.
    stations: await Promise.all(served.map(view)),
    policy: { idleMinutes: policy.idleMinutes },
    session: live && supervisor !== null
      ? { employee: { id: live.employee.id, name: live.employee.name, initials: stationInitials(live.employee.name), supervisor, preferredLanguage: live.employee.preferredLanguage === "en" ? "en" : "ar" } }
      : null,
    serverTime: new Date().toISOString(),
  }, noStore);
}
