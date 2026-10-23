// Workstations W2 — the administrator's side (Figma UR-13, UR-14, UR-14b): stations, their devices
// and one-time activation codes, who may sign in where, the station policy, and the station PIN's
// reset and re-enable (UR-04). Every route calling these runs requireAdminAction first (the admin
// role, a verified individual — SIMPLE MODE waives that — and, for every change, a recent step-up).
// Every change is audited (AuthAuditLog, sourceInterface WEB, actor = the administrator).
import { Prisma } from "@/generated/prisma/client";
import { prisma, TX_OPTS } from "@/lib/db";
import type { SessionUser } from "@/lib/auth-server";
import { parsePermissions, buildDefaultPermissions } from "@/lib/auth-shared";
import { simpleModePermissions } from "@/lib/simple-mode";
import { UsersError } from "@/lib/users/errors";
import { auditContext } from "@/lib/users/account-update";
import { recordUsersAudit } from "@/lib/users/server";
import {
  STATION_TYPES, activationCodeHash, effectivePolicy, newActivationCode, normalizeDeviceCode, policyValue,
  type StationType,
} from "@/lib/station/device";
import { accessNow, holdsStationPrivilege, isAdminRole, type AccessNow } from "@/lib/station/access";

type Db = Prisma.TransactionClient | typeof prisma;
const secret = () => process.env.JWT_SECRET ?? "";
const text = (v: unknown, max: number) => (typeof v === "string" ? v.trim().replace(/\s+/g, " ").slice(0, max) : "");
const reasonOf = (v: unknown) => text(v, 300);

export const STATION_TYPE_AR: Record<StationType, { ar: string; en: string }> = {
  ROASTING: { ar: "التحميص", en: "Roasting" }, QUALITY: { ar: "الجودة", en: "Quality" }, PACKAGING: { ar: "التعبئة والتجهيز", en: "Packaging & fulfilment" },
};

// ── Reads ──────────────────────────────────────────────────────────────────────────────────────
export async function stationsOverview() {
  const [stations, policyRow, roasters] = await Promise.all([
    prisma.station.findMany({
      orderBy: [{ status: "asc" }, { createdAt: "asc" }],
      include: {
        devices: { orderBy: [{ registeredAt: "desc" }], select: { extraStations: { select: { stationId: true } }, id: true, displayName: true, deviceCode: true, status: true, activationExpiresAt: true, activationCodeHash: true, activatedAt: true, lastSeenAt: true, registeredAt: true, registeredByName: true, revokedAt: true, revokedByName: true, revokeReason: true } },
        _count: { select: { assignments: true } },
      },
    }),
    prisma.stationPolicy.findUnique({ where: { id: "singleton" } }),
    prisma.roaster.findMany({ where: { status: { not: "RETIRED" } }, orderBy: [{ isDefault: "desc" }, { name: "asc" }], select: { id: true, name: true, type: true, status: true } }),
  ]);
  const roasterName = new Map(roasters.map((r) => [r.id, r.name]));
  const now = Date.now();
  return {
    stations: stations.map((s) => ({
      id: s.id, name: s.name, type: s.type, place: s.place, status: s.status, roasterId: s.roasterId, roasterName: s.roasterId ? roasterName.get(s.roasterId) ?? null : null,
      assigned: s._count.assignments, createdAt: s.createdAt.toISOString(), createdByName: s.createdByName,
    })),
    devices: stations.flatMap((s) => s.devices.map((d) => ({
      id: d.id, name: d.displayName, deviceCode: d.deviceCode, status: d.status, stationId: s.id, stationName: s.name, stationType: s.type, place: s.place,
      alsoStationIds: d.extraStations.map((x) => x.stationId),
      codeLive: d.status === "PENDING" && !!d.activationCodeHash && !!d.activationExpiresAt && d.activationExpiresAt.getTime() > now,
      codeExpiresAt: d.activationExpiresAt?.toISOString() ?? null, activatedAt: d.activatedAt?.toISOString() ?? null, lastSeenAt: d.lastSeenAt?.toISOString() ?? null,
      registeredAt: d.registeredAt.toISOString(), registeredByName: d.registeredByName, revokedAt: d.revokedAt?.toISOString() ?? null, revokedByName: d.revokedByName, revokeReason: d.revokeReason,
    }))).sort((a, b) => (a.status === "REVOKED" ? 1 : 0) - (b.status === "REVOKED" ? 1 : 0) || b.registeredAt.localeCompare(a.registeredAt)),
    policy: { ...effectivePolicy(policyRow), stored: { idleMinutes: policyRow?.idleMinutes ?? null, pinMaxAttempts: policyRow?.pinMaxAttempts ?? null, activationMinutes: policyRow?.activationMinutes ?? null } },
    roasters: roasters.filter((r) => r.type === "PRODUCTION"),
  };
}

// ── Stations ───────────────────────────────────────────────────────────────────────────────────
async function stationFields(raw: Record<string, unknown>, partial: boolean) {
  const out: { name?: string; type?: StationType; place?: string | null; roasterId?: string | null } = {};
  if (!partial || raw.name !== undefined) {
    const name = text(raw.name, 80);
    if (!name) throw new UsersError(400, "STATION_NAME_REQUIRED", "اسم المحطة مطلوب.", "The station name is required.");
    out.name = name;
  }
  if (!partial || raw.type !== undefined) {
    if (!STATION_TYPES.includes(raw.type as StationType)) throw new UsersError(400, "STATION_TYPE_INVALID", "نوع المحطة غير صالح.", "The station type is not valid.");
    out.type = raw.type as StationType;
  }
  if (!partial || raw.place !== undefined) out.place = text(raw.place, 80) || null;
  if (!partial || raw.roasterId !== undefined) {
    const id = typeof raw.roasterId === "string" && raw.roasterId ? raw.roasterId : null;
    if (id) {
      const r = await prisma.roaster.findUnique({ where: { id }, select: { type: true, status: true } });
      if (!r || r.status === "RETIRED" || r.type !== "PRODUCTION") throw new UsersError(400, "ROASTER_INVALID", "اختر حمّاصة إنتاج في الخدمة.", "Choose a production roaster in service.");
    }
    out.roasterId = id;
  }
  return out;
}

export async function createStation(request: Request, user: SessionUser, raw: Record<string, unknown>) {
  const f = await stationFields(raw, false);
  if (f.type !== "ROASTING" && f.roasterId) throw new UsersError(400, "ROASTER_ONLY_ROASTING", "الحمّاصة لمحطة التحميص فقط.", "Only a roasting station names a roaster.");
  if (f.type === "ROASTING" && !f.roasterId) throw new UsersError(400, "ROASTER_REQUIRED", "اختر حمّاصة محطة التحميص.", "Choose the roasting station's roaster.");
  const dup = await prisma.station.findFirst({ where: { name: { equals: f.name!, mode: "insensitive" }, status: "ACTIVE" }, select: { id: true } });
  if (dup) throw new UsersError(409, "STATION_NAME_TAKEN", "يوجد محطة بهذا الاسم.", "A station with this name exists.");
  const ctx = auditContext(request, user.id);
  return prisma.$transaction(async (tx) => {
    const s = await tx.station.create({ data: { name: f.name!, type: f.type!, place: f.place ?? null, roasterId: f.roasterId ?? null, createdById: user.id, createdByName: user.name } });
    await recordUsersAudit(tx, ctx, "STATION_CREATED", { stationId: s.id, stationName: s.name, type: s.type, place: s.place, roasterId: s.roasterId });
    return s;
  }, TX_OPTS);
}

export async function updateStation(request: Request, user: SessionUser, id: string, raw: Record<string, unknown>) {
  const s = await prisma.station.findUnique({ where: { id } });
  if (!s) throw new UsersError(404, "NOT_FOUND", "المحطة غير موجودة.", "Station not found.");
  const f = await stationFields({ ...raw, type: undefined }, true);
  const status = raw.status === "RETIRED" ? "RETIRED" : raw.status === "ACTIVE" ? "ACTIVE" : undefined;
  if (s.type !== "ROASTING" && f.roasterId) throw new UsersError(400, "ROASTER_ONLY_ROASTING", "الحمّاصة لمحطة التحميص فقط.", "Only a roasting station names a roaster.");
  if (s.type === "ROASTING" && f.roasterId === null) throw new UsersError(400, "ROASTER_REQUIRED", "اختر حمّاصة محطة التحميص.", "Choose the roasting station's roaster.");
  const ctx = auditContext(request, user.id);
  return prisma.$transaction(async (tx) => {
    const updated = await tx.station.update({ where: { id }, data: { ...f, ...(status ? { status } : {}) } });
    // A retired station works nowhere: every session on its devices ends now (the devices are refused).
    let ended = 0;
    if (status === "RETIRED" && s.status !== "RETIRED") ended = (await tx.authSession.updateMany({ where: { stationId: id, revokedAt: null }, data: { revokedAt: new Date(), revokedReason: "STATION_RETIRED" } })).count;
    await recordUsersAudit(tx, ctx, "STATION_UPDATED", { stationId: id, stationName: updated.name, before: { name: s.name, place: s.place, roasterId: s.roasterId, status: s.status }, after: { name: updated.name, place: updated.place, roasterId: updated.roasterId, status: updated.status }, sessionsEnded: ended, reason: reasonOf(raw.reason) || undefined });
    return updated;
  }, TX_OPTS);
}

// ── Devices and activation codes (UR-14, UR-14b) ───────────────────────────────────────────────
async function issueCode(tx: Db, deviceId: string, deviceCode: string) {
  const policy = effectivePolicy(await tx.stationPolicy.findUnique({ where: { id: "singleton" } }));
  const code = newActivationCode();
  const expiresAt = new Date(Date.now() + policy.activationMinutes * 60_000);
  await tx.stationDevice.update({ where: { id: deviceId }, data: { deviceCode, activationCodeHash: activationCodeHash(code, deviceCode, secret()), activationExpiresAt: expiresAt, activationAttempts: 0 } });
  return { code, expiresAt };
}

/** «تسجيل جهاز»: a PENDING device of an active station, and its one-time activation code (shown once). */
export async function registerDevice(request: Request, user: SessionUser, stationId: string, raw: Record<string, unknown>) {
  const st = await prisma.station.findUnique({ where: { id: stationId } });
  if (!st || st.status !== "ACTIVE") throw new UsersError(404, "NOT_FOUND", "المحطة غير موجودة أو موقوفة.", "Station not found or retired.");
  const deviceCode = normalizeDeviceCode(raw.deviceCode);
  if (!deviceCode) throw new UsersError(400, "DEVICE_CODE_INVALID", "رمز الجهاز غير صالح. انسخه كما يظهر على الجهاز (مثل WS-7F3K).", "The device code is not valid (e.g. WS-7F3K).");
  const name = text(raw.name, 80) || st.name;
  const ctx = auditContext(request, user.id);
  return prisma.$transaction(async (tx) => {
    const d = await tx.stationDevice.create({ data: { stationId, displayName: name, deviceCode, registeredById: user.id, registeredByName: user.name } });
    const { code, expiresAt } = await issueCode(tx, d.id, deviceCode);
    await recordUsersAudit(tx, ctx, "STATION_REGISTERED", { stationDeviceId: d.id, deviceName: name, stationId, stationName: st.name, expiresAt: expiresAt.toISOString() });
    return { device: { id: d.id, name, stationName: st.name, deviceCode }, activationCode: code, expiresAt: expiresAt.toISOString() };
  }, TX_OPTS);
}

/** «رمز جديد»: a new one-time code for a PENDING device (the earlier one stops working). */
export async function reissueCode(request: Request, user: SessionUser, deviceId: string, raw: Record<string, unknown>) {
  const d = await prisma.stationDevice.findUnique({ where: { id: deviceId }, include: { station: { select: { name: true, status: true } } } });
  if (!d) throw new UsersError(404, "NOT_FOUND", "الجهاز غير موجود.", "Device not found.");
  if (d.status !== "PENDING" || d.station.status !== "ACTIVE") throw new UsersError(409, "DEVICE_NOT_PENDING", "يُصدر رمز التفعيل لجهاز بانتظار التفعيل فقط.", "A code is issued only for a device waiting for activation.");
  const deviceCode = raw.deviceCode === undefined || raw.deviceCode === "" ? d.deviceCode : normalizeDeviceCode(raw.deviceCode);
  if (!deviceCode) throw new UsersError(400, "DEVICE_CODE_INVALID", "رمز الجهاز غير صالح. انسخه كما يظهر على الجهاز (مثل WS-7F3K).", "The device code is not valid (e.g. WS-7F3K).");
  const ctx = auditContext(request, user.id);
  return prisma.$transaction(async (tx) => {
    const { code, expiresAt } = await issueCode(tx, d.id, deviceCode);
    await recordUsersAudit(tx, ctx, "STATION_CODE_ISSUED", { stationDeviceId: d.id, deviceName: d.displayName, stationId: d.stationId, stationName: d.station.name, expiresAt: expiresAt.toISOString() });
    return { device: { id: d.id, name: d.displayName, stationName: d.station.name, deviceCode }, activationCode: code, expiresAt: expiresAt.toISOString() };
  }, TX_OPTS);
}

/** «إلغاء الرمز»: the live code stops working now (the device stays pending). */
export async function cancelCode(request: Request, user: SessionUser, deviceId: string) {
  const d = await prisma.stationDevice.findUnique({ where: { id: deviceId }, include: { station: { select: { name: true } } } });
  if (!d) throw new UsersError(404, "NOT_FOUND", "الجهاز غير موجود.", "Device not found.");
  const ctx = auditContext(request, user.id);
  await prisma.$transaction(async (tx) => {
    await tx.stationDevice.updateMany({ where: { id: d.id, status: "PENDING" }, data: { activationCodeHash: null, activationExpiresAt: null } });
    await recordUsersAudit(tx, ctx, "STATION_CODE_CANCELLED", { stationDeviceId: d.id, deviceName: d.displayName, stationId: d.stationId, stationName: d.station.name });
  }, TX_OPTS);
  return { cancelled: true };
}

/** «إلغاء الجهاز»: REVOKED now; every session on it ends at once (DS-15 on the device). */
export async function revokeDevice(request: Request, user: SessionUser, deviceId: string, raw: Record<string, unknown>) {
  const d = await prisma.stationDevice.findUnique({ where: { id: deviceId }, include: { station: { select: { name: true } } } });
  if (!d) throw new UsersError(404, "NOT_FOUND", "الجهاز غير موجود.", "Device not found.");
  if (d.status === "REVOKED") throw new UsersError(409, "ALREADY_REVOKED", "الجهاز ملغى مسبقًا.", "The device is already revoked.");
  const reason = reasonOf(raw.reason);
  if (reason.length < 3) throw new UsersError(400, "REASON_REQUIRED", "اكتب سبب الإلغاء.", "Give the reason.");
  const ctx = auditContext(request, user.id);
  return prisma.$transaction(async (tx) => {
    const now = new Date();
    const r = await tx.stationDevice.updateMany({ where: { id: d.id, status: { not: "REVOKED" } }, data: { status: "REVOKED", revokedAt: now, revokedById: user.id, revokedByName: user.name, revokeReason: reason, activationCodeHash: null, activationExpiresAt: null } });
    if (r.count !== 1) throw new UsersError(409, "ALREADY_REVOKED", "الجهاز ملغى مسبقًا.", "The device is already revoked.");
    const ended = await tx.authSession.updateMany({ where: { stationDeviceId: d.id, revokedAt: null }, data: { revokedAt: now, revokedReason: "STATION_DEVICE_REVOKED" } });
    await tx.authAuditLog.create({ data: { userId: user.id, action: "STATION_REVOKED", result: "SUCCESS", sourceInterface: "WEB", ipHash: ctx.ipHash, userAgent: ctx.userAgent, metadata: { stationDeviceId: d.id, deviceName: d.displayName, stationId: d.stationId, stationName: d.station.name, reason, sessionsEnded: ended.count } } });
    return { revoked: true, sessionsEnded: ended.count };
  }, TX_OPTS);
}

/**
 * W3 «يخدم أيضًا» — the other stations this ACTIVE or PENDING device may serve (the same iPad at the
 * roaster and in QC). The device chooses the station before the employee; its own station is always
 * served. Removing a link ends every session on the device bound to that station. Audited.
 */
export async function setDeviceStations(request: Request, user: SessionUser, deviceId: string, raw: Record<string, unknown>) {
  const d = await prisma.stationDevice.findUnique({ where: { id: deviceId }, include: { station: { select: { name: true } }, extraStations: { select: { stationId: true } } } });
  if (!d) throw new UsersError(404, "NOT_FOUND", "الجهاز غير موجود.", "Device not found.");
  if (d.status === "REVOKED") throw new UsersError(409, "ALREADY_REVOKED", "الجهاز ملغى.", "The device is revoked.");
  const wanted = [...new Set((Array.isArray(raw.stationIds) ? raw.stationIds : []).filter((x): x is string => typeof x === "string" && !!x && x !== d.stationId))];
  if (wanted.length > 10) throw new UsersError(400, "TOO_MANY", "عشر محطات على الأكثر.", "Ten stations at most.");
  const valid = await prisma.station.findMany({ where: { id: { in: wanted }, status: "ACTIVE" }, select: { id: true, name: true } });
  if (valid.length !== wanted.length) throw new UsersError(400, "STATION_INVALID", "محطة غير موجودة أو موقوفة.", "A station is missing or retired.");
  const before = d.extraStations.map((x) => x.stationId);
  const removed = before.filter((x) => !wanted.includes(x));
  const added = wanted.filter((x) => !before.includes(x));
  const ctx = auditContext(request, user.id);
  return prisma.$transaction(async (tx) => {
    if (removed.length) await tx.stationDeviceStation.deleteMany({ where: { stationDeviceId: d.id, stationId: { in: removed } } });
    if (added.length) await tx.stationDeviceStation.createMany({ data: added.map((stationId) => ({ stationDeviceId: d.id, stationId, createdById: user.id, createdByName: user.name })) });
    const ended = removed.length ? (await tx.authSession.updateMany({ where: { stationDeviceId: d.id, stationId: { in: removed }, revokedAt: null }, data: { revokedAt: new Date(), revokedReason: "STATION_LINK_REMOVED" } })).count : 0;
    await recordUsersAudit(tx, ctx, "STATION_DEVICE_STATIONS", { stationDeviceId: d.id, deviceName: d.displayName, stationId: d.stationId, stationName: d.station.name, added, removed, sessionsEnded: ended });
    return { stationIds: wanted, sessionsEnded: ended };
  }, TX_OPTS);
}

// ── The station policy (D7) ────────────────────────────────────────────────────────────────────
export async function setPolicy(request: Request, user: SessionUser, raw: Record<string, unknown>) {
  const data: Record<string, number | null> = {};
  for (const k of ["idleMinutes", "pinMaxAttempts", "activationMinutes"] as const) {
    if (raw[k] === undefined) continue;
    const v = policyValue(k, raw[k]);
    if (!v.ok) throw new UsersError(400, "POLICY_INVALID", "قيمة خارج الحدود المسموحة: الخمول 1–60 دقيقة، المحاولات 3–10، رمز التفعيل 1–15 دقيقة.", "Out of range: idle 1–60 min, attempts 3–10, activation code 1–15 min.", { field: k });
    data[k] = v.value;
  }
  const ctx = auditContext(request, user.id);
  return prisma.$transaction(async (tx) => {
    const before = await tx.stationPolicy.findUnique({ where: { id: "singleton" } });
    const row = await tx.stationPolicy.upsert({ where: { id: "singleton" }, create: { id: "singleton", ...data, updatedById: user.id }, update: { ...data, updatedById: user.id } });
    await recordUsersAudit(tx, ctx, "STATION_POLICY_CHANGED", { before: effectivePolicy(before), after: effectivePolicy(row), reason: reasonOf(raw.reason) || undefined });
    return effectivePolicy(row);
  }, TX_OPTS);
}

// ── UR-13 · one person's stations ──────────────────────────────────────────────────────────────
export type UserStationRow = {
  stationId: string; name: string; type: StationType; place: string | null; allowed: boolean; supervisor: boolean;
  holdsPrivilege: boolean; now: AccessNow; lockedOn: string[];
};

export async function userStations(id: string) {
  const e = await prisma.employee.findUnique({
    where: { id },
    select: { id: true, name: true, role: true, active: true, permissions: true, stationAssignments: { select: { stationId: true, supervisor: true } }, stationPin: { select: { setAt: true, attempts: { where: { lockedAt: { not: null } }, select: { stationDeviceId: true, lockedAt: true, device: { select: { displayName: true } } } } } } },
  });
  if (!e) return null;
  const stations = await prisma.station.findMany({ where: { status: "ACTIVE" }, orderBy: { createdAt: "asc" }, select: { id: true, name: true, type: true, place: true } });
  let perms = parsePermissions(e.permissions);
  if (!perms || Object.keys(perms).length === 0) perms = buildDefaultPermissions(e.role);
  perms = simpleModePermissions(perms, e.role);
  const assigned = new Map(e.stationAssignments.map((a) => [a.stationId, a]));
  const locks = e.stationPin?.attempts ?? [];
  const rows: UserStationRow[] = stations.map((s) => {
    const a = assigned.get(s.id);
    const holds = holdsStationPrivilege(perms, s.type as StationType);
    return {
      stationId: s.id, name: s.name, type: s.type as StationType, place: s.place, allowed: !!a, supervisor: !!a?.supervisor, holdsPrivilege: holds,
      now: accessNow({ allowed: !!a, admin: isAdminRole(e.role), active: e.active, hasPin: !!e.stationPin, locked: locks.length > 0, holdsPrivilege: holds }),
      lockedOn: locks.map((l) => l.device.displayName),
    };
  });
  return {
    employee: { id: e.id, name: e.name, admin: isAdminRole(e.role), active: e.active },
    pin: { set: !!e.stationPin, setAt: e.stationPin?.setAt.toISOString() ?? null, locked: locks.length > 0, lockedOn: locks.map((l) => ({ device: l.device.displayName, at: l.lockedAt!.toISOString() })) },
    stations: rows,
  };
}

/** Save UR-13: the stations this person may sign in at, and the supervisor label. */
export async function setUserStations(request: Request, user: SessionUser, id: string, raw: Record<string, unknown>) {
  if (id === user.id) throw new UsersError(403, "SELF_ACCESS_CHANGE", "لا يمكنك تغيير وصولك أنت إلى المحطات.", "You cannot change your own station access.");
  const e = await prisma.employee.findUnique({ where: { id }, select: { id: true, name: true, role: true } });
  if (!e) throw new UsersError(404, "NOT_FOUND", "المستخدم غير موجود.", "User not found.");
  const list = Array.isArray(raw.stations) ? raw.stations : null;
  if (!list) throw new UsersError(400, "STATIONS_REQUIRED", "أرسل قائمة المحطات.", "Send the station list.");
  const want = new Map<string, { allowed: boolean; supervisor: boolean }>();
  for (const it of list as Record<string, unknown>[]) {
    if (!it || typeof it.stationId !== "string") continue;
    want.set(it.stationId, { allowed: it.allowed === true, supervisor: it.allowed === true && it.supervisor === true });
  }
  // D12: the administrator account never signs in at a station device.
  if (isAdminRole(e.role) && [...want.values()].some((w) => w.allowed)) throw new UsersError(409, "ADMIN_NOT_AT_STATION", "حساب مدير المنشأة لا يدخل من أجهزة المحطات؛ يستخدم المحطة من متصفحه بحسابه.", "The administrator account does not sign in at station devices.");
  const stations = await prisma.station.findMany({ where: { id: { in: [...want.keys()] }, status: "ACTIVE" }, select: { id: true, name: true } });
  const known = new Map(stations.map((s) => [s.id, s.name]));
  const ctx = auditContext(request, user.id);
  return prisma.$transaction(async (tx) => {
    const before = await tx.stationAssignment.findMany({ where: { employeeId: id }, select: { stationId: true, supervisor: true } });
    const had = new Map(before.map((b) => [b.stationId, b]));
    const changes: { stationId: string; stationName: string; from: string; to: string }[] = [];
    let ended = 0;
    for (const [stationId, w] of want) {
      const name = known.get(stationId);
      if (!name) continue;
      const prev = had.get(stationId);
      const from = prev ? (prev.supervisor ? "SUPERVISOR" : "ALLOWED") : "NONE";
      const to = w.allowed ? (w.supervisor ? "SUPERVISOR" : "ALLOWED") : "NONE";
      if (from === to) continue;
      if (!w.allowed) {
        await tx.stationAssignment.delete({ where: { stationId_employeeId: { stationId, employeeId: id } } });
        // Access removed: a session at that station ends now (S7 on its next request anyway).
        ended += (await tx.authSession.updateMany({ where: { employeeId: id, stationId, revokedAt: null }, data: { revokedAt: new Date(), revokedReason: "STATION_ACCESS_REMOVED" } })).count;
      } else {
        await tx.stationAssignment.upsert({ where: { stationId_employeeId: { stationId, employeeId: id } }, create: { stationId, employeeId: id, supervisor: w.supervisor, createdById: user.id }, update: { supervisor: w.supervisor } });
      }
      changes.push({ stationId, stationName: name, from, to });
    }
    if (changes.length) await recordUsersAudit(tx, ctx, "STATION_ACCESS_CHANGED", { targetEmployeeId: id, targetName: e.name, changes, sessionsEnded: ended, reason: reasonOf(raw.reason) || undefined });
    // feat/notifications: access newly granted to a station (NONE → allowed) is told to the person.
    const granted = changes.filter((c) => c.from === "NONE" && c.to !== "NONE");
    if (granted.length) {
      const { notify } = await import("@/lib/notifications/notify");
      await notify(tx, { event: "me.station_access_granted", dedupeKey: `${id}:${granted.map((g) => g.stationId).sort().join(",")}:${Date.now()}`, actorId: user.id, entity: { type: "Employee", id }, facts: { stations: granted.map((g) => `«${g.stationName}»`).join("، ") }, people: { subject: id } });
    }
    return { changed: changes.length, sessionsEnded: ended };
  }, TX_OPTS);
}

// ── UR-04 · the station PIN (reset clears it; re-enable lifts a lockout) ──────────────────────
/** Clears the station PIN (and its lockouts). The person sets a new one from their profile (J-6). */
export async function clearStationPin(tx: Db, employeeId: string) {
  const r = await tx.stationPin.deleteMany({ where: { employeeId } });
  const ended = await tx.authSession.updateMany({ where: { employeeId, scope: "STATION", revokedAt: null }, data: { revokedAt: new Date(), revokedReason: "STATION_PIN_RESET" } });
  return { cleared: r.count > 0, sessionsEnded: ended.count };
}

/** Lifts the station-PIN lockout on every device (D7: «إعادة تفعيل»); the PIN itself is unchanged. */
export async function reenableStationPin(tx: Db, employeeId: string) {
  const r = await tx.stationPinAttempt.deleteMany({ where: { employeeId } });
  return { devices: r.count };
}
