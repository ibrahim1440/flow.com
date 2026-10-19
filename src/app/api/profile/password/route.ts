import { NextResponse } from "next/server";
import { hash } from "bcryptjs";
import { prisma } from "@/lib/db";
import { requireAuth, requireFreshAuth } from "@/lib/auth-server";
import { isEnrolled } from "@/lib/auth/mfa";
import { authAudit, verifySecret } from "@/lib/auth/sign-in";
import { revokeSessions } from "@/lib/auth/session";
import { extractIp, hashRateLimitKey, pruneExpired, isIpRateLimited, isPairRateLimited, recordFailedAttempt, clearAttempts } from "@/lib/rate-limit";
import { setFreshSession } from "@/lib/session-cookie";
import { PASSWORD_MAX, PASSWORD_MIN } from "@/lib/password-policy";

// PUT — change the signed-in user's OWN password («تغيير كلمة المرور», UR-02 «كلمة المرور»).
// Only the caller's row is read or written (id from the session). Needs the current password;
// a privileged or MFA-enrolled account also needs a recent step-up (the same rule as the PIN change,
// re-test AUTH-A). Throttled like the PIN change. On success every OTHER session of the account
// ends (Figma TD-S DS-11 «تغيّرت كلمة المرور»: sign in again on your other devices) and this one
// is replaced by a fresh session in the same response — not a re-authentication: it inherits the
// step-up clock, MFA state and absolute deadline (session-cookie.ts).
export async function PUT(request: Request) {
  // A temporary password (UR-03e / UR-04) is changed here: the one request such an account may make.
  const { user, error } = await requireAuth({ allowPasswordChange: true });
  if (error) return error;
  if (user.privileged || (await isEnrolled(user.id))) {
    const stale = requireFreshAuth(user);
    if (stale) return stale;
  }
  const { currentPassword, newPassword } = (await request.json().catch(() => ({}))) as { currentPassword?: unknown; newPassword?: unknown };
  if (typeof currentPassword !== "string" || !currentPassword || typeof newPassword !== "string" || !newPassword) {
    return NextResponse.json({ error: "كلمة المرور الحالية والجديدة مطلوبتان.", errorEn: "Current and new password are required." }, { status: 400 });
  }
  if (newPassword.length < PASSWORD_MIN || newPassword.length > PASSWORD_MAX || !newPassword.trim()) {
    return NextResponse.json({ error: `كلمة المرور الجديدة من ${PASSWORD_MIN} إلى ${PASSWORD_MAX} حرفًا.`, errorEn: `The new password must be ${PASSWORD_MIN}–${PASSWORD_MAX} characters.`, code: "PASSWORD_POLICY" }, { status: 400 });
  }
  if (newPassword === currentPassword) {
    return NextResponse.json({ error: "كلمة المرور الجديدة مطابقة للحالية.", errorEn: "The new password is the same as the current one.", code: "PASSWORD_SAME" }, { status: 400 });
  }

  const ipHash = hashRateLimitKey(extractIp(request));
  const identifierHash = hashRateLimitKey("profile-password:" + user.id);
  await pruneExpired();
  if ((await isIpRateLimited(ipHash, 10)) || (await isPairRateLimited(ipHash, identifierHash, 5))) {
    return NextResponse.json({ error: "محاولات كثيرة. حاول لاحقًا.", errorEn: "Too many requests. Try again later." }, { status: 429 });
  }

  const e = await prisma.employee.findUnique({ where: { id: user.id }, select: { password: true, username: true } });
  if (!e) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (!e.password) {
    return NextResponse.json({ error: "لا توجد كلمة مرور لهذا الحساب: يعيّنها مسؤول المستخدمين.", errorEn: "This account has no password: an account editor sets it.", code: "NO_PASSWORD" }, { status: 409 });
  }
  if (!(await verifySecret(currentPassword, e.password))) {
    await recordFailedAttempt(ipHash, identifierHash);
    await authAudit(request, { userId: user.id, action: "PASSWORD_CHANGE_SELF", result: "FAILURE", reasonCode: "WRONG_CURRENT" });
    return NextResponse.json({ error: "كلمة المرور الحالية غير صحيحة.", errorEn: "The current password is not correct.", code: "WRONG_CURRENT" }, { status: 401 });
  }
  if (e.username && newPassword.trim().toLowerCase() === e.username.trim().toLowerCase()) {
    return NextResponse.json({ error: "لا تستخدم اسم المستخدم كلمةَ مرور.", errorEn: "Do not use your username as the password.", code: "PASSWORD_POLICY" }, { status: 400 });
  }
  await clearAttempts(ipHash, identifierHash);

  // Setting one's own password ends a temporary one (UR-03e / UR-04: «يجب تغييرها عند أول دخول»).
  await prisma.employee.update({ where: { id: user.id }, data: { password: await hash(newPassword, 10), passwordMustChange: false, passwordTempExpiresAt: null } });
  // The credential digest changed, so the other tokens are already refused; mark their rows ended
  // too, so «الجلسات النشطة» lists only what can still be used.
  const ended = await revokeSessions(prisma, user.id, "PASSWORD_CHANGED_SELF", { exceptId: user.sessionId });
  await authAudit(request, { userId: user.id, action: "PASSWORD_CHANGED_SELF", result: "SUCCESS", metadata: { otherSessionsEnded: ended } });
  return setFreshSession(NextResponse.json({ success: true, otherSessionsEnded: ended }), user.id, user);
}
