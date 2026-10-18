// Owner (RC3.1): "Payroll documents must not represent an unapproved or locked payroll run as an
// authorized payment." Pure (no database): the service, the payslip page and the tests share it.
//
//   · LOCKED payroll (payrollLive off): no payslip is produced at all — 409 PAYROLL_LOCKED
//     (action PAYSLIP, services/payroll.ts payslip()).
//   · Live payroll, run not APPROVED / PAID: the payslip is produced for review only and carries
//     NOT_AUTHORIZED_AR / NOT_AUTHORIZED_EN — both languages together, as a banner and a
//     watermark on every printed page — and its net is labelled as not payable.
export const AUTHORIZED_RUN_STATUSES = ["APPROVED", "PAID"] as const;

/** Is a run in this status an authorized payment? Only APPROVED or PAID. */
export const isAuthorizedPayment = (runStatus: string) => (AUTHORIZED_RUN_STATUSES as readonly string[]).includes(runStatus);

export const NOT_AUTHORIZED_AR = "ليست دفعة معتمدة — مسير الرواتب غير معتمد";
export const NOT_AUTHORIZED_EN = "NOT AN AUTHORIZED PAYMENT — PAYROLL UNAPPROVED";
export const NOT_AUTHORIZED_NET_AR = "الصافي (مسودة — غير مستحق الدفع)";
export const NOT_AUTHORIZED_NET_EN = "Net (draft — not payable)";

/**
 * The payroll CSV export (services/payroll.ts exportCsv). LOCKED: refused (409 PAYROLL_LOCKED,
 * BANK_FILE / PAYROLL_EXPORT). Live, run not APPROVED / PAID: the file's FIRST line is this
 * bilingual marker (before the column header), so the file is never read as a payment instruction.
 * Authorized runs: no marker (null).
 */
export const exportMarkerLine = (runStatus: string): string | null =>
  isAuthorizedPayment(runStatus) ? null : `${NOT_AUTHORIZED_EN} / ${NOT_AUTHORIZED_AR} (status: ${runStatus})`;
