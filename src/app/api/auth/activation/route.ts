import { NextResponse } from "@/lib/api-response";
import { ActivationError, peekActivation, redeemActivation } from "@/lib/users/activation";
import { extractIp, hashRateLimitKey, isIpRateLimited, pruneExpired, recordFailedAttempt } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";
const noStore = { headers: { "Cache-Control": "no-store" } };
const TOO_MANY = () => NextResponse.json({ error: "محاولات كثيرة. حاول بعد ربع ساعة.", errorEn: "Too many attempts. Try again later.", code: "TOO_MANY" }, { status: 429, ...noStore });

/**
 * «رابط تفعيل الحساب» — public (the person has no session yet; the token is the credential).
 * GET ?t=<token>: the name and username the link is for, or 410 when it is not valid (no other detail is revealed).
 * POST { token, password }: the person's own password; the link is used; every session of the account ends.
 * Throttled per IP: a wrong or stale token counts as a failed attempt.
 */
export async function GET(request: Request) {
  const ipHash = hashRateLimitKey(extractIp(request));
  if (await isIpRateLimited(ipHash, 30)) return TOO_MANY();
  const v = await peekActivation(new URL(request.url).searchParams.get("t"));
  if (!v) {
    await recordFailedAttempt(ipHash, hashRateLimitKey("activation"));
    return NextResponse.json({ error: "الرابط غير صالح أو انتهت صلاحيته أو استُخدم من قبل. اطلب من المدير رابطًا جديدًا.", errorEn: "The link is invalid, expired or already used.", code: "LINK_INVALID" }, { status: 410, ...noStore });
  }
  return NextResponse.json(v, noStore);
}

export async function POST(request: Request) {
  const ipHash = hashRateLimitKey(extractIp(request));
  await pruneExpired();
  if (await isIpRateLimited(ipHash, 30)) return TOO_MANY();
  const b = (await request.json().catch(() => ({}))) as { token?: unknown; password?: unknown };
  try {
    const r = await redeemActivation(b.token, b.password);
    return NextResponse.json({ ok: true, username: r.username }, noStore);
  } catch (e) {
    if (e instanceof ActivationError) {
      if (e.code === "LINK_INVALID") await recordFailedAttempt(ipHash, hashRateLimitKey("activation"));
      return NextResponse.json({ error: e.ar, errorEn: e.en, code: e.code }, { status: e.status, ...noStore });
    }
    throw e;
  }
}
