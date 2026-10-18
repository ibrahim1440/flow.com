// Native HR — the CLOSED list of payroll adjustment categories (review P1-B2, spec S-7.6.1).
// Pure: no database.
//
// Every payroll adjustment carries a category from this list (DB CHECK, migration
// 20261017130000). End of service, leave encashment and final settlement are NOT on it: they
// exist only as parts of an HrFinalSettlement (./services/final-settlement). Asking for one of
// them is refused with 409 EOS_NOT_SALARY. The reason text is no longer what decides: the old
// keyword match stays only as a WARNING shown to the approver (EOS_KEYWORD, INFO).
//
// Postings follow the category. Which ledger account each posting key is stays the account
// map's (accountant) decision; this mapping of category → posting key is engineering and is
// listed for the accountant's review in docs/hr/P2-REVIEW-FIXES.md.
import { HrError } from "./core";

// P-2 rev3 item 5 (D-7i, migration 20261017190000): PRIOR_PERIOD_ARREARS and COMMISSION_TRUE_UP —
// legitimate dues owed for an EARLIER period. Each names its document and the related period; for
// a person whose separation is in scope the period is before the separation and an independent
// attestation is still required. They COUNT towards the end-of-service match (review rev8 P2-a):
// the route for legitimate dues (`legitimateDuesRoute`, D-7i-5) is undecided, so the strict default
// never lets a due reach an amount on record through payroll; the attestation clears the review only.
export const EARNING_CATEGORIES = ["OVERTIME_CORRECTION", "ALLOWANCE_CORRECTION", "SALARY_ARREARS", "APPROVED_BONUS", "OTHER_WITH_MEMO", "PRIOR_PERIOD_ARREARS", "COMMISSION_TRUE_UP"] as const;
export const DUES_CATEGORIES = ["PRIOR_PERIOD_ARREARS", "COMMISSION_TRUE_UP"] as const;
export const isDuesCategory = (c: string | null | undefined) => !!c && (DUES_CATEGORIES as readonly string[]).includes(c);
export const DEDUCTION_CATEGORIES_ADJ = ["CONSENTED_DEDUCTION", "COURT_ORDER_DEDUCTION", "DAMAGE_DEDUCTION", "OTHER_WITH_MEMO"] as const;
export const ADJUSTMENT_CATEGORIES = [...new Set<string>([...EARNING_CATEGORIES, ...DEDUCTION_CATEGORIES_ADJ])] as readonly string[];
export type AdjustmentCategory = (typeof EARNING_CATEGORIES)[number] | (typeof DEDUCTION_CATEGORIES_ADJ)[number];

/** Names that are never a payroll adjustment category (they are final-settlement components). */
export const NOT_SALARY = ["EOS", "END_OF_SERVICE", "EOSB", "GRATUITY", "LEAVE_ENCASHMENT", "ENCASHMENT", "FINAL_SETTLEMENT", "SEVERANCE"] as const;

/** OTHER_WITH_MEMO needs a real memo, not a word. */
export const MEMO_MIN = 10;

/**
 * Validate the category of an adjustment of `kind`. Refuses end-of-service / leave-encashment /
 * final-settlement names with 409 EOS_NOT_SALARY, a category of the wrong kind or an unknown one
 * with 400, and an OTHER_WITH_MEMO whose reason is shorter than a memo.
 */
export function parseAdjustmentCategory(kind: "EARNING" | "DEDUCTION", v: unknown, reason: string): AdjustmentCategory {
  const raw = typeof v === "string" ? v.trim().toUpperCase() : "";
  if (!raw) throw new HrError(`category is required: one of ${(kind === "EARNING" ? EARNING_CATEGORIES : DEDUCTION_CATEGORIES_ADJ).join(", ")}.`, 400, "CATEGORY_REQUIRED");
  if ((NOT_SALARY as readonly string[]).includes(raw) || /END.?OF.?SERVICE|ENCASH|GRATUITY|FINAL.?SETTLEMENT|SEVERANCE/.test(raw)) {
    throw new HrError("End-of-service, leave-encashment and final-settlement amounts are never a payroll adjustment. Use the final settlement on the employee's offboarding tab.", 409, "EOS_NOT_SALARY");
  }
  const allowed: readonly string[] = kind === "EARNING" ? EARNING_CATEGORIES : DEDUCTION_CATEGORIES_ADJ;
  if (!allowed.includes(raw)) throw new HrError(`category must be one of ${allowed.join(", ")} for ${kind === "EARNING" ? "an earning" : "a deduction"}.`, 400, "CATEGORY_INVALID");
  if (raw === "OTHER_WITH_MEMO" && reason.trim().length < MEMO_MIN) throw new HrError(`OTHER_WITH_MEMO needs a memo of at least ${MEMO_MIN} characters in the reason.`, 400, "MEMO_REQUIRED");
  return raw as AdjustmentCategory;
}

/** The posting key of an adjustment, by category (see the header: the key → account map is the accountant's). */
export function adjustmentPostingKey(kind: string, category: string | null): "SALARY_EXPENSE" | "ALLOWANCE_EXPENSE" | "OVERTIME_EXPENSE" | "COMMISSION_EXPENSE" | "OTHER_DEDUCTIONS_PAYABLE" {
  if (kind === "DEDUCTION") return "OTHER_DEDUCTIONS_PAYABLE";
  if (category === "OVERTIME_CORRECTION") return "OVERTIME_EXPENSE";
  if (category === "ALLOWANCE_CORRECTION") return "ALLOWANCE_EXPENSE";
  // rev3 item 5: a commission true-up posts like the commission it corrects (listed for the accountant).
  if (category === "COMMISSION_TRUE_UP") return "COMMISSION_EXPENSE";
  // SALARY_ARREARS, APPROVED_BONUS, OTHER_WITH_MEMO, PRIOR_PERIOD_ARREARS (and adjustments from before categories).
  return "SALARY_EXPENSE";
}

/**
 * rev3 item 5: the evidence a prior-period category needs — the document reference and the related
 * period (YYYY-MM). Null for every other category (which carries neither).
 */
export function parseDuesEvidence(category: string, b: { documentReference?: unknown; relatedPeriod?: unknown }): { documentReference: string; relatedPeriod: string } | null {
  if (!isDuesCategory(category)) {
    if ((b.documentReference !== undefined && b.documentReference !== null && b.documentReference !== "") || (b.relatedPeriod !== undefined && b.relatedPeriod !== null && b.relatedPeriod !== "")) throw new HrError("documentReference and relatedPeriod belong to PRIOR_PERIOD_ARREARS and COMMISSION_TRUE_UP only.", 400);
    return null;
  }
  const documentReference = typeof b.documentReference === "string" ? b.documentReference.trim() : "";
  const relatedPeriod = typeof b.relatedPeriod === "string" ? b.relatedPeriod.trim() : "";
  if (documentReference.length < 3 || documentReference.length > 200) throw new HrError(`${category} needs the reference of the document it rests on (documentReference, 3 to 200 characters).`, 400, "DUES_EVIDENCE");
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(relatedPeriod)) throw new HrError(`${category} names the earlier period it is owed for (relatedPeriod, YYYY-MM).`, 400, "DUES_EVIDENCE");
  return { documentReference, relatedPeriod };
}

/** Wording that LOOKS like end of service / leave encashment / final settlement. A warning only. */
export const EOS_WORDS = /(end[\s-]*of[\s-]*service|\bEOS\b|gratuity|leave[\s-]*encash|encashment|final[\s-]*settlement|severance|terminal[\s-]*benefit|\bEOSB\b|e\.o\.s|end[\s-]*of[\s-]*contract|leave[\s-]*pay[\s-]*out|مكافأة|نهاية\s*(ال)?خدمة|نهاية\s*(ال)?عقد|انتهاء\s*(ال)?عقد|بدل\s*(رصيد\s*)?(ال)?[إا]جاز|صرف\s*رصيد\s*(ال)?[إا]جاز|تصفية\s*(ال)?مستحقات|المخالصة|مخالصة|التسوية\s*النهائية)/i;

export function looksLikeFinalSettlement(reason: string): boolean {
  return EOS_WORDS.test(reason);
}
