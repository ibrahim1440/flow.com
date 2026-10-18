import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireAuth } from "@/lib/auth-server";
import { extractIp, hashRateLimitKey, isIdentifierRateLimited, isIpRateLimited, recordFailedAttempt } from "@/lib/rate-limit";
import { pinVerifierInput, requirePinLookupSecret } from "@/lib/pin-lookup";
import { isEnrolled, mfaConfigured, verifySecondFactor } from "@/lib/auth/mfa";
import { authAudit, MFA_UNAVAILABLE, TOO_MANY, verifySecret } from "@/lib/auth/sign-in";
import { normalizeUsername } from "@/lib/auth/privileged";

/**
 * Step-up (owner security decision): the signed-in user proves it again — their PIN or
 * password, plus the verification code when MFA is enrolled — and the session's authTime is
 * renewed. Sensitive actions accept a session whose authTime is within 10 minutes.
 */
export async function POST(request: Request) {
  const { user, error } = await requireAuth({ allowMfaEnrollment: true });
  if (error) return error;
  const { username, pin, password, code } = (await request.json().catch(() => ({}))) as { username?: string; pin?: string; password?: string; code?: string };
  const enrolled = await isEnrolled(user.id);
  if (enrolled && !mfaConfigured()) {
    await authAudit(request, { userId: user.id, action: "STEP_UP", result: "REFUSED", reasonCode: "MFA_NOT_CONFIGURED" });
    return MFA_UNAVAILABLE();
  }
  const ipHash = hashRateLimitKey(extractIp(request));
  const idHash = hashRateLimitKey("reauth:" + user.id);
  if ((await isIpRateLimited(ipHash, 30)) || (await isIdentifierRateLimited(idHash, 5))) return TOO_MANY();
  const e = await prisma.employee.findUniqueOrThrow({ where: { id: user.id }, select: { pin: true, password: true, username: true } });
  // A privileged account confirms with its username as well (the same factors as its sign-in).
  let ok = !user.privileged || (!!e.username && normalizeUsername(username) === normalizeUsername(e.username));
  if (typeof pin === "string" && pin) ok = (await verifySecret(pinVerifierInput(pin, requirePinLookupSecret()), e.pin)) && ok;
  else if (typeof password === "string" && password) ok = (await verifySecret(password, e.password)) && ok;
  else ok = false;
  let mfa = false;
  if (ok && enrolled) {
    const how = await verifySecondFactor(user.id, String(code ?? ""));
    ok = !!how;
    mfa = !!how;
  }
  if (!ok) {
    await recordFailedAttempt(ipHash, idHash);
    await authAudit(request, { userId: user.id, action: "STEP_UP", result: "FAILURE" });
    return NextResponse.json({ error: "بيانات التأكيد غير صحيحة.", errorEn: "The confirmation is not valid.", code: "REAUTH_FAILED" }, { status: 401 });
  }
  // Owner decision 4: which secret this step-up used (a privileged stock change needs the PIN).
  const authFactor = typeof pin === "string" && pin ? "PIN" : "PASSWORD";
  await prisma.authSession.update({ where: { id: user.sessionId }, data: { authTime: new Date(), authFactor, ...(mfa ? { mfa: true } : {}) } });
  await authAudit(request, { userId: user.id, action: "STEP_UP", result: "SUCCESS", metadata: { mfa, factor: authFactor } });
  return NextResponse.json({ ok: true });
}
