"use client";

// Shared labels for the inventory screens (Figma page 20, ACC-40..47).
import { Badge, useL, type Tone } from "../../finance/_components/ui";

export const DOC_TYPE: Record<string, [string, string]> = {
  RECEIPT: ["استلام من مورد", "Goods receipt"], SUPPLIER_RETURN: ["مرتجع لمورد", "Return to supplier"], ISSUE: ["صرف", "Issue"], TRANSFER: ["تحويل", "Transfer"],
  PRODUCTION: ["إنتاج", "Production"], SALE_ISSUE: ["تكلفة المبيعات", "Cost of sales"], CUSTOMER_RETURN: ["مرتجع من عميل", "Customer return"],
  LANDED_COST: ["تكلفة إضافية", "Landed cost"], BILL_MATCH: ["مطابقة فاتورة مورد", "Bill match"], COUNT: ["جرد", "Stock count"],
  SUPPLIER_CREDIT: ["إشعار دائن من مورد", "Supplier credit"], SALE_REVERSAL: ["عكس تكلفة فاتورة", "Invoice reversal: cost back to delivered, not invoiced"], ADJUSTMENT: ["تسوية كمية", "Stock adjustment"],
};
export const ISSUE_REASON: Record<string, [string, string]> = {
  INTERNAL_USE: ["استهلاك داخلي (المقهى)", "Internal use (café)"], CALIBRATION: ["معايرة", "Calibration"], QC: ["اختبار جودة", "QC testing"], TRAINING: ["تدريب", "Training"], SPOILAGE: ["تلف", "Spoilage"],
};
export const KIND: Record<string, [string, string, Tone]> = {
  GREEN_COFFEE: ["بن أخضر", "Green coffee", "info"], ROASTED_COFFEE: ["تحت التشغيل", "Work in progress", "brand"], PACKAGING: ["تغليف", "Packaging", "warn"], MILK: ["حليب", "Milk", "info"],
  BAKERY_INGREDIENT: ["مكونات المخبز", "Bakery ingredient", "info"], FINISHED_GOOD: ["تامة الصنع", "Finished good", "ok"], RESALE_GOOD: ["بغرض البيع", "For resale", "ok"], CONSUMABLE: ["مستهلكات", "Consumable", "warn"],
};

export function DocTypeLabel({ type, reason }: { type: string; reason?: string | null }) {
  const { L } = useL();
  const t = DOC_TYPE[type] ?? [type, type];
  return <>{L(t[0], t[1])}{reason && ISSUE_REASON[reason] ? ` — ${L(ISSUE_REASON[reason][0], ISSUE_REASON[reason][1])}` : ""}</>;
}

export function KindBadge({ kind }: { kind: string }) {
  const { L } = useL();
  const k = KIND[kind] ?? [kind, kind, "info" as Tone];
  return <Badge tone={k[2]}>{L(k[0], k[1])}</Badge>;
}

export function InvStatus({ status, rejected, ledger, provisional }: { status: string; rejected?: boolean; ledger?: { status: string } | null; provisional?: boolean }) {
  const { L } = useL();
  if (status === "DRAFT") return <Badge tone={rejected ? "bad" : "info"}>{rejected ? L("مسودة · مرفوضة", "Draft · rejected") : L("مسودة", "Draft")}</Badge>;
  if (status === "SUBMITTED") return <Badge tone="warn">{L("بانتظار الاعتماد", "Awaiting approval")}</Badge>;
  if (status === "APPROVED") return <Badge tone="brand">{L("معتمد · للترحيل", "Approved · to post")}</Badge>;
  if (ledger && ledger.status !== "TRANSLATED" && ledger.status !== "SKIPPED") return <Badge tone="warn">{L("مرحّل · القيد بانتظار الاعتماد", "Posted · journal waiting")}</Badge>;
  return <Badge tone="ok">{provisional ? L("مرحّل مؤقتاً (اختبار)", "Posted provisionally (test)") : L("مرحّل", "Posted")}</Badge>;
}

/** Quantity to 4 places; a left-to-right mark keeps a minus sign on the left inside RTL text. */
export const qty = (s: string | null | undefined) => (s == null ? "—" : `\u200E${Number(s).toLocaleString("en-US", { minimumFractionDigits: 4, maximumFractionDigits: 4 })}`);

export const AUDIT_ACTION: Record<string, [string, string]> = {
  "inventory.document.create": ["إنشاء", "Create"], "inventory.document.update": ["تعديل", "Edit"], "inventory.document.submit": ["تقديم", "Submit"], "inventory.document.approve": ["اعتماد", "Approve"],
  "inventory.document.reject": ["رفض", "Reject"], "inventory.document.post": ["ترحيل", "Post"], "inventory.sale_issue.create": ["إنشاء آلي من الفاتورة", "Created from the invoice"], "inventory.customer_return.create": ["إنشاء آلي من عكس الفاتورة", "Created from the invoice reversal"],
  "inventory.ops_event.retry": ["إعادة محاولة حدث تشغيلي", "Operational event retried"], "inventory.ops_event.ignore": ["استبعاد حدث تشغيلي", "Operational event dismissed"],
  "inventory.ops_event.link": ["ربط حدث تشغيلي بمستند", "Operational event linked to a document"], "inventory.costing.retry": ["إعادة محاولة تكلفة المبيعات", "Cost of sales retried"],
};

/** Accounting state of an operational stock event (the exception queue). */
export const OPS_STATUS: Record<string, [string, string, Tone]> = {
  PENDING: ["بانتظار المعالجة", "Pending", "warn"], PROCESSING: ["قيد المعالجة", "Processing", "brand"], POSTED: ["مرحّل", "Posted", "ok"],
  HELD: ["معلّق", "Held", "warn"], BLOCKED: ["محجوب", "Blocked", "bad"], FAILED: ["فشل", "Failed", "bad"], IGNORED: ["مستبعد", "Dismissed", "info"],
};
export function OpsStatus({ status }: { status: string }) {
  const { L } = useL();
  const s = OPS_STATUS[status] ?? [status, status, "info" as Tone];
  return <Badge tone={s[2]}>{L(s[0], s[1])}</Badge>;
}

/** Cost of sales state of a posted sales invoice. */
export const COSTING_STATUS: Record<string, [string, string, Tone]> = {
  PENDING: ["بانتظار التكلفة", "Pending", "warn"], AWAITING_POLICY: ["بانتظار قرار التوقيت أو السياسة", "Awaiting decision or policy", "warn"], AWAITING_DISPATCH: ["بانتظار التسليم", "Awaiting dispatch", "warn"],
  COSTED: ["مكلفة", "Costed", "ok"], NOT_REQUIRED: ["لا تحتاج تكلفة", "Not required", "info"], BLOCKED: ["محجوبة", "Blocked", "bad"], FAILED: ["فشلت", "Failed", "bad"],
  CANCELLED: ["ملغاة", "Cancelled", "info"], UNCOSTED: ["معكوسة · التكلفة إلى «مسلَّم لم يُفوتر»", "Reversed · cost back to delivered, not invoiced", "info"],
};
export function CostingStatus({ status }: { status: string }) {
  const { L } = useL();
  const s = COSTING_STATUS[status] ?? [status, status, "info" as Tone];
  return <Badge tone={s[2]}>{L(s[0], s[1])}</Badge>;
}
