// Payroll pages — shared DTO types and bilingual labels (kept beside the pages; the API's
// shapes live in src/lib/hr/services/payroll.ts).
import { money, type StatusEntry } from "@/components/hr/ui";
import type { Lang } from "@/lib/i18n/translations";
import { hrText } from "@/lib/hr/messages-en";

export type RunRow = {
  id: string; runNo: number; periodMonth: string; branchKey: string; kind: "REGULAR" | "CORRECTION"; status: string;
  totalGross: string; totalDeductions: string; totalNet: string; lines: number; preparedAt: string;
};

export type PayItem = { code: string; kind: "EARNING" | "DEDUCTION" | "EMPLOYER"; amount: string; quantity: string | null; description: string };
export type PayException = { code: string; severity: "BLOCKING" | "WARNING" | "INFO"; message: string };

/** Read from the line's stored calculation snapshot (never recomputed in the browser). */
export type DayDetail = {
  payable: string; basis: number; employed: number; unpaid: number; employedFrom: string | null; employedTo: string | null;
  /** P-2 rev3 item 6 (lines built since): each figure in one unit — calendar days, or pay units of the basis. */
  calendarServiceDays?: number; unpaidCalendarDays?: number; unpaidDeductedUnits?: number; payUnits?: number; payslipDays?: number;
  status?: "PAYABLE" | "BLOCKED_FULL_UNPAID" | "FULL_UNPAID";
};

/** P-2 rev3 item 6: a whole period of unpaid leave — the line shows no payable days and no payable amount. */
export const fullUnpaid = (d: DayDetail | null | undefined) => d?.status === "BLOCKED_FULL_UNPAID" || d?.status === "FULL_UNPAID";

/**
 * P-2 rev3 item 6: the day rows of a line or payslip, one unit per row (calendar days, or pay units
 * of the month basis), never one figure mixing them. [label, value, tone].
 */
/** Arabic counted noun: 1 and 2 by the dual-free forms, 3–10 the plural, 11+ the singular («5 وحدات», «12 وحدة»). */
function arCount(n: number, one: string, few: string): string {
  const k = Math.abs(n) % 100;
  return `${n} ${k >= 3 && k <= 10 ? few : one}`;
}
export function dayRows(d: DayDetail, lang: Lang = "ar"): [string, string, "warning" | undefined][] {
  const en = lang === "en";
  const range = d.employedFrom ? ` · ${d.employedFrom} → ${d.employedTo}` : "";
  if (typeof d.calendarServiceDays !== "number") {
    return [
      [en ? "Month basis" : "أساس الشهر", `${d.basis} ${en ? "days" : "يومًا"}`, undefined],
      [en ? "Employed" : "على رأس العمل", `${d.employed} ${en ? "days" : "يومًا"}${range}`, undefined],
      [en ? "Unpaid leave" : "إجازة بدون راتب", `${d.unpaid} ${en ? "days" : "يومًا"}`, d.unpaid ? "warning" : undefined],
      [en ? "Payable" : "المستحق", `${Number(d.payable)} ${en ? "days" : "يومًا"}`, undefined],
    ];
  }
  const blocked = fullUnpaid(d);
  return [
    [en ? "Service (calendar days)" : "أيام الخدمة (تقويمية)", `${d.calendarServiceDays}${range}`, undefined],
    [en ? "Unpaid leave in service (calendar days)" : "إجازة بدون راتب ضمن الخدمة (أيام تقويمية)", String(d.unpaidCalendarDays ?? 0), d.unpaidCalendarDays ? "warning" : undefined],
    [en ? "Units deducted for unpaid leave (one per unpaid working day; rule D-2a open)" : "وحدات خُصمت للإجازة بدون راتب (وحدة لكل يوم عمل؛ القاعدة D-2a مفتوحة)", String(d.unpaidDeductedUnits ?? 0), undefined],
    [en ? "Pay units" : "وحدات الأجر", `${d.payUnits} ${en ? "of" : "من"} ${d.basis}`, undefined],
    [en ? "On the payslip" : "في القسيمة", blocked ? (en ? "0 — the whole period is unpaid leave: nothing is payable (blocked)" : "0 — الفترة كلها إجازة بدون راتب: لا مستحق (محجوب)") : `${d.payslipDays} ${en ? "of" : "من"} ${d.basis}`, blocked ? "warning" : undefined],
  ];
}

/** P-2 rev3 item 2: what the bank proved for this line (APPROVED / PAID runs only). */
export type LineSettlement = { status: "NONE_DUE" | "UNPAID" | "PARTIAL" | "PAID" | "RETURNED"; allocated: string; returned: string; rejected: string; settled: string; outstanding: string };

export type RunLine = {
  id: string; employee: { id: string; employeeNo: string; fullNameAr: string }; isMine: boolean;
  payableDays: string; dayDetail: DayDetail | null; gross: string; deductions: string; net: string; employer: string;
  settlement?: LineSettlement | null;
  exceptions: PayException[] | null; blocking: boolean; approvedBy: string | null; approvedByName: string | null; approvedAt: string | null;
  items: PayItem[];
};

export type RunDetail = {
  id: string; runNo: number; periodMonth: string; periodStart: string; periodEnd: string; branchKey: string; kind: "REGULAR" | "CORRECTION"; correctsRunId: string | null;
  status: string; preparedBy: string; preparedByName: string | null; preparedAt: string; submittedAt: string | null; approvedAt: string | null; paidAt: string | null;
  cancelledAt: string | null; cancelReason: string | null; accountingSkipped: boolean;
  policy: { id: string; version: number; dayBasis: string; isProposal: boolean };
  totals: { gross: string; deductions: string; net: string; employer: string; paid: string; unpaid: string };
  payments: {
    id: string; amount: string; paidOn: string; method: string; reference: string; lineId?: string | null;
    allocated?: string; rejected?: string; unallocated?: string;
    allocations?: { id: string; lineId: string; amount: string; bankReference: string; payeeAccountLast4: string | null; source: string; confirmedOn: string }[];
  }[];
  returns?: { id: string; kind: "RETURNED" | "REJECTED"; paymentId: string; allocationId: string | null; lineId: string; amount: string; bankReference: string; reason: string; returnedOn: string }[];
  bankImports?: { id: string; paymentId: string; fileName: string; sha256: string; rows: number; at: string }[];
  /** P-2 rev3 item 2: the run is PAID only when this is complete. */
  proof?: { complete: boolean; unsettledLines: number; unallocated: string; returned: string };
  /** Whether the actor may record per-employee proof or a return (APPROVED / PAID), or why not. */
  canProve?: boolean;
  journals: { purpose: string; journalEntryId: string; entryNo: string | number; status: string; amount: string; date: string }[];
  /** What the accrual will post on final approval (DRAFT/REVIEW, nothing posted yet). */
  journalPreview: { lines: { key: string; side: "D" | "C"; amount: string; account: { code: string; nameAr: string | null; nameEn?: string | null } | null }[]; debit: string; credit: string } | null;
  canApprove: boolean;
  /** P-3: why the actor may not approve or record payment (they prepared the run), or null. */
  approveBlock: string | null;
  reconciliation: { ok: boolean; checkedLines: number; mismatches: { scope: string; lineId: string | null; label: string | null; check: string; expected: string; actual: string; differenceHalalas: number }[] } | null;
  canPay: boolean;
  payBlock: string | null;
  /** Q-2: cancelling an APPROVED run — only the separate duty, never a preparer or approver. */
  canCancelApproved: boolean;
  cancelBlock: string | null;
  /** P-2 review P2-B7: advances of the run's people escalated for repeated deferral (acknowledged on submit). */
  escalations?: { reviewItemId: string; advanceNo: string; deferralCount: number }[];
  lines: RunLine[];
};

/** P-2 review P1-B2: the closed list of adjustment categories, by kind (server: src/lib/hr/adjustment-categories.ts). */
export const ADJUSTMENT_CATEGORY: Record<"EARNING" | "DEDUCTION", [string, string, string][]> = {
  EARNING: [
    ["OVERTIME_CORRECTION", "تصحيح عمل إضافي", "Overtime correction"],
    ["ALLOWANCE_CORRECTION", "تصحيح بدل", "Allowance correction"],
    ["SALARY_ARREARS", "فروقات راتب متأخرة", "Salary arrears"],
    ["APPROVED_BONUS", "مكافأة معتمدة", "Approved bonus"],
    ["OTHER_WITH_MEMO", "أخرى (بمذكرة)", "Other (with memo)"],
    // P-2 rev3 item 5: dues of an earlier period (document + period; attested for a separating person).
    ["PRIOR_PERIOD_ARREARS", "مستحقات فترة سابقة", "Prior-period arrears"],
    ["COMMISSION_TRUE_UP", "تسوية عمولة فترة سابقة", "Commission true-up (earlier period)"],
  ],
  DEDUCTION: [
    ["CONSENTED_DEDUCTION", "خصم بموافقة الموظف", "Consented deduction"],
    ["COURT_ORDER_DEDUCTION", "خصم بأمر قضائي", "Court-order deduction"],
    ["DAMAGE_DEDUCTION", "خصم إتلاف", "Damage deduction"],
    ["OTHER_WITH_MEMO", "أخرى (بمذكرة)", "Other (with memo)"],
  ],
};

export type ApproveResult = RunDetail & { approvedNow: number; skippedOwn: number; finalized: boolean; journalEntryId: string | null };

export const ITEM_LABEL: Record<string, [string, string]> = {
  BASIC: ["الراتب الأساسي", "Basic salary"],
  HOUSING: ["بدل السكن", "Housing allowance"],
  TRANSPORT: ["بدل النقل", "Transport allowance"],
  OTHER_ALLOWANCE: ["بدلات أخرى", "Other allowances"],
  OVERTIME: ["عمل إضافي", "Overtime"],
  COMMISSION: ["عمولة", "Commission"],
  ADJUSTMENT_EARNING: ["تسوية · إضافة", "Adjustment · earning"],
  UNPAID_LEAVE: ["إجازة بدون راتب", "Unpaid leave"],
  ADVANCE_INSTALLMENT: ["قسط سلفة", "Advance instalment"],
  ADJUSTMENT_DEDUCTION: ["تسوية · خصم", "Adjustment · deduction"],
};
const pick = (pair: [string, string], lang: Lang) => pair[lang === "en" ? 1 : 0];
export const itemLabel = (code: string, lang: Lang = "ar") =>
  ITEM_LABEL[code] ? pick(ITEM_LABEL[code], lang) : code.startsWith("CONTRIB_EE:") ? pick(["اشتراك · حصة الموظف", "Contribution · employee share"], lang) : code.startsWith("CONTRIB_ER:") ? pick(["اشتراك · حصة صاحب العمل", "Contribution · employer share"], lang) : code;

/** The item's description under its label, without repeating the label («(30/30)», not «Basic salary (30/30)»). */
export const itemNote = (i: Pick<PayItem, "code" | "description">, lang: Lang = "ar") => {
  if (!i.description) return null;
  const text = hrText(i.description, lang);
  const lab = itemLabel(i.code, lang);
  if (text === lab) return null;
  return text.startsWith(`${lab} `) ? text.slice(lab.length + 1) : text;
};

export const ALLOWANCE_CODES = ["HOUSING", "TRANSPORT", "OTHER_ALLOWANCE"];

/** Sum of the line's items whose code is one of `codes`. */
export const sumCodes = (items: PayItem[], codes: string[]) => items.filter((i) => codes.includes(i.code)).reduce((s, i) => s + Number(i.amount), 0);
/** A component that does not apply to the line reads «—», as in the approved HR-03 table. */
export const dash = (n: number) => (n === 0 ? "—" : money(n));

/** P-2 rev3 item 2: per-line settlement status (what the bank proved). */
export const SETTLEMENT_STATUS: Record<string, StatusEntry> = {
  NONE_DUE: ["لا مستحق", "neutral", "Nothing due"], UNPAID: ["غير مصروف", "neutral", "Unpaid"], PARTIAL: ["مصروف جزئيًا", "warning", "Partly paid"], PAID: ["مصروف بإثبات", "success", "Paid with proof"], RETURNED: ["مرتجع / مرفوض", "danger", "Returned / rejected"],
};

export const METHOD_LABEL: Record<string, [string, string]> = { BANK_TRANSFER: ["تحويل بنكي", "Bank transfer"], CASH: ["نقدًا", "Cash"], CHEQUE: ["شيك", "Cheque"] };
export const KIND_LABEL: Record<string, [string, string]> = { REGULAR: ["عادي", "Regular"], CORRECTION: ["تصحيح", "Correction"] };
export const label = (map: Record<string, [string, string]>, code: string, lang: Lang = "ar") => (map[code] ? pick(map[code], lang) : code);
export const JOURNAL_STATUS: Record<string, [string, string]> = { DRAFT: ["مسودة", "Draft"], SUBMITTED: ["مُرسل", "Submitted"], APPROVED: ["معتمد", "Approved"], POSTED: ["مُرحَّل", "Posted"], REVERSED: ["معكوس", "Reversed"] };
export const JOURNAL_PURPOSE = (p: string, lang: Lang = "ar") => (p === "ACCRUAL" ? pick(["قيد الاستحقاق", "Accrual entry"], lang) : p === "REVERSAL" ? pick(["قيد عكس الاستحقاق", "Accrual reversal entry"], lang) : p.startsWith("PAYMENT") ? pick(["قيد تسجيل الصرف", "Payment entry"], lang) : p.startsWith("RETURN") ? pick(["قيد مبلغ مرتجع", "Returned credit entry"], lang) : p);

export const day = (iso: string | null | undefined) => (iso ? String(iso).slice(0, 10) : "—");
export const thisMonth = () => new Date().toISOString().slice(0, 7);

/**
 * Day count display (HR-03 baseline): «28 من 30» = payable days of the month basis, with what
 * explains a shortfall — approved unpaid leave, or service for part of the month (joined after
 * the 1st / left before the end). `short` is the compact-width wording of the second.
 */
export function dayParts(l: Pick<RunLine, "payableDays" | "dayDetail">, period: { start: string; end: string }, lang: Lang = "ar") {
  const d = l.dayDetail;
  const payable = String(Number(l.payableDays));
  if (!d) return { main: payable, basis: null as number | null, note: null as string | null, short: null as string | null, tone: null as "warning" | null };
  let note: string | null = null, short: string | null = null, tone: "warning" | null = null;
  // P-2 rev3 item 6: a whole period of unpaid leave shows 0, blocked — never the 30-day units left over.
  if (fullUnpaid(d)) return { main: "0", basis: d.basis, note: lang === "en" ? "whole period unpaid · blocked" : "الفترة كلها بلا راتب · محجوب", short: lang === "en" ? "Blocked" : "محجوب", tone: "warning" as const };
  if (typeof d.unpaidCalendarDays === "number" && d.unpaidCalendarDays > 0) { note = lang === "en" ? `${d.unpaidCalendarDays} calendar days unpaid · ${d.unpaidDeductedUnits} units deducted` : `${arCount(d.unpaidCalendarDays, "يوم", "أيام")} بلا راتب · خُصمت ${arCount(Number(d.unpaidDeductedUnits ?? 0), "وحدة", "وحدات")}`; short = lang === "en" ? `${d.unpaidCalendarDays} unpaid` : `${d.unpaidCalendarDays} بلا راتب`; tone = "warning"; }
  else if (d.unpaid > 0) { note = short = lang === "en" ? `${d.unpaid} unpaid` : `${d.unpaid} بلا راتب`; tone = "warning"; }
  // A partial month by the CALENDAR (joined after the 1st / left before the end) — also when the
  // 30-day rule still pays 30 units (left on the 30th of a 31-day month).
  else if (d.employed < d.basis || (d.employedFrom && d.employedFrom > period.start) || (d.employedTo && d.employedTo < period.end)) {
    short = lang === "en" ? "Partial month" : "خدمة جزئية";
    note = d.employedTo && d.employedTo < period.end ? (lang === "en" ? `until ${d.employedTo}` : `حتى ${d.employedTo}`) : d.employedFrom && d.employedFrom > period.start ? (lang === "en" ? `from ${d.employedFrom}` : `من ${d.employedFrom}`) : short;
  }
  return { main: payable, basis: d.basis, note, short, tone };
}
