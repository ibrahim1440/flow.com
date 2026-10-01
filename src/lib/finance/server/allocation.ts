// Cash allocation: categories, versioned rules, runs, manual allocations, category
// transfers, payment reservations and payments from categories.
//
// Invariants (each enforced here AND in the database where expressible):
//   - An allocation is an internal earmark. It creates no bank line, no expense and no
//     journal entry.
//   - Every allocation entry names its source: a receipt (sourceTxnId), an account's opening
//     balance (sourceCashAccountId), a transfer, a reversal or a payment.
//   - One run per receipt (AllocationRun.sourceTxnId unique). Retries and concurrent
//     requests collapse onto the first run.
//   - Every write that changes allocated/unallocated cash holds the scope's pool lock, then
//     re-reads balances, then checks: never more than the receipt's remainder, never more
//     than the pool's unallocated cash.
//   - Ledgers are append-only (DB trigger). Corrections are reversing entries.
import { Prisma } from "@/generated/prisma/client";
import { POSTED_BANK_LINE_MESSAGE, postedBankLines } from "@/lib/accounting/bank-posted";
import { prisma } from "@/lib/db";
import {
  computeAllocation, fundingNeed, validateRuleSteps, AllocationRefused,
  type AllocMethod, type CategoryState, type RuleStep,
} from "../allocation-engine";
import { fromMinor, parseMoney, parsePercentScaled, toMinor, type Minor } from "../money";
import { dbDate, isDateString, isMonthString, monthOf, riyadhDateString } from "../dates";
import { ALL_CLASSES, DEFAULT_BASE_CLASSES, isAllocatableClass, type TxnClass } from "../classes";
import {
  assertCan, assertScope, audit, COMPANY, FinanceError, lockPool, reqStr, scopeWhere, str,
  type Db, type FinanceActor, type FinanceScope,
} from "./context";
import { categoryLedgers, openingUnallocated, poolUnallocated, receiptUnallocated, reservedByCategory } from "./ledger";
import { paidByObligation, recomputeObligationStatus, LIVE_OBLIGATION } from "./obligations";
import { createApproval } from "./approval-core";

const METHODS: AllocMethod[] = ["PERCENT_OF_BASE", "FILL_TARGET", "FUND_OBLIGATIONS", "RECEIPT_TAX_COMPONENT", "WEIGHTED_REMAINDER", "LEAVE_UNALLOCATED"];

// ─── Categories ─────────────────────────────────────────────────────────────────

function parseCategoryBody(body: Record<string, unknown>, partial: boolean) {
  const data: Prisma.AllocationCategoryUncheckedCreateInput = {} as Prisma.AllocationCategoryUncheckedCreateInput;
  if (!partial || body.code !== undefined) data.code = reqStr(body.code, "Code", 40).toUpperCase();
  if (!partial || body.nameEn !== undefined) data.nameEn = reqStr(body.nameEn, "English name", 120);
  if (body.nameAr !== undefined) data.nameAr = str(body.nameAr, 120);
  if (body.priority !== undefined) {
    const p = Number(body.priority);
    if (!Number.isInteger(p) || p < 0 || p > 10_000) throw new FinanceError("Priority must be a whole number 0–10000.", 400);
    data.priority = p;
  }
  if (body.fundingType !== undefined) {
    if (!["MONTHLY_TARGET", "RESERVE_TARGET", "OPEN"].includes(String(body.fundingType))) throw new FinanceError("Unknown funding type.", 400);
    data.fundingType = body.fundingType as "OPEN";
  }
  if (body.targetAmount !== undefined) {
    if (body.targetAmount === null || body.targetAmount === "") data.targetAmount = null;
    else {
      const t = parseMoney(body.targetAmount);
      if (t === null || t <= 0) throw new FinanceError("Target must be a positive amount.", 400);
      data.targetAmount = fromMinor(t);
    }
  }
  if (body.spendingLimit !== undefined) {
    if (body.spendingLimit === null || body.spendingLimit === "") data.spendingLimit = null;
    else {
      const t = parseMoney(body.spendingLimit);
      if (t === null || t <= 0) throw new FinanceError("Spending limit must be a positive amount.", 400);
      data.spendingLimit = fromMinor(t);
    }
  }
  if (body.replenish !== undefined) data.replenish = body.replenish === true;
  if (body.isTaxReserve !== undefined) data.isTaxReserve = body.isTaxReserve === true;
  if (body.active !== undefined) data.active = body.active === true;
  if (body.rollover !== undefined) {
    if (!["CARRY_FORWARD", "SWEEP_TO_UNALLOCATED"].includes(String(body.rollover))) throw new FinanceError("Unknown rollover policy.", 400);
    data.rollover = body.rollover as "CARRY_FORWARD";
  }
  for (const k of ["targetStartMonth", "targetEndMonth"] as const) {
    if (body[k] !== undefined) {
      if (body[k] === null || body[k] === "") data[k] = null;
      else if (!isMonthString(body[k])) throw new FinanceError(`${k} must be YYYY-MM.`, 400);
      else data[k] = body[k] as string;
    }
  }
  if (body.dueDay !== undefined) {
    if (body.dueDay === null || body.dueDay === "") data.dueDay = null;
    else {
      const d = Number(body.dueDay);
      if (!Number.isInteger(d) || d < 1 || d > 31) throw new FinanceError("Due day must be 1–31.", 400);
      data.dueDay = d;
    }
  }
  for (const k of ["approverEmployeeId", "finCategoryId", "costCenterId"] as const) {
    if (body[k] !== undefined) data[k] = str(body[k], 40);
  }
  return data;
}

function checkCategoryShape(c: { fundingType: string; targetAmount: unknown; replenish?: boolean }) {
  if (c.fundingType !== "OPEN" && (c.targetAmount === null || c.targetAmount === undefined)) {
    throw new FinanceError("Monthly and reserve targets need a target amount.", 400);
  }
  if (c.fundingType !== "RESERVE_TARGET" && c.replenish) {
    throw new FinanceError("Only a reserve target can replenish; a monthly target never refills after spending.", 400);
  }
}

export async function createCategory(actor: FinanceActor, scope: FinanceScope, body: Record<string, unknown>) {
  assertCan(actor, "budget_prepare");
  const branchKey = str(body.branchKey, 60) ?? COMPANY;
  assertScope(scope, branchKey);
  const data = parseCategoryBody(body, false);
  data.branchKey = branchKey;
  data.createdBy = actor.id;
  checkCategoryShape({ fundingType: data.fundingType ?? "OPEN", targetAmount: data.targetAmount ?? null, replenish: data.replenish });
  return prisma.$transaction(async (tx) => {
    const c = await tx.allocationCategory.create({ data });
    await audit(tx, { action: "allocation_category.created", entityType: "AllocationCategory", entityId: c.id, branchKey, after: c, userId: actor.id });
    return c;
  });
}

export async function updateCategory(actor: FinanceActor, scope: FinanceScope, id: string, body: Record<string, unknown>) {
  assertCan(actor, "budget_prepare");
  return prisma.$transaction(async (tx) => {
    const before = await tx.allocationCategory.findUnique({ where: { id } });
    if (!before) throw new FinanceError("Not found", 404);
    assertScope(scope, before.branchKey);
    const data = parseCategoryBody(body, true);
    delete (data as { branchKey?: string }).branchKey;
    delete (data as { code?: string }).code; // codes are identifiers referenced by history
    const merged = { ...before, ...data };
    checkCategoryShape({ fundingType: merged.fundingType, targetAmount: merged.targetAmount, replenish: merged.replenish });
    const after = await tx.allocationCategory.update({ where: { id }, data });
    await audit(tx, { action: "allocation_category.updated", entityType: "AllocationCategory", entityId: id, branchKey: before.branchKey, before, after, reason: str(body.reason, 300), userId: actor.id });
    return after;
  });
}

export type CategoryView = {
  id: string; code: string; nameEn: string; nameAr: string | null; branchKey: string; priority: number;
  fundingType: string; targetAmount: Minor | null; replenish: boolean; rollover: string; spendingLimit: Minor | null;
  isTaxReserve: boolean; active: boolean; approverEmployeeId: string | null; finCategoryId: string | null;
  targetStartMonth: string | null; targetEndMonth: string | null; dueDay: number | null;
  // formula for the month:
  openingCarried: Minor; allocations: Minor; incoming: Minor; payments: Minor; outgoing: Minor; balance: Minor;
  reserved: Minor; available: Minor; obligationsRemaining: Minor; unfunded: Minor; fundingNeed: Minor;
  fundedThisMonth: Minor;
};

async function categoryStates(db: Db, branchKeys: string[] | null, month: string) {
  const cats = await db.allocationCategory.findMany({
    where: branchKeys ? { branchKey: { in: branchKeys } } : {},
    orderBy: [{ priority: "asc" }, { code: "asc" }],
  });
  const ids = cats.map((c) => c.id);
  const [all, before, thisMonth, reserved, funded] = await Promise.all([
    categoryLedgers(db, { categoryId: { in: ids } }),
    categoryLedgers(db, { categoryId: { in: ids }, periodMonth: { lt: month } }),
    categoryLedgers(db, { categoryId: { in: ids }, periodMonth: month }),
    reservedByCategory(db, ids),
    db.allocationEntry.groupBy({
      by: ["categoryId", "entryType", "periodMonth"],
      where: { categoryId: { in: ids }, OR: [{ entryType: "ALLOCATION" }, { sourceType: "RECEIPT_REVERSAL" }] },
      _sum: { amount: true },
    }),
  ]);
  const obligations = await db.finObligation.findMany({
    where: { allocationCategoryId: { in: ids }, status: { in: [...LIVE_OBLIGATION] } },
    select: { id: true, amount: true, allocationCategoryId: true },
  });
  const paid = await paidByObligation(db, obligations.map((o) => o.id));
  const oblByCat = new Map<string, Minor>();
  for (const o of obligations) {
    const rem = Math.max(0, toMinor(o.amount) - (paid.get(o.id) ?? 0));
    oblByCat.set(o.allocationCategoryId!, (oblByCat.get(o.allocationCategoryId!) ?? 0) + rem);
  }
  const fundedFor = (id: string, onlyMonth: boolean) =>
    funded
      .filter((f) => f.categoryId === id && (!onlyMonth || f.periodMonth === month))
      .reduce((s, f) => s + (f.entryType === "ALLOCATION" ? 1 : -1) * toMinor(f._sum.amount), 0);

  return cats.map((c) => {
    const l = all.get(c.id);
    const b = before.get(c.id);
    const m = thisMonth.get(c.id);
    const balance = l?.balance ?? 0;
    const res = reserved.get(c.id) ?? 0;
    const obligationsRemaining = oblByCat.get(c.id) ?? 0;
    const state: CategoryState = {
      id: c.id, code: c.code, priority: c.priority, fundingType: c.fundingType,
      targetAmount: c.targetAmount === null ? null : toMinor(c.targetAmount), replenish: c.replenish,
      isTaxReserve: c.isTaxReserve, active: c.active, balance,
      fundedThisMonth: fundedFor(c.id, true), fundedEver: fundedFor(c.id, false), obligationsRemaining,
      targetStartMonth: c.targetStartMonth, targetEndMonth: c.targetEndMonth,
    };
    const view: CategoryView = {
      id: c.id, code: c.code, nameEn: c.nameEn, nameAr: c.nameAr, branchKey: c.branchKey, priority: c.priority,
      fundingType: c.fundingType, targetAmount: state.targetAmount, replenish: c.replenish, rollover: c.rollover,
      spendingLimit: c.spendingLimit === null ? null : toMinor(c.spendingLimit), isTaxReserve: c.isTaxReserve,
      active: c.active, approverEmployeeId: c.approverEmployeeId, finCategoryId: c.finCategoryId,
      targetStartMonth: c.targetStartMonth, targetEndMonth: c.targetEndMonth, dueDay: c.dueDay,
      openingCarried: b?.balance ?? 0, allocations: m?.allocations ?? 0, incoming: m?.incoming ?? 0,
      payments: m?.payments ?? 0, outgoing: m?.outgoing ?? 0, balance, reserved: res, available: balance - res,
      obligationsRemaining, unfunded: Math.max(0, obligationsRemaining - Math.max(0, balance)),
      fundingNeed: fundingNeed(state, month), fundedThisMonth: state.fundedThisMonth,
    };
    return { cat: c, state, view };
  });
}

export async function listCategories(db: Db, scope: FinanceScope, month = monthOf(riyadhDateString())): Promise<CategoryView[]> {
  const rows = await categoryStates(db, scope.all ? null : scope.branchKeys, month);
  return rows.map((r) => r.view);
}

// ─── Rule versions ──────────────────────────────────────────────────────────────

function parseSteps(raw: unknown): RuleStep[] {
  if (!Array.isArray(raw)) throw new FinanceError("steps must be an array.", 400);
  if (raw.length > 50) throw new FinanceError("At most 50 steps.", 400);
  return raw.map((s, i) => {
    const o = (s ?? {}) as Record<string, unknown>;
    const method = String(o.method) as AllocMethod;
    if (!METHODS.includes(method)) throw new FinanceError(`Step ${i + 1}: unknown method.`, 400);
    const percentScaled = o.percent === undefined || o.percent === null || o.percent === "" ? null : parsePercentScaled(o.percent);
    if (o.percent !== undefined && o.percent !== null && o.percent !== "" && percentScaled === null) {
      throw new FinanceError(`Step ${i + 1}: percentage must be 0–100 with at most four decimals.`, 400);
    }
    const cap = o.capAmount === undefined || o.capAmount === null || o.capAmount === "" ? null : parseMoney(o.capAmount);
    if (o.capAmount && cap === null) throw new FinanceError(`Step ${i + 1}: invalid cap.`, 400);
    const weight = o.weight === undefined || o.weight === null || o.weight === "" ? null : Number(o.weight);
    return {
      seq: o.seq === undefined ? i + 1 : Number(o.seq),
      method,
      categoryId: typeof o.categoryId === "string" && o.categoryId ? o.categoryId : null,
      percentScaled,
      weight,
      capAmount: cap,
    };
  });
}

function parseBase(raw: unknown): TxnClass[] {
  if (raw === undefined) return [...DEFAULT_BASE_CLASSES];
  if (!Array.isArray(raw) || raw.length === 0) throw new FinanceError("Choose at least one receipt type for the percentage base.", 400);
  for (const c of raw) {
    if (!(ALL_CLASSES as readonly string[]).includes(String(c)) || !isAllocatableClass(c as TxnClass)) {
      throw new FinanceError(`"${String(c)}" cannot be part of an allocation base.`, 400);
    }
  }
  return [...new Set(raw as TxnClass[])];
}

async function validateForScope(db: Db, branchKey: string, steps: RuleStep[]) {
  const cats = await db.allocationCategory.findMany({ where: { branchKey } });
  const v = validateRuleSteps(steps, cats.map((c) => ({
    id: c.id, isTaxReserve: c.isTaxReserve, fundingType: c.fundingType,
    targetAmount: c.targetAmount === null ? null : toMinor(c.targetAmount), active: c.active,
  })));
  return v;
}

export async function saveRuleDraft(actor: FinanceActor, scope: FinanceScope, body: Record<string, unknown>, versionId?: string) {
  assertCan(actor, "budget_prepare");
  const steps = parseSteps(body.steps);
  const baseClasses = parseBase(body.baseClasses);
  return prisma.$transaction(async (tx) => {
    let branchKey = str(body.branchKey, 60) ?? COMPANY;
    let version;
    if (versionId) {
      const existing = await tx.allocationRuleVersion.findUnique({ where: { id: versionId } });
      if (!existing) throw new FinanceError("Not found", 404);
      assertScope(scope, existing.branchKey);
      if (existing.status !== "DRAFT" && existing.status !== "REJECTED") throw new FinanceError("Only a draft can be edited; create a new version.", 409);
      branchKey = existing.branchKey;
    } else assertScope(scope, branchKey);
    const v = await validateForScope(tx, branchKey, steps);
    if (!v.ok) throw new FinanceError("The rule is not valid.", 400, v);
    if (versionId) {
      await tx.allocationRuleStep.deleteMany({ where: { versionId } });
      version = await tx.allocationRuleVersion.update({
        where: { id: versionId },
        data: { status: "DRAFT", baseClasses, autoExecute: body.autoExecute === true, notes: str(body.notes, 1000) },
      });
    } else {
      const last = await tx.allocationRuleVersion.aggregate({ where: { branchKey }, _max: { versionNo: true } });
      version = await tx.allocationRuleVersion.create({
        data: { branchKey, versionNo: (last._max.versionNo ?? 0) + 1, baseClasses, autoExecute: body.autoExecute === true, notes: str(body.notes, 1000), createdBy: actor.id },
      });
    }
    await tx.allocationRuleStep.createMany({
      data: steps.map((s) => ({
        versionId: version.id, seq: s.seq, method: s.method, categoryId: s.categoryId,
        percent: s.percentScaled ? (s.percentScaled / 10_000).toFixed(4) : null,
        weight: s.weight ?? null, capAmount: s.capAmount ? fromMinor(s.capAmount) : null,
      })),
    });
    await audit(tx, { action: versionId ? "allocation_rules.draft_updated" : "allocation_rules.draft_created", entityType: "AllocationRuleVersion", entityId: version.id, branchKey, after: { version, steps }, userId: actor.id });
    return { version, validation: v };
  });
}

export async function submitRuleVersion(actor: FinanceActor, scope: FinanceScope, versionId: string, reason: string | null) {
  assertCan(actor, "budget_prepare");
  return prisma.$transaction(async (tx) => {
    const v = await tx.allocationRuleVersion.findUnique({ where: { id: versionId }, include: { steps: true } });
    if (!v) throw new FinanceError("Not found", 404);
    assertScope(scope, v.branchKey);
    if (v.status !== "DRAFT") throw new FinanceError("Only a draft can be submitted.", 409);
    const val = await validateForScope(tx, v.branchKey, v.steps.map(stepFromRow));
    if (!val.ok) throw new FinanceError("The rule is not valid.", 400, val);
    await tx.allocationRuleVersion.update({ where: { id: versionId }, data: { status: "PENDING_APPROVAL" } });
    const active = await tx.allocationRuleVersion.findFirst({ where: { branchKey: v.branchKey, status: "ACTIVE" }, include: { steps: true } });
    return createApproval(tx, actor, {
      type: "ALLOCATION_RULES", branchKey: v.branchKey, entityType: "AllocationRuleVersion", entityId: v.id,
      summary: `Allocation rules v${v.versionNo}${v.autoExecute ? " (automatic execution)" : ""}`,
      payload: { versionNo: v.versionNo, autoExecute: v.autoExecute, steps: v.steps.map(stepFromRow), replaces: active ? { id: active.id, versionNo: active.versionNo, steps: active.steps.map(stepFromRow) } : null },
      reason,
    });
  });
}

/** Approval effect: the version becomes the one ACTIVE version of its scope. */
export async function activateRuleVersion(tx: Prisma.TransactionClient, versionId: string, approverId: string) {
  const v = await tx.allocationRuleVersion.findUnique({ where: { id: versionId } });
  if (!v || v.status !== "PENDING_APPROVAL") throw new FinanceError("Rule version is not awaiting approval.", 409);
  await tx.allocationRuleVersion.updateMany({ where: { branchKey: v.branchKey, status: "ACTIVE" }, data: { status: "SUPERSEDED" } });
  return tx.allocationRuleVersion.update({ where: { id: versionId }, data: { status: "ACTIVE", approvedAt: new Date(), approvedBy: approverId, activatedAt: new Date() } });
}

export function stepFromRow(s: { seq: number; method: string; categoryId: string | null; percent: unknown; weight: number | null; capAmount: unknown }): RuleStep {
  return {
    seq: s.seq, method: s.method as AllocMethod, categoryId: s.categoryId,
    percentScaled: s.percent === null || s.percent === undefined ? null : parsePercentScaled(String(s.percent)),
    weight: s.weight, capAmount: s.capAmount === null || s.capAmount === undefined ? null : toMinor(s.capAmount as string),
  };
}

export async function listRuleVersions(db: Db, scope: FinanceScope) {
  return db.allocationRuleVersion.findMany({
    where: scopeWhere(scope),
    include: { steps: { orderBy: { seq: "asc" } } },
    orderBy: [{ branchKey: "asc" }, { versionNo: "desc" }],
    take: 100,
  });
}

// ─── Preview and runs ──────────────────────────────────────────────────────────

async function taxComponentOf(db: Db, txnId: string): Promise<Minor> {
  const agg = await db.bankTransactionMatch.aggregate({ where: { transactionId: txnId, active: true }, _sum: { taxAmount: true } });
  return toMinor(agg._sum.taxAmount);
}

/**
 * Preview a version on a hypothetical receipt amount (or a real receipt), plus the same
 * rule on a lower-collections scenario. Persists nothing.
 */
export async function previewAllocation(actor: FinanceActor, scope: FinanceScope, body: Record<string, unknown>) {
  const versionId = reqStr(body.versionId, "versionId", 40);
  const v = await prisma.allocationRuleVersion.findUnique({ where: { id: versionId }, include: { steps: true } });
  if (!v) throw new FinanceError("Not found", 404);
  assertScope(scope, v.branchKey);
  const month = isMonthString(body.month) ? body.month : monthOf(riyadhDateString());
  let amount: Minor;
  let tax = 0;
  let source = "hypothetical";
  if (body.txnId) {
    const t = await prisma.bankTransaction.findUnique({ where: { id: String(body.txnId) } });
    if (!t) throw new FinanceError("Not found", 404);
    assertScope(scope, t.branchKey);
    amount = await receiptUnallocated(prisma, t.id, toMinor(t.amount));
    tax = await taxComponentOf(prisma, t.id);
    source = "receipt";
  } else {
    const a = parseMoney(body.amount);
    if (a === null || a <= 0) throw new FinanceError("Enter a positive receipt amount to preview.", 400);
    amount = a;
    const t = body.taxAmount === undefined || body.taxAmount === "" ? 0 : parseMoney(body.taxAmount);
    if (t === null || t < 0 || t > a) throw new FinanceError("VAT must be between 0 and the amount.", 400);
    tax = t;
  }
  const lowerPct = body.lowerCollectionsPct === undefined ? 70 : Number(body.lowerCollectionsPct);
  if (!Number.isInteger(lowerPct) || lowerPct < 1 || lowerPct > 100) throw new FinanceError("Lower-collections scenario must be 1–100%.", 400);

  const states = await categoryStates(prisma, [v.branchKey], month);
  const steps = v.steps.map(stepFromRow);
  const validation = validateRuleSteps(steps, states.map((s) => ({ ...s.state })));
  // Preview ignores the pool check (it shows the rule, not whether cash exists).
  const run = (amt: Minor, tx: Minor) =>
    computeAllocation({ receiptUnallocated: amt, taxComponent: tx, poolUnallocated: Number.MAX_SAFE_INTEGER, month, steps, categories: states.map((s) => s.state) });
  const base = run(amount, tax);
  const lowerAmt = Math.floor((amount * lowerPct) / 100);
  const lower = run(lowerAmt, Math.floor((tax * lowerPct) / 100));
  const names = new Map(states.map((s) => [s.cat.id, { code: s.cat.code, nameEn: s.cat.nameEn, nameAr: s.cat.nameAr }]));
  const label = (r: ReturnType<typeof run>) => ({ ...r, lines: r.lines.map((l) => ({ ...l, category: names.get(l.categoryId) })) });
  return {
    version: { id: v.id, versionNo: v.versionNo, status: v.status, baseClasses: v.baseClasses },
    source, month, amount, tax,
    baseDefinition: "Base = receipt amount not yet allocated (net deposit, after gateway/POS fees) − VAT reserved from matched documents.",
    validation,
    scenario: label(base),
    lowerCollections: { percent: lowerPct, amount: lowerAmt, ...label(lower) },
    poolUnallocated: await poolUnallocated(prisma, v.branchKey),
  };
}

export async function assertEligibleReceipt(db: Db, txn: { id: string; status: string; amount: unknown; reviewStatus: string; classification: string; cashAccountId: string; txnDate: Date }) {
  if (txn.status !== "CONFIRMED") throw new FinanceError("Only a confirmed bank line can be allocated. Pending receipts are not cash yet.", 409);
  if (toMinor(txn.amount as string) <= 0) throw new FinanceError("Only money received can be allocated.", 409);
  if (txn.reviewStatus !== "REVIEWED") throw new FinanceError("Review and classify this receipt before allocating it.", 409);
  if (!isAllocatableClass(txn.classification as TxnClass)) throw new FinanceError("This classification cannot be allocated (transfers and unclassified lines are excluded).", 409);
  const acc = await db.cashAccount.findUnique({ where: { id: txn.cashAccountId } });
  if (!acc || acc.isRestricted) throw new FinanceError("Receipts into a restricted account cannot be allocated.", 409);
}

export async function runAllocation(actor: FinanceActor, scope: FinanceScope, txnId: string, trigger: "MANUAL" | "AUTO" = "MANUAL") {
  if (trigger === "MANUAL") assertCan(actor, "allocate");
  const first = await prisma.bankTransaction.findUnique({ where: { id: txnId } });
  if (!first) throw new FinanceError("Not found", 404);
  assertScope(scope, first.branchKey);
  try {
    return await prisma.$transaction(async (tx) => {
      await lockPool(tx, first.branchKey);
      const existing = await tx.allocationRun.findUnique({ where: { sourceTxnId: txnId }, include: { entries: true } });
      if (existing) return { replayed: true, run: existing };
      const txn = await tx.bankTransaction.findUniqueOrThrow({ where: { id: txnId } });
      await assertEligibleReceipt(tx, txn);
      const version = await tx.allocationRuleVersion.findFirst({ where: { branchKey: txn.branchKey, status: "ACTIVE" }, include: { steps: true } });
      if (!version) throw new FinanceError("No approved allocation rules are active for this branch.", 409);
      if (trigger === "AUTO" && !version.autoExecute) throw new FinanceError("Automatic execution is not approved for the active rules.", 409);
      if (!version.baseClasses.includes(txn.classification)) {
        throw new FinanceError("This receipt type is outside the approved percentage base; allocate it manually.", 409);
      }
      const month = monthOf(txn.txnDate.toISOString().slice(0, 10));
      const states = await categoryStates(tx, [txn.branchKey], month);
      const remainder = await receiptUnallocated(tx, txn.id, toMinor(txn.amount));
      const result = computeAllocation({
        receiptUnallocated: remainder,
        taxComponent: await taxComponentOf(tx, txn.id),
        poolUnallocated: await poolUnallocated(tx, txn.branchKey),
        month,
        steps: version.steps.map(stepFromRow),
        categories: states.map((s) => s.state),
      });
      const run = await tx.allocationRun.create({
        data: {
          versionId: version.id, sourceTxnId: txn.id, baseAmount: fromMinor(result.base),
          allocatedTotal: fromMinor(result.allocatedTotal), leftUnallocated: fromMinor(result.leftUnallocated),
          trigger, createdBy: actor.id,
        },
      });
      if (result.lines.length) {
        await tx.allocationEntry.createMany({
          data: result.lines.map((l) => ({
            categoryId: l.categoryId, branchKey: txn.branchKey, entryType: "ALLOCATION" as const, sourceType: "RECEIPT" as const,
            amount: fromMinor(l.amount), periodMonth: month, sourceTxnId: txn.id, runId: run.id, ruleVersionId: version.id,
            stepSeq: l.stepSeq, reason: l.note, createdBy: actor.id,
          })),
        });
      }
      await audit(tx, {
        action: "allocation.run", entityType: "AllocationRun", entityId: run.id, branchKey: txn.branchKey,
        after: { ...result, versionNo: version.versionNo }, refs: { sourceTxnId: txn.id, ruleVersionId: version.id, trigger }, userId: actor.id,
      });
      return { replayed: false, run: await tx.allocationRun.findUniqueOrThrow({ where: { id: run.id }, include: { entries: true } }), warnings: result.warnings };
    });
  } catch (err) {
    // Lost a race on the unique run: the other request's run is the answer.
    if (err && typeof err === "object" && (err as { code?: string }).code === "P2002") {
      const run = await prisma.allocationRun.findUnique({ where: { sourceTxnId: txnId }, include: { entries: true } });
      if (run) return { replayed: true, run };
    }
    if (err instanceof AllocationRefused) throw new FinanceError(err.message, 409);
    throw err;
  }
}

export async function manualAllocate(actor: FinanceActor, scope: FinanceScope, body: Record<string, unknown>) {
  assertCan(actor, "allocate");
  const categoryId = reqStr(body.categoryId, "categoryId", 40);
  const amount = parseMoney(body.amount);
  if (amount === null || amount <= 0) throw new FinanceError("Amount must be positive.", 400);
  const reason = reqStr(body.reason, "Reason", 500);
  const sourceTxnId = str(body.sourceTxnId, 40);
  const sourceCashAccountId = str(body.sourceCashAccountId, 40);
  if (!!sourceTxnId === !!sourceCashAccountId) throw new FinanceError("Choose exactly one source: a receipt or an account's opening balance.", 400);
  const cat = await prisma.allocationCategory.findUnique({ where: { id: categoryId } });
  if (!cat) throw new FinanceError("Not found", 404);
  assertScope(scope, cat.branchKey);
  if (!cat.active) throw new FinanceError("Category is inactive.", 409);

  return prisma.$transaction(async (tx) => {
    await lockPool(tx, cat.branchKey);
    let month = monthOf(riyadhDateString());
    if (sourceTxnId) {
      const t = await tx.bankTransaction.findUnique({ where: { id: sourceTxnId } });
      if (!t || t.branchKey !== cat.branchKey) throw new FinanceError("Receipt must belong to the category's branch.", 400);
      await assertEligibleReceipt(tx, t);
      if (cat.isTaxReserve) {
        const tax = await taxComponentOf(tx, t.id);
        const already = await tx.allocationEntry.aggregate({ where: { sourceTxnId: t.id, categoryId, entryType: "ALLOCATION" }, _sum: { amount: true } });
        if (amount + toMinor(already._sum.amount) > tax) throw new FinanceError("A tax reserve can only receive the VAT on this receipt's matched documents.", 409);
      }
      const rem = await receiptUnallocated(tx, t.id, toMinor(t.amount));
      if (amount > rem) throw new FinanceError(`Only ${fromMinor(rem)} SAR of this receipt is unallocated.`, 409);
      month = monthOf(t.txnDate.toISOString().slice(0, 10));
    } else {
      const acc = await tx.cashAccount.findUnique({ where: { id: sourceCashAccountId! } });
      if (!acc || acc.branchKey !== cat.branchKey) throw new FinanceError("Account must belong to the category's branch.", 400);
      if (acc.isRestricted) throw new FinanceError("Restricted cash cannot be allocated.", 409);
      if (cat.isTaxReserve) throw new FinanceError("A tax reserve is funded from document VAT or via an approved transfer.", 409);
      const rem = await openingUnallocated(tx, acc.id, toMinor(acc.openingBalance));
      if (amount > rem) throw new FinanceError(`Only ${fromMinor(rem)} SAR of the opening balance is unallocated.`, 409);
    }
    const pool = await poolUnallocated(tx, cat.branchKey);
    if (amount > pool) throw new FinanceError(`Only ${fromMinor(Math.max(0, pool))} SAR of cash is unallocated in this branch.`, 409);
    const e = await tx.allocationEntry.create({
      data: {
        categoryId, branchKey: cat.branchKey, entryType: "ALLOCATION",
        sourceType: sourceTxnId ? "RECEIPT" : "OPENING_BALANCE", amount: fromMinor(amount), periodMonth: month,
        sourceTxnId, sourceCashAccountId, reason, createdBy: actor.id,
      },
    });
    await audit(tx, { action: "allocation.manual", entityType: "AllocationEntry", entityId: e.id, branchKey: cat.branchKey, after: e, reason, userId: actor.id });
    return e;
  });
}

// ─── Transfers between categories (approval required) ───────────────────────────

export async function requestCategoryTransfer(actor: FinanceActor, scope: FinanceScope, body: Record<string, unknown>) {
  assertCan(actor, "allocate");
  const fromId = reqStr(body.fromCategoryId, "From category", 40);
  const toId = reqStr(body.toCategoryId, "To category", 40);
  if (fromId === toId) throw new FinanceError("Choose two different categories.", 400);
  const amount = parseMoney(body.amount);
  if (amount === null || amount <= 0) throw new FinanceError("Amount must be positive.", 400);
  const reason = reqStr(body.reason, "Reason", 500);
  return prisma.$transaction(async (tx) => {
    const [from, to] = await Promise.all([tx.allocationCategory.findUnique({ where: { id: fromId } }), tx.allocationCategory.findUnique({ where: { id: toId } })]);
    if (!from || !to) throw new FinanceError("Not found", 404);
    assertScope(scope, from.branchKey);
    if (from.branchKey !== to.branchKey) throw new FinanceError("Both categories must be in the same branch.", 400);
    const [s] = (await categoryStates(tx, [from.branchKey], monthOf(riyadhDateString()))).filter((x) => x.cat.id === fromId);
    if (amount > s.view.available) throw new FinanceError(`Only ${fromMinor(Math.max(0, s.view.available))} SAR is available in ${from.code}.`, 409);
    return createApproval(tx, actor, {
      type: "CATEGORY_TRANSFER", branchKey: from.branchKey, entityType: "AllocationCategory", entityId: fromId,
      summary: `Move ${fromMinor(amount)} SAR from ${from.code} to ${to.code}`,
      payload: { fromCategoryId: fromId, toCategoryId: toId, amount, fromCode: from.code, toCode: to.code, fromNameEn: from.nameEn, fromNameAr: from.nameAr, toNameEn: to.nameEn, toNameAr: to.nameAr },
      reason, assignedToId: str(body.assignedToId, 40),
    });
  });
}

export async function executeCategoryTransfer(tx: Prisma.TransactionClient, approval: { id: string; branchKey: string; payload: unknown; requestedBy: string }, approverId: string) {
  const p = approval.payload as { fromCategoryId: string; toCategoryId: string; amount: Minor };
  await lockPool(tx, approval.branchKey);
  const [s] = (await categoryStates(tx, [approval.branchKey], monthOf(riyadhDateString()))).filter((x) => x.cat.id === p.fromCategoryId);
  // Re-checked at decision time: the balance may have changed since the request.
  if (!s || p.amount > s.view.available) throw new FinanceError("The source category no longer has enough available balance.", 409);
  const month = monthOf(riyadhDateString());
  const common = { branchKey: approval.branchKey, sourceType: "CATEGORY_TRANSFER" as const, amount: fromMinor(p.amount), periodMonth: month, approvalId: approval.id, createdBy: approverId };
  await tx.allocationEntry.create({ data: { ...common, categoryId: p.fromCategoryId, entryType: "TRANSFER_OUT", reason: `Transfer to ${p.toCategoryId}` } });
  await tx.allocationEntry.create({ data: { ...common, categoryId: p.toCategoryId, entryType: "TRANSFER_IN", reason: `Transfer from ${p.fromCategoryId}` } });
}

// ─── Reservations and payments ────────────────────────────────────────────────

export async function createReservation(actor: FinanceActor, scope: FinanceScope, body: Record<string, unknown>) {
  assertCan(actor, "allocate");
  const categoryId = reqStr(body.categoryId, "Category", 40);
  const amount = parseMoney(body.amount);
  if (amount === null || amount <= 0) throw new FinanceError("Amount must be positive.", 400);
  const payee = reqStr(body.payee, "Payee", 200);
  const purpose = reqStr(body.purpose, "Purpose", 500);
  const dueDate = body.dueDate ? (isDateString(body.dueDate) ? body.dueDate : null) : null;
  if (body.dueDate && !dueDate) throw new FinanceError("Invalid due date.", 400);
  const obligationId = str(body.obligationId, 40);
  const idempotencyKey = str(body.idempotencyKey, 100);
  const cat = await prisma.allocationCategory.findUnique({ where: { id: categoryId } });
  if (!cat) throw new FinanceError("Not found", 404);
  assertScope(scope, cat.branchKey);

  if (idempotencyKey) {
    const prior = await prisma.paymentReservation.findUnique({ where: { createdBy_idempotencyKey: { createdBy: actor.id, idempotencyKey } } });
    if (prior) return { replayed: true, reservation: prior };
  }
  try {
    return await prisma.$transaction(async (tx) => {
      await lockPool(tx, cat.branchKey);
      if (obligationId) {
        const o = await tx.finObligation.findUnique({ where: { id: obligationId } });
        if (!o || o.branchKey !== cat.branchKey || !(LIVE_OBLIGATION as readonly string[]).includes(o.status)) throw new FinanceError("Obligation not found or not open in this branch.", 409);
        const paid = (await paidByObligation(tx, [o.id])).get(o.id) ?? 0;
        const held = await tx.paymentReservation.aggregate({ where: { obligationId: o.id, status: { in: ["ACTIVE", "PENDING_APPROVAL"] } }, _sum: { amount: true } });
        if (amount > toMinor(o.amount) - paid - toMinor(held._sum.amount)) throw new FinanceError("This would reserve more than the obligation still owes.", 409);
      }
      const [s] = (await categoryStates(tx, [cat.branchKey], monthOf(riyadhDateString()))).filter((x) => x.cat.id === categoryId);
      const overLimit = cat.spendingLimit !== null && amount > toMinor(cat.spendingLimit);
      const overBalance = amount > s.view.available;
      const requiresOverride = overLimit || overBalance;
      const r = await tx.paymentReservation.create({
        data: {
          categoryId, branchKey: cat.branchKey, obligationId, amount: fromMinor(amount), payee, purpose,
          dueDate: dueDate ? dbDate(dueDate) : null, status: requiresOverride ? "PENDING_APPROVAL" : "ACTIVE",
          requiresOverride, idempotencyKey, createdBy: actor.id,
        },
      });
      await audit(tx, { action: "reservation.created", entityType: "PaymentReservation", entityId: r.id, branchKey: cat.branchKey, after: r, refs: { obligationId }, userId: actor.id });
      if (requiresOverride) {
        const approval = await createApproval(tx, actor, {
          type: "SPEND_OVERRIDE", branchKey: cat.branchKey, entityType: "PaymentReservation", entityId: r.id,
          summary: `${fromMinor(amount)} SAR to ${payee} from ${cat.code} — ${overLimit ? "above the spending limit" : ""}${overLimit && overBalance ? " and " : ""}${overBalance ? `above the available ${fromMinor(s.view.available)} SAR` : ""}`,
          payload: { reservationId: r.id, amount, available: s.view.available, spendingLimit: cat.spendingLimit === null ? null : toMinor(cat.spendingLimit), payee, categoryNameEn: cat.nameEn, categoryNameAr: cat.nameAr, overLimit, overBalance },
          reason: purpose, assignedToId: cat.approverEmployeeId,
        });
        await tx.paymentReservation.update({ where: { id: r.id }, data: { approvalId: approval.id } });
      }
      return { replayed: false, reservation: await tx.paymentReservation.findUniqueOrThrow({ where: { id: r.id } }) };
    });
  } catch (err) {
    if (idempotencyKey && (err as { code?: string })?.code === "P2002") {
      const prior = await prisma.paymentReservation.findUnique({ where: { createdBy_idempotencyKey: { createdBy: actor.id, idempotencyKey } } });
      if (prior) return { replayed: true, reservation: prior };
    }
    throw err;
  }
}

export async function releaseReservation(actor: FinanceActor, scope: FinanceScope, id: string, reason: string) {
  assertCan(actor, "allocate");
  return prisma.$transaction(async (tx) => {
    const r = await tx.paymentReservation.findUnique({ where: { id } });
    if (!r) throw new FinanceError("Not found", 404);
    assertScope(scope, r.branchKey);
    if (r.status !== "ACTIVE" && r.status !== "PENDING_APPROVAL") throw new FinanceError("Only an open reservation can be released.", 409);
    const upd = await tx.paymentReservation.update({ where: { id }, data: { status: "RELEASED", releasedAt: new Date(), releasedBy: actor.id, releaseReason: reason } });
    if (r.approvalId) await tx.finApprovalRequest.updateMany({ where: { id: r.approvalId, status: "PENDING" }, data: { status: "CANCELLED", decidedAt: new Date(), decidedBy: actor.id, decisionNote: "Reservation released" } });
    await audit(tx, { action: "reservation.released", entityType: "PaymentReservation", entityId: id, branchKey: r.branchKey, before: r, after: upd, reason, userId: actor.id });
    return upd;
  });
}

async function paymentsBookedOnTxn(db: Db, txnId: string): Promise<Minor> {
  const rows = await db.allocationEntry.groupBy({ by: ["entryType"], where: { sourceTxnId: txnId, sourceType: "PAYMENT" }, _sum: { amount: true } });
  let v = 0;
  for (const r of rows) v += (r.entryType === "PAYMENT" ? 1 : -1) * toMinor(r._sum.amount);
  return v;
}

async function assertPaymentTxn(tx: Prisma.TransactionClient, txnId: string, branchKey: string, amount: Minor) {
  const t = await tx.bankTransaction.findUnique({ where: { id: txnId } });
  if (!t || t.branchKey !== branchKey) throw new FinanceError("Payment bank line not found in this branch.", 404);
  if (t.status === "VOID") throw new FinanceError("That bank line is void.", 409);
  if (toMinor(t.amount) >= 0) throw new FinanceError("A payment must be an outgoing bank line.", 409);
  if (t.classification === "INTERNAL_TRANSFER") throw new FinanceError("A transfer between company accounts is not a payment.", 409);
  const used = await paymentsBookedOnTxn(tx, txnId);
  if (amount + used > -toMinor(t.amount)) throw new FinanceError(`Only ${fromMinor(-toMinor(t.amount) - used)} SAR of this bank line is not yet assigned to a category.`, 409);
  return t;
}

/**
 * Execute a reserved payment: the category balance falls by the amount and the reservation
 * is released IN THE SAME TRANSACTION, so "available" is unchanged by execution and nothing
 * is deducted twice.
 */
export async function executeReservation(actor: FinanceActor, scope: FinanceScope, id: string, body: Record<string, unknown>) {
  assertCan(actor, "allocate");
  const txnId = reqStr(body.txnId, "Payment bank line", 40);
  const r0 = await prisma.paymentReservation.findUnique({ where: { id } });
  if (!r0) throw new FinanceError("Not found", 404);
  assertScope(scope, r0.branchKey);
  return prisma.$transaction(async (tx) => {
    await lockPool(tx, r0.branchKey);
    const r = await tx.paymentReservation.findUniqueOrThrow({ where: { id } });
    if (r.status === "EXECUTED" && r.executedTxnId === txnId) return { replayed: true, reservation: r };
    if (r.status !== "ACTIVE") throw new FinanceError(r.status === "PENDING_APPROVAL" ? "This payment is waiting for override approval." : "This reservation is not open.", 409);
    const amount = toMinor(r.amount);
    await assertPaymentTxn(tx, txnId, r.branchKey, amount);
    const claimed = await tx.paymentReservation.updateMany({
      where: { id, status: "ACTIVE" },
      data: { status: "EXECUTED", executedTxnId: txnId, executedAt: new Date(), executedBy: actor.id },
    });
    if (claimed.count === 0) throw new FinanceError("This reservation was just executed by someone else.", 409);
    await tx.allocationEntry.create({
      data: {
        categoryId: r.categoryId, branchKey: r.branchKey, entryType: "PAYMENT", sourceType: "PAYMENT", amount: fromMinor(amount),
        periodMonth: monthOf(riyadhDateString()), sourceTxnId: txnId, reservationId: r.id, reason: `${r.payee}: ${r.purpose}`, createdBy: actor.id,
      },
    });
    if (r.obligationId) {
      const existing = await tx.bankTransactionMatch.findFirst({ where: { transactionId: txnId, targetType: "OBLIGATION", targetId: r.obligationId, active: true } });
      if (!existing) {
        if ((await postedBankLines(tx, [txnId])).size) throw new FinanceError(POSTED_BANK_LINE_MESSAGE, 409);
        await tx.bankTransactionMatch.create({ data: { transactionId: txnId, targetType: "OBLIGATION", targetId: r.obligationId, amount: fromMinor(amount), createdBy: actor.id } });
      }
      await recomputeObligationStatus(tx, r.obligationId);
    }
    const after = await tx.paymentReservation.findUniqueOrThrow({ where: { id } });
    await audit(tx, { action: "reservation.executed", entityType: "PaymentReservation", entityId: id, branchKey: r.branchKey, before: r, after, refs: { txnId, obligationId: r.obligationId }, userId: actor.id });
    return { replayed: false, reservation: after };
  });
}

/** A payment from a category without a prior reservation. Never beyond what is available. */
export async function recordCategoryPayment(actor: FinanceActor, scope: FinanceScope, body: Record<string, unknown>) {
  assertCan(actor, "allocate");
  const categoryId = reqStr(body.categoryId, "Category", 40);
  const txnId = reqStr(body.txnId, "Payment bank line", 40);
  const amount = parseMoney(body.amount);
  if (amount === null || amount <= 0) throw new FinanceError("Amount must be positive.", 400);
  const cat = await prisma.allocationCategory.findUnique({ where: { id: categoryId } });
  if (!cat) throw new FinanceError("Not found", 404);
  assertScope(scope, cat.branchKey);
  return prisma.$transaction(async (tx) => {
    await lockPool(tx, cat.branchKey);
    await assertPaymentTxn(tx, txnId, cat.branchKey, amount);
    const [s] = (await categoryStates(tx, [cat.branchKey], monthOf(riyadhDateString()))).filter((x) => x.cat.id === categoryId);
    if (amount > s.view.available) throw new FinanceError("Not enough available in this category. Create a payment request to seek an override.", 409);
    if (cat.spendingLimit !== null && amount > toMinor(cat.spendingLimit)) throw new FinanceError("Above this category's spending limit. Create a payment request to seek an override.", 409);
    const e = await tx.allocationEntry.create({
      data: {
        categoryId, branchKey: cat.branchKey, entryType: "PAYMENT", sourceType: "PAYMENT", amount: fromMinor(amount),
        periodMonth: monthOf(riyadhDateString()), sourceTxnId: txnId, reason: str(body.note, 300), createdBy: actor.id,
      },
    });
    await audit(tx, { action: "category.payment", entityType: "AllocationEntry", entityId: e.id, branchKey: cat.branchKey, after: e, refs: { txnId }, userId: actor.id });
    return e;
  });
}

// ─── Reversals (auditable; never rewriting history) ──────────────────────────────

/**
 * Reverse everything a receipt funded. If the money has already been spent, the category
 * goes negative — that shortfall is shown and must be reviewed; it is not hidden.
 */
export async function reverseReceiptAllocations(tx: Prisma.TransactionClient, actorId: string, txnId: string, reason: string) {
  const rows = await tx.allocationEntry.groupBy({
    by: ["categoryId", "entryType", "sourceType", "periodMonth"],
    where: { sourceTxnId: txnId, sourceType: { in: ["RECEIPT", "RECEIPT_REVERSAL"] } },
    _sum: { amount: true },
  });
  const net = new Map<string, { branchKey?: string; month: string; amount: Minor }>();
  for (const r of rows) {
    const k = `${r.categoryId}|${r.periodMonth}`;
    const cur = net.get(k) ?? { month: r.periodMonth, amount: 0 };
    cur.amount += (r.entryType === "ALLOCATION" ? 1 : -1) * toMinor(r._sum.amount);
    net.set(k, cur);
  }
  const reversed: { categoryId: string; amount: Minor; balanceAfter: Minor }[] = [];
  for (const [k, v] of net) {
    if (v.amount <= 0) continue;
    const categoryId = k.split("|")[0];
    const cat = await tx.allocationCategory.findUniqueOrThrow({ where: { id: categoryId } });
    await tx.allocationEntry.create({
      data: {
        categoryId, branchKey: cat.branchKey, entryType: "ADJUSTMENT_OUT", sourceType: "RECEIPT_REVERSAL",
        amount: fromMinor(v.amount), periodMonth: v.month, sourceTxnId: txnId, reason, createdBy: actorId,
      },
    });
    const l = (await categoryLedgers(tx, { categoryId })).get(categoryId);
    reversed.push({ categoryId, amount: v.amount, balanceAfter: l?.balance ?? 0 });
  }
  return { reversed, shortfalls: reversed.filter((r) => r.balanceAfter < 0) };
}

/** A voided outgoing line: its category payments come back, reservations reopen. */
export async function reversePaymentsForTxn(tx: Prisma.TransactionClient, actorId: string, txnId: string, reason: string) {
  const payments = await tx.allocationEntry.findMany({ where: { sourceTxnId: txnId, entryType: "PAYMENT" } });
  for (const p of payments) {
    const already = await tx.allocationEntry.findUnique({ where: { reversesEntryId: p.id } });
    if (already) continue;
    await tx.allocationEntry.create({
      data: {
        categoryId: p.categoryId, branchKey: p.branchKey, entryType: "ADJUSTMENT_IN", sourceType: "PAYMENT",
        amount: p.amount, periodMonth: monthOf(riyadhDateString()), sourceTxnId: txnId, reservationId: p.reservationId,
        reversesEntryId: p.id, reason, createdBy: actorId,
      },
    });
    if (p.reservationId) {
      await tx.paymentReservation.updateMany({ where: { id: p.reservationId, status: "EXECUTED" }, data: { status: "ACTIVE", executedTxnId: null, executedAt: null, executedBy: null } });
    }
  }
  return payments.length;
}

/** Month-end sweep for categories whose policy returns unspent funds to unallocated. */
export async function sweepCategory(actor: FinanceActor, scope: FinanceScope, categoryId: string, reason: string) {
  assertCan(actor, "period_close");
  const cat = await prisma.allocationCategory.findUnique({ where: { id: categoryId } });
  if (!cat) throw new FinanceError("Not found", 404);
  assertScope(scope, cat.branchKey);
  if (cat.rollover !== "SWEEP_TO_UNALLOCATED") throw new FinanceError("This category carries its balance forward.", 409);
  return prisma.$transaction(async (tx) => {
    await lockPool(tx, cat.branchKey);
    const [s] = (await categoryStates(tx, [cat.branchKey], monthOf(riyadhDateString()))).filter((x) => x.cat.id === categoryId);
    if (s.view.available <= 0) throw new FinanceError("Nothing available to sweep.", 409);
    const e = await tx.allocationEntry.create({
      data: {
        categoryId, branchKey: cat.branchKey, entryType: "ADJUSTMENT_OUT", sourceType: "PERIOD_SWEEP", amount: fromMinor(s.view.available),
        periodMonth: monthOf(riyadhDateString()), reason, createdBy: actor.id,
      },
    });
    await audit(tx, { action: "category.swept", entityType: "AllocationEntry", entityId: e.id, branchKey: cat.branchKey, after: e, reason, userId: actor.id });
    return e;
  });
}

export async function categoryEntries(db: Db, scope: FinanceScope, categoryId: string, page = 0) {
  const cat = await db.allocationCategory.findUnique({ where: { id: categoryId } });
  if (!cat) throw new FinanceError("Not found", 404);
  assertScope(scope, cat.branchKey);
  const [rows, total] = await Promise.all([
    db.allocationEntry.findMany({ where: { categoryId }, orderBy: { createdAt: "desc" }, take: 50, skip: page * 50 }),
    db.allocationEntry.count({ where: { categoryId } }),
  ]);
  return { category: cat, rows, total };
}

export async function listReservations(db: Db, scope: FinanceScope, status?: string) {
  return db.paymentReservation.findMany({
    where: { ...scopeWhere(scope), ...(status ? { status: status as "ACTIVE" } : { status: { in: ["ACTIVE", "PENDING_APPROVAL"] } }) },
    include: { category: { select: { code: true, nameEn: true, nameAr: true } } },
    orderBy: [{ dueDate: "asc" }, { createdAt: "asc" }],
    take: 200,
  });
}
