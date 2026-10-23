// Workstations W2 — the station device, the station session and the station guard (server).
//
// The order of checks on every station API (CORE-INTERFACES §H8, PLAN §6 W2):
//   1. a registered, ACTIVE device (the hq_station cookie, stored hashed) of an ACTIVE station;
//   2. a live STATION session bound to THAT device and station (hq_station_session; idle per the
//      policy, absolute 8 h, revocation and credential changes end it at the next request);
//   3. station access: the employee is assigned to the station (UR-13), active, not the admin
//      role (D12);
//   4. the module privilege the station's work needs (the same key the ERP guard checks);
//   5. never a privileged key: the station actor carries no privileged permission at all.
// A browser with NO station device cookie is the W1 personal session: the ordinary ERP session and
// the same module privilege, exactly as before (owner decision: W1 keeps working off a device).
import { cookies, headers } from "next/headers";
import { NextResponse } from "@/lib/api-response";
import { prisma } from "@/lib/db";
import { verifyToken, parsePermissions, buildDefaultPermissions } from "@/lib/auth";
import { credentialVersion } from "@/lib/credential-version";
import { forbidden, isPrivilegedKey, requireAuth, requireSub, requireEdit, type SessionUser } from "@/lib/auth-server";
import { revokeSession } from "@/lib/auth/session";
import { hashRateLimitKey } from "@/lib/rate-limit";
import {
  STATION_DEVICE_COOKIE, STATION_SESSION_COOKIE, STATION_PRIVILEGE, STATION_TAB_PRIVILEGE, STATION_TYPE_TABS, deviceTokenHash, effectivePolicy, validDeviceToken,
  type StationPolicyValues, type StationTab, type StationType,
} from "@/lib/station/device";
import { holdsPrivilege, holdsStationPrivilege, isAdminRole, stationIdleExpired, stationPermissions } from "@/lib/station/access";

export type StationRow = { id: string; name: string; type: StationType; place: string | null; roasterId: string | null; status: string };
export type DeviceRow = { id: string; stationId: string; displayName: string; status: string; lastSeenAt: Date | null };
export type StationActor = SessionUser & { scope: "STATION"; stationId: string; stationDeviceId: string; supervisor: boolean };

/** A refusal of the station: a stable code the screen maps to S1 / S2 / S7 / DS-15, in both languages. */
export class StationError extends Error {
  constructor(readonly status: number, readonly code: string, readonly ar: string, readonly en: string, readonly extra: Record<string, unknown> = {}) {
    super(en);
    this.name = "StationError";
  }
  response() {
    return NextResponse.json({ error: this.ar, errorEn: this.en, code: this.code, ...this.extra }, { status: this.status, headers: { "Cache-Control": "no-store" } });
  }
}
export const DEVICE_REQUIRED = () => new StationError(401, "STATION_DEVICE_REQUIRED", "هذا الجهاز غير مسجّل كمحطة.", "This device is not registered as a station.");
export const DEVICE_REVOKED = () => new StationError(401, "STATION_DEVICE_REVOKED", "أُلغي تسجيل هذا الجهاز. لا يمكن الدخول عليه حتى يُسجَّل من جديد.", "This device was revoked. Nobody can sign in on it until it is registered again.");
export const SESSION_REQUIRED = () => new StationError(401, "STATION_SESSION_REQUIRED", "انتهت الجلسة. اختر اسمك ثم أدخل رمز المحطة.", "The session ended. Choose your name and enter the station PIN.");
export const NOT_ASSIGNED = (name: string, station: string) => new StationError(403, "STATION_NOT_ASSIGNED", `${name} غير مكلّف بهذه المحطة. اطلب من المشرف أو مسؤول النظام إضافة «${station}» إلى محطاتك.`, `${name} is not assigned to this station.`);
export const NO_PRIVILEGE = () => new StationError(403, "STATION_PRIVILEGE_REQUIRED", "لا تملك صلاحية العمل في هذه المحطة. اطلب من مسؤول النظام منحك صلاحية الوحدة.", "You do not hold the module privilege this station's work needs.");
export const WRONG_STATION = () => new StationError(403, "STATION_TYPE_MISMATCH", "هذه الشاشة ليست لهذه المحطة.", "This screen does not belong to this station.");

/** The policy row (D7), or the approved defaults. */
export async function stationPolicy(): Promise<StationPolicyValues> {
  const row = await prisma.stationPolicy.findUnique({ where: { id: "singleton" } }).catch(() => null);
  return effectivePolicy(row);
}

/** One station audit row (AuthAuditLog, sourceInterface STATION). Never a PIN, code or token. */
export async function stationAudit(e: { userId?: string | null; action: string; result: "SUCCESS" | "FAILURE" | "REFUSED"; reasonCode?: string | null; device?: { id: string; stationId: string; displayName?: string } | null; metadata?: Record<string, unknown>; ip?: string; userAgent?: string | null }) {
  await prisma.authAuditLog.create({
    data: {
      userId: e.userId ?? null, action: e.action, result: e.result, reasonCode: e.reasonCode ?? null, sourceInterface: "STATION",
      identifierHash: e.device ? hashRateLimitKey(`station-device:${e.device.id}`) : null,
      ipHash: hashRateLimitKey(e.ip ?? "0.0.0.0"), userAgent: e.userAgent?.slice(0, 300) ?? null,
      metadata: { ...(e.device ? { stationDeviceId: e.device.id, stationId: e.device.stationId, ...(e.device.displayName ? { deviceName: e.device.displayName } : {}) } : {}), ...(e.metadata ?? {}) } as never,
    },
  }).catch((err: unknown) => console.error("[station] audit not written:", err instanceof Error ? err.message : err));
}

const TOUCH_DEVICE_MS = 60_000;
const TOUCH_SESSION_MS = 15_000;

export type DeviceState =
  | { state: "none" }
  | { state: "unknown" }
  | { state: "revoked"; device: DeviceRow }
  | { state: "active"; device: DeviceRow; station: StationRow };

/** The device a Cookie value names (steps 1 of H8). A revoked device or a retired station is "revoked". */
export async function deviceFromToken(token: string | null | undefined): Promise<DeviceState> {
  if (!token) return { state: "none" };
  if (!validDeviceToken(token)) return { state: "unknown" };
  const d = await prisma.stationDevice.findUnique({
    where: { tokenHash: deviceTokenHash(token) },
    select: { id: true, stationId: true, displayName: true, status: true, lastSeenAt: true, station: { select: { id: true, name: true, type: true, place: true, roasterId: true, status: true } } },
  });
  if (!d) return { state: "unknown" };
  const device: DeviceRow = { id: d.id, stationId: d.stationId, displayName: d.displayName, status: d.status, lastSeenAt: d.lastSeenAt };
  if (d.status !== "ACTIVE" || d.station.status !== "ACTIVE") return { state: "revoked", device };
  // «آخر ظهور» (UR-14): from the device's requests, written at most once a minute.
  if (!d.lastSeenAt || Date.now() - d.lastSeenAt.getTime() > TOUCH_DEVICE_MS) {
    await prisma.stationDevice.updateMany({ where: { id: d.id, status: "ACTIVE" }, data: { lastSeenAt: new Date() } }).catch(() => undefined);
  }
  return { state: "active", device, station: { ...d.station, type: d.station.type as StationType } };
}

export async function currentDevice(): Promise<DeviceState> {
  const jar = await cookies();
  return deviceFromToken(jar.get(STATION_DEVICE_COOKIE)?.value ?? null);
}

type LiveStationSession = { id: string; employeeId: string; createdAt: Date; lastSeenAt: Date; expiresAt: Date; stationId: string };

const STATION_ROW_SELECT = { id: true, name: true, type: true, place: true, roasterId: true, status: true } as const;

/**
 * Workstations W3 — the stations a device serves: its own (registration) and every ACTIVE station
 * the administrator linked to it (StationDeviceStation: the same iPad at the roaster and in QC). The
 * station is chosen on the device BEFORE the employee; the session is bound to that choice.
 */
export async function deviceStations(device: { id: string; stationId: string }, home?: StationRow): Promise<StationRow[]> {
  const own = home ?? ((await prisma.station.findUnique({ where: { id: device.stationId }, select: STATION_ROW_SELECT })) as StationRow | null);
  const links = await prisma.stationDeviceStation.findMany({ where: { stationDeviceId: device.id, station: { status: "ACTIVE" } }, select: { station: { select: STATION_ROW_SELECT } }, orderBy: { createdAt: "asc" } });
  const out: StationRow[] = own && own.status === "ACTIVE" ? [own] : [];
  for (const l of links) if (!out.some((x) => x.id === l.station.id)) out.push({ ...l.station, type: l.station.type as StationType });
  return out;
}

/** One station this device may serve (its own or a linked ACTIVE one), or null. */
export async function deviceStation(device: { id: string; stationId: string }, stationId: string | null | undefined, home?: StationRow): Promise<StationRow | null> {
  if (!stationId || stationId === device.stationId) return home ?? ((await prisma.station.findUnique({ where: { id: device.stationId }, select: STATION_ROW_SELECT })) as StationRow | null);
  const link = await prisma.stationDeviceStation.findUnique({ where: { stationDeviceId_stationId: { stationDeviceId: device.id, stationId } }, select: { station: { select: STATION_ROW_SELECT } } });
  if (!link || link.station.status !== "ACTIVE") return null;
  return { ...link.station, type: link.station.type as StationType };
}

/**
 * The STATION session the cookie names, bound to this device (step 2 of H8), or null. Ends it here
 * when it is idle past the policy (D7) — the employee is back at the tiles — or no longer valid.
 * `touch` false for the station's background polls: a poll is not activity.
 */
export async function stationSessionFor(device: { id: string; stationId: string }, token: string | null | undefined, opts: { touch: boolean; policy: StationPolicyValues; request?: { ip?: string; userAgent?: string | null } }): Promise<{ session: LiveStationSession; employee: { id: string; name: string; role: string; permissions: string; preferredLanguage: string } } | null> {
  if (!token) return null;
  const payload = await verifyToken(token);
  if (!payload?.sid || payload.scope !== "STATION") return null;
  const s = await prisma.authSession.findUnique({ where: { id: payload.sid } });
  if (!s || s.scope !== "STATION" || s.employeeId !== payload.id || s.revokedAt) return null;
  if (s.stationDeviceId !== device.id || !s.stationId) return null;
  // W3: a session on a linked station stays valid only while the link and that station do.
  if (s.stationId !== device.stationId && !(await deviceStation(device, s.stationId))) return null;
  const now = Date.now();
  if (now >= s.expiresAt.getTime()) return null;
  if (stationIdleExpired(s.lastSeenAt, now, opts.policy.idleMinutes)) {
    await revokeSession(s.id, "STATION_IDLE");
    await stationAudit({ userId: s.employeeId, action: "STATION_SIGN_OUT", result: "SUCCESS", reasonCode: "IDLE", device, ip: opts.request?.ip, userAgent: opts.request?.userAgent });
    return null;
  }
  const e = await prisma.employee.findUnique({ where: { id: s.employeeId }, select: { id: true, name: true, role: true, permissions: true, preferredLanguage: true, active: true, username: true, pin: true, password: true } });
  if (!e || !e.active) return null;
  if (payload.cv !== credentialVersion(e)) return null;
  // D12: the admin role never works at a station device (a role changed to admin since sign-in ends it).
  if (isAdminRole(e.role)) { await revokeSession(s.id, "STATION_ADMIN_REFUSED"); return null; }
  if (opts.touch && now - s.lastSeenAt.getTime() > TOUCH_SESSION_MS) {
    await prisma.authSession.updateMany({ where: { id: s.id, revokedAt: null }, data: { lastSeenAt: new Date(now) } });
  }
  return { session: { id: s.id, employeeId: s.employeeId, createdAt: s.createdAt, lastSeenAt: s.lastSeenAt, expiresAt: s.expiresAt, stationId: s.stationId }, employee: e };
}

/** The station employee as the services see a caller: effective permissions, no privileged key. */
export function stationActorOf(employee: { id: string; name: string; role: string; permissions: string; preferredLanguage: string }, session: Omit<LiveStationSession, "stationId"> & { stationId?: string }, device: DeviceRow, supervisor: boolean): StationActor {
  let perms = parsePermissions(employee.permissions);
  if (!perms || Object.keys(perms).length === 0) perms = buildDefaultPermissions(employee.role);
  const permissions = stationPermissions(perms);
  return {
    id: employee.id, name: employee.name, role: employee.role, permissions, preferredLanguage: employee.preferredLanguage === "en" ? "en" : "ar",
    sid: session.id, authTime: session.createdAt, sessionId: session.id, sessionMethod: "PIN", sessionMfa: false, authFactor: null,
    privileged: false, mfaEnrollmentRequired: false, passwordChangeRequired: false,
    scope: "STATION", stationId: session.stationId ?? device.stationId, stationDeviceId: device.id, supervisor,
  };
}

export type StationContext =
  | { mode: "device"; user: StationActor; station: StationRow; device: DeviceRow; error: null }
  | { mode: "personal"; user: SessionUser; station: null; device: null; error: null }
  | { mode: null; user: null; station: null; device: null; error: NextResponse };

/**
 * The station guard (H8). `type` is the station screen asking; `tab` (W4, the packaging station) is
 * the tab whose APIs are called — its own module privilege («التعبئة»: packaging at edit; «تجهيز
 * الطلبات»: dispatch at edit). Without a tab, a station with tabs needs either one (the station's
 * own reads). On a paired device: the five steps above; off a device: the W1 personal ERP session
 * with the same module privilege (requireSub / requireEdit, as the ERP).
 */
export async function requireStationContext(type: StationType, tab?: StationTab): Promise<StationContext> {
  const tabbed = !tab && STATION_TYPE_TABS[type].length > 0;
  const need = tab ? STATION_TAB_PRIVILEGE[tab] : STATION_PRIVILEGE[type];
  // Step 5, asserted where the key is chosen: a station never asks for a privileged key.
  if (isPrivilegedKey(need.module, need.sub ?? undefined)) throw new Error(`station guard: ${need.module}.${need.sub} is privileged`);
  for (const n of tabbed ? STATION_TYPE_TABS[type].map((t) => STATION_TAB_PRIVILEGE[t]) : []) {
    if (isPrivilegedKey(n.module, n.sub ?? undefined)) throw new Error(`station guard: ${n.module}.${n.sub} is privileged`);
  }
  const jar = await cookies();
  const deviceToken = jar.get(STATION_DEVICE_COOKIE)?.value ?? null;
  const fail = (e: StationError) => ({ mode: null, user: null, station: null, device: null, error: e.response() }) as const;
  if (!deviceToken) {
    if (tabbed) {
      const r = await requireAuth();
      if (r.error) return { mode: null, user: null, station: null, device: null, error: r.error };
      if (!holdsStationPrivilege(r.user.permissions, type)) return { mode: null, user: null, station: null, device: null, error: forbidden() };
      return { mode: "personal", user: r.user, station: null, device: null, error: null };
    }
    const r = need.sub ? await requireSub(need.module, need.sub) : await requireEdit(need.module);
    if (r.error) return { mode: null, user: null, station: null, device: null, error: r.error };
    return { mode: "personal", user: r.user, station: null, device: null, error: null };
  }
  const dev = await deviceFromToken(deviceToken);
  if (dev.state === "none" || dev.state === "unknown") return fail(DEVICE_REQUIRED());
  if (dev.state === "revoked") return fail(DEVICE_REVOKED());
  const h = await headers();
  const policy = await stationPolicy();
  const live = await stationSessionFor(dev.device, jar.get(STATION_SESSION_COOKIE)?.value ?? null, { touch: h.get("x-station-poll") !== "1", policy });
  if (!live) return fail(SESSION_REQUIRED());
  // W3: the session's station — the device's own, or a linked one chosen before the employee.
  const station = await deviceStation(dev.device, live.session.stationId, dev.station);
  if (!station) return fail(SESSION_REQUIRED());
  const assignment = await prisma.stationAssignment.findUnique({ where: { stationId_employeeId: { stationId: station.id, employeeId: live.employee.id } }, select: { supervisor: true } });
  if (!assignment) return fail(NOT_ASSIGNED(live.employee.name, station.name));
  if (station.type !== type) return fail(WRONG_STATION());
  const actor = stationActorOf(live.employee, live.session, dev.device, assignment.supervisor);
  if (!(tab ? holdsPrivilege(actor.permissions, need) : holdsStationPrivilege(actor.permissions, type))) return fail(NO_PRIVILEGE());
  return { mode: "device", user: actor, station, device: dev.device, error: null };
}
