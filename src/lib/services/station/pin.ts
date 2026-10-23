// Workstations W2 — «رمز المحطة» set by the person themselves (PUT /api/profile/station-pin; J-6).
// Changing it needs the current station PIN; the first one (or after the administrator's reset,
// UR-04) needs a recent PASSWORD step-up (the identity check, UR-S18). Six digits; NOT unique across
// employees and never looked up (J-2). Never the admin role (D12: it never signs in at a station).
import { hash, compare } from "bcryptjs";
import { NextResponse } from "@/lib/api-response";
import { prisma } from "@/lib/db";
import { requireFreshAuth, type SessionUser } from "@/lib/auth-server";
import { validatePin } from "@/lib/pin-policy";
import { requirePinLookupSecret } from "@/lib/pin-lookup";
import { extractIp, hashRateLimitKey, isPairRateLimited, pruneExpired, recordFailedAttempt, clearAttempts } from "@/lib/rate-limit";
import { stationPinVerifierInput } from "@/lib/station/device";
import { isAdminRole } from "@/lib/station/access";

export async function setOwnStationPin(request: Request, user: SessionUser) {
  if (isAdminRole(user.role)) {
    return NextResponse.json({ error: "حساب مدير المنشأة لا يدخل من أجهزة المحطات، فلا يحتاج رمز محطة.", errorEn: "The administrator account does not sign in at station devices, so it needs no station PIN.", code: "STATION_ADMIN_REFUSED" }, { status: 403 });
  }
  const b = ((await request.json().catch(() => ({}))) ?? {}) as { currentPin?: unknown; newPin?: unknown };
  const next = validatePin(b.newPin);
  if (!next.ok) return NextResponse.json({ error: "رمز المحطة 6 أرقام.", errorEn: "The station PIN is 6 digits.", code: "PIN_FORMAT" }, { status: 400 });
  const secret = requirePinLookupSecret();
  const current = await prisma.stationPin.findUnique({ where: { employeeId: user.id }, select: { verifier: true } });
  const ipHash = hashRateLimitKey(extractIp(request));
  const idHash = hashRateLimitKey(`profile-station-pin:${user.id}`);
  await pruneExpired();
  if (await isPairRateLimited(ipHash, idHash, 5)) return NextResponse.json({ error: "محاولات كثيرة. حاول لاحقًا.", errorEn: "Too many attempts. Try later.", code: "RATE_LIMITED" }, { status: 429 });
  if (current) {
    const ok = typeof b.currentPin === "string" && validatePin(b.currentPin).ok && (await compare(stationPinVerifierInput(b.currentPin, secret), current.verifier));
    if (!ok) {
      await recordFailedAttempt(ipHash, idHash);
      return NextResponse.json({ error: "رمز المحطة الحالي غير صحيح.", errorEn: "The current station PIN is not correct.", code: "CURRENT_PIN_WRONG" }, { status: 401 });
    }
  } else {
    // The first station PIN (or after the administrator's reset): the person proves it is them with
    // the password, recently (step-up made with the password, never a PIN).
    const stale = requireFreshAuth(user);
    if (stale) return stale;
    if (user.authFactor !== "PASSWORD") return NextResponse.json({ error: "أكّد هويتك بكلمة المرور أولًا لتعيين رمز المحطة.", errorEn: "Confirm your identity with your password first to set the station PIN.", code: "REAUTH_REQUIRED" }, { status: 401 });
  }
  await clearAttempts(ipHash, idHash);
  const verifier = await hash(stationPinVerifierInput(next.pin, secret), 10);
  await prisma.stationPin.upsert({ where: { employeeId: user.id }, create: { employeeId: user.id, verifier }, update: { verifier, setAt: new Date() } });
  await prisma.authAuditLog.create({
    data: { userId: user.id, action: "STATION_PIN_SET", result: "SUCCESS", reasonCode: current ? "CHANGED" : "FIRST", sourceInterface: "WEB", ipHash, userAgent: request.headers.get("user-agent")?.slice(0, 300) ?? null, metadata: { targetEmployeeId: user.id } },
  }).catch(() => undefined);
  return NextResponse.json({ set: true }, { headers: { "Cache-Control": "no-store" } });
}
