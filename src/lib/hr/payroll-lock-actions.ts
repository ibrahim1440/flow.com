// Phase 1 payroll lock — the action codes and the refusal wording (pure; no database). The
// enforcement, and the full refused / allowed list with endpoints, is in ./payroll-lock.ts.
export const PAYROLL_LOCKED = "PAYROLL_LOCKED";

export const LOCKED_ACTIONS = [
  "RUN_SUBMIT", "RUN_APPROVE", "RUN_CANCEL_APPROVED", "PAYMENT_RECORD", "PAYMENT_PROOF", "PAYMENT_BANK_RESULTS", "PAYMENT_RETURN", "BANK_FILE",
  "SETTLEMENT_POST", "SETTLEMENT_PAY", "GOSI_PAY", "GOSI_BOOK", "PROVISION_ENTRY", "PROVISION_SHORTFALL",
  "ADVANCE_DISBURSE", "ADVANCE_REPAY", "POLICY_ACTIVATE",
  // Outside the HR module (independent review F1 / F2): a general-ledger journal on a payroll
  // account, and a commission payout (employee pay recorded as paid; owner-adjustable scope).
  "GL_PAYROLL_JOURNAL", "COMMISSION_PAYOUT",
  // Re-review R1: an HR posting key already mapped is never remapped while locked (mapping a key not
  // yet mapped stays allowed — it only adds protection).
  "ACCOUNT_REMAP",
  // Owner (RC3.1): "Payroll documents must not represent an unapproved or locked payroll run as
  // an authorized payment." While locked, no payslip is generated (screen or print), for anyone.
  "PAYSLIP",
  // Independent review (payroll-doc guard, fix 1): no payroll CSV export of any variant while
  // locked — the IBAN variant stays BANK_FILE, every other variant is PAYROLL_EXPORT.
  "PAYROLL_EXPORT",
] as const;
export type LockedAction = (typeof LOCKED_ACTIONS)[number];

export function payrollLockedMessage(action: LockedAction): string {
  return `Payroll is locked: live payroll has not been switched on, so this action (${action}) is refused. Viewing stays available.`;
}
