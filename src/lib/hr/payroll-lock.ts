// Phase 1 PAYROLL LOCK (decision C GAP-9 subset; migration 20261017215000_hr_payroll_lock).
//
// Live payroll (HrSettings.payrollLive) is OFF by default. While it is off every action that moves
// money or posts a journal is refused (409 PAYROLL_LOCKED) for everyone — administrators and
// accounts on role defaults included — after the action's own permission check (an account without
// the duty still gets 403). The setting is read on every call, never cached. The database refuses
// the same writes (hr_payroll_lock_guard), whoever writes them. Table: docs/hr/PAYROLL-LOCK.md.
//
// REFUSED while locked (action code → service → endpoint):
//   RUN_SUBMIT            payroll.submitRun            POST /api/hr/payroll/runs/:id/submit
//   RUN_APPROVE           payroll.approveLines         POST /api/hr/payroll/runs/:id/approve   (posts the accrual; correction runs too)
//   RUN_CANCEL_APPROVED   payroll.cancelRun (APPROVED) POST /api/hr/payroll/runs/:id/cancel    (posts the reversal)
//   PAYMENT_RECORD        payroll.recordPayment        POST /api/hr/payroll/runs/:id/payments
//   PAYMENT_PROOF         payroll.confirmAllocations   POST /api/hr/payroll/runs/:id/payments/allocations
//   PAYMENT_BANK_RESULTS  payroll.importBankResults    POST /api/hr/payroll/runs/:id/payments/bank-results
//   PAYMENT_RETURN        payroll.recordPaymentReturn  POST /api/hr/payroll/runs/:id/payments/returns
//   BANK_FILE             payroll.exportCsv (IBANs)    GET  /api/hr/payroll/runs/:id/export (with private_view)
//   PAYROLL_EXPORT        payroll.exportCsv (no IBANs) GET  /api/hr/payroll/runs/:id/export (without private_view)
//   PAYSLIP               payroll.payslip              GET  /api/hr/payroll/payslips/:id, /api/hr/me/payslips/:id
//   SETTLEMENT_POST       finalSettlement.postSettlement POST /api/hr/final-settlements/:id/post
//   SETTLEMENT_PAY        finalSettlement.paySettlement  POST /api/hr/final-settlements/:id/pay
//   GOSI_PAY              gosi.payGosiInvoice          POST /api/hr/payroll/gosi/:id/lifecycle/pay
//   GOSI_BOOK             gosi booking under a treatment POST /api/hr/payroll/gosi/settlements/:id/book (and a booking decide)
//   PROVISION_ENTRY       provisions.request/decideProvisionEntry   POST /api/hr/provisions, /api/hr/provisions/:id/decide
//   PROVISION_SHORTFALL   provisions.request/decideProvisionShortfall POST /api/hr/final-settlements/:id/shortfall, /api/hr/provisions/shortfalls/:id/decide
//   ADVANCE_DISBURSE      advances.disburseAdvance     POST /api/hr/advances/:id/disburse
//   ADVANCE_REPAY         advances.repayAdvance        POST /api/hr/advances/:id/repay
//   POLICY_ACTIVATE       policy.activatePolicy        POST /api/hr/policy/:id/activate
//   GL_PAYROLL_JOURNAL    accounting journal-service   POST /api/accounting/journals, PATCH …/:id/{submit,approve,post,reverse}
//                         — any journal with a line on a PAYROLL ACCOUNT (the HR posting map, PAYROLL_CASH
//                         excepted: payrollAccountIds) or of the HR module (sourceModule 'hr')
//   COMMISSION_PAYOUT     commissions review action    POST /api/commissions/review/actions {action:"payout"}
//   ACCOUNT_REMAP         config-change ACCOUNT_MAP_SET of a key ALREADY mapped (request and approval)
//                         POST /api/hr/policy/accounts, /api/hr/config-changes/:id/decide — the DB refuses any HrAccountMap
//                         remap / delete too. Mapping a key not yet mapped stays allowed.
// ALLOWED while locked: every read-only view; dry preparation (prepare / rebuild a DRAFT run, its
// adjustments, return to draft, cancelling a DRAFT / REVIEW run); people, contracts, leave,
// attendance, overtime, advance requests and decisions; policy DRAFTS; separations; the final
// settlement's preparation, calculation, review and approval (they post nothing); GOSI invoice
// entry, reconciliation and approval; settings changes (two people).
import { prisma } from "@/lib/db";
import { HrError, type Db } from "./core";
import { toArabic } from "./messages-ar";

import { PAYROLL_LOCKED, payrollLockedMessage, type LockedAction } from "./payroll-lock-actions";
export { PAYROLL_LOCKED, LOCKED_ACTIONS, payrollLockedMessage, type LockedAction } from "./payroll-lock-actions";

/**
 * Read every time (no cache): is live payroll on? FAIL-CLOSED (owner decisions A-7 / A-8): a missing
 * settings row, a missing column, a read error or any value other than exactly `true` is LOCKED.
 */
export async function isPayrollLive(db: Db = prisma): Promise<boolean> {
  try {
    const s = await db.hrSettings.findUnique({ where: { id: "singleton" }, select: { payrollLive: true } });
    return s?.payrollLive === true;
  } catch {
    return false;
  }
}

/** Refuse a money / posting action while live payroll is off (409 PAYROLL_LOCKED). */
export async function assertPayrollLive(action: LockedAction, db: Db = prisma): Promise<void> {
  if (!(await isPayrollLive(db))) throw new HrError(payrollLockedMessage(action), 409, PAYROLL_LOCKED);
}

/** The refusal as the generic (non-HR) API layers return it: Arabic `error`, English `errorEn`, the code. */
export function payrollLockedRefusal(action: LockedAction): { _appCode: 409; message: string; errorEn: string; code: typeof PAYROLL_LOCKED } {
  const en = payrollLockedMessage(action);
  return { _appCode: 409, message: toArabic(en) ?? en, errorEn: en, code: PAYROLL_LOCKED };
}

/**
 * The PAYROLL ACCOUNTS of the general ledger while payroll is locked: every account mapped in the HR
 * posting map (HrAccountMap: salary / allowance / overtime / commission / employer-contribution
 * expense, salaries / contributions / other-deductions / final-settlement payables, employee
 * advances, EOS and leave provisions and expenses) except PAYROLL_CASH — normally the operating
 * bank account; every payroll posting carries a payroll-side line, which is refused. The database
 * applies the same set (hr_is_payroll_account). Derived from the map, never hard-coded: an account
 * mapped later is protected from the moment it is mapped.
 *
 * STICKY (re-review R1): an account EVER mapped under a payroll key stays a payroll account — the
 * database records every mapping in HrPayrollAccount (append-only), so remapping a key away from an
 * account never opens that account to manual payroll postings again.
 */
export async function payrollAccountIds(db: Db, accountIds: string[]): Promise<string[]> {
  if (!accountIds.length) return [];
  // Sequential: `db` may be an interactive transaction.
  const now = await db.hrAccountMap.findMany({ where: { accountId: { in: accountIds }, key: { not: "PAYROLL_CASH" } }, select: { accountId: true } });
  const ever = await db.hrPayrollAccount.findMany({ where: { accountId: { in: accountIds }, key: { not: "PAYROLL_CASH" } }, select: { accountId: true } });
  return [...new Set([...now, ...ever].map((r) => r.accountId))];
}
