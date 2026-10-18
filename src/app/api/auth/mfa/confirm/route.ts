import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireAuth } from "@/lib/auth-server";
import { confirmEnrollment, MfaError } from "@/lib/auth/mfa";
import { revokeSessions } from "@/lib/auth/session";
import { authAudit } from "@/lib/auth/sign-in";

/** Confirm with a first code: enrolled; ten recovery codes shown ONCE; other sessions end. */
export async function POST(request: Request) {
  const { user, error } = await requireAuth({ allowMfaEnrollment: true });
  if (error) return error;
  const { code } = (await request.json().catch(() => ({}))) as { code?: string };
  try {
    const recoveryCodes = await confirmEnrollment(user.id, String(code ?? ""));
    await prisma.authSession.update({ where: { id: user.sessionId }, data: { mfa: true, authTime: new Date() } });
    const ended = await revokeSessions(prisma, user.id, "MFA_ENROLLED", { exceptId: user.sessionId });
    await authAudit(request, { userId: user.id, action: "MFA_ENROLLED", result: "SUCCESS", metadata: { otherSessionsRevoked: ended } });
    return NextResponse.json({ enrolled: true, recoveryCodes });
  } catch (e) {
    if (e instanceof MfaError) {
      await authAudit(request, { userId: user.id, action: "MFA_ENROLL_CONFIRM", result: "FAILURE", reasonCode: e.code });
      return NextResponse.json({ error: e.messageAr, errorEn: e.message, code: e.code }, { status: e.status });
    }
    throw e;
  }
}
