// «ملفي الشخصي» — what the signed-in user may see and do about their OWN account security:
// their sessions (Figma UR-02d «الجلسات النشطة» 598:966), the browsers they signed in from (TD-11
// «أجهزتي» 556:4350), their recent sign-in activity (TD-11 «النشاط الأخير») and the account facts
// of UR-02 «نظرة عامة» (597:759).
//
// SCOPE: every query below is filtered by the CALLER's employee id, taken from the authenticated
// session — never from the request. A session or device reference that is not the caller's is
// indistinguishable from one that does not exist (404). Nothing returned carries a session id, a
// device id, an address hash or a credential: sessions and devices are named by one-way refs.
import { prisma } from "@/lib/db";
import { asMsgLang } from "@/lib/automation/employee-lang";
import { SESSION_IDLE_MS } from "./session-policy";
import { describeUserAgent, deviceKey, deviceRef, sessionRef, type DeviceInfo } from "./device";
import { revokeSession, revokeSessions } from "./session";

/** How far back the device list looks (sessions are kept; older ones are not listed). */
const DEVICE_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;
/** The authentication events the activity list shows — the caller's own sign-in story only. */
export const ACTIVITY_ACTIONS = [
  "SIGN_IN", "MFA_SIGN_IN", "MFA_RECOVERY_CODE_USED", "STEP_UP", "SIGN_OUT", "PRIVILEGED_PIN_ONLY_REFUSED",
  "MFA_ENROLLED", "SESSION_ENDED_SELF", "OTHER_SESSIONS_ENDED_SELF", "PASSWORD_CHANGED_SELF", "PASSWORD_CHANGE_SELF",
] as const;

type Caller = { id: string; sessionId: string };
type Row = { id: string; method: string; mfa: boolean; createdAt: Date; lastSeenAt: Date; authTime: Date; expiresAt: Date; revokedAt: Date | null; revokedReason: string | null; userAgent: string | null; deviceId: string | null };

export function isLive(s: Pick<Row, "revokedAt" | "expiresAt" | "lastSeenAt">, now = Date.now()): boolean {
  return !s.revokedAt && s.expiresAt.getTime() > now && now - s.lastSeenAt.getTime() <= SESSION_IDLE_MS;
}
/**
 * A session opened by a sign-in has authTime = createdAt (or later, after a step-up). A session that
 * REPLACED another one on a self credential change inherits the older authTime (session-cookie.ts),
 * so authTime < createdAt: it is not a sign-in and does not count as «آخر دخول».
 */
const isSignIn = (s: Pick<Row, "authTime" | "createdAt">) => s.authTime.getTime() >= s.createdAt.getTime() - 1000;

export type MySession = { ref: string; current: boolean; method: string; mfa: boolean; createdAt: string; lastSeenAt: string; expiresAt: string; device: DeviceInfo };
export type MyDevice = { ref: string; current: boolean; device: DeviceInfo; firstSeenAt: string; lastSignInAt: string | null; lastSignInMethod: string | null; lastSeenAt: string; liveSessions: number };
export type MyActivity = { at: string; action: string; result: string; reasonCode: string | null; device: DeviceInfo };

export async function mySecurity(caller: Caller, opts: { activityLimit?: number; now?: number } = {}) {
  const now = opts.now ?? Date.now();
  const rows: Row[] = await prisma.authSession.findMany({
    where: { employeeId: caller.id, OR: [{ createdAt: { gte: new Date(now - DEVICE_WINDOW_MS) } }, { revokedAt: null, expiresAt: { gt: new Date(now) } }] },
    orderBy: { createdAt: "desc" },
    take: 500,
    select: { id: true, method: true, mfa: true, createdAt: true, lastSeenAt: true, authTime: true, expiresAt: true, revokedAt: true, revokedReason: true, userAgent: true, deviceId: true },
  });
  const current = rows.find((r) => r.id === caller.sessionId) ?? null;
  const currentKey = current ? deviceKey(current) : null;

  const sessions: MySession[] = rows.filter((r) => isLive(r, now)).map((r) => ({
    ref: sessionRef(r.id), current: r.id === caller.sessionId, method: r.method, mfa: r.mfa,
    createdAt: r.createdAt.toISOString(), lastSeenAt: r.lastSeenAt.toISOString(), expiresAt: r.expiresAt.toISOString(), device: describeUserAgent(r.userAgent),
  })).sort((a, b) => Number(b.current) - Number(a.current) || b.lastSeenAt.localeCompare(a.lastSeenAt));

  const groups = new Map<string, Row[]>();
  for (const r of rows) {
    const k = deviceKey(r);
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  const devices: MyDevice[] = [...groups.entries()].map(([k, list]) => {
    const signIns = list.filter(isSignIn);
    const lastIn = signIns[0] ?? null; // rows are newest first
    const lastSeen = list.reduce((m, r) => (r.lastSeenAt > m ? r.lastSeenAt : m), list[0].lastSeenAt);
    const first = list.reduce((m, r) => (r.createdAt < m ? r.createdAt : m), list[0].createdAt);
    return {
      ref: deviceRef(k), current: k === currentKey, device: describeUserAgent(list[0].userAgent),
      firstSeenAt: first.toISOString(), lastSignInAt: lastIn ? lastIn.createdAt.toISOString() : null, lastSignInMethod: lastIn ? lastIn.method : null,
      lastSeenAt: lastSeen.toISOString(), liveSessions: list.filter((r) => isLive(r, now)).length,
    };
  }).sort((a, b) => Number(b.current) - Number(a.current) || b.lastSeenAt.localeCompare(a.lastSeenAt));

  // «آخر دخول» (UR-02): the sign-in BEFORE the one this page is open in — the one worth checking.
  const prev = await prisma.authSession.findMany({
    where: { employeeId: caller.id, id: { not: caller.sessionId }, ...(current ? { createdAt: { lt: current.createdAt } } : {}) },
    orderBy: { createdAt: "desc" }, take: 20,
    select: { createdAt: true, authTime: true, method: true, userAgent: true },
  });
  const previous = prev.find(isSignIn) ?? null;

  const limit = Math.min(Math.max(opts.activityLimit ?? 8, 1), 100);
  const events = await prisma.authAuditLog.findMany({
    where: { userId: caller.id, action: { in: [...ACTIVITY_ACTIONS] } },
    orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    select: { occurredAt: true, action: true, result: true, reasonCode: true, userAgent: true },
  });
  const activity: MyActivity[] = events.slice(0, limit).map((e) => ({ at: e.occurredAt.toISOString(), action: e.action, result: e.result, reasonCode: e.reasonCode, device: describeUserAgent(e.userAgent) }));

  // Account facts (UR-02 «نظرة عامة»).
  const e = await prisma.employee.findUniqueOrThrow({ where: { id: caller.id }, select: { name: true, username: true, role: true, createdAt: true, password: true, phoneNumber: true, preferredLanguage: true, whatsappLanguage: true, pinResetRequired: true } });
  const mfa = await prisma.authMfa.findUnique({ where: { employeeId: caller.id }, select: { enrolledAt: true } });
  const changed = await credentialChanges(caller.id);

  return {
    account: {
      name: e.name, username: e.username, role: e.role, createdAt: e.createdAt.toISOString(),
      hasPassword: !!e.password, passwordChangedAt: changed.password, pinChangedAt: changed.pin,
      // An administrator cleared the PIN (UR-04): a new one is set without the old one, after a password step-up.
      pinResetRequired: e.pinResetRequired,
      mfaEnrolledAt: mfa?.enrolledAt ? mfa.enrolledAt.toISOString() : null,
      phoneNumber: e.phoneNumber ?? "", preferredLanguage: e.preferredLanguage === "en" ? "en" : "ar",
      // Owner language decision 3: the language automation WhatsApp messages reach this person in (null = the system's).
      whatsappLanguage: asMsgLang(e.whatsappLanguage),
    },
    currentSignIn: current ? { at: current.createdAt.toISOString(), method: current.method, device: describeUserAgent(current.userAgent) } : null,
    previousSignIn: previous ? { at: previous.createdAt.toISOString(), method: previous.method, device: describeUserAgent(previous.userAgent) } : null,
    sessions, devices, activity, activityMore: events.length > limit,
  };
}

/** When the caller's password / PIN last changed, as far as the audit trails record it (else null). */
async function credentialChanges(employeeId: string): Promise<{ password: string | null; pin: string | null }> {
  const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
  const self = await prisma.authAuditLog.findFirst({ where: { userId: employeeId, action: "PASSWORD_CHANGED_SELF", result: "SUCCESS" }, orderBy: { occurredAt: "desc" }, select: { occurredAt: true } });
  // An administrator's change of this account (employee-audit.ts: EMPLOYEE_CREDENTIAL_CHANGED, actor = the admin).
  const byAdmin = await prisma.$queryRaw<{ cls: string; at: Date }[]>`
    SELECT c.cls, max(a."occurredAt") AS at
    FROM "AuthAuditLog" a CROSS JOIN LATERAL jsonb_array_elements_text(CASE WHEN jsonb_typeof(a.metadata -> 'credentials') = 'array' THEN a.metadata -> 'credentials' ELSE '[]'::jsonb END) AS c(cls)
    WHERE a.action = 'EMPLOYEE_CREDENTIAL_CHANGED' AND a.metadata ->> 'targetEmployeeId' = ${employeeId}
    GROUP BY c.cls`;
  const pinSelf = await prisma.hrAuditLog.findFirst({ where: { action: "PIN_CHANGED_SELF", entityType: "Employee", entityId: employeeId }, orderBy: { createdAt: "desc" }, select: { createdAt: true } }).catch(() => null);
  const latest = (...ds: (Date | null | undefined)[]) => ds.filter((d): d is Date => !!d).sort((a, b) => b.getTime() - a.getTime())[0] ?? null;
  const admin = (cls: string) => byAdmin.find((r) => r.cls === cls)?.at ?? null;
  return { password: iso(latest(self?.occurredAt, admin("password"))), pin: iso(latest(pinSelf?.createdAt, admin("pin"))) };
}

/** End ONE of the caller's own live sessions by its ref. The current one is ended by signing out. */
export async function endMySession(caller: Caller, ref: string): Promise<"ENDED" | "NOT_FOUND" | "CURRENT"> {
  const now = Date.now();
  const live = await prisma.authSession.findMany({
    where: { employeeId: caller.id, revokedAt: null, expiresAt: { gt: new Date(now) } },
    select: { id: true, revokedAt: true, expiresAt: true, lastSeenAt: true },
  });
  const hit = live.find((s) => isLive(s, now) && sessionRef(s.id) === ref);
  if (!hit) return "NOT_FOUND";
  if (hit.id === caller.sessionId) return "CURRENT";
  // revokeSession matches by id only; the id came from the caller's own rows above.
  await revokeSession(hit.id, "ENDED_BY_OWNER");
  return "ENDED";
}

/** End every live session of the caller except the one this request is made in. */
export async function endMyOtherSessions(caller: Caller): Promise<number> {
  return revokeSessions(prisma, caller.id, "ENDED_BY_OWNER", { exceptId: caller.sessionId });
}
