import { NextResponse } from "@/lib/api-response";
import { extractIp, hashRateLimitKey, isIdentifierRateLimited, isIpRateLimited, recordFailedAttempt } from "@/lib/rate-limit";
import { mfaConfigured, verifySecondFactor } from "@/lib/auth/mfa";
import { authAudit, completeSignIn, readChallenge, MFA_UNAVAILABLE, TOO_MANY } from "@/lib/auth/sign-in";
import { pinLoginEnabled, PIN_LOGIN_DISABLED, PIN_SESSION_METHODS } from "@/lib/auth/pin-login";

/** Second factor of a sign-in: the 5-minute challenge from POST /api/auth/login plus a TOTP or recovery code. */
export async function POST(request: Request) {
  const { challenge, code } = (await request.json().catch(() => ({}))) as { challenge?: string; code?: string };
  const c = typeof challenge === "string" ? await readChallenge(challenge, "login") : null;
  if (!c) return NextResponse.json({ error: "Sign in again.", errorAr: "سجّل الدخول من جديد.", code: "CHALLENGE_EXPIRED" }, { status: 401 });
  // W0: a challenge a PIN sign-in started (before the flag was turned off) cannot finish one.
  if (PIN_SESSION_METHODS.includes(c.method) && !pinLoginEnabled()) {
    return NextResponse.json(PIN_LOGIN_DISABLED, { status: 400 });
  }
  // Fail closed, audited like sign-in (re-test follow-up 1).
  if (!mfaConfigured()) {
    await authAudit(request, { userId: c.employeeId, action: "MFA_SIGN_IN", result: "REFUSED", reasonCode: "MFA_NOT_CONFIGURED" });
    return MFA_UNAVAILABLE();
  }
  const ipHash = hashRateLimitKey(extractIp(request));
  const idHash = hashRateLimitKey("mfa:" + c.employeeId);
  if ((await isIpRateLimited(ipHash, 30)) || (await isIdentifierRateLimited(idHash, 5))) return TOO_MANY();
  const how = await verifySecondFactor(c.employeeId, String(code ?? ""));
  if (!how) {
    await recordFailedAttempt(ipHash, idHash);
    await authAudit(request, { userId: c.employeeId, action: "MFA_SIGN_IN", result: "FAILURE" });
    return NextResponse.json({ error: "The verification code is not valid.", errorAr: "رمز التحقق غير صحيح.", code: "MFA_CODE_INVALID" }, { status: 401 });
  }
  if (how === "RECOVERY") await authAudit(request, { userId: c.employeeId, action: "MFA_RECOVERY_CODE_USED", result: "SUCCESS" });
  return completeSignIn(request, c.employeeId, c.method, true);
}
