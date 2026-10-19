// Review item 2 (orchestrator, 16 Oct): a credential change ends every session issued before it
// (the credential digest `cv` no longer matches). When the change is the caller's OWN, the same
// response carries a fresh session — a new AuthSession row, same sign-in method — and the old
// one is revoked, so they are not signed out by changing their own PIN or password.
//
// Re-test AUTH-A: the fresh session is NOT a new authentication. It inherits the old session's
// authTime (step-up clock), its MFA state and its absolute deadline — a self credential change
// never renews step-up, never adds MFA and never extends the 12-hour limit.
import type { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { createSession, revokeSession, setSessionCookie, type SessionMethod } from "@/lib/auth/session";

export async function setFreshSession(response: NextResponse, employeeId: string, previous: { sessionId: string; sessionMethod: SessionMethod }): Promise<NextResponse> {
  const old = await prisma.authSession.findUniqueOrThrow({ where: { id: previous.sessionId }, select: { authTime: true, authFactor: true, mfa: true, expiresAt: true, deviceId: true, ipHash: true, userAgent: true } });
  await revokeSession(previous.sessionId, "CREDENTIAL_CHANGE_SELF");
  // Same browser: the replacement keeps the replaced session's device id, address and agent.
  const s = await createSession(employeeId, previous.sessionMethod, old.mfa, undefined, prisma, { deviceId: old.deviceId, ipHash: old.ipHash, userAgent: old.userAgent });
  const inherited = await prisma.authSession.update({ where: { id: s.id }, data: { authTime: old.authTime, authFactor: old.authFactor, expiresAt: old.expiresAt }, select: { id: true, expiresAt: true, deviceId: true } });
  return setSessionCookie(response, employeeId, inherited);
}

/** Re-sign the token of the CURRENT session (e.g. a language change), keeping its row and deadlines. */
export async function refreshSessionCookie(response: NextResponse, employeeId: string, sessionId: string): Promise<NextResponse> {
  const s = await prisma.authSession.findUniqueOrThrow({ where: { id: sessionId }, select: { id: true, expiresAt: true } });
  return setSessionCookie(response, employeeId, s);
}
