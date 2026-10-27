import { NextResponse } from "@/lib/api-response";
import { prisma } from "@/lib/db";
import { forbidden, requireAdminAction, requireAuth } from "@/lib/auth-server";
import { handleDomainError } from "@/lib/api-error";
import { checkAndRecordRateLimit } from "@/lib/api-rate-limit";
import { canReceiveGreenAlert, greenShortages, runGreenReadiness } from "@/lib/services/green-readiness";

/**
 * «جاهزية البن الأخضر للتحميص» for the supervisor (lib/services/green-readiness.ts): the coming roasts (today and the
 * next two days) whose green is at another site, each with the prefilled transfer.
 *   GET  → { shortages } (read-only).
 *   POST → runs the check (the alert in «مساحة عملي», idempotent per coffee and day) → the counts. The SAME 5-minute
 *          throttle as the page loads (council F2): within it, the last result with `throttled: true`. The admin role may
 *          send { force: true } to run it now. Per person: at most 6 POSTs in 10 minutes (429).
 * Who: the people the alert is for — inventory › receive or adjust, or production › manage_schedule. `force` goes through
 * the admin-role gate.
 * Nothing is moved: the transfer is confirmed by the supervisor on the transfer form.
 */
async function gate() {
  const { user, error } = await requireAuth();
  if (error) return { error };
  return canReceiveGreenAlert(user) ? { user } : { error: forbidden() };
}

export async function GET() {
  const g = await gate();
  if (g.error) return g.error;
  try {
    return NextResponse.json({ shortages: await greenShortages(prisma) });
  } catch (err) {
    return handleDomainError(err);
  }
}

export async function POST(request: Request) {
  const g = await gate();
  if (g.error) return g.error;
  const body = (await request.json().catch(() => ({}))) as { force?: unknown };
  try {
    const { limited } = await checkAndRecordRateLimit({ scope: "green-readiness", key: g.user.id, limit: 6, windowMs: 10 * 60_000 });
    if (limited) return NextResponse.json({ error: "طلبات كثيرة — حاول بعد دقائق.", errorEn: "Too many requests — try again in a few minutes.", code: "RATE_LIMITED" }, { status: 429 });
    const force = body?.force === true;
    if (force) {
      const refused = await requireAdminAction(g.user, "production.green_readiness_force");
      if (refused) return refused;
    }
    return NextResponse.json(await runGreenReadiness({ force }));
  } catch (err) {
    return handleDomainError(err);
  }
}
