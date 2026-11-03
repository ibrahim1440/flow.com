import { NextResponse } from "@/lib/api-response";
import { prisma } from "@/lib/db";
import { requireSub } from "@/lib/auth-server";
import { handleDomainError } from "@/lib/api-error";
import { hasModuleAccess, hasSubPrivilege, type Permissions } from "@/lib/auth-shared";
import { PlanError, loadPlan, periodEndOf, periodStartOf, riyadhIso, setAdminGoals, type Period } from "@/lib/services/sales/plans";

/**
 * «أهداف الفريق» (owner decision, 3 Nov 2026) — sales › lead_assign: the people who set the monthly target (the general
 * manager, the admin, whoever distributes the customers).
 *   GET /api/sales/team-goals?period=WEEK|MONTH&date=YYYY-MM-DD — every rep (sales module, no lead_assign, active) with
 *       the period's management goals, what each has done, and how their plan went (planned items, done, «خارج الخطة»).
 *   PUT /api/sales/team-goals { period, start, goals: [{ employeeId, metric, label?, target | null }] }.
 */
const periodOf = (v: unknown): Period => (v === "MONTH" ? "MONTH" : "WEEK");

export async function GET(request: Request) {
  const { error } = await requireSub("sales", "lead_assign");
  if (error) return error;
  try {
    const sp = new URL(request.url).searchParams;
    const period = periodOf(sp.get("period"));
    const day = /^\d{4}-\d{2}-\d{2}$/.test(sp.get("date") ?? "") ? sp.get("date")! : riyadhIso(new Date());
    const start = periodStartOf(period, day);
    const end = periodEndOf(period, start);
    const staff = await prisma.employee.findMany({ where: { active: true, role: { not: "admin" } }, select: { id: true, name: true, permissions: true }, orderBy: { name: "asc" } });
    const reps = staff.filter((e) => {
      const p = (typeof e.permissions === "string" ? JSON.parse(e.permissions) : e.permissions) as Permissions;
      return hasModuleAccess(p, "sales") && !hasSubPrivilege(p, "sales", "lead_assign");
    });
    const ids = reps.map((r) => r.id);
    const [goals, books] = await Promise.all([
      prisma.salesPlanItem.findMany({ where: { employeeId: { in: ids }, period, periodStart: new Date(`${start}T00:00:00Z`), source: "ADMIN", kind: "GOAL" },
        select: { id: true, employeeId: true, metric: true, label: true, target: true, manualDone: true } }),
      prisma.customer.groupBy({ by: ["accountOwnerId"], where: { accountOwnerId: { in: ids } }, _count: { _all: true } }),
    ]);
    // Each rep's plan of the period: what each did (the counts) and how the planned actions went.
    const plans = await Promise.all(reps.map((r) => loadPlan(prisma, r.id, period, start)));
    return NextResponse.json({
      period, start, end,
      reps: reps.map((r, i) => ({
        id: r.id, name: r.name, customers: books.find((b) => b.accountOwnerId === r.id)?._count._all ?? 0, counts: plans[i].counts,
        plan: {
          planned: plans[i].items.filter((x) => x.kind !== "GOAL").length,
          done: plans[i].items.filter((x) => x.kind !== "GOAL" && x.checked).length,
          offPlan: plans[i].offPlan.length,
        },
        goals: goals.filter((g) => g.employeeId === r.id).map((g) => ({ id: g.id, metric: g.metric, label: g.label, target: Number(g.target), done: g.metric === "CUSTOM" ? Number(g.manualDone ?? 0) : null })),
      })),
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) { return handleDomainError(e); }
}

export async function PUT(request: Request) {
  const { user, error } = await requireSub("sales", "lead_assign");
  if (error) return error;
  try {
    const body = (await request.json().catch(() => null)) as { period?: string; start?: string; goals?: unknown } | null;
    if (!body || !/^\d{4}-\d{2}-\d{2}$/.test(String(body.start))) return NextResponse.json({ error: "الفترة غير صحيحة.", errorEn: "Bad period." }, { status: 400 });
    const period = periodOf(body.period);
    const start = periodStartOf(period, String(body.start));
    await prisma.$transaction((tx) => setAdminGoals(tx, user.id, period, start, body.goals as never));
    return NextResponse.json({ ok: true, period, start });
  } catch (e) {
    if (e instanceof PlanError) return NextResponse.json({ error: e.ar, errorEn: e.message }, { status: e.status });
    return handleDomainError(e);
  }
}
