// Native HR — the D-4h GOSI difference matrix (P-2 rev3 item 3). Pure: no database.
//
// The nine cases of the accountant decision package (gates/P2-ACCOUNTANT-DECISIONS rev3 §6.1), by
// the same names. Which case a difference is, is decided by a person (proposer + second-person
// approver); this module only checks that the case FITS the difference (share and sign). Whether a
// case BOOKS anything, and with which keys, is the accountant's decision: every case ships disabled
// with no keys (HrGosiTreatment, migration 20261017170000) and is enabled only by an applied
// two-person GOSI_TREATMENT_SET change. Nothing here names an account.

export const GOSI_TREATMENT_CASES = [
  "CASE_1_EMPLOYER_INVOICE_HIGHER",
  "CASE_2A_EMPLOYEE_SHARE_RECOVER",
  "CASE_2B_EMPLOYEE_SHARE_EMPLOYER_BORNE",
  "CASE_3_EMPLOYER_INVOICE_LOWER",
  "CASE_4_EMPLOYEE_SHARE_REFUND",
  "CASE_5_ALREADY_BOOKED",
  "CASE_6_REGISTRATION_CORRECTED",
  "CASE_7_ROUNDING",
  "CASE_8_DISPUTED",
] as const;
export type GosiCase = (typeof GOSI_TREATMENT_CASES)[number];

type Share = "EMPLOYEE" | "EMPLOYER";
type Rule = {
  /** The decision action this case is recorded under. */
  action: "EMPLOYER_EXPENSE" | "EMPLOYEE_RECEIVABLE" | "EMPLOYEE_REFUND" | "PAYROLL_CORRECTION" | "INVOICE_DISPUTE";
  share: Share | null;
  /** +1: invoice above payroll; −1: below; 0: either. */
  sign: 1 | -1 | 0;
  /** Whether the case ever books an entry (5 and 6 never do: they link to what already booked it). */
  posting: boolean;
  /** The entry the draft PROPOSES (not approved; † = posting key not in the account map today). */
  proposed: string;
  /**
   * The only posting keys an enabling decision may name for this case (review rev8 P3): the
   * draft's proposed entry, as written. An empty side has no key named yet (2B's debit), so that
   * case cannot be enabled until the accountant names one (a code change, then this list).
   */
  keys: { debit: readonly string[]; credit: readonly string[] };
};

export const GOSI_CASE_RULES: Record<GosiCase, Rule> = {
  CASE_1_EMPLOYER_INVOICE_HIGHER: { action: "EMPLOYER_EXPENSE", share: "EMPLOYER", sign: 1, posting: true, proposed: "Dr EMPLOYER_CONTRIB_EXPENSE / Cr CONTRIB_PAYABLE", keys: { debit: ["EMPLOYER_CONTRIB_EXPENSE"], credit: ["CONTRIB_PAYABLE"] } },
  CASE_2A_EMPLOYEE_SHARE_RECOVER: { action: "EMPLOYEE_RECEIVABLE", share: "EMPLOYEE", sign: 1, posting: true, proposed: "Dr EMPLOYEE_RECEIVABLE† / Cr CONTRIB_PAYABLE", keys: { debit: ["EMPLOYEE_RECEIVABLE"], credit: ["CONTRIB_PAYABLE"] } },
  CASE_2B_EMPLOYEE_SHARE_EMPLOYER_BORNE: { action: "EMPLOYER_EXPENSE", share: "EMPLOYEE", sign: 1, posting: true, proposed: "Dr (employer-borne employee-share expense, to be named)† / Cr CONTRIB_PAYABLE", keys: { debit: [], credit: ["CONTRIB_PAYABLE"] } },
  CASE_3_EMPLOYER_INVOICE_LOWER: { action: "EMPLOYER_EXPENSE", share: "EMPLOYER", sign: -1, posting: true, proposed: "Dr CONTRIB_PAYABLE / Cr EMPLOYER_CONTRIB_EXPENSE", keys: { debit: ["CONTRIB_PAYABLE"], credit: ["EMPLOYER_CONTRIB_EXPENSE"] } },
  CASE_4_EMPLOYEE_SHARE_REFUND: { action: "EMPLOYEE_REFUND", share: "EMPLOYEE", sign: -1, posting: true, proposed: "Dr CONTRIB_PAYABLE / Cr EMPLOYEE_REFUND_PAYABLE†", keys: { debit: ["CONTRIB_PAYABLE"], credit: ["EMPLOYEE_REFUND_PAYABLE"] } },
  CASE_5_ALREADY_BOOKED: { action: "PAYROLL_CORRECTION", share: null, sign: 0, posting: false, proposed: "no entry: linked to the correction run that booked it", keys: { debit: [], credit: [] } },
  CASE_6_REGISTRATION_CORRECTED: { action: "INVOICE_DISPUTE", share: null, sign: 0, posting: false, proposed: "no entry: the corrected invoice clears it", keys: { debit: [], credit: [] } },
  CASE_7_ROUNDING: { action: "EMPLOYER_EXPENSE", share: null, sign: 0, posting: true, proposed: "Dr/Cr GOSI_ROUNDING† (or EMPLOYER_CONTRIB_EXPENSE) / Cr/Dr CONTRIB_PAYABLE; threshold not set (D-4d)", keys: { debit: ["GOSI_ROUNDING", "EMPLOYER_CONTRIB_EXPENSE"], credit: ["CONTRIB_PAYABLE"] } },
  CASE_8_DISPUTED: { action: "INVOICE_DISPUTE", share: null, sign: 0, posting: true, proposed: "no entry while disputed; if paid in full: Dr GOSI_DISPUTED_RECEIVABLE† / Cr CONTRIB_PAYABLE (reclass)", keys: { debit: ["GOSI_DISPUTED_RECEIVABLE"], credit: ["CONTRIB_PAYABLE"] } },
};

/** The legacy decision (no case named) as the case it has always meant. Null: it never books. */
export function defaultCase(action: string, share: Share, sign: number): GosiCase | null {
  if (action === "EMPLOYER_EXPENSE") return share === "EMPLOYER" ? (sign > 0 ? "CASE_1_EMPLOYER_INVOICE_HIGHER" : "CASE_3_EMPLOYER_INVOICE_LOWER") : sign > 0 ? "CASE_2B_EMPLOYEE_SHARE_EMPLOYER_BORNE" : null;
  if (action === "EMPLOYEE_RECEIVABLE") return "CASE_2A_EMPLOYEE_SHARE_RECOVER";
  if (action === "EMPLOYEE_REFUND") return "CASE_4_EMPLOYEE_SHARE_REFUND";
  if (action === "PAYROLL_CORRECTION") return "CASE_5_ALREADY_BOOKED";
  if (action === "INVOICE_DISPUTE") return "CASE_8_DISPUTED";
  return null;
}

/** Why `c` does not fit a difference of `share` and `sign` (or null when it fits). */
export function caseMismatch(c: GosiCase, action: string, share: Share, sign: number, differenceType: string | null): string | null {
  const r = GOSI_CASE_RULES[c];
  if (r.action !== action) return `${c} is recorded under the decision ${r.action}, not ${action}.`;
  if (r.share && r.share !== share) return `${c} is for the ${r.share.toLowerCase()} share.`;
  if (r.sign > 0 && sign <= 0) return `${c} is for an invoice above payroll (a positive difference).`;
  if (r.sign < 0 && sign >= 0) return `${c} is for an invoice below payroll (a negative difference).`;
  if (c === "CASE_7_ROUNDING" && differenceType !== "ROUNDING") return "CASE_7_ROUNDING applies only to a difference classified as ROUNDING (no rounding threshold is approved, D-4d).";
  return null;
}

/** The posting of a booked case: Dr / Cr of the absolute difference (rounding: sides follow the sign). */
export function caseLines(c: GosiCase, debitKey: string, creditKey: string, difference: number): { debit: string; credit: string } {
  if (c === "CASE_7_ROUNDING" && difference < 0) return { debit: creditKey, credit: debitKey };
  return { debit: debitKey, credit: creditKey };
}
