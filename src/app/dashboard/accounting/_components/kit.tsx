"use client";

// Accounting additions to the Finance UI kit (which is reused as-is: same cards, tables,
// badges and states as the Figma frames on page "17 — Accounting · General Ledger").
import { useUser } from "../../user-context";
import { Badge, Button, useL, type Tone } from "../../finance/_components/ui";

export type Sub =
  | "settings_manage" | "coa_manage" | "tax_category_manage" | "period_lock" | "period_close" | "journal_create"
  | "journal_submit" | "journal_approve" | "journal_post" | "journal_reverse" | "export_view" | "mapping_manage"
  | "policy_prepare" | "policy_approve" | "events_process" | "unlock_period"
  | "ap_bill_create" | "ap_bill_approve" | "ap_bill_post" | "bank_posting_manage" | "bank_correction_request" | "bank_correction_approve"
  | "ar_invoice_create" | "ar_invoice_approve" | "ar_invoice_post" | "ar_receipt_assign"
  | "inv_doc_create" | "inv_doc_approve" | "inv_doc_post" | "inv_master_manage" | "inv_return_receive";

/** Whether the signed-in user holds an accounting duty. Display only — the server decides. */
export function useCan() {
  const user = useUser();
  const acc = user?.permissions?.accounting as { access: string; sub?: Record<string, boolean> } | undefined;
  return { user, can: (s: Sub) => !!acc && acc.access === "edit" && !!acc.sub?.[s] };
}

const STATUS: Record<string, { ar: string; en: string; tone: Tone }> = {
  DRAFT: { ar: "مسودة", en: "Draft", tone: "info" },
  SUBMITTED: { ar: "بانتظار الاعتماد", en: "Awaiting approval", tone: "warn" },
  APPROVED: { ar: "معتمد · للترحيل", en: "Approved · to post", tone: "brand" },
  POSTED: { ar: "مرحّل", en: "Posted", tone: "ok" },
  REVERSED: { ar: "معكوس", en: "Reversed", tone: "info" },
};
export function JournalStatus({ status, rejected }: { status: string; rejected?: boolean }) {
  const { L } = useL();
  if (status === "DRAFT" && rejected) return <Badge tone="bad">{L("مسودة · مرفوض", "Draft · rejected")}</Badge>;
  const s = STATUS[status] ?? { ar: status, en: status, tone: "info" as Tone };
  return <Badge tone={s.tone}>{L(s.ar, s.en)}</Badge>;
}

const TYPES: Record<string, [string, string]> = {
  MANUAL: ["يدوي", "Manual"], AUTO: ["آلي", "Automatic"], REVERSAL: ["عكسي", "Reversal"], ADJUSTMENT: ["تسوية", "Adjustment"],
  OPENING: ["افتتاحي", "Opening"], CLOSING: ["إقفال", "Closing"],
};
export function JournalType({ type, source }: { type: string; source?: string }) {
  const { L } = useL();
  const [ar, en] = TYPES[type] ?? [type, type];
  const srcLabel: Record<string, [string, string]> = { commissions: [" · عمولات", " · commissions"], payables: [" · موردين", " · payables"], bank: [" · بنك", " · bank"] };
  const src = type === "AUTO" && source && srcLabel[source] ? L(...srcLabel[source]) : "";
  return <Badge tone={type === "AUTO" ? "info" : type === "OPENING" ? "brand" : "info"}>{L(ar, en)}{src}</Badge>;
}

export const EVENT_STATUS: Record<string, { ar: string; en: string; tone: Tone }> = {
  PENDING: { ar: "بانتظار الترحيل", en: "Pending", tone: "warn" },
  TRANSLATED: { ar: "مرحّل", en: "Posted", tone: "ok" },
  BLOCKED: { ar: "محجوب", en: "Blocked", tone: "bad" },
  FAILED: { ar: "فشل", en: "Failed", tone: "bad" },
  SKIPPED: { ar: "قبل بداية الدفتر", en: "Before cutover", tone: "info" },
};

export const PERIOD_STATUS: Record<string, { ar: string; en: string; tone: Tone }> = {
  OPEN: { ar: "مفتوحة", en: "Open", tone: "ok" },
  LOCKED: { ar: "مغلقة مؤقتاً", en: "Locked", tone: "warn" },
  CLOSED: { ar: "مقفلة نهائياً", en: "Closed", tone: "info" },
};

export const ROLE_LABELS: Record<string, [string, string]> = {
  COMMISSION_EXPENSE: ["مصروف عمولات المبيعات", "Commission expense"],
  COMMISSION_PAYABLE: ["عمولات مستحقة الدفع (مراقبة)", "Commissions payable (control)"],
  COMMISSION_PAYMENT_CLEARING: ["حساب وسيط لمدفوعات العمولات", "Commission payments clearing"],
  RETAINED_EARNINGS: ["الأرباح المبقاة", "Retained earnings"],
  OPENING_BALANCE_EQUITY: ["حقوق ملكية الأرصدة الافتتاحية", "Opening balance equity"],
  AP_CONTROL: ["ذمم دائنة تجارية (مراقبة)", "Trade payables (control)"],
  GRNI: ["بضاعة مستلمة لم تصل فاتورتها", "Goods received not invoiced"],
  INPUT_VAT: ["ضريبة المدخلات", "Input VAT"],
  SUPPLIER_ADVANCES: ["دفعات مقدمة للموردين", "Supplier advances"],
  BANK_FEES: ["رسوم بنكية", "Bank fees"],
};

/** Supplier bill status; a posted bill shows whether it is paid, part-paid or overdue. */
export function BillStatus({ status, rejected, remaining, gross, overdueDays, sales, creditNote }: { status: string; rejected?: boolean; remaining?: string | null; gross?: string; overdueDays?: number; sales?: boolean; creditNote?: boolean }) {
  const { L } = useL();
  if (creditNote && status !== "POSTED") { const s = STATUS[status] ?? { ar: status, en: status, tone: "info" as Tone }; return <Badge tone={s.tone}>{L(`إشعار دائن · ${s.ar}`, `Credit note · ${s.en}`)}</Badge>; }
  if (creditNote) return <Badge tone="info">{L("إشعار دائن · مرحّل", "Credit note · posted")}</Badge>;
  if (status === "DRAFT" && rejected) return <Badge tone="bad">{L("مسودة · مرفوضة", "Draft · rejected")}</Badge>;
  if (status === "POSTED" && remaining !== undefined && remaining !== null) {
    const rem = Number(remaining);
    if (rem <= 0) return <Badge tone="ok">{sales ? L("محصّلة", "Collected") : L("مسدّدة", "Paid")}</Badge>;
    if (overdueDays && overdueDays > 0) return <Badge tone="bad">{L(`متأخرة ${overdueDays} يوماً`, `${overdueDays} days overdue`)}</Badge>;
    if (gross && rem < Number(gross)) return <Badge tone="brand">{sales ? L("مرحّلة · محصّلة جزئياً", "Posted · part-collected") : L("مرحّلة · مدفوعة جزئياً", "Posted · part-paid")}</Badge>;
  }
  const s = STATUS[status] ?? { ar: status, en: status, tone: "info" as Tone };
  return <Badge tone={s.tone}>{L(s.ar, s.en)}</Badge>;
}

/** Display number of a sales document: INV-… or CN-…. */
export const docNo = (r: { kind: string; invoiceNo: number }) => `${r.kind === "CREDIT_NOTE" ? "CN" : "INV"}-${r.invoiceNo}`;

/** Today as a Riyadh calendar day, "YYYY-MM-DD". Call outside render (initialisers/handlers). */
export function riyadhToday(): string { return new Date(Date.now() + 3 * 3600_000).toISOString().slice(0, 10); }

/** Stored accounting dates are UTC midnight of a Riyadh calendar day: show the day as stored. */
export function useDay() {
  const { lang } = useL();
  return (d: string | Date | null | undefined) => {
    if (!d) return "—";
    const iso = (typeof d === "string" ? d : d.toISOString()).slice(0, 10);
    const [y, m, day] = iso.split("-");
    return lang === "ar" ? `${day}/${m}/${y}` : `${day}/${m}/${y}`;
  };
}

export function Pager({ page, pageSize, total, onPage }: { page: number; pageSize: number; total: number; onPage: (p: number) => void }) {
  const { L } = useL();
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, total);
  return (
    <div className="flex items-center justify-between gap-2 flex-wrap">
      <span className="text-xs text-brown tabular-nums">{L(`عرض ${from}–${to} من ${total}`, `Showing ${from}–${to} of ${total}`)}</span>
      <div className="flex gap-2">
        <Button disabled={page <= 1} onClick={() => onPage(page - 1)}>{L("السابق", "Previous")}</Button>
        <Button disabled={to >= total} onClick={() => onPage(page + 1)}>{L("التالي", "Next")}</Button>
      </div>
    </div>
  );
}

export const EVENT_LABEL: Record<string, [string, string]> = {
  "commission.accrual": ["استحقاق عمولة", "Commission accrual"], "commission.reversal": ["عكس عمولة", "Commission reversal"],
  "commission.adjustment": ["تسوية عمولة", "Commission adjustment"], "commission.payout": ["صرف عمولة", "Commission payout"],
  "ap.bill.posted": ["ترحيل فاتورة مورد", "Supplier bill posted"], "ap.bill.reversed": ["عكس فاتورة مورد", "Supplier bill reversed"],
  "bank.transaction.confirmed": ["حركة بنكية", "Bank line"], "bank.transaction.voided": ["إلغاء حركة بنكية", "Bank line voided"],
  "ar.invoice.posted": ["ترحيل فاتورة مبيعات", "Sales invoice posted"], "ar.invoice.reversed": ["عكس فاتورة مبيعات", "Sales invoice reversed"],
  "ar.credit_note.posted": ["ترحيل إشعار دائن", "Credit note posted"], "ar.credit_note.reversed": ["عكس إشعار دائن", "Credit note reversed"],
  "ar.advance.applied": ["تطبيق دفعة مقدمة", "Advance applied"], "ar.advance.reversed": ["عكس تطبيق دفعة مقدمة", "Advance application reversed"],
  "ar.credit.allocated": ["تخصيص رصيد دائن لفاتورة", "Credit applied to an invoice"], "ar.credit.released": ["إلغاء تخصيص رصيد دائن", "Credit application released"],
  "inv.document.posted": ["ترحيل مستند مخزون", "Inventory document posted"],
};

/** The posting engine's reasons are English sentences; the known ones are shown in Arabic too. */
const REASONS: [RegExp, (m: RegExpMatchArray) => string][] = [
  [/commission plan (\S+) v(\d+) is not approved for accounting/, (m) => `خطة العمولات ${m[1]} الإصدار ${m[2]} غير معتمدة محاسبياً`],
  [/policy "([^"]+)" has no approved version/, (m) => `السياسة "${m[1]}" ليس لها إصدار معتمد`],
  [/No account is mapped for: (.+)\./, (m) => `لا يوجد حساب مربوط بالدور: ${m[1]}`],
  [/Fiscal period (\S+) is (\w+); (\S+) cannot be posted/, (m) => `الفترة ${m[1]} ${m[2] === "LOCKED" ? "مغلقة مؤقتاً" : "مقفلة"}؛ لا يمكن ترحيل ${m[3]}`],
  [/No fiscal period covers (\S+)/, (m) => `لا توجد فترة مالية تغطي ${m[1]}`],
  [/An earlier event for the same party has not posted yet/, () => "حدث سابق للطرف نفسه لم يُرحّل بعد؛ أحداث الطرف الواحد تُرحّل بالترتيب"],
  [/Dated before the ledger cutover \((\S+)\)/, (m) => `قبل بداية الدفتر (${m[1]})؛ يحمله الرصيد الافتتاحي`],
  [/Accounting setup is not complete/, () => "إعداد المحاسبة لم يكتمل"],
  [/No ledger cutover date is set/, () => "لم يُحدَّد تاريخ بداية الدفتر"],
  [/the movement does not record which plan version produced it/, () => "الحركة لا تسجّل إصدار الخطة الذي أنتجها"],
  [/The commission movement is zero/, () => "حركة العمولة صفرية؛ لا شيء يُرحّل"],
  [/Posted provisionally/, () => "رُحّل مؤقتاً (قاعدة اختبار معزولة) — بانتظار الاعتماد"],
  [/([\d.,]+) SAR on the payables category is not matched to posted supplier bills/, (m) => `${m[1]} ر.س على فئة الموردين غير مطابقة لفواتير مرحّلة`],
  [/Budget categories not mapped to a ledger account: (.+)\./, (m) => `فئات ميزانية غير مربوطة بحساب: ${m[1]}`],
  [/Customer receipts and settlements post only once receivables are in the ledger/, () => "متحصلات العملاء تُرحّل بعد إضافة الذمم المدينة (المرحلة 3)"],
  [/Cash account (\S+) is not mapped to a ledger account/, (m) => `الحساب النقدي ${m[1]} غير مربوط بحساب أستاذ`],
  [/Transfers post once, from the paying side/, () => "التحويل يُرحّل مرة واحدة من الطرف الدافع"],
  [/Dated before bank posting starts \((\S+)\)/, (m) => `قبل بدء الترحيل البنكي (${m[1]})`],
  [/The bank posting start date is not set/, () => "لم يُحدَّد تاريخ بدء الترحيل البنكي"],
  [/VAT on customer advances \(decision D-2\) is not set/, () => "لم يُقرَّر بعد إن كانت ضريبة الدفعات المقدمة تُستحق عند الاستلام (القرار D-2)"],
  [/Assign this line to a customer/, () => "أسند الحركة إلى عميل في المحاسبة ← الذمم المدينة ← التحصيلات"],
  [/has posted; correct it through Accounting/, () => "رُحّلت الحركة؛ صحّحها من المحاسبة ← البنك ← تصحيح حركات مرحّلة"],
  [/has no VAT registration number, so input VAT cannot be claimed/, () => "المورد بلا رقم تسجيل ضريبي؛ لا تُسترد ضريبة المدخلات"],
];
export function useExplain() {
  const { lang } = useL();
  return (msg: string | null | undefined) => {
    if (!msg || lang !== "ar") return msg ?? "";
    const parts = REASONS.flatMap(([re, f]) => { const m = msg.match(re); return m ? [f(m)] : []; });
    return parts.length ? parts.join(" · ") : msg;
  };
}

/** Automatic entries are stored with English descriptions (the ledger's canonical text); the
 *  known phrases are shown in Arabic in the Arabic interface. */
const AUTO_PHRASES: [string, string][] = [
  ["Reversal of invoice", "عكس الفاتورة"], ["Cost of sales", "تكلفة المبيعات"], ["Roasting batch", "دفعة تحميص"], ["Purchase record", "سجل شراء"],
  ["Goods receipt", "استلام من مورد"], ["Return to supplier", "مرتجع لمورد"], ["Stock issue", "صرف مخزون"], ["Customer return", "مرتجع من عميل"], ["Stock count", "جرد"],
  ["Landed cost", "تكلفة إضافية"], ["Supplier price difference", "فرق سعر المورد"], ["Production", "إنتاج"],
  ["Commission accrual", "استحقاق عمولة"], ["Commission reversal", "عكس عمولة"], ["Commission adjustment", "تسوية عمولة"],
  ["Commission payout", "صرف عمولة"], ["Reversal of supplier bill", "عكس فاتورة المورد"], ["Supplier bill", "فاتورة مورد"],
  ["Void of bank line", "إلغاء حركة بنكية"], ["Bank line", "حركة بنكية"], ["Transfer", "تحويل"], ["Supplier payment", "دفعة لمورد"],
  ["Input VAT", "ضريبة المدخلات"], ["Reversal of entry", "عكس القيد"], ["Reversal", "عكس"],
];
export function useAutoText() {
  const { lang } = useL();
  return (s: string | null | undefined) => {
    if (!s || lang !== "ar") return s ?? "";
    let out = s;
    for (const [en, ar] of AUTO_PHRASES) out = out.split(en).join(ar);
    return out;
  };
}
export const SOURCE_LABEL: Record<string, [string, string]> = { manual: ["يدوي", "manual"], commissions: ["عمولات", "commissions"], payables: ["موردين", "payables"], bank: ["بنك", "bank"] };

/** A decimal string from the database → formatted amount with a correctly placed sign. */
export function useAmount() {
  const { money } = useL();
  return (v: string | null | undefined) => {
    if (v === null || v === undefined || v === "") return "";
    const neg = v.trim().startsWith("-");
    const abs = v.replace("-", "");
    const [w, f = ""] = abs.split(".");
    const minor = Number(w) * 100 + Number((f + "00").slice(0, 2));
    return neg ? `(${money(minor)})` : money(minor);
  };
}
