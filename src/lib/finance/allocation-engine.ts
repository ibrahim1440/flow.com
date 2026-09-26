// The allocation engine: pure, deterministic, integer-only.
//
// Given ONE confirmed receipt and ONE rule version, decide how much of that receipt's cash
// is earmarked to each category. Nothing here touches the database; the service supplies
// category state, persists the result, and guarantees single execution.
//
// ── Calculation base (shown verbatim in the preview) ──────────────────────────────────
//   base = receipt amount still unallocated (the NET deposit — gateway/POS fees never
//          reached the bank) − the VAT reserved from the matched documents in phase 1.
//   Every PERCENT_OF_BASE step uses that one base. Percentages are never applied to a
//   running remainder, so two 50% steps can never mean 50% then 25%.
//
// ── Execution order (fixed, independent of the order steps were typed in) ─────────────
//   1. RECEIPT_TAX_COMPONENT  VAT on the documents this receipt settles — not company money.
//   2. PERCENT_OF_BASE        all percentage steps together, on the same base.
//   3. FUND_OBLIGATIONS       categories by priority, up to their due obligations.
//   4. FILL_TARGET            categories by priority, up to their funding need.
//   5. WEIGHTED_REMAINDER     what is left, split by weight.
//   6. LEAVE_UNALLOCATED      explicit: anything still left stays unallocated.
//   Within a phase, ties are broken by (priority, step seq).
//
// ── Target semantics ──────────────────────────────────────────────────────────────────
//   MONTHLY_TARGET  need = target − net funded THIS MONTH. Spending does not reopen the
//                   gap, so the category cannot refill itself indefinitely.
//   RESERVE_TARGET  replenish=true:  need = target − current balance (refills after spending)
//                   replenish=false: need = target − net funded EVER (a one-time fill)
//   A step's capAmount further limits what that step may allocate.

import { PERCENT_SCALE, splitByWeights, type Minor } from "./money";

export type AllocMethod =
  | "PERCENT_OF_BASE"
  | "FILL_TARGET"
  | "FUND_OBLIGATIONS"
  | "RECEIPT_TAX_COMPONENT"
  | "WEIGHTED_REMAINDER"
  | "LEAVE_UNALLOCATED";

export type RuleStep = {
  seq: number;
  method: AllocMethod;
  categoryId: string | null;
  /** Percent × 10 000 (65% = 650 000). PERCENT_OF_BASE only. */
  percentScaled?: number | null;
  weight?: number | null;
  capAmount?: Minor | null;
};

export type CategoryState = {
  id: string;
  code: string;
  priority: number;
  fundingType: "MONTHLY_TARGET" | "RESERVE_TARGET" | "OPEN";
  targetAmount: Minor | null;
  replenish: boolean;
  isTaxReserve: boolean;
  active: boolean;
  /** Current balance (can be negative after a reversal of already-spent funds). */
  balance: Minor;
  /** Net ALLOCATION entries this month (allocations − receipt reversals). */
  fundedThisMonth: Minor;
  /** Net ALLOCATION entries ever. */
  fundedEver: Minor;
  /** Remaining amount of open obligations assigned to this category. */
  obligationsRemaining: Minor;
  /** Month window of a target; null = no window. */
  targetStartMonth?: string | null;
  targetEndMonth?: string | null;
};

export type AllocationInput = {
  receiptUnallocated: Minor;
  /** VAT on the documents this receipt was matched to (sum of match.taxAmount). */
  taxComponent: Minor;
  /** Unallocated cash in the whole pool of this scope. A run may never exceed it. */
  poolUnallocated: Minor;
  month: string;
  steps: RuleStep[];
  categories: CategoryState[];
};

export type AllocationLine = { categoryId: string; amount: Minor; stepSeq: number; method: AllocMethod; note: string };

export type AllocationResult = {
  base: Minor;
  lines: AllocationLine[];
  allocatedTotal: Minor;
  leftUnallocated: Minor;
  warnings: string[];
};

export type RuleValidation = { ok: boolean; errors: string[]; warnings: string[] };

const PHASE: Record<AllocMethod, number> = {
  RECEIPT_TAX_COMPONENT: 1,
  PERCENT_OF_BASE: 2,
  FUND_OBLIGATIONS: 3,
  FILL_TARGET: 4,
  WEIGHTED_REMAINDER: 5,
  LEAVE_UNALLOCATED: 6,
};

export function validateRuleSteps(steps: RuleStep[], categories: Pick<CategoryState, "id" | "isTaxReserve" | "fundingType" | "targetAmount" | "active">[]): RuleValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  const byId = new Map(categories.map((c) => [c.id, c]));
  const seqs = new Set<number>();
  let percentTotal = 0;
  const percentCats = new Set<string>();

  if (steps.length === 0) errors.push("A rule version needs at least one step.");

  for (const s of steps) {
    if (seqs.has(s.seq)) errors.push(`Step ${s.seq}: duplicate sequence number.`);
    seqs.add(s.seq);
    const needsCategory = s.method !== "LEAVE_UNALLOCATED";
    if (needsCategory && !s.categoryId) { errors.push(`Step ${s.seq}: choose a category.`); continue; }
    if (!needsCategory && s.categoryId) errors.push(`Step ${s.seq}: "leave unallocated" takes no category.`);
    const cat = s.categoryId ? byId.get(s.categoryId) : undefined;
    if (needsCategory && !cat) { errors.push(`Step ${s.seq}: category not found in this scope.`); continue; }
    if (cat && !cat.active) errors.push(`Step ${s.seq}: category is inactive.`);
    if (s.capAmount !== undefined && s.capAmount !== null && s.capAmount <= 0) errors.push(`Step ${s.seq}: cap must be positive.`);

    switch (s.method) {
      case "PERCENT_OF_BASE":
        if (!s.percentScaled || s.percentScaled <= 0 || s.percentScaled > PERCENT_SCALE) {
          errors.push(`Step ${s.seq}: percentage must be greater than 0 and at most 100.`);
        } else percentTotal += s.percentScaled;
        if (cat?.isTaxReserve) {
          errors.push(`Step ${s.seq}: a tax reserve cannot be funded with a flat percentage of deposits. Use "VAT from matched documents" or tax obligations.`);
        }
        if (cat && percentCats.has(cat.id)) errors.push(`Step ${s.seq}: the same category has two percentage steps; combine them.`);
        if (cat) percentCats.add(cat.id);
        break;
      case "FILL_TARGET":
        if (cat && (cat.fundingType === "OPEN" || cat.targetAmount === null)) {
          errors.push(`Step ${s.seq}: "fill target" needs a category with a monthly or reserve target.`);
        }
        break;
      case "RECEIPT_TAX_COMPONENT":
        if (cat && !cat.isTaxReserve) errors.push(`Step ${s.seq}: VAT can only be reserved into a category marked as a tax reserve.`);
        break;
      case "WEIGHTED_REMAINDER":
        if (!s.weight || s.weight <= 0) errors.push(`Step ${s.seq}: remainder weight must be a positive whole number.`);
        break;
      default:
        break;
    }
  }
  if (percentTotal > PERCENT_SCALE) {
    errors.push(`Percentage steps add up to ${(percentTotal / 10_000).toFixed(4).replace(/\.?0+$/, "")}% — they may not exceed 100% of the base.`);
  }
  const taxSteps = steps.filter((s) => s.method === "RECEIPT_TAX_COMPONENT");
  if (taxSteps.length > 1) errors.push("Only one VAT step is allowed.");
  if (percentTotal === PERCENT_SCALE && steps.some((s) => PHASE[s.method] > PHASE.PERCENT_OF_BASE && s.method !== "LEAVE_UNALLOCATED")) {
    warnings.push("Percentages total 100%, so later steps (targets, obligations, remainder) will receive nothing.");
  }
  return { ok: errors.length === 0, errors, warnings };
}

function inWindow(c: CategoryState, month: string): boolean {
  if (c.targetStartMonth && month < c.targetStartMonth) return false;
  if (c.targetEndMonth && month > c.targetEndMonth) return false;
  return true;
}

export function fundingNeed(c: CategoryState, month: string): Minor {
  if (c.targetAmount === null || !inWindow(c, month)) return 0;
  if (c.fundingType === "MONTHLY_TARGET") return Math.max(0, c.targetAmount - c.fundedThisMonth);
  if (c.fundingType === "RESERVE_TARGET") {
    return c.replenish ? Math.max(0, c.targetAmount - c.balance) : Math.max(0, c.targetAmount - c.fundedEver);
  }
  return 0;
}

export function computeAllocation(input: AllocationInput): AllocationResult {
  const warnings: string[] = [];
  const cats = new Map(input.categories.map((c) => [c.id, { ...c }]));
  const lines: AllocationLine[] = [];

  if (input.receiptUnallocated <= 0) {
    return { base: 0, lines: [], allocatedTotal: 0, leftUnallocated: 0, warnings: ["Nothing left to allocate from this receipt."] };
  }
  if (input.poolUnallocated < input.receiptUnallocated) {
    // Refuse rather than scale: scaling would silently change what every percentage means.
    throw new AllocationRefused(
      `Unallocated cash in this scope (${input.poolUnallocated / 100} SAR) is less than this receipt's unallocated amount ` +
        `(${input.receiptUnallocated / 100} SAR). Existing allocations exceed available cash; resolve the shortfall before allocating.`,
    );
  }

  let remaining = input.receiptUnallocated;
  const add = (categoryId: string, amount: Minor, step: RuleStep, note: string) => {
    if (amount <= 0) return;
    lines.push({ categoryId, amount, stepSeq: step.seq, method: step.method, note });
    remaining -= amount;
    const c = cats.get(categoryId);
    if (c) { c.balance += amount; c.fundedThisMonth += amount; c.fundedEver += amount; }
  };
  const capped = (step: RuleStep, amount: Minor) =>
    step.capAmount !== undefined && step.capAmount !== null ? Math.min(amount, step.capAmount) : amount;
  const prio = (s: RuleStep) => (s.categoryId ? cats.get(s.categoryId)?.priority ?? 0 : 0);
  const ordered = [...input.steps].sort(
    (a, b) => PHASE[a.method] - PHASE[b.method] || prio(a) - prio(b) || a.seq - b.seq,
  );

  // Phase 1 — VAT.
  let taxTaken = 0;
  for (const s of ordered.filter((x) => x.method === "RECEIPT_TAX_COMPONENT")) {
    const amt = capped(s, Math.min(input.taxComponent, remaining));
    if (input.taxComponent > amt) warnings.push("VAT on matched documents exceeds what this step could reserve.");
    add(s.categoryId!, amt, s, "VAT on matched documents");
    taxTaken += amt;
  }

  // Phase 2 — percentages, all on the same base, split with exact rounding.
  const base = input.receiptUnallocated - taxTaken;
  const pct = ordered.filter((x) => x.method === "PERCENT_OF_BASE");
  if (pct.length > 0) {
    const used = pct.reduce((a, s) => a + (s.percentScaled ?? 0), 0);
    // The implicit last bucket is the part of the base no percentage claims; it flows on.
    const parts = splitByWeights(base, [...pct.map((s) => s.percentScaled ?? 0), Math.max(0, PERCENT_SCALE - used)]);
    pct.forEach((s, i) => {
      const amt = capped(s, parts[i]);
      if (amt < parts[i]) warnings.push(`Step ${s.seq}: capped at ${amt / 100} SAR; ${(parts[i] - amt) / 100} SAR flows to later steps.`);
      add(s.categoryId!, amt, s, `${(s.percentScaled ?? 0) / 10_000}% of base`);
    });
  }

  // Phase 3 — obligations due.
  for (const s of ordered.filter((x) => x.method === "FUND_OBLIGATIONS")) {
    const c = cats.get(s.categoryId!);
    if (!c) continue;
    const need = Math.max(0, c.obligationsRemaining - c.balance);
    add(c.id, capped(s, Math.min(need, remaining)), s, "Fund open obligations");
  }

  // Phase 4 — targets.
  for (const s of ordered.filter((x) => x.method === "FILL_TARGET")) {
    const c = cats.get(s.categoryId!);
    if (!c) continue;
    const need = fundingNeed(c, input.month);
    add(c.id, capped(s, Math.min(need, remaining)), s, c.fundingType === "MONTHLY_TARGET" ? "Monthly funding target" : "Reserve target");
  }

  // Phase 5 — weighted remainder.
  const rem = ordered.filter((x) => x.method === "WEIGHTED_REMAINDER");
  if (rem.length > 0 && remaining > 0) {
    const parts = splitByWeights(remaining, rem.map((s) => s.weight ?? 0));
    rem.forEach((s, i) => add(s.categoryId!, capped(s, parts[i]), s, `Remainder weight ${s.weight}`));
  }

  // Phase 6 — anything left stays unallocated (explicitly or by default).
  const allocatedTotal = lines.reduce((a, l) => a + l.amount, 0);
  // Merge lines of the same category+step (defensive; one step yields one line).
  return { base, lines, allocatedTotal, leftUnallocated: input.receiptUnallocated - allocatedTotal, warnings };
}

export class AllocationRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AllocationRefused";
  }
}

/** Scenario helper for the preview: the same rule over a lower-collections month. */
export function scaleScenario(amount: Minor, percent: number): Minor {
  return Math.floor((amount * percent) / 100);
}
