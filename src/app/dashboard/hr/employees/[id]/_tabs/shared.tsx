"use client";
// HR-02 · Employee profile — shared types, labels and small helpers for the tab files.
import type { ReactNode } from "react";
import { HrApiError, hrFetch, type StatusEntry, dateTimeIn } from "@/components/hr/ui";
import type { Lang } from "@/lib/i18n/translations";

export type Person = {
  id: string; employeeNo: string; fullNameAr: string; fullNameEn: string | null; jobTitle: string; status: string; employmentType: string;
  hireDate: string; probationEndDate: string | null; separationDate: string | null; hasAccount: boolean;
  department: { id: string; nameAr: string; nameEn?: string | null } | null; branch: { id: string; code: string; nameAr: string | null; nameEn: string } | null; manager: { id: string; fullNameAr: string } | null;
  version: number; workPhone: string | null; workEmail: string | null; managerId: string | null; departmentId: string | null; branchId: string | null;
};
export type Perms = {
  edit: boolean; privateView: boolean; contracts: boolean; documents: boolean; documentsManage: boolean; leave: boolean; advances: boolean;
  assets: boolean; performance: boolean; offboard: boolean; attendance: boolean;
};
export type Contract = {
  id: string; contractNo: string; version: number; type: string; startDate: string; endDate: string | null; probationDays: number | null; noticeDays: number;
  status: string; supersedesId: string | null; notes: string | null; activatedAt: string | null; endedAt: string | null; endReason: string | null;
};
export type Comp = { id: string; effectiveFrom: string; effectiveTo: string | null; basic: string; housing: string; transport: string; otherAllowance: string; total: string; reason: string };
export type Doc = { id: string; category: string; title: string; fileName: string; mimeType: string; sizeBytes: number; confidential: boolean; expiresOn: string | null; createdAt: string };
export type AssetRow = { id: string; tag: string; name: string; category: string; assignedOn: string; returnedOn: string | null };
export type Reminder = { kind: string; employeeId: string; employeeName: string; date: string; message: string };
export type Profile = {
  person: Person;
  permissions: Perms;
  currentContract: { contractNo: string; type: string; startDate: string; endDate: string | null; noticeDays: number } | null;
  contracts?: Contract[];
  compensation?: Comp[];
  documents?: Doc[];
  assets?: AssetRow[];
  reminders: Reminder[];
  /** Directory preview facts; each key exists only for a caller holding its duty (server-side). */
  snapshot?: {
    shift?: { name: string; startTime: string; endTime: string } | null;
    leave?: { code: string; nameAr: string; available: string } | null;
    upcomingLeave?: { startDate: string; endDate: string; days: string; type: string; typeCode?: string } | null;
    advance?: { advanceNo: string; status: string } | null;
  };
};
export type TabProps = { id: string; profile: Profile; readOnly: boolean; reload: () => void };

export type Balance = { leaveTypeId: string; code: string; nameAr: string; paid: boolean; tracksBalance: boolean; isProposal: boolean; balance: string; pending: string; available: string };
export type AdvanceRow = {
  id: string; advanceNo: string; amount: string; installmentCount: number; firstInstallmentMonth: string; reason: string | null; status: string;
  outstanding: string; reserved: string; settled: string; repaid: string; createdAt: string; employee: { id: string; fullNameAr: string; employeeNo: string };
};

// ── Labels ─────────────────────────────────────────────────────────────────────────

/** Bilingual labels: [Arabic, English]. Read with `lbl(map, code, lang)`. */
export type Labels = Record<string, [string, string]>;
export const lbl = (map: Labels, code: string, lang: Lang) => (map[code] ? map[code][lang === "en" ? 1 : 0] : code);

export const CONTRACT_TYPE: Labels = { FIXED_TERM: ["محدد المدة", "Fixed term"], OPEN_ENDED: ["غير محدد المدة", "Open-ended"] };
export const EMPLOYMENT_TYPE: Labels = { FULL_TIME: ["دوام كامل", "Full time"], PART_TIME: ["دوام جزئي", "Part time"], TEMPORARY: ["مؤقت", "Temporary"] };
export const DOC_CATEGORY: Labels = { CONTRACT: ["عقد", "Contract"], IDENTITY: ["هوية", "Identity"], CERTIFICATE: ["شهادة", "Certificate"], MEDICAL: ["طبي", "Medical"], OTHER: ["أخرى", "Other"] };
export const SEPARATION_TYPE: Labels = { RESIGNATION: ["استقالة", "Resignation"], TERMINATION: ["إنهاء من صاحب العمل", "Termination by the employer"], END_OF_CONTRACT: ["انتهاء العقد", "End of contract"], OTHER: ["أخرى", "Other"] };
export const INCIDENT_CATEGORY: Labels = { WARNING: ["إنذار", "Warning"], MISCONDUCT: ["مخالفة سلوك", "Misconduct"], SAFETY: ["سلامة", "Safety"], ATTENDANCE: ["حضور", "Attendance"], OTHER: ["أخرى", "Other"] };
export const TRAINING_STATUS: Record<string, StatusEntry> = { PLANNED: ["مخطط", "info", "Planned"], COMPLETED: ["مكتمل", "success", "Completed"], CANCELLED: ["ملغى", "cancelled", "Cancelled"] };
export const REVIEW_STATUS: Record<string, StatusEntry> = { DRAFT: ["مسودة", "neutral", "Draft"], SUBMITTED: ["مُرسل", "info", "Submitted"], ACKNOWLEDGED: ["اطّلع عليه الموظف", "success", "Acknowledged by the employee"] };
export const LEDGER_ENTRY: Labels = { OPENING: ["رصيد افتتاحي", "Opening balance"], ACCRUAL: ["استحقاق شهري", "Monthly accrual"], GRANT: ["منح", "Grant"], TAKE: ["إجازة مأخوذة", "Leave taken"], REVERSAL: ["عكس قيد", "Reversal"], ADJUSTMENT: ["تسوية", "Adjustment"] };
export const AUDIT_ACTION: Labels = {
  PERSON_CREATE: ["إنشاء الملف", "File created"], PERSON_UPDATE: ["تعديل البيانات", "Details edited"], STATUS_CHANGE: ["تغيير الحالة", "Status changed"], ACCOUNT_LINK: ["ربط حساب الدخول", "Login account linked"], ACCOUNT_UNLINK: ["فك ربط حساب الدخول", "Login account unlinked"],
  PRIVATE_VIEW: ["عرض البيانات الخاصة", "Private data viewed"], PRIVATE_VIEW_SELF: ["عرض الموظف لبياناته الخاصة", "Employee viewed own private data"], PRIVATE_UPDATE: ["تعديل البيانات الخاصة", "Private data edited"],
  CONTRACT_CREATE: ["إنشاء عقد", "Contract created"], CONTRACT_ACTIVATE: ["تفعيل عقد", "Contract activated"], CONTRACT_END: ["إنهاء عقد", "Contract ended"], COMPENSATION_ADD: ["نسخة راتب جديدة", "New pay version"],
  DOCUMENT_UPLOAD: ["رفع مستند", "Document uploaded"], DOCUMENT_DOWNLOAD: ["تنزيل مستند", "Document downloaded"], DOCUMENT_REMOVE: ["حذف مستند", "Document removed"],
  LEAVE_OPENING: ["رصيد إجازة افتتاحي", "Opening leave balance"], LEAVE_GRANT: ["منح رصيد إجازة", "Leave balance granted"], LEAVE_ADJUSTMENT: ["تسوية رصيد إجازة", "Leave balance adjusted"], LEAVE_REQUEST: ["طلب إجازة", "Leave requested"], LEAVE_APPROVE: ["اعتماد إجازة", "Leave approved"], LEAVE_REJECT: ["رفض إجازة", "Leave rejected"], LEAVE_CANCEL: ["إلغاء إجازة", "Leave cancelled"], LEAVE_WITHDRAW: ["سحب طلب إجازة", "Leave request withdrawn"],
  SHIFT_ASSIGN: ["تعيين وردية", "Shift assigned"], CHECK_IN: ["تسجيل حضور", "Check-in"], CHECK_OUT: ["تسجيل انصراف", "Check-out"], MANUAL_DAY: ["يوم حضور يدوي", "Manual attendance day"], MARK_ABSENT: ["تسجيل غياب", "Absence recorded"],
  CORRECTION_REQUEST: ["طلب تصحيح حضور", "Attendance correction requested"], CORRECTION_APPROVE: ["اعتماد تصحيح حضور", "Attendance correction approved"], CORRECTION_REJECT: ["رفض تصحيح حضور", "Attendance correction rejected"], OVERTIME_REQUEST: ["طلب عمل إضافي", "Overtime requested"], OVERTIME_APPROVE: ["اعتماد عمل إضافي", "Overtime approved"], OVERTIME_REJECT: ["رفض عمل إضافي", "Overtime rejected"],
  ADVANCE_REQUEST: ["طلب سلفة", "Advance requested"], ADVANCE_APPROVE: ["اعتماد سلفة", "Advance approved"], ADVANCE_REJECT: ["رفض سلفة", "Advance rejected"], ADVANCE_DISBURSE: ["صرف سلفة", "Advance paid out"], ADVANCE_REPAYMENT: ["سداد سلفة", "Advance repayment"], ADVANCE_CLOSE: ["إغلاق سلفة", "Advance closed"], ADVANCE_CANCEL: ["إلغاء سلفة", "Advance cancelled"],
  ASSET_ASSIGN: ["تسليم عهدة", "Asset handed over"], ASSET_RETURN: ["استلام عهدة", "Asset returned"], TRAINING_ADD: ["إضافة تدريب", "Training added"], REVIEW_SUBMIT: ["تقييم أداء", "Performance review"], REVIEW_ACKNOWLEDGE: ["اطّلاع على تقييم", "Review acknowledged"], INCIDENT_ADD: ["تسجيل مخالفة", "Incident recorded"],
  SEPARATION_INITIATE: ["بدء إنهاء الخدمة", "End of service started"], SETTLEMENT_RECORD: ["تسجيل التسوية النهائية", "Final settlement recorded"], SEPARATION_COMPLETE: ["إتمام إنهاء الخدمة", "End of service completed"], SEPARATION_CANCEL: ["إلغاء إنهاء الخدمة", "End of service cancelled"],
  APPLICANT_HIRE: ["تعيين من التوظيف", "Hired from recruitment"], PAYROLL_ADJUSTMENT: ["تعديل في مسير رواتب", "Payroll adjustment"],
};

// ── Helpers ────────────────────────────────────────────────────────────────────────

export const daysUntil = (iso: string) => Math.round((Date.parse(iso) - Date.parse(new Date().toISOString().slice(0, 10))) / 86400000);

export function fmtDateTime(v: string | null | undefined) {
  if (!v) return "—";
  if (Number.isNaN(new Date(v).getTime())) return v;
  return dateTimeIn(v);
}

export const fileSize = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

/** ≤2 decimals, non-negative. Empty is allowed (callers decide whether it is required). */
export const isAmount = (v: string) => v === "" || /^\d+(\.\d{1,2})?$/.test(v.trim());

/** A mutation that turns the API's optimistic-lock refusal into a clear instruction (page language). */
export async function mutate<T = unknown>(url: string, init?: { method?: string; json?: unknown; form?: FormData }): Promise<T> {
  try {
    return await hrFetch<T>(url, init);
  } catch (e) {
    if (e instanceof HrApiError && e.code === "STALE") throw new Error(typeof document !== "undefined" && document.documentElement.lang === "en" ? "Someone else changed this record after you opened it. Reload the page and make the change again." : "غيّر شخص آخر هذا السجل بعد أن فتحته. أعد تحميل الصفحة ثم أعد التعديل.");
    throw e;
  }
}

export function SectionHead({ title, actions, id }: { title: ReactNode; actions?: ReactNode; id?: string }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
      <h2 className="hr-section" id={id}>{title}</h2>
      {actions ? <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>{actions}</div> : null}
    </div>
  );
}

export function Check({ checked, onChange, children }: { checked: boolean; onChange: (v: boolean) => void; children: ReactNode }) {
  return (
    <label className="hr-label" style={{ display: "inline-flex", gap: 8, alignItems: "center", cursor: "pointer" }}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {children}
    </label>
  );
}
