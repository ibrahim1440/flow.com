// «متابعة الفريق» — the sales manager's quiet overview of the team (batch 24 WP-C, /dashboard/sales/team).
//
// One row per rep, sorted by name — deliberately not by any figure: the owner ruled out leaderboards and
// rep-vs-rep ranking. Each row opens that rep's «يومي» read-only (/dashboard/my-day?rep=<id>, WP-B).
//
// A "rep": an active account holding the sales module that owns at least one customer, or has a target, an
// open deal or a collection this month. Figures, each defined where it is already defined:
//   targetPercent / collected   the month's collections against the target (services/sales/performance.ts —
//                               the same figures as «الأهداف» and «لوحة الأداء»; SAR, collections-based).
//   negotiation                 open deals whose stage purpose is QUOTATION or NEGOTIATION: count and Σ amount.
//   lateReorders                the rep's customers (Customer.accountOwnerId) whose reorder state is LATE
//                               (services/customers/reorder.ts).
//   contractsExpiring           the rep's customers' contracts ending within the company's notice period
//                               (SystemConfig.contractRenewalNoticeDays, NULL = 45 — the same window as «يومي»),
//                               not yet ended, not already renewed (./customers/contracts.ts).
//   unassigned («بدون مندوب»)   the customers with NO account owner and their contracts ending in that window: they
//                               appear on nobody's «يومي», so the manager sees them here (council fix round 1).
//   lastActivityAt              the rep's most recent COMPLETED activity.
// The caller (GET /api/sales/team) admits only a team-view user (seesTeamReports).
import type { PrismaClient } from "@/generated/prisma/client";
import { effectivePermissions } from "@/lib/notifications/recipients";
import { hasModuleAccess } from "@/lib/auth-shared";
import { monthPeriod, performanceSummary } from "./performance";
import { reorderSuggestions } from "../customers/reorder";
import { expiringContracts } from "../customers/contracts";

export const TEAM_CONTRACT_DAYS = 45;

export type TeamRow = {
  employeeId: string;
  name: string;
  customers: number;
  target: string | null;
  targetPercent: string | null;
  collected: string;
  negotiationCount: number;
  negotiationValue: string;
  lateReorders: number;
  contractsExpiring: number;
  lastActivityAt: Date | null;
};

export type TeamOverview = { month: string; rows: TeamRow[]; unassigned: { customers: number; contractsExpiring: number }; contractWindowDays: number };

export async function teamOverview(db: PrismaClient, opts: { selfId: string; now?: Date }): Promise<TeamOverview> {
  const now = opts.now ?? new Date();
  const period = monthPeriod(null, now)!;
  // reorderSuggestions refuses a missing owner unless `scope: "all"` is said in words (batch 24 WP-A scope hardening).
  // This page is team-view only (GET /api/sales/team, seesTeamReports), so it reads every account's reorder state.
  const allBook = { scope: "all" as const, now, limit: 1_000_000, everyCustomer: true };
  const cfg = await db.systemConfig.findUnique({ where: { id: "singleton" }, select: { contractRenewalNoticeDays: true } });
  const windowDays = cfg?.contractRenewalNoticeDays ?? TEAM_CONTRACT_DAYS;
  const [employees, perf, deals, reorder, contracts, activity, books, pool] = await Promise.all([
    db.employee.findMany({ where: { active: true }, select: { id: true, name: true, role: true, permissions: true } }),
    performanceSummary(db, { start: period.start, end: period.end, month: period.month, ownerId: null, selfId: opts.selfId, commission: "none", trendMonths: 1 }),
    db.opportunity.groupBy({
      by: ["ownerId"],
      where: { outcome: "OPEN", stage: { purpose: { in: ["QUOTATION", "NEGOTIATION"] } } },
      _count: { _all: true }, _sum: { amount: true },
    }),
    reorderSuggestions(db, allBook),
    expiringContracts(db, { scope: "all", withinDays: windowDays, now, limit: 2000 }),
    db.activity.groupBy({ by: ["ownerId"], where: { completedAt: { not: null } }, _max: { completedAt: true } }),
    db.customer.groupBy({ by: ["accountOwnerId"], where: { accountOwnerId: { not: null } }, _count: { _all: true } }),
    db.customer.count({ where: { accountOwnerId: null } }),
  ]);

  const repFigures = new Map(perf.reps.map((r) => [r.employeeId, r]));
  const dealsBy = new Map(deals.map((d) => [d.ownerId, d]));
  const lateBy = new Map<string, number>();
  for (const r of reorder) if (r.state === "LATE" && r.accountOwnerId) lateBy.set(r.accountOwnerId, (lateBy.get(r.accountOwnerId) ?? 0) + 1);
  const contractsBy = new Map<string, number>();
  for (const c of contracts) if (c.ownerId && c.daysLeft >= 0) contractsBy.set(c.ownerId, (contractsBy.get(c.ownerId) ?? 0) + 1);
  const lastBy = new Map(activity.map((a) => [a.ownerId, a._max.completedAt]));
  const booksBy = new Map(books.map((b) => [b.accountOwnerId as string, b._count._all]));

  const rows: TeamRow[] = [];
  for (const e of employees) {
    if (!hasModuleAccess(effectivePermissions(e), "sales")) continue;
    const f = repFigures.get(e.id);
    const d = dealsBy.get(e.id);
    const customers = booksBy.get(e.id) ?? 0;
    const active = customers > 0 || (f && (f.target.target !== null || f.netCollected !== "0.00" || f.openCount > 0));
    if (!active) continue;
    rows.push({
      employeeId: e.id,
      name: e.name,
      customers,
      target: f?.target.target ?? null,
      targetPercent: f?.target.percent ?? null,
      collected: f?.netCollected ?? "0.00",
      negotiationCount: d?._count._all ?? 0,
      negotiationValue: d?._sum.amount ? d._sum.amount.toFixed(2) : "0.00",
      lateReorders: lateBy.get(e.id) ?? 0,
      contractsExpiring: contractsBy.get(e.id) ?? 0,
      lastActivityAt: lastBy.get(e.id) ?? null,
    });
  }
  rows.sort((a, b) => a.name.localeCompare(b.name, "ar"));
  const poolContracts = contracts.filter((c) => !c.ownerId && c.daysLeft >= 0).length;
  return { month: period.month, rows, unassigned: { customers: pool, contractsExpiring: poolContracts }, contractWindowDays: windowDays };
}
