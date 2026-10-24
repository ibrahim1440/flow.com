// Accounting A5 — the accounting dashboard («نظرة عامة»): the figures an owner of a roastery + café decides on, each
// with its basis and source, and the close issues of the open months.
//   cash               CASH + BANK accounts (roles / control type), GL balance today
//   ar / overdueAr     the AR control account (GL) and the overdue part of the AR sub-ledger (A2 aging)
//   ap                 the AP control account (GL)
//   inventory          the five inventory roles + WIP (GL)
//   month              this month's revenue, gross profit and gross margin (the P&L, by function)
//   vatPayable         an ESTIMATE: VAT output − VAT input (+ VAT net payable) balances today — not a return
//   roastCostPerKg     this month's roasted cost per kg (A3 cost of each roast)
//   trend              revenue and gross profit of the last six months
//   issues             FAIL / WARN items of the close checklist of this month and of every earlier month not closed
import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { Decimal, ZERO, fix2 } from "./money";
import { dayText, riyadhDay } from "./dates";
import { incomeStatement, isCashAccount, loadAccountInfo, periodRange } from "./statements";
import { closeChecklist, type CheckResult } from "./close";
import { batchCosts } from "./ops/valuation";
import { agingReport } from "@/lib/services/invoicing/ar";

const INVENTORY = ["INVENTORY_GREEN", "INVENTORY_ROASTED", "INVENTORY_PACKED", "INVENTORY_PACKAGING", "INVENTORY_CAFE", "WIP_ROASTING"];

export async function accountingDashboard(today: Date = riyadhDay()) {
  const y = today.getUTCFullYear(), m = today.getUTCMonth() + 1;
  const end = new Date(today.getTime() + 86_399_999);
  const [accounts, bal] = await Promise.all([
    loadAccountInfo(),
    prisma.$queryRaw<{ accountId: string; v: Prisma.Decimal }[]>`
      SELECT l."accountId", coalesce(sum(l."debit" - l."credit"), 0) AS v FROM "JournalEntryLine" l JOIN "JournalEntry" j ON j."id" = l."journalEntryId"
       WHERE j."status" IN ('POSTED', 'REVERSED') AND j."entryDate" <= ${end} GROUP BY 1`,
  ]);
  const b = new Map(bal.map((r) => [r.accountId, new Decimal(String(r.v))]));
  const sum = (pred: (a: (typeof accounts extends Map<string, infer V> ? V : never)) => boolean) => [...accounts.values()].filter(pred).reduce((s, a) => s.plus(b.get(a.id) ?? ZERO), ZERO);
  const has = (role: string) => (a: { roles: string[] }) => a.roles.includes(role);
  const cash = sum(isCashAccount);
  const ar = sum(has("AR"));
  const ap = sum(has("AP")).negated();
  const inventory = sum((a) => a.roles.some((r) => INVENTORY.includes(r)));
  const vatPayable = sum((a) => a.roles.some((r) => r === "VAT_OUTPUT" || r === "VAT_INPUT" || r === "VAT_NET_PAYABLE")).negated();

  const month = periodRange("month", y, m);
  const [pl, aging, roast, trendRows] = await Promise.all([
    incomeStatement(month, null),
    agingReport(prisma, null, dayText(today)),
    batchCosts(dayText(month.from), dayText(today)).catch(() => null),
    trend(accounts, y, m),
  ]);

  // The close issues: this month and every earlier month of the year (and last December) not CLOSED.
  const goLive = (await prisma.accountingSettings.findUnique({ where: { id: "singleton" }, select: { goLiveDate: true } }))?.goLiveDate ?? null;
  const open = await prisma.fiscalPeriod.findMany({ where: { status: { not: "CLOSED" }, startDate: { lte: end, gte: new Date(Date.UTC(y - 1, 11, 1)) }, ...(goLive ? { endDate: { gte: goLive } } : {}) }, orderBy: { startDate: "asc" }, select: { id: true, year: true, periodNo: true, status: true } });
  const issues: (CheckResult & { period: string; periodId: string })[] = [];
  for (const p of open.slice(-3)) {
    const c = await closeChecklist(p.id);
    for (const x of c.checks) if (x.status === "FAIL" || x.status === "WARN") issues.push({ ...x, period: `${p.year}-${String(p.periodNo).padStart(2, "0")}`, periodId: p.id });
  }
  return {
    asOf: dayText(today), month: month.label,
    kpis: {
      cash: fix2(cash), ar: fix2(ar), ap: fix2(ap), inventory: fix2(inventory), vatPayable: fix2(vatPayable),
      overdueAr: fix2(aging.totals.overdue), overdueCustomers: aging.rows.filter((r) => r.aging.overdue.gt(0)).length,
      revenue: pl.totals.revenue[0], grossProfit: pl.totals.grossProfit[0], grossMarginPct: pl.totals.grossMarginPct[0], netProfit: pl.totals.netProfit[0],
      roastCostPerKg: roast?.totals.roastedUnitCost ?? null, roastedKg: roast?.totals.roastedKg ?? null, roastLossPct: roast?.totals.lossPct ?? null,
    },
    trend: trendRows,
    issues,
    openPeriods: open.map((p) => ({ id: p.id, label: `${p.year}-${String(p.periodNo).padStart(2, "0")}`, status: String(p.status) })),
  };
}

/** Revenue and gross profit of the last six months (one grouped query). */
async function trend(accounts: Awaited<ReturnType<typeof loadAccountInfo>>, y: number, m: number) {
  const start = new Date(Date.UTC(y, m - 6, 1)), end = new Date(Date.UTC(y, m, 0, 23, 59, 59, 999));
  const rows = await prisma.$queryRaw<{ month: string; accountId: string; v: Prisma.Decimal }[]>`
    SELECT to_char(j."entryDate", 'YYYY-MM') AS month, l."accountId", coalesce(sum(l."debit" - l."credit"), 0) AS v
      FROM "JournalEntryLine" l JOIN "JournalEntry" j ON j."id" = l."journalEntryId"
      JOIN "Account" a ON a."id" = l."accountId"
     WHERE j."status" IN ('POSTED', 'REVERSED') AND j."type"::text <> 'CLOSING' AND a."type"::text IN ('REVENUE', 'EXPENSE')
       AND j."entryDate" >= ${start} AND j."entryDate" <= ${end}
     GROUP BY 1, 2`;
  const out: { month: string; revenue: string; grossProfit: string; grossMarginPct: string | null }[] = [];
  for (let i = 0; i < 6; i++) {
    const d = new Date(Date.UTC(y, m - 6 + i, 1));
    const key = dayText(d).slice(0, 7);
    let rev = ZERO, cos = ZERO;
    for (const r of rows) {
      if (r.month !== key) continue;
      const g = accounts.get(r.accountId)?.group;
      if (g === "REVENUE") rev = rev.minus(String(r.v));
      else if (g === "COST_OF_SALES") cos = cos.plus(String(r.v));
    }
    const gp = rev.minus(cos);
    out.push({ month: key, revenue: fix2(rev), grossProfit: fix2(gp), grossMarginPct: rev.isZero() ? null : gp.times(100).dividedBy(rev).toFixed(1) });
  }
  return out;
}
