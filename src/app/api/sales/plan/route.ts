import { NextResponse } from "@/lib/api-response";
import { prisma } from "@/lib/db";
import { requireModule } from "@/lib/auth-server";
import { handleDomainError } from "@/lib/api-error";
import { seesTeamReports } from "@/lib/services/sales/scope";
import { canSeeCustomerContact } from "@/lib/auth/customer-detail";
import { PERIODS, PlanError, loadPlan, periodStartOf, riyadhIso, setSelfTarget, type Period } from "@/lib/services/sales/plans";

/**
 * «خطة الأسبوع» (owner-approved Figma page 07, 3 Nov 2026).
 *   GET  /api/sales/plan?period=DAY|WEEK|MONTH&date=YYYY-MM-DD[&rep=<id>] — the plan of the caller (or, for a supervisor —
 *        sales › lead_assign or the admin role — a rep's, read-only): the period's numbers with their progress, the planned
 *        actions and free items with whether each is done, and the visits and calls nobody planned.
 *   PUT  /api/sales/plan { period, start, metric, target | null } — the caller's OWN number for one counted kind. A number
 *        the supervisor set is not overridden here (PUT /api/sales/team-goals).
 * Items: POST /api/sales/plan/items, PATCH|DELETE /api/sales/plan/items/:id.
 */
// The supervisor: the same mark as the team reports (sales › lead_assign, or the admin role).
const supervisor = (u: { permissions: unknown; role?: string | null }) => seesTeamReports(u.permissions as never, u.role);
const periodOf = (v: string | null): Period => ((PERIODS as readonly string[]).includes(String(v)) ? (v as Period) : "WEEK");
const err = (e: unknown) => (e instanceof PlanError ? NextResponse.json({ error: e.ar, errorEn: e.message, code: e.code }, { status: e.status }) : handleDomainError(e));

export async function GET(request: Request) {
  const { user, error } = await requireModule("sales");
  if (error) return error;
  const sp = new URL(request.url).searchParams;
  const rep = sp.get("rep");
  if (rep && rep !== user.id && !supervisor(user)) return NextResponse.json({ error: "خطة المندوب يشوفها مشرفه فقط.", errorEn: "Only a supervisor reads a rep's plan." }, { status: 403 });
  try {
    const period = periodOf(sp.get("period"));
    const today = riyadhIso(new Date());
    const day = /^\d{4}-\d{2}-\d{2}$/.test(sp.get("date") ?? "") ? sp.get("date")! : today;
    const start = periodStartOf(period, day);
    // The customers' phone and address (the row's call / WhatsApp / map) only with the customer-contact right.
    const plan = await loadPlan(prisma, rep || user.id, period, start, new Date(), { contact: canSeeCustomerContact(user.permissions) });
    return NextResponse.json({ ...plan, today, readOnly: !!rep && rep !== user.id, canSetGoals: supervisor(user) }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) { return err(e); }
}

export async function PUT(request: Request) {
  const { user, error } = await requireModule("sales");
  if (error) return error;
  try {
    const body = (await request.json().catch(() => null)) as { period?: string; start?: string; metric?: unknown; target?: unknown } | null;
    const period = periodOf(body?.period ?? null);
    if (!body || !/^\d{4}-\d{2}-\d{2}$/.test(String(body.start))) return NextResponse.json({ error: "الفترة غير صحيحة.", errorEn: "Bad period." }, { status: 400 });
    const start = periodStartOf(period, String(body.start));
    await prisma.$transaction((tx) => setSelfTarget(tx, user.id, period, start, body.metric, body.target ?? null));
    return NextResponse.json({ ok: true });
  } catch (e) { return err(e); }
}
