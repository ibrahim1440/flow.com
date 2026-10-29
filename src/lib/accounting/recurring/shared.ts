// «المعاملات المتكررة» — what the services, the routes, the widget and the screens share. Pure.

export const KINDS = ["JOURNAL", "SALES_INVOICE"] as const;
export type RecurringKind = (typeof KINDS)[number];
export const SOURCE_TYPES = ["TEMPLATE", "JOURNAL", "SALES_INVOICE"] as const;
export type RecurringSourceType = (typeof SOURCE_TYPES)[number];
export const STATUSES = ["ACTIVE", "PAUSED", "COMPLETED", "CANCELLED"] as const;
export type RecurringStatus = (typeof STATUSES)[number];
export const RUN_STATUSES = ["CREATED", "POSTED", "SKIPPED", "FAILED"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

/**
 * The kinds Qoyod's widget names and whether this build makes them. PURCHASE_INVOICE and SIMPLE_BILL are phase 2:
 * the purchase invoice service has no request key (a retry is recognised only by a 15-minute same-user heuristic), and
 * each bill carries the SUPPLIER'S own tax-invoice number (unique per supplier, and the basis of the input-VAT claim),
 * which a schedule cannot know in advance — so a run could neither be made idempotent nor be a valid bill.
 */
export const WIDGET_KINDS = [
  { key: "SALES_INVOICE", ar: "فواتير المبيعات", en: "Sales invoices", supported: true },
  { key: "PURCHASE_INVOICE", ar: "فواتير المشتريات", en: "Purchase invoices", supported: false },
  { key: "SIMPLE_BILL", ar: "فواتير بسيطة", en: "Simple bills", supported: false },
] as const;

export const PHASE_2_REASON = {
  ar: "فواتير المشتريات والفواتير البسيطة المتكررة في المرحلة الثانية: كل فاتورة مورد تحمل رقم فاتورة المورد الضريبية (فريد لكل مورد وأساس استرداد ضريبة المدخلات) ولا يمكن معرفته مسبقًا، وخدمة فواتير المشتريات لا تملك مفتاح طلب يمنع التكرار.",
  en: "Recurring purchase invoices and simple bills are phase 2: each supplier bill carries the supplier's own tax-invoice number (unique per supplier and the basis of the input-VAT claim), which cannot be known in advance, and the purchase-invoice service has no request key to make a run idempotent.",
};

export const refText = (refNo: number) => `REC-${String(refNo).padStart(6, "0")}`;

export const STATUS_LABEL: Record<RecurringStatus, [string, string]> = {
  ACTIVE: ["نشطة", "Active"], PAUSED: ["موقوفة مؤقتًا", "Paused"], COMPLETED: ["مكتملة", "Completed"], CANCELLED: ["ملغاة", "Cancelled"],
};
export const RUN_LABEL: Record<RunStatus, [string, string]> = {
  CREATED: ["أُنشئت مسودة", "Draft created"], POSTED: ["رُحّل", "Posted"], SKIPPED: ["تُخطّي (قبل تفعيل المحاسبة)", "Skipped (before go-live)"], FAILED: ["فشل", "Failed"],
};
export const KIND_LABEL: Record<RecurringKind, [string, string]> = { JOURNAL: ["قيد", "Journal"], SALES_INVOICE: ["فاتورة مبيعات", "Sales invoice"] };
export const FREQ_LABEL: Record<string, [string, string, string, string]> = {
  // [ar, en, ar unit, en unit]
  DAILY: ["يومي", "Daily", "يوم", "day"], WEEKLY: ["أسبوعي", "Weekly", "أسبوع", "week"], MONTHLY: ["شهري", "Monthly", "شهر", "month"], YEARLY: ["سنوي", "Yearly", "سنة", "year"],
};

/** The stored failure message: Arabic and English, split by « || » (the screens show the viewer's language). */
export const errorText = (d: { ar: string; en: string }) => `${d.ar} || ${d.en}`.slice(0, 1000);
export const errorIn = (stored: string | null, lang: "ar" | "en") => {
  if (!stored) return null;
  const [ar, en] = stored.split(" || ");
  return lang === "en" ? en ?? ar : ar;
};
