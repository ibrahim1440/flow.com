// Overview, 13-week cash forecast, alerts and accrual readiness. Read-only.
import { toMinor, type Minor } from "../money";
import { addDays, dbDate, diffDays, monthEnd, monthOf, monthStart, riyadhDateString } from "../dates";
import { runForecast, type FlowItem } from "../forecast";
import { FINANCING_PAYMENTS, FINANCING_RECEIPTS } from "../classes";
import { COMPANY, getSettings, scopeWhere, type Db, type FinanceScope } from "./context";
import { accountBalances, poolSummaries } from "./ledger";
import { listCategories } from "./allocation";
import { listObligations } from "./obligations";
import { budgetReport } from "./budgets";

/** Start of the forecast: the Sunday of the current Riyadh week (Saudi work week). */
function weekStart(today: string): string {
  const dow = new Date(`${today}T00:00:00Z`).getUTCDay(); // 0 = Sunday
  return addDays(today, -dow);
}

export async function cashForecast(db: Db, scope: FinanceScope) {
  const settings = await getSettings(db);
  const today = riyadhDateString();
  const start = weekStart(today);
  const horizonEnd = addDays(start, 13 * 7 - 1);
  const accounts = await accountBalances(db, scope);
  const opening = accounts.filter((a) => !a.isRestricted).reduce((s, a) => s + a.bookBalance, 0);
  const restricted = accounts.filter((a) => a.isRestricted).reduce((s, a) => s + a.bookBalance, 0);

  const [items, obligations, reservations, pendingLines] = await Promise.all([
    db.finForecastItem.findMany({ where: { ...scopeWhere(scope), status: "OPEN", expectedDate: { lte: dbDate(horizonEnd) } } }),
    listObligations(db, scope, { status: "LIVE", dueBefore: horizonEnd, take: 1000 }),
    db.paymentReservation.findMany({ where: { ...scopeWhere(scope), status: { in: ["ACTIVE", "PENDING_APPROVAL"] }, obligationId: null } }),
    db.bankTransaction.findMany({ where: { ...scopeWhere(scope), status: "PENDING", cashAccount: { isRestricted: false } }, select: { txnDate: true, amount: true, description: true } }),
  ]);

  const receipts: FlowItem[] = [];
  const payments: FlowItem[] = [];
  for (const it of items) {
    const f = { date: it.expectedDate.toISOString().slice(0, 10), amount: toMinor(it.amount), label: it.description, source: "forecast", collection: it.kind === "RECEIPT" };
    (it.kind === "RECEIPT" ? receipts : payments).push(f);
  }
  for (const o of obligations.rows) payments.push({ date: o.dueDate, amount: o.remaining, label: o.description, source: "obligation" });
  // Payment requests NOT tied to an obligation are extra outflows; those tied to one are
  // already inside the obligation's remaining amount and are not counted again.
  for (const r of reservations) payments.push({ date: r.dueDate?.toISOString().slice(0, 10) ?? today, amount: toMinor(r.amount), label: `${r.payee}: ${r.purpose}`, source: "payment_request" });
  // Pending bank lines are expected, not cash: they enter the forecast, not the opening.
  for (const p of pendingLines) {
    const amt = toMinor(p.amount);
    (amt > 0 ? receipts : payments).push({ date: p.txnDate.toISOString().slice(0, 10), amount: Math.abs(amt), label: p.description ?? "Pending bank line", source: "pending_line", collection: amt > 0 });
  }

  const base = runForecast(opening, start, receipts, payments, null);
  const conservative = runForecast(opening, start, receipts, payments, { delayWeeks: settings.conservativeDelayWeeks, collectPct: settings.conservativeCollectPct });

  // Month-end projection: confirmed cash + expected flows dated up to month end.
  const mEnd = monthEnd(monthOf(today));
  const upTo = (xs: FlowItem[]) => xs.filter((x) => x.date <= mEnd).reduce((s, x) => s + x.amount, 0);
  const monthEndCash = opening + upTo(receipts) - upTo(payments);

  return {
    start, horizonEnd, opening, restricted, base, conservative, monthEndCash,
    assumptions: {
      conservativeDelayWeeks: settings.conservativeDelayWeeks,
      conservativeCollectPct: settings.conservativeCollectPct,
      note: "Opening = confirmed cash in unrestricted accounts. Internal allocations are not payments and are not deducted. Expected receipts are not cash until received.",
    },
    inputs: { receipts: receipts.length, payments: payments.length },
  };
}

export async function accrualReadiness(db: Db) {
  const [settings, posted, operationalEvents] = await Promise.all([
    db.accountingSettings.findUnique({ where: { id: "singleton" } }),
    db.journalEntry.count({ where: { status: "POSTED" } }),
    db.accountingEvent.count(),
  ]);
  const reasons: string[] = [];
  if (!settings?.setupComplete) reasons.push("Accounting setup is not marked complete.");
  if (operationalEvents === 0) reasons.push("No operational module (sales, purchasing, inventory, payroll) posts accounting events yet.");
  if (posted === 0) reasons.push("There are no posted journal entries.");
  // Even with manual postings, revenue and expense would be incomplete while operational
  // modules do not post: the accrual view stays off until they do.
  return { available: false, reasons, postedJournals: posted };
}

/** `message` is an English fallback; the UI localises from `kind` + `data`. */
export type Alert = { kind: string; severity: "high" | "medium" | "low"; message: string; ref?: string; amount?: Minor; date?: string; data?: Record<string, unknown> };

export async function overview(db: Db, scope: FinanceScope) {
  const settings = await getSettings(db);
  const today = riyadhDateString();
  const month = monthOf(today);
  const [accounts, pools, categories, obligations, forecast, accrual] = await Promise.all([
    accountBalances(db, scope),
    poolSummaries(db, scope),
    listCategories(db, scope, month),
    listObligations(db, scope, { status: "LIVE", take: 500 }),
    cashForecast(db, scope),
    accrualReadiness(db),
  ]);

  // Monthly receipts and payments (confirmed lines, split into operating and financing).
  const lines = await db.bankTransaction.groupBy({
    by: ["classification"],
    where: { ...scopeWhere(scope), status: "CONFIRMED", txnDate: { gte: dbDate(monthStart(month)), lte: dbDate(today) } },
    _sum: { amount: true },
    _count: true,
  });
  let receipts = 0, payments = 0, financingIn = 0, financingOut = 0, transfers = 0, unclassified = 0;
  for (const l of lines) {
    const v = toMinor(l._sum.amount);
    if (l.classification === "INTERNAL_TRANSFER") { transfers += v; continue; }
    if (l.classification === "UNCLASSIFIED") { unclassified += v; continue; }
    if (FINANCING_RECEIPTS.includes(l.classification as never)) { financingIn += v; continue; }
    if (FINANCING_PAYMENTS.includes(l.classification as never)) { financingOut += -v; continue; }
    if (v > 0) receipts += v; else payments += -v;
  }

  // Unfunded obligations: by category, cover obligations in due-date order from what is
  // available; anything beyond that (or with no category at all) is unfunded.
  const avail = new Map(categories.map((c) => [c.id, Math.max(0, c.available + (0))]));
  // Money reserved for a specific obligation already covers it.
  const unfunded = [] as { id: string; description: string; dueDate: string; remaining: Minor; unfunded: Minor; category: string | null }[];
  for (const o of obligations.rows) {
    let need = Math.max(0, o.remaining - o.reserved);
    if (need > 0 && o.allocationCategoryId && avail.has(o.allocationCategoryId)) {
      const a = avail.get(o.allocationCategoryId)!;
      const use = Math.min(a, need);
      avail.set(o.allocationCategoryId, a - use);
      need -= use;
    }
    if (need > 0) unfunded.push({ id: o.id, description: o.description, dueDate: o.dueDate, remaining: o.remaining, unfunded: need, category: categories.find((c) => c.id === o.allocationCategoryId)?.code ?? null });
  }

  const reviewQueue = await db.bankTransaction.count({ where: { ...scopeWhere(scope), reviewStatus: "NEEDS_REVIEW", status: { not: "VOID" } } });
  const pendingApprovals = await db.finApprovalRequest.count({ where: { ...scopeWhere(scope), status: "PENDING" } });

  const alerts: Alert[] = [];
  for (const u of unfunded) {
    const days = diffDays(today, u.dueDate);
    if (days <= settings.obligationAlertDays) {
      alerts.push({ kind: "UNFUNDED_OBLIGATION", severity: days < 0 ? "high" : "medium", message: `${u.description} — ${u.unfunded / 100} SAR unfunded, due ${u.dueDate}`, ref: u.id, amount: u.unfunded, date: u.dueDate, data: { description: u.description, dueDate: u.dueDate, unfunded: u.unfunded, days } });
    }
  }
  if (forecast.base.firstShortfallWeek) {
    const w = forecast.base.weeks[forecast.base.firstShortfallWeek - 1];
    alerts.push({ kind: "CASH_SHORTFALL", severity: "high", message: `Projected cash turns negative in week ${w.index} (${w.start})`, amount: w.closing, date: w.start, data: { week: w.index, start: w.start, closing: w.closing } });
  } else if (forecast.conservative.firstShortfallWeek) {
    const w = forecast.conservative.weeks[forecast.conservative.firstShortfallWeek - 1];
    alerts.push({ kind: "CASH_SHORTFALL_CONSERVATIVE", severity: "medium", message: `In the conservative scenario cash turns negative in week ${w.index} (${w.start})`, amount: w.closing, date: w.start, data: { week: w.index, start: w.start, closing: w.closing } });
  }
  if (reviewQueue > 0) alerts.push({ kind: "UNCLASSIFIED", severity: "medium", message: `${reviewQueue} bank line(s) waiting for review and classification`, amount: reviewQueue, data: { count: reviewQueue } });
  for (const a of accounts) {
    const due = a.lastReconciledDate ? diffDays(a.lastReconciledDate, today) > settings.reconciliationDueDays : true;
    if (due) alerts.push({ kind: "RECONCILIATION_OVERDUE", severity: "low", message: `${a.code}: ${a.lastReconciledDate ? `last reconciled ${a.lastReconciledDate}` : "never reconciled"}`, ref: a.id, date: a.lastReconciledDate ?? undefined, data: { code: a.code, nameEn: a.nameEn, nameAr: a.nameAr, last: a.lastReconciledDate } });
  }
  for (const p of pools) {
    if (p.unallocated < 0) alerts.push({ kind: "OVER_ALLOCATED", severity: "high", message: `${p.branchKey === COMPANY ? "Company" : p.branchKey}: allocations exceed eligible cash by ${-p.unallocated / 100} SAR — review categories`, amount: p.unallocated, data: { branchKey: p.branchKey, over: -p.unallocated } });
    if (p.negativeCategories > 0) alerts.push({ kind: "NEGATIVE_CATEGORY", severity: "high", message: `${p.negativeCategories} category balance(s) are negative after a reversal — funds were already spent`, amount: p.negativeCategories, data: { count: p.negativeCategories } });
  }

  // Budget overruns in the current month.
  const budgets = await db.finBudget.findMany({ where: { month, status: { in: ["APPROVED", "CLOSED"] }, ...(scope.all ? {} : { branchKey: { in: scope.branchKeys } }) }, select: { id: true, branchKey: true } });
  const significant: { budgetId: string; branchKey: string; code: string; nameEn: string; nameAr: string | null; kind: string; state: string; variance: Minor; percentBp: number | null; forecastVariance: Minor }[] = [];
  for (const b of budgets) {
    const r = await budgetReport(db, scope, b.id);
    for (const row of r.rows.filter((x) => x.alert)) {
      significant.push({ budgetId: b.id, branchKey: b.branchKey, code: row.code, nameEn: row.nameEn, nameAr: row.nameAr, kind: row.kind, state: row.toDate.state, variance: row.toDate.variance, percentBp: row.toDate.percentBp, forecastVariance: row.forecastVariance.variance });
      alerts.push({ kind: "BUDGET_VARIANCE", severity: row.toDate.adverse ? "medium" : "low", message: `${row.code}: ${row.toDate.state.replace("_", " ").toLowerCase()} ${Math.abs(row.toDate.variance) / 100} SAR to date`, ref: b.id, amount: row.toDate.variance, data: { code: row.code, nameEn: row.nameEn, nameAr: row.nameAr, state: row.toDate.state, variance: row.toDate.variance, percentBp: row.toDate.percentBp } });
    }
  }

  const rank = { high: 0, medium: 1, low: 2 } as const;
  alerts.sort((a, b) => rank[a.severity] - rank[b.severity]);

  return {
    today, month, accounts, pools, categories,
    monthly: { receipts, payments, financingIn, financingOut, transfers, unclassified, net: receipts - payments },
    reserved: categories.reduce((s, c) => s + c.reserved, 0),
    unfunded, unfundedTotal: unfunded.reduce((s, u) => s + u.unfunded, 0),
    forecast: { monthEndCash: forecast.monthEndCash, lowest: forecast.base.lowestClosing, lowestWeek: forecast.base.lowestWeek, firstShortfallWeek: forecast.base.firstShortfallWeek, conservativeFirstShortfallWeek: forecast.conservative.firstShortfallWeek, weeks: forecast.base.weeks, conservativeWeeks: forecast.conservative.weeks },
    reviewQueue, pendingApprovals, alerts, accrual, currentBudgets: budgets, significantVariances: significant,
    definitions: {
      unallocated: "Eligible cash (confirmed, unrestricted) minus all category balances. The only figure that is not earmarked.",
      available: "Category balance minus open reservations. Spendable for that category's purpose only.",
      reserved: "Held for approved or pending payment requests; still in the bank.",
    },
  };
}
