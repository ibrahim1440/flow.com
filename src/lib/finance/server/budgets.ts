// Monthly CASH budget: lifecycle, revisions, actual-versus-budget, forecasts.
//
// Basis: CASH (receipts and payments). The accounting module does not yet receive
// operational postings, so no accrual figures are reliable; an ACCRUAL budget is refused
// and the report never derives profit. Planned and actual always use the same basis.
//
// Lifecycle: Draft → Submitted → Approved → Closed. Revision 1 is the original approved
// baseline. A change after approval is a NEW revision (with reason, editor, approver and
// timestamps); approved revisions are immutable in the database (trigger), so an overrun
// can never be hidden by quietly editing the plan.
//
// A COMPANY budget is consolidated across every branch and needs company-wide access; a
// branch budget covers that branch only.
import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { fromMinor, parseMoney, toMinor, type Minor } from "../money";
import { rowCompleteness, unreconciledAccounts, type OpenLine, type RowCompleteness } from "../completeness";
import { addMonths, dbDate, isDateString, isMonthString, monthEnd, monthStart, riyadhDateString } from "../dates";
import { plannedThrough, validateWeights, type Phasing } from "../phasing";
import { aggregateVariance, computeVariance, crossesThreshold, forecastAtCompletion, type Variance } from "../variance";
import {
  assertCan, assertScope, audit, COMPANY, FinanceError, getSettings, reqStr, str,
  type Db, type FinanceActor, type FinanceScope,
} from "./context";
import { createApproval } from "./approval-core";
import { LIVE_OBLIGATION, paidByObligation } from "./obligations";

type LineInput = {
  finCategoryId: string; costCenterId: string | null; kind: "RECEIPT" | "PAYMENT" | "SALES_MEMO"; plannedAmount: Minor;
  ownerEmployeeId: string | null; assumptions: string | null; dueDate: string | null; phasing: Phasing; phasingWeights: Record<string, number> | null;
};

export const lineKeyOf = (kind: string, finCategoryId: string, costCenterId: string | null) => `${kind}:${finCategoryId}:${costCenterId ?? "-"}`;

function budgetScopeKeys(budget: { branchKey: string }): string[] | null {
  return budget.branchKey === COMPANY ? null : [budget.branchKey];
}

async function loadBudget(db: Db, scope: FinanceScope, id: string) {
  const b = await db.finBudget.findUnique({ where: { id }, include: { revisions: { orderBy: { revisionNo: "asc" }, include: { lines: true } } } });
  if (!b) throw new FinanceError("Not found", 404);
  assertScope(scope, b.branchKey);
  return b;
}

export async function listBudgets(db: Db, scope: FinanceScope) {
  return db.finBudget.findMany({
    where: scope.all ? {} : { branchKey: { in: scope.branchKeys } },
    include: { revisions: { select: { id: true, revisionNo: true, status: true, decidedAt: true } } },
    orderBy: [{ month: "desc" }, { branchKey: "asc" }], take: 120,
  });
}

async function actualsByCategory(db: Db, branchKeys: string[] | null, from: string, to: string) {
  const rows = await db.bankTransactionSplit.groupBy({
    by: ["finCategoryId", "costCenterId"],
    where: {
      transaction: {
        status: "CONFIRMED",
        txnDate: { gte: dbDate(from), lte: dbDate(to) },
        ...(branchKeys ? { branchKey: { in: branchKeys } } : {}),
      },
    },
    _sum: { amount: true },
  });
  return rows.map((r) => ({ finCategoryId: r.finCategoryId, costCenterId: r.costCenterId, signed: toMinor(r._sum.amount) }));
}

export async function createBudget(actor: FinanceActor, scope: FinanceScope, body: Record<string, unknown>) {
  assertCan(actor, "budget_prepare");
  const month = body.month;
  if (!isMonthString(month)) throw new FinanceError("Month must be YYYY-MM.", 400);
  const branchKey = str(body.branchKey, 60) ?? COMPANY;
  assertScope(scope, branchKey);
  if (body.basis === "ACCRUAL") {
    throw new FinanceError("An accrual budget is not available: operational modules do not yet post accounting entries, so accrual actuals would be incomplete.", 409);
  }
  const startFrom = String(body.startFrom ?? "EMPTY");
  if (!["EMPTY", "COPY_PREVIOUS", "HISTORICAL_ACTUALS"].includes(startFrom)) throw new FinanceError("Unknown starting point.", 400);

  return prisma.$transaction(async (tx) => {
    const b = await tx.finBudget.create({ data: { month, branchKey, basis: "CASH", title: str(body.title, 120), costCenterId: str(body.costCenterId, 40), createdBy: actor.id } });
    const rev = await tx.budgetRevision.create({ data: { budgetId: b.id, revisionNo: 1, createdBy: actor.id, reason: "Original budget" } });
    let lines: Prisma.BudgetLineCreateManyInput[] = [];
    const prevMonth = addMonths(month, -1);
    if (startFrom === "COPY_PREVIOUS") {
      const prev = await tx.finBudget.findUnique({ where: { month_branchKey: { month: prevMonth, branchKey } }, include: { revisions: { where: { status: "APPROVED" }, orderBy: { revisionNo: "desc" }, take: 1, include: { lines: true } } } });
      const src = prev?.revisions[0]?.lines ?? [];
      if (!src.length) throw new FinanceError(`No approved budget for ${prevMonth} to copy.`, 409);
      lines = src.map((l) => ({
        revisionId: rev.id, lineKey: l.lineKey, finCategoryId: l.finCategoryId, costCenterId: l.costCenterId, kind: l.kind,
        plannedAmount: l.plannedAmount, ownerEmployeeId: l.ownerEmployeeId, assumptions: l.assumptions,
        dueDate: l.dueDate ? dbDate(`${month}-${String(Math.min(Number(l.dueDate.toISOString().slice(8, 10)), Number(monthEnd(month).slice(8)))).padStart(2, "0")}`) : null,
        phasing: l.phasing, phasingWeights: l.phasingWeights ?? Prisma.JsonNull,
      }));
    } else if (startFrom === "HISTORICAL_ACTUALS") {
      const acts = await actualsByCategory(tx, budgetScopeKeys({ branchKey }), monthStart(prevMonth), monthEnd(prevMonth));
      const cats = await tx.finCategory.findMany({ where: { id: { in: acts.map((a) => a.finCategoryId) } } });
      lines = acts.flatMap((a) => {
        const c = cats.find((x) => x.id === a.finCategoryId);
        if (!c) return [];
        const planned = c.kind === "RECEIPT" ? a.signed : -a.signed;
        if (planned <= 0) return [];
        return [{
          revisionId: rev.id, lineKey: lineKeyOf(c.kind, c.id, a.costCenterId), finCategoryId: c.id, costCenterId: a.costCenterId,
          kind: c.kind, plannedAmount: fromMinor(planned), assumptions: `Actual ${prevMonth}`, phasing: "DUE_DATE" as const,
        }];
      });
    }
    if (lines.length) await tx.budgetLine.createMany({ data: lines });
    await audit(tx, { action: "budget.created", entityType: "FinBudget", entityId: b.id, branchKey, after: { budget: b, startFrom, lines: lines.length }, userId: actor.id });
    return b;
  });
}

function parseLines(raw: unknown): LineInput[] {
  if (!Array.isArray(raw)) throw new FinanceError("lines must be an array.", 400);
  if (raw.length > 300) throw new FinanceError("At most 300 lines.", 400);
  return raw.map((r, i) => {
    const o = (r ?? {}) as Record<string, unknown>;
    const kind = String(o.kind);
    if (!["RECEIPT", "PAYMENT", "SALES_MEMO"].includes(kind)) throw new FinanceError(`Line ${i + 1}: unknown kind.`, 400);
    const planned = parseMoney(o.plannedAmount);
    if (planned === null || planned < 0) throw new FinanceError(`Line ${i + 1}: planned amount must be zero or positive.`, 400);
    const phasing = String(o.phasing ?? "DUE_DATE") as Phasing;
    if (!["DUE_DATE", "CUSTOM_WEIGHTS", "STRAIGHT_LINE"].includes(phasing)) throw new FinanceError(`Line ${i + 1}: unknown phasing.`, 400);
    const dueDate = o.dueDate ? String(o.dueDate) : null;
    if (dueDate && !isDateString(dueDate)) throw new FinanceError(`Line ${i + 1}: invalid due date.`, 400);
    const weights = phasing === "CUSTOM_WEIGHTS" ? validateWeights(o.phasingWeights) : null;
    if (phasing === "CUSTOM_WEIGHTS" && !weights) throw new FinanceError(`Line ${i + 1}: custom phasing needs day weights, e.g. {"1": 1, "15": 1}.`, 400);
    return {
      finCategoryId: reqStr(o.finCategoryId, `Line ${i + 1} category`, 40), costCenterId: str(o.costCenterId, 40),
      kind: kind as LineInput["kind"], plannedAmount: planned, ownerEmployeeId: str(o.ownerEmployeeId, 40),
      assumptions: str(o.assumptions, 1000), dueDate, phasing, phasingWeights: weights,
    };
  });
}

export async function saveDraftLines(actor: FinanceActor, scope: FinanceScope, budgetId: string, body: Record<string, unknown>) {
  assertCan(actor, "budget_prepare");
  const lines = parseLines(body.lines);
  return prisma.$transaction(async (tx) => {
    const b = await loadBudget(tx, scope, budgetId);
    if (b.status === "CLOSED") throw new FinanceError("This budget period is closed.", 409);
    const draft = b.revisions.find((r) => r.status === "DRAFT" || r.status === "REJECTED");
    if (!draft) throw new FinanceError("There is no draft revision. Start a revision to change an approved budget.", 409);
    const cats = await tx.finCategory.findMany({ where: { id: { in: lines.map((l) => l.finCategoryId) } } });
    const keys = new Set<string>();
    for (const l of lines) {
      const c = cats.find((x) => x.id === l.finCategoryId);
      if (!c) throw new FinanceError("Unknown budget category.", 400);
      if (l.kind !== "SALES_MEMO" && c.kind !== l.kind) throw new FinanceError(`${c.code} is a ${c.kind.toLowerCase()} category.`, 400);
      if (l.dueDate && !l.dueDate.startsWith(b.month)) throw new FinanceError(`Due dates must fall in ${b.month}.`, 400);
      const k = lineKeyOf(l.kind, l.finCategoryId, l.costCenterId);
      if (keys.has(k)) throw new FinanceError(`${c.code} appears twice; combine the lines.`, 400);
      keys.add(k);
    }
    const before = draft.lines;
    await tx.budgetLine.deleteMany({ where: { revisionId: draft.id } });
    await tx.budgetLine.createMany({
      data: lines.map((l) => ({
        revisionId: draft.id, lineKey: lineKeyOf(l.kind, l.finCategoryId, l.costCenterId), finCategoryId: l.finCategoryId,
        costCenterId: l.costCenterId, kind: l.kind, plannedAmount: fromMinor(l.plannedAmount), ownerEmployeeId: l.ownerEmployeeId,
        assumptions: l.assumptions, dueDate: l.dueDate ? dbDate(l.dueDate) : null, phasing: l.phasing,
        phasingWeights: l.phasingWeights ?? Prisma.JsonNull,
      })),
    });
    if (draft.status === "REJECTED") await tx.budgetRevision.update({ where: { id: draft.id }, data: { status: "DRAFT" } });
    await audit(tx, { action: "budget.lines_saved", entityType: "BudgetRevision", entityId: draft.id, branchKey: b.branchKey, before, after: lines, userId: actor.id });
    return { revisionId: draft.id, lines: lines.length };
  });
}

/** Lines of the editable (draft or rejected) revision, for the line editor. */
export async function draftLines(db: Db, scope: FinanceScope, budgetId: string) {
  const b = await loadBudget(db, scope, budgetId);
  const draft = b.revisions.find((r) => r.status === "DRAFT" || r.status === "REJECTED");
  if (!draft) throw new FinanceError("There is no draft revision.", 404);
  return { revisionId: draft.id, lines: draft.lines };
}

export async function submitBudget(actor: FinanceActor, scope: FinanceScope, budgetId: string, body: Record<string, unknown>) {
  assertCan(actor, "budget_prepare");
  return prisma.$transaction(async (tx) => {
    const b = await loadBudget(tx, scope, budgetId);
    const draft = b.revisions.find((r) => r.status === "DRAFT");
    if (!draft) throw new FinanceError("Nothing to submit.", 409);
    if (draft.lines.length === 0) throw new FinanceError("Add at least one budget line.", 400);
    if (draft.revisionNo > 1 && !draft.reason) throw new FinanceError("A revision needs a reason.", 400);
    await tx.budgetRevision.update({ where: { id: draft.id }, data: { status: "SUBMITTED", submittedAt: new Date(), submittedBy: actor.id } });
    if (draft.revisionNo === 1) await tx.finBudget.update({ where: { id: b.id }, data: { status: "SUBMITTED" } });
    const total = (k: string) => draft.lines.filter((l) => l.kind === k).reduce((s, l) => s + toMinor(l.plannedAmount), 0);
    return createApproval(tx, actor, {
      type: "BUDGET_APPROVAL", branchKey: b.branchKey, entityType: "BudgetRevision", entityId: draft.id,
      summary: `${b.month} ${draft.revisionNo === 1 ? "budget" : `revision ${draft.revisionNo}`} — receipts ${fromMinor(total("RECEIPT"))} / payments ${fromMinor(total("PAYMENT"))} SAR`,
      payload: { budgetId: b.id, month: b.month, revisionNo: draft.revisionNo, receipts: total("RECEIPT"), payments: total("PAYMENT") },
      reason: draft.reason ?? str(body.reason, 500), assignedToId: str(body.assignedToId, 40),
    });
  });
}

export async function decideRevision(tx: Prisma.TransactionClient, revisionId: string, approve: boolean, deciderId: string, note: string | null) {
  const rev = await tx.budgetRevision.findUnique({ where: { id: revisionId } });
  if (!rev || rev.status !== "SUBMITTED") throw new FinanceError("Revision is not awaiting approval.", 409);
  await tx.budgetRevision.update({ where: { id: revisionId }, data: { status: approve ? "APPROVED" : "REJECTED", decidedAt: new Date(), decidedBy: deciderId, decisionNote: note } });
  if (rev.revisionNo === 1) await tx.finBudget.update({ where: { id: rev.budgetId }, data: { status: approve ? "APPROVED" : "DRAFT" } });
}

export async function startRevision(actor: FinanceActor, scope: FinanceScope, budgetId: string, reason: string) {
  assertCan(actor, "budget_prepare");
  return prisma.$transaction(async (tx) => {
    const b = await loadBudget(tx, scope, budgetId);
    if (b.status !== "APPROVED") throw new FinanceError("Only an approved, open budget can be revised.", 409);
    if (b.revisions.some((r) => r.status === "DRAFT" || r.status === "SUBMITTED" || r.status === "REJECTED")) {
      throw new FinanceError("A revision is already in progress.", 409);
    }
    const latest = [...b.revisions].reverse().find((r) => r.status === "APPROVED")!;
    const rev = await tx.budgetRevision.create({ data: { budgetId, revisionNo: latest.revisionNo + 1, reason, createdBy: actor.id } });
    await tx.budgetLine.createMany({
      data: latest.lines.map((l) => ({
        revisionId: rev.id, lineKey: l.lineKey, finCategoryId: l.finCategoryId, costCenterId: l.costCenterId, kind: l.kind,
        plannedAmount: l.plannedAmount, ownerEmployeeId: l.ownerEmployeeId, assumptions: l.assumptions, dueDate: l.dueDate,
        phasing: l.phasing, phasingWeights: l.phasingWeights ?? Prisma.JsonNull,
      })),
    });
    await audit(tx, { action: "budget.revision_started", entityType: "BudgetRevision", entityId: rev.id, branchKey: b.branchKey, after: rev, reason, userId: actor.id });
    return rev;
  });
}

export async function closeBudget(actor: FinanceActor, scope: FinanceScope, budgetId: string, reason: string | null) {
  assertCan(actor, "period_close");
  return prisma.$transaction(async (tx) => {
    const b = await loadBudget(tx, scope, budgetId);
    if (b.status !== "APPROVED") throw new FinanceError("Only an approved budget can be closed.", 409);
    if (b.revisions.some((r) => r.status === "SUBMITTED")) throw new FinanceError("A revision is awaiting approval.", 409);
    const upd = await tx.finBudget.update({ where: { id: budgetId }, data: { status: "CLOSED", closedAt: new Date(), closedBy: actor.id } });
    await audit(tx, { action: "budget.closed", entityType: "FinBudget", entityId: budgetId, branchKey: b.branchKey, before: { status: b.status }, after: { status: "CLOSED" }, reason, userId: actor.id });
    return upd;
  });
}

export async function requestReopen(actor: FinanceActor, scope: FinanceScope, budgetId: string, reason: string) {
  assertCan(actor, "period_close");
  return prisma.$transaction(async (tx) => {
    const b = await loadBudget(tx, scope, budgetId);
    if (b.status !== "CLOSED") throw new FinanceError("Only a closed budget can be reopened.", 409);
    const open = await tx.finApprovalRequest.findFirst({ where: { type: "PERIOD_REOPEN", entityId: budgetId, status: "PENDING" } });
    if (open) throw new FinanceError("A reopen request is already pending.", 409);
    return createApproval(tx, actor, { type: "PERIOD_REOPEN", branchKey: b.branchKey, entityType: "FinBudget", entityId: budgetId, summary: `Reopen ${b.month} budget`, payload: { month: b.month }, reason });
  });
}

// ─── Report ─────────────────────────────────────────────────────────────────

export type ReportRow = {
  lineKey: string; kind: "RECEIPT" | "PAYMENT"; finCategoryId: string; costCenterId: string | null;
  code: string; nameEn: string; nameAr: string | null; isOperating: boolean;
  originalApproved: Minor | null; revisedApproved: Minor | null; baseline: Minor;
  plannedToDate: Minor; actualToDate: Minor; toDate: Variance;
  fullMonth: Variance; openCommitments: Minor; additionalForecast: Minor; remainingForecast: Minor;
  fac: Minor; forecastVariance: Variance; alert: boolean;
  ownerEmployeeId: string | null; ownerName: string | null; phasing: string | null; dueDate: string | null;
  note: { id: string; explanation: string; correctiveAction: string | null; responsibleEmployeeId: string | null; followUpDate: string | null; status: string } | null;
  unbudgeted: boolean;
  /** Whether this row's actual could still change (D4a): see completeness.ts. */
  completeness: RowCompleteness;
};

export async function budgetReport(db: Db, scope: FinanceScope, budgetId: string, reportDateIn?: string) {
  const b = await loadBudget(db, scope, budgetId);
  const settings = await getSettings(db);
  const today = riyadhDateString();
  const mStart = monthStart(b.month);
  const mEnd = monthEnd(b.month);
  const reportDate = isDateString(reportDateIn) ? reportDateIn : today < mStart ? mStart : today > mEnd ? mEnd : today;
  if (reportDate < mStart || reportDate > mEnd) throw new FinanceError(`Reporting date must fall in ${b.month}.`, 400);
  const monthOver = reportDate >= mEnd;
  const keys = budgetScopeKeys(b);

  const approved = b.revisions.filter((r) => r.status === "APPROVED");
  const original = approved[0] ?? null;
  const latest = approved[approved.length - 1] ?? null;
  const working = latest ?? [...b.revisions].reverse()[0];
  const hasRevision = !!(latest && original && latest.id !== original.id);

  const acts = await actualsByCategory(db, keys, mStart, reportDate);
  const actFull = monthOver ? acts : await actualsByCategory(db, keys, mStart, mEnd);
  const catIds = new Set<string>([...acts.map((a) => a.finCategoryId), ...b.revisions.flatMap((r) => r.lines.map((l) => l.finCategoryId))]);

  // Commitments: live obligations due by month end, remaining (unpaid) part only.
  const obligations = monthOver ? [] : await db.finObligation.findMany({
    where: { status: { in: [...LIVE_OBLIGATION] }, dueDate: { lte: dbDate(mEnd) }, finCategoryId: { not: null }, ...(keys ? { branchKey: { in: keys } } : {}) },
  });
  const paid = await paidByObligation(db, obligations.map((o) => o.id));
  const commitByCat = new Map<string, Minor>();
  for (const o of obligations) {
    const rem = Math.max(0, toMinor(o.amount) - (paid.get(o.id) ?? 0));
    commitByCat.set(o.finCategoryId!, (commitByCat.get(o.finCategoryId!) ?? 0) + rem);
    catIds.add(o.finCategoryId!);
  }
  // Additional forecast: open items in the month that are not obligations (separate table,
  // so a commitment can never be counted twice).
  const items = monthOver ? [] : await db.finForecastItem.findMany({
    where: { status: "OPEN", expectedDate: { gte: dbDate(mStart), lte: dbDate(mEnd) }, finCategoryId: { not: null }, ...(keys ? { branchKey: { in: keys } } : {}) },
  });
  const addByCat = new Map<string, Minor>();
  for (const it of items) { addByCat.set(it.finCategoryId!, (addByCat.get(it.finCategoryId!) ?? 0) + toMinor(it.amount)); catIds.add(it.finCategoryId!); }

  const cats = await db.finCategory.findMany({ where: { id: { in: [...catIds] } } });
  const notes = await db.finVarianceNote.findMany({ where: { budgetId }, orderBy: { createdAt: "desc" } });
  const ownerIds = [...new Set(working?.lines.map((l) => l.ownerEmployeeId).filter(Boolean) as string[])];
  const owners = await db.employee.findMany({ where: { id: { in: ownerIds } }, select: { id: true, name: true } });
  const thresholds = { amount: toMinor(settings.alertAmountThreshold), percentBp: Math.round(Number(settings.alertPercentThreshold) * 100), mode: settings.alertThresholdMode === "BOTH" ? "BOTH" as const : "EITHER" as const };

  const lineMap = (rev: typeof original) => new Map((rev?.lines ?? []).filter((l) => l.kind !== "SALES_MEMO").map((l) => [l.lineKey, l]));
  const origLines = lineMap(original);
  const latestLines = lineMap(latest ?? working);
  const allKeys = new Set<string>([...origLines.keys(), ...latestLines.keys()]);
  const actualKey = (a: { finCategoryId: string; costCenterId: string | null }) => {
    const c = cats.find((x) => x.id === a.finCategoryId)!;
    return lineKeyOf(c.kind, a.finCategoryId, a.costCenterId);
  };
  for (const a of acts) if (cats.find((c) => c.id === a.finCategoryId)) allKeys.add(actualKey(a));
  // Commitment/forecast categories with no line land on the category-level key.
  for (const id of [...commitByCat.keys(), ...addByCat.keys()]) {
    const c = cats.find((x) => x.id === id);
    if (c && ![...allKeys].some((k) => k.split(":")[1] === id)) allKeys.add(lineKeyOf(c.kind, id, null));
  }

  const rows: ReportRow[] = [];
  const commitUsed = new Set<string>();
  for (const key of allKeys) {
    const [kind, finCategoryId, ccRaw] = key.split(":");
    const costCenterId = ccRaw === "-" ? null : ccRaw;
    const c = cats.find((x) => x.id === finCategoryId);
    if (!c) continue;
    const o = origLines.get(key);
    const l = latestLines.get(key);
    const baselineLine = l ?? null;
    const baseline = baselineLine ? toMinor(baselineLine.plannedAmount) : 0;
    const sign = kind === "RECEIPT" ? 1 : -1;
    const actualToDate = sign * acts.filter((a) => a.finCategoryId === finCategoryId && (a.costCenterId ?? null) === costCenterId).reduce((s, a) => s + a.signed, 0);
    const actualMonth = sign * actFull.filter((a) => a.finCategoryId === finCategoryId && (a.costCenterId ?? null) === costCenterId).reduce((s, a) => s + a.signed, 0);
    const plannedToDate = baselineLine
      ? plannedThrough({ planned: baseline, phasing: baselineLine.phasing as Phasing, dueDate: baselineLine.dueDate?.toISOString().slice(0, 10) ?? null, weights: baselineLine.phasingWeights as Record<string, number> | null }, b.month, reportDate)
      : 0;
    // Category-level commitments attach to the first row of that category only.
    let openCommitments = 0, additionalForecast = 0;
    if (!commitUsed.has(finCategoryId)) {
      openCommitments = commitByCat.get(finCategoryId) ?? 0;
      additionalForecast = addByCat.get(finCategoryId) ?? 0;
      commitUsed.add(finCategoryId);
    }
    const { remainingForecast, fac } = forecastAtCompletion({ actualToDate, openCommitments, additionalForecast });
    const toDate = computeVariance(kind as "RECEIPT", plannedToDate, actualToDate);
    const forecastVariance = computeVariance(kind as "RECEIPT", baseline, fac);
    const note = notes.find((n) => n.lineKey === key) ?? null;
    rows.push({
      lineKey: key, kind: kind as "RECEIPT", finCategoryId, costCenterId, code: c.code, nameEn: c.nameEn, nameAr: c.nameAr, isOperating: c.isOperating,
      originalApproved: o ? toMinor(o.plannedAmount) : null, revisedApproved: hasRevision && l ? toMinor(l.plannedAmount) : null, baseline,
      plannedToDate, actualToDate, toDate, fullMonth: computeVariance(kind as "RECEIPT", baseline, actualMonth),
      openCommitments, additionalForecast, remainingForecast, fac, forecastVariance,
      alert: crossesThreshold(toDate, thresholds) || crossesThreshold(forecastVariance, thresholds),
      ownerEmployeeId: baselineLine?.ownerEmployeeId ?? null, ownerName: owners.find((x) => x.id === baselineLine?.ownerEmployeeId)?.name ?? null,
      phasing: baselineLine?.phasing ?? null, dueDate: baselineLine?.dueDate?.toISOString().slice(0, 10) ?? null,
      note: note ? { id: note.id, explanation: note.explanation, correctiveAction: note.correctiveAction, responsibleEmployeeId: note.responsibleEmployeeId, followUpDate: note.followUpDate?.toISOString().slice(0, 10) ?? null, status: note.status } : null,
      unbudgeted: !o && !l,
      completeness: { verified: false, unreviewed: 0, pending: 0, unreconciled: [] },
    });
  }
  rows.sort((a, b2) => (a.kind === b2.kind ? a.code.localeCompare(b2.code) : a.kind === "RECEIPT" ? -1 : 1));

  const agg = (kind: "RECEIPT" | "PAYMENT", pick: (r: ReportRow) => { planned: Minor; actual: Minor }, filter?: (r: ReportRow) => boolean) =>
    aggregateVariance(kind, rows.filter((r) => r.kind === kind && (!filter || filter(r))).map(pick));
  const totals = {
    receipts: { toDate: agg("RECEIPT", (r) => ({ planned: r.plannedToDate, actual: r.actualToDate })), fullMonth: agg("RECEIPT", (r) => ({ planned: r.baseline, actual: r.fullMonth.actual })), forecast: agg("RECEIPT", (r) => ({ planned: r.baseline, actual: r.fac })) },
    payments: { toDate: agg("PAYMENT", (r) => ({ planned: r.plannedToDate, actual: r.actualToDate })), fullMonth: agg("PAYMENT", (r) => ({ planned: r.baseline, actual: r.fullMonth.actual })), forecast: agg("PAYMENT", (r) => ({ planned: r.baseline, actual: r.fac })) },
    operatingReceipts: agg("RECEIPT", (r) => ({ planned: r.plannedToDate, actual: r.actualToDate }), (r) => r.isOperating),
    operatingPayments: agg("PAYMENT", (r) => ({ planned: r.plannedToDate, actual: r.actualToDate }), (r) => r.isOperating),
  };
  const netCashFlow = { toDate: totals.receipts.toDate.actual - totals.payments.toDate.actual, forecast: totals.receipts.forecast.actual - totals.payments.forecast.actual, planned: totals.receipts.fullMonth.planned - totals.payments.fullMonth.planned };

  // Completeness: a verified zero needs every line reviewed and every account reconciled.
  const txWhere: Prisma.BankTransactionWhereInput = { txnDate: { gte: dbDate(mStart), lte: dbDate(reportDate) }, status: { not: "VOID" }, ...(keys ? { branchKey: { in: keys } } : {}) };
  const [needsReview, pending, lastTxn, accounts] = await Promise.all([
    db.bankTransaction.count({ where: { ...txWhere, reviewStatus: "NEEDS_REVIEW" } }),
    db.bankTransaction.count({ where: { ...txWhere, status: "PENDING" } }),
    db.bankTransaction.findFirst({ where: keys ? { branchKey: { in: keys } } : {}, orderBy: { createdAt: "desc" }, select: { createdAt: true } }),
    db.cashAccount.findMany({ where: { active: true, ...(keys ? { branchKey: { in: keys } } : {}) }, select: { id: true, code: true } }),
  ]);
  const recons = await db.bankReconciliation.findMany({ where: { cashAccountId: { in: accounts.map((a) => a.id) }, status: "COMPLETED" }, orderBy: { statementDate: "desc" }, distinct: ["cashAccountId"] });
  const reconciledThrough = accounts.length === 0 ? null : accounts.every((a) => recons.some((r) => r.cashAccountId === a.id))
    ? recons.map((r) => r.statementDate.toISOString().slice(0, 10)).sort()[0] : null;
  const complete = needsReview === 0 && pending === 0 && !!reconciledThrough && reconciledThrough >= reportDate;
  // Per row: only indicators that could actually change THIS row (direction and category).
  const open = await db.bankTransaction.findMany({
    where: { ...txWhere, OR: [{ reviewStatus: "NEEDS_REVIEW" }, { status: "PENDING" }] },
    select: { amount: true, status: true, reviewStatus: true, splits: { select: { finCategoryId: true } } },
  });
  const openLines: OpenLine[] = open.map((t) => ({ amount: toMinor(t.amount), status: t.status === "PENDING" ? "PENDING" : "CONFIRMED", reviewStatus: t.reviewStatus === "NEEDS_REVIEW" ? "NEEDS_REVIEW" : "REVIEWED", finCategoryIds: t.splits.map((x) => x.finCategoryId) }));
  const unrec = unreconciledAccounts(accounts, new Map(recons.map((r) => [r.cashAccountId, r.statementDate.toISOString().slice(0, 10)])), reportDate);
  for (const r of rows) r.completeness = rowCompleteness(r, openLines, unrec);

  const memo = (working?.lines ?? []).filter((l) => l.kind === "SALES_MEMO").map((l) => ({ lineKey: l.lineKey, finCategoryId: l.finCategoryId, planned: toMinor(l.plannedAmount), assumptions: l.assumptions }));

  return {
    budget: { id: b.id, month: b.month, branchKey: b.branchKey, status: b.status, basis: b.basis, title: b.title },
    revisions: b.revisions.map((r) => ({ id: r.id, revisionNo: r.revisionNo, status: r.status, reason: r.reason, createdBy: r.createdBy, createdAt: r.createdAt, submittedBy: r.submittedBy, submittedAt: r.submittedAt, decidedBy: r.decidedBy, decidedAt: r.decidedAt, decisionNote: r.decisionNote })),
    workingRevision: working ? { id: working.id, revisionNo: working.revisionNo, status: working.status, lines: working.lines } : null,
    reportDate, monthOver, rows, totals, netCashFlow, memo,
    completeness: { needsReview, pending, reconciledThrough, complete, lastTransactionAt: lastTxn?.createdAt ?? null, refreshedAt: new Date().toISOString() },
    thresholds: { amount: thresholds.amount, percentBp: thresholds.percentBp, mode: thresholds.mode },
    basisNote: "Cash budget: receipts and payments. Net cash flow is not profit; accounting profit is not derived here.",
  };
}

export async function drillDown(db: Db, scope: FinanceScope, budgetId: string, lineKey: string, reportDate?: string) {
  const b = await loadBudget(db, scope, budgetId);
  const [, finCategoryId, cc] = lineKey.split(":");
  const costCenterId = cc === "-" || cc === undefined ? null : cc;
  const keys = budgetScopeKeys(b);
  const to = isDateString(reportDate) && reportDate <= monthEnd(b.month) ? reportDate : monthEnd(b.month);
  const splits = await db.bankTransactionSplit.findMany({
    where: { finCategoryId, costCenterId, transaction: { status: "CONFIRMED", txnDate: { gte: dbDate(monthStart(b.month)), lte: dbDate(to) }, ...(keys ? { branchKey: { in: keys } } : {}) } },
    include: { transaction: { select: { id: true, txnDate: true, amount: true, bankReference: true, description: true, counterparty: true, classification: true, cashAccount: { select: { code: true } } } } },
    orderBy: { transaction: { txnDate: "asc" } }, take: 500,
  });
  const obligations = await db.finObligation.findMany({ where: { finCategoryId, status: { in: [...LIVE_OBLIGATION] }, dueDate: { lte: dbDate(monthEnd(b.month)) }, ...(keys ? { branchKey: { in: keys } } : {}) }, orderBy: { dueDate: "asc" } });
  const items = await db.finForecastItem.findMany({ where: { finCategoryId, status: "OPEN", expectedDate: { gte: dbDate(monthStart(b.month)), lte: dbDate(monthEnd(b.month)) }, ...(keys ? { branchKey: { in: keys } } : {}) } });
  return { splits, obligations, forecastItems: items };
}

export async function addVarianceNote(actor: FinanceActor, scope: FinanceScope, budgetId: string, body: Record<string, unknown>) {
  assertCan(actor, "budget_prepare");
  const lineKey = reqStr(body.lineKey, "Line", 200);
  const followUp = body.followUpDate ? String(body.followUpDate) : null;
  if (followUp && !isDateString(followUp)) throw new FinanceError("Invalid follow-up date.", 400);
  return prisma.$transaction(async (tx) => {
    const b = await loadBudget(tx, scope, budgetId);
    const n = await tx.finVarianceNote.create({
      data: {
        budgetId, lineKey, explanation: reqStr(body.explanation, "Explanation", 2000), correctiveAction: str(body.correctiveAction, 2000),
        responsibleEmployeeId: str(body.responsibleEmployeeId, 40), followUpDate: followUp ? dbDate(followUp) : null, createdBy: actor.id,
      },
    });
    await audit(tx, { action: "variance_note.created", entityType: "FinVarianceNote", entityId: n.id, branchKey: b.branchKey, after: n, userId: actor.id });
    return n;
  });
}

export async function resolveVarianceNote(actor: FinanceActor, scope: FinanceScope, noteId: string) {
  assertCan(actor, "budget_prepare");
  return prisma.$transaction(async (tx) => {
    const n = await tx.finVarianceNote.findUnique({ where: { id: noteId } });
    if (!n) throw new FinanceError("Not found", 404);
    await loadBudget(tx, scope, n.budgetId);
    const upd = await tx.finVarianceNote.update({ where: { id: noteId }, data: { status: "RESOLVED", resolvedAt: new Date(), resolvedBy: actor.id } });
    await audit(tx, { action: "variance_note.resolved", entityType: "FinVarianceNote", entityId: noteId, before: n, after: upd, userId: actor.id });
    return upd;
  });
}

/** Dated snapshot of the month's forecast. Touches no budget revision. */
export async function saveForecastSnapshot(actor: FinanceActor, scope: FinanceScope, budgetId: string, reportDate?: string) {
  assertCan(actor, "budget_prepare");
  const report = await budgetReport(prisma, scope, budgetId, reportDate);
  return prisma.$transaction(async (tx) => {
    const s = await tx.finForecastSnapshot.create({
      data: {
        kind: "MONTH_FORECAST", branchKey: report.budget.branchKey, budgetId, month: report.budget.month, cutoffDate: dbDate(report.reportDate),
        data: JSON.parse(JSON.stringify({ rows: report.rows.map((r) => ({ lineKey: r.lineKey, code: r.code, kind: r.kind, baseline: r.baseline, actualToDate: r.actualToDate, remainingForecast: r.remainingForecast, fac: r.fac })), totals: report.totals, netCashFlow: report.netCashFlow })),
        createdBy: actor.id,
      },
    });
    await audit(tx, { action: "forecast.snapshot", entityType: "FinForecastSnapshot", entityId: s.id, branchKey: report.budget.branchKey, refs: { budgetId, cutoff: report.reportDate }, userId: actor.id });
    return s;
  });
}

export async function listSnapshots(db: Db, scope: FinanceScope, budgetId: string) {
  await loadBudget(db, scope, budgetId);
  return db.finForecastSnapshot.findMany({ where: { budgetId }, orderBy: { createdAt: "desc" }, take: 50 });
}
