// Native HR — deduction-category policy (P-2 findings 2 and 3). Controls only.
//
// The policy version carries, besides its existing overall cap (`maxDeductionPercent`):
// a cap per deduction category, which categories the overall cap covers, the order the
// categories apply in, what a cap breach does (WARN / BLOCK), whether variable pay counts in
// the cap base, and after how many deferrals an advance is escalated. EVERY ONE of these is an
// accountant decision: nothing here supplies a value. While any is unset, payroll refuses to
// build a run under that version (409 DEDUCTION_POLICY_UNSET) and advance approval refuses too.
// Test fixtures set FICTIONAL values explicitly.
import { Prisma } from "@/generated/prisma/client";
import { HrError, bool, oneOf } from "./core";
import { D as MD } from "./money";
import { DEDUCTION_CATEGORIES, type DeductionCategory, type DeductionConfig } from "./payroll-engine";

export { DEDUCTION_CATEGORIES };
export type { DeductionCategory };

type PolicyRow = {
  version: number;
  capBaseIncludesVariable: boolean;
  /** Review P2-B7: the cap base after unearned pay (true) or before (false). NULL = not decided. */
  capBaseAfterUnearned: boolean | null;
  deductionCapUnearnedPercent: Prisma.Decimal | null;
  deductionCapLoanPercent: Prisma.Decimal | null;
  deductionCapStatutoryPercent: Prisma.Decimal | null;
  deductionCapOtherPercent: Prisma.Decimal | null;
  deductionOverallCovers: string[];
  deductionPriority: string[];
  deductionCapAction: string | null;
  advanceDeferralEscalateAfter: number | null;
};

const CAP_FIELD: Record<DeductionCategory, keyof PolicyRow> = {
  UNEARNED_PAY: "deductionCapUnearnedPercent",
  LOAN_RECOVERY: "deductionCapLoanPercent",
  STATUTORY: "deductionCapStatutoryPercent",
  OTHER: "deductionCapOtherPercent",
};

/** The fields of a policy version that are not yet decided (empty when complete). */
export function deductionPolicyGaps(p: PolicyRow): string[] {
  const gaps: string[] = [];
  for (const c of DEDUCTION_CATEGORIES) if (p[CAP_FIELD[c]] === null || p[CAP_FIELD[c]] === undefined) gaps.push(CAP_FIELD[c]);
  if (!p.deductionOverallCovers?.length) gaps.push("deductionOverallCovers");
  if ((p.deductionPriority?.length ?? 0) !== DEDUCTION_CATEGORIES.length) gaps.push("deductionPriority");
  if (!p.deductionCapAction) gaps.push("deductionCapAction");
  if (p.advanceDeferralEscalateAfter === null || p.advanceDeferralEscalateAfter === undefined) gaps.push("advanceDeferralEscalateAfter");
  if (p.capBaseAfterUnearned === null || p.capBaseAfterUnearned === undefined) gaps.push("capBaseAfterUnearned");
  return gaps;
}

/** Refuse to run payroll under a version whose deduction policy is not fully decided. */
/**
 * Refuse to run payroll — regular AND correction runs — under a version whose deduction policy is
 * not fully decided. Review P2-B6: every version created before these settings existed has them
 * empty; it is never patched (an ACTIVE version never changes) and no value is invented. The way
 * forward is a NEW version carrying the accountant-approved settings, drafted by one policy
 * manager and activated by another (A-15) — see docs/hr/P2-REVIEW-FIXES.md (runbook / data prep).
 */
export function assertDeductionPolicyComplete(p: PolicyRow) {
  const gaps = deductionPolicyGaps(p);
  if (gaps.length) {
    throw new HrError(
      `Payroll policy v${p.version} has no accountant-approved deduction settings (${gaps.join(", ")}), so no payroll run — regular or correction — can be prepared under it, and it will not be patched: approved versions never change. Issue a NEW policy version for this period with the accountant-approved deduction settings (drafted by one policy manager, activated by another), then prepare the run. Nothing was changed.`,
      409, "DEDUCTION_POLICY_UNSET",
    );
  }
}

/** The engine configuration of a complete policy version (call assertDeductionPolicyComplete first). */
export function engineDeductionConfig(p: PolicyRow): DeductionConfig {
  assertDeductionPolicyComplete(p);
  return {
    capBaseIncludesVariable: p.capBaseIncludesVariable,
    capBaseAfterUnearned: p.capBaseAfterUnearned as boolean,
    categoryCapPercent: Object.fromEntries(DEDUCTION_CATEGORIES.map((c) => [c, MD((p[CAP_FIELD[c]] as Prisma.Decimal).toString())])) as Record<DeductionCategory, ReturnType<typeof MD>>,
    overallCovers: p.deductionOverallCovers as DeductionCategory[],
    priority: p.deductionPriority as DeductionCategory[],
    onExceed: p.deductionCapAction as "WARN" | "BLOCK",
  };
}

/** The loan-recovery cap of a version, or null while undecided (advance approval refuses then). */
export function loanCapPercent(p: PolicyRow): Prisma.Decimal | null {
  return deductionPolicyGaps(p).length ? null : (p.deductionCapLoanPercent as Prisma.Decimal);
}

const pct = (v: unknown, field: string): Prisma.Decimal | null => {
  if (v === undefined || v === null || v === "") return null;
  let d: Prisma.Decimal;
  try { d = new Prisma.Decimal(String(v)); } catch { throw new HrError(`${field} must be a number.`, 400); }
  if (d.isNaN() || d.lessThan(0) || d.greaterThan(100) || d.decimalPlaces() > 2) throw new HrError(`${field} must be a percentage between 0 and 100.`, 400);
  return d;
};

function categories(v: unknown, field: string): string[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw new HrError(`${field} must be a list of ${DEDUCTION_CATEGORIES.join(", ")}.`, 400);
  for (const c of v) if (!(DEDUCTION_CATEGORIES as string[]).includes(c)) throw new HrError(`${field}: unknown category ${String(c)}.`, 400);
  if (new Set(v).size !== v.length) throw new HrError(`${field} lists a category twice.`, 400);
  return v as string[];
}

/** Parse the deduction-policy fields of a draft version. Unset stays null / empty (never defaulted). */
export function deductionPolicyFields(b: Record<string, unknown>) {
  const priority = categories(b.deductionPriority, "deductionPriority");
  if (priority.length && priority.length !== DEDUCTION_CATEGORIES.length) throw new HrError(`deductionPriority must list all ${DEDUCTION_CATEGORIES.length} categories in order.`, 400);
  let escalate: number | null = null;
  if (b.advanceDeferralEscalateAfter !== undefined && b.advanceDeferralEscalateAfter !== null && b.advanceDeferralEscalateAfter !== "") {
    const n = Number(b.advanceDeferralEscalateAfter);
    if (!Number.isInteger(n) || n < 1 || n > 24) throw new HrError("advanceDeferralEscalateAfter must be a whole number from 1 to 24.", 400);
    escalate = n;
  }
  // Review P2-B7: a nullable choice — absent stays undecided (never defaulted).
  const afterUnearned = b.capBaseAfterUnearned === undefined || b.capBaseAfterUnearned === null || b.capBaseAfterUnearned === "" ? null : bool(b.capBaseAfterUnearned, false);
  return {
    capBaseIncludesVariable: bool(b.capBaseIncludesVariable, false),
    capBaseAfterUnearned: afterUnearned,
    deductionCapUnearnedPercent: pct(b.deductionCapUnearnedPercent, "deductionCapUnearnedPercent"),
    deductionCapLoanPercent: pct(b.deductionCapLoanPercent, "deductionCapLoanPercent"),
    deductionCapStatutoryPercent: pct(b.deductionCapStatutoryPercent, "deductionCapStatutoryPercent"),
    deductionCapOtherPercent: pct(b.deductionCapOtherPercent, "deductionCapOtherPercent"),
    deductionOverallCovers: categories(b.deductionOverallCovers, "deductionOverallCovers"),
    deductionPriority: priority,
    deductionCapAction: b.deductionCapAction === undefined || b.deductionCapAction === null || b.deductionCapAction === "" ? null : oneOf(b.deductionCapAction, "deductionCapAction", ["WARN", "BLOCK"] as const),
    advanceDeferralEscalateAfter: escalate,
  };
}

/** What the reviewer approves (part of the policy fingerprint) and what the UI shows. */
export function deductionPolicyContent(p: PolicyRow) {
  const s = (d: Prisma.Decimal | null) => (d === null || d === undefined ? null : d.toString());
  return {
    capBaseIncludesVariable: p.capBaseIncludesVariable,
    capBaseAfterUnearned: p.capBaseAfterUnearned ?? null,
    deductionCapUnearnedPercent: s(p.deductionCapUnearnedPercent),
    deductionCapLoanPercent: s(p.deductionCapLoanPercent),
    deductionCapStatutoryPercent: s(p.deductionCapStatutoryPercent),
    deductionCapOtherPercent: s(p.deductionCapOtherPercent),
    deductionOverallCovers: [...(p.deductionOverallCovers ?? [])].sort(),
    // Order matters: never sorted.
    deductionPriority: [...(p.deductionPriority ?? [])],
    deductionCapAction: p.deductionCapAction,
    advanceDeferralEscalateAfter: p.advanceDeferralEscalateAfter,
  };
}
