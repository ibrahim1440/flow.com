import { NextResponse } from "@/lib/api-response";
import { prisma } from "@/lib/db";
import { requireModule } from "@/lib/auth-server";
import { handleDomainError } from "@/lib/api-error";
import { seesTeamReports } from "@/lib/services/sales/scope";
import { PERIODS, PlanError, loadPlan, periodStartOf, riyadhIso, saveSelf, type Period } from "@/lib/services/sales/plans";

/**
 * «خطتي» (owner decision, 3 Nov 2026).
 *   GET  /api/sales/plan?period=DAY|WEEK|MONTH&date=YYYY-MM-DD[&rep=<id>] — the plan of the caller (or, for a supervisor —
 *        sales › lead_assign or the admin role — a rep's, read-only) with every goal's progress.
 *   PUT  /api/sales/plan { period, start, items } — the caller replaces their OWN items of that period. Management goals are
 *        not touched here (PUT /api/sales/team-goals).
 */
// The supervisor: the same mark as the team reports (sales › lead_assign, or the admin role).
const supervisor = (u: { permissions: unknown; role?: string | null }) => seesTeamReports(u.permissions as never, u.role);
const periodOf = (v: string | null): Period => ((PERIODS as readonly string[]).includes(String(v)) ? (v as Period) : "WEEK");
const err = (e: unknown) => (e instanceof PlanError ? NextResponse.json({ error: e.ar, errorEn: e.message }, { status: e.status }) : handleDomainError(e));

export async function GET(request: Request) {
  const { user, error } = await requireModule("sales");
  if (error) return error;
  const sp = new URL(request.url).searchParams;
  const rep = sp.get("rep");
  if (rep && rep !== user.id && !supervisor(user)) return NextResponse.json({ error: "خطة المندوب يشوفها مشرفه فقط.", errorEn: "Only a supervisor reads a rep's plan." }, { status: 403 });
  try {
    const period = periodOf(sp.get("period"));
    const day = /^\d{4}-\d{2}-\d{2}$/.test(sp.get("date") ?? "") ? sp.get("date")! : riyadhIso(new Date());
    const start = periodStartOf(period, day);
    const plan = await loadPlan(prisma, rep || user.id, period, start);
    return NextResponse.json({ ...plan, readOnly: !!rep && rep !== user.id, canSetGoals: supervisor(user) });
  } catch (e) { return err(e); }
}

export async function PUT(request: Request) {
  const { user, error } = await requireModule("sales");
  if (error) return error;
  try {
    const body = (await request.json().catch(() => null)) as { period?: string; start?: string; items?: unknown } | null;
    const period = periodOf(body?.period ?? null);
    if (!body || !/^\d{4}-\d{2}-\d{2}$/.test(String(body.start))) return NextResponse.json({ error: "الفترة غير صحيحة.", errorEn: "Bad period." }, { status: 400 });
    const start = periodStartOf(period, String(body.start));
    await prisma.$transaction((tx) => saveSelf(tx, user.id, period, start, body.items as never));
    return NextResponse.json(await loadPlan(prisma, user.id, period, start));
  } catch (e) { return err(e); }
}
