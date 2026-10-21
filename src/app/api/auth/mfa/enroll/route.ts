import { NextResponse } from "@/lib/api-response";
import { prisma } from "@/lib/db";
import { requireAuth, requireFreshAuth } from "@/lib/auth-server";
import { MfaError, startEnrollment } from "@/lib/auth/mfa";
import { authAudit } from "@/lib/auth/sign-in";

/** Start enrollment: a recent strong authentication, then a new (inactive) secret for the QR. */
export async function POST(request: Request) {
  const { user, error } = await requireAuth({ allowMfaEnrollment: true });
  if (error) return error;
  const stale = requireFreshAuth(user);
  if (stale) return stale;
  try {
    const e = await prisma.employee.findUniqueOrThrow({ where: { id: user.id }, select: { username: true, name: true } });
    const r = await startEnrollment(user.id, e.username ?? e.name);
    await authAudit(request, { userId: user.id, action: "MFA_ENROLL_START", result: "SUCCESS" });
    return NextResponse.json(r);
  } catch (e) {
    if (e instanceof MfaError) return NextResponse.json({ error: e.messageAr, errorEn: e.message, code: e.code }, { status: e.status });
    throw e;
  }
}
