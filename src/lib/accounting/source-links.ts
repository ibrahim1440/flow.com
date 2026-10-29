// Unified inventory phase 4 — ONE vocabulary for where an accounting number comes from. Pure (no database), shared by
// the journal page, the general-ledger statement, the cost-ledger drill-down of «تقييم المخزون» and the tests.
//
//   SOURCE_DOC    a source document's plain name (Qoyod-style Arabic, plain English); the internal code stays a tooltip;
//   SOURCE_EVENT  what happened to it (استلام · ترحيل · إلغاء …);
//   MOVE_KIND     a cost-ledger movement's kind (وارد · صادر · تحويل · تسوية …);
//   GL_STATE      whether a movement reached the general ledger;
//   sourceDocHref where the document lives in the app — only pages that exist (tests/accounting/unit/valuation.test.ts
//                 checks every target against the pages on disk). `extra` carries what only the database knows: the
//                 purchase invoice a receipt belongs to, the count sheet an adjustment came from, the lot a packing run
//                 made, the day of a roast.

export type Pair = [ar: string, en: string];

export const SOURCE_DOC: Record<string, Pair> = {
  GRN: ["استلام بضاعة", "Goods receipt"],
  SUPPLIER_INVOICE: ["فاتورة مشتريات", "Purchase invoice"],
  SUPPLIER_PAYMENT: ["سداد مورد", "Supplier payment"],
  SUPPLIER_CREDIT_NOTE: ["إشعار دائن من المورد", "Supplier credit note"],
  SUPPLIER_CLAIM: ["مطالبة مورد", "Supplier claim"],
  ROAST_BATCH: ["دفعة تحميص", "Roast"],
  BLEND: ["خلطة", "Blend"],
  PACKAGING_RUN: ["تعبئة", "Packing"],
  STOCK_ADJUSTMENT: ["تسوية مخزون أو جرد", "Stock adjustment or count"],
  STOCK_TRANSFER: ["تحويل مخزون", "Stock transfer"],
  STOCK_TRANSFER_SHORTFALL: ["عجز تحويل", "Transfer shortfall"],
  DELIVERY: ["تسليم طلب", "Delivery"],
  ORDER: ["طلب", "Order"],
  QC_DISPOSITION: ["قرار الجودة", "Quality decision"],
  OPENING_VALUATION: ["تقييم المخزون الافتتاحي", "Opening inventory valuation"],
  OPENING_STOCK: ["رصيد عند إنشاء الصنف", "Balance at item creation"],
  OPENING_BALANCE: ["الأرصدة الافتتاحية", "Opening balances"],
  SALES_INVOICE: ["فاتورة مبيعات", "Sales invoice"],
  CREDIT_NOTE: ["إشعار دائن", "Credit note"],
  DEBIT_NOTE: ["إشعار مدين", "Debit note"],
  COLLECTION: ["تحصيل", "Collection"],
  PAYROLL_RUN: ["مسير الرواتب", "Payroll run"],
  COMMISSION: ["عمولة", "Commission"],
  YEAR_END: ["إقفال السنة", "Year-end close"],
  // «المعاملات المتكررة» (20261120090000): a journal a recurring transaction made (draft or auto-posted).
  RECURRING: ["معاملة متكررة", "Recurring transaction"],
  DEFERRAL_RUN: ["الاعتراف الشهري بالمؤجلات", "Monthly deferral recognition"],
};

export const SOURCE_EVENT: Record<string, Pair> = {
  RECEIVED: ["استلام", "Received"], REVERSED: ["عكس", "Reversed"], POSTED: ["ترحيل", "Posted"], CANCELLED: ["إلغاء", "Cancelled"],
  GREEN_ISSUED: ["صرف البن الأخضر", "Green coffee issued"], COMPLETED: ["اكتمال", "Completed"], COGS: ["تكلفة المبيعات", "Cost of sales"],
  RETURNED: ["مرتجع", "Returned"], APPROVED: ["اعتماد", "Approved"], EXECUTED: ["تنفيذ", "Executed"], CREATED: ["إنشاء", "Created"],
  BLENDED: ["خلط", "Blended"], QC_REJECTED: ["رفض الجودة", "Rejected by quality"], SENT: ["إرسال", "Sent"], VOIDED: ["إلغاء", "Voided"],
  QC_CONVERT: ["تحويل إلى منتج آخر", "Converted to another product"], QC_BLEND: ["خلط", "Blended"], QC_DESTROY: ["إتلاف", "Destroyed"],
  // Stock locations round 2 (20261117090000): two-step transfers and lot splits.
  IN_TRANSIT: ["إرسال إلى «في الطريق»", "Sent, in transit"], TRANSIT_OUT: ["خروج من «في الطريق»", "Out of transit"],
  CANCEL_OUT: ["إلغاء (خروج)", "Cancel (out)"], CANCEL_IN: ["إلغاء (عودة)", "Cancel (back)"],
  SPLIT_OUT: ["فصل جزء من اللوط", "Part split off the lot"], SPLIT_IN: ["لوط مفصول", "Split lot"],
  TRANSFER_SHORTFALL: ["عجز تحويل", "Transfer shortfall"],
  ACCRUED: ["استحقاق", "Accrued"], PAID: ["سداد", "Paid"], ISSUED: ["إصدار", "Issued"],
  RECOGNIZED: ["اعتراف", "Recognised"],
  REPLACED: ["بضاعة بديلة", "Replacement goods"], ABANDONED: ["تنازل", "Abandoned"], REFUNDED: ["استرداد من المورد", "Refund received"],
};

export const MOVE_KIND: Record<string, Pair> = {
  RECEIPT: ["وارد", "In"], ISSUE: ["صادر", "Out"], TRANSFER_IN: ["تحويل وارد", "Transfer in"], TRANSFER_OUT: ["تحويل صادر", "Transfer out"],
  ADJUSTMENT: ["تسوية", "Adjustment"], REVALUATION: ["فرق سعر أو تكلفة إضافية", "Price difference or landed cost"], OPENING: ["افتتاحي", "Opening"],
  WRITE_OFF: ["إتلاف", "Write-off"], RETURN: ["مرتجع", "Return"],
};

export const GL_STATE: Record<string, Pair> = {
  POSTED: ["مرحّل", "Posted"], SKIPPED: ["لم يُرحَّل", "Not posted"],
  NONE: ["بلا قيد", "No entry"], OPENING: ["رصيد افتتاحي", "Opening balance"], PENDING: ["قيد المعالجة", "Pending"],
};

/** The plain name of a code («ACCRUED.2» by its head), the code itself when unknown (never blank). */
export function plain(map: Record<string, Pair>, code: string | null | undefined, lang: "ar" | "en" | string): string {
  if (!code) return "";
  const e = map[code] ?? map[code.split(".")[0]];
  return e ? (lang === "en" ? e[1] : e[0]) : code;
}

export type SourceExtra = { invoiceId?: string | null; countSessionId?: string | null; lotId?: string | null; day?: string | null };

/** Where a source document lives in the app (null when it has no page). Every target is an existing page. */
export function sourceDocHref(sourceType: string | null | undefined, sourceId: string | null | undefined, extra: SourceExtra = {}, sourceModule?: string | null): string | null {
  if (!sourceType || !sourceId) return null;
  const id = encodeURIComponent(sourceId);
  const range = extra.day ? `&from=${extra.day}&to=${extra.day}` : "";
  switch (sourceType) {
    case "OPENING_BALANCE": return "/dashboard/accounting/opening";
    case "COLLECTION": return `/dashboard/sales/collections?focus=${id}`;
    case "ORDER": case "DELIVERY": return `/dashboard/orders?focus=${id}`;
    case "PAYROLL_RUN": return "/dashboard/hr/payroll";
    case "SALES_INVOICE": case "CREDIT_NOTE": case "DEBIT_NOTE": return `/dashboard/sales/invoices/${id}`;
    case "SUPPLIER_INVOICE": return `/dashboard/purchases/invoices/${id}`;
    case "SUPPLIER_PAYMENT": return "/dashboard/accounting/ap?view=payments";
    case "SUPPLIER_CREDIT_NOTE": case "SUPPLIER_CLAIM": return "/dashboard/purchases?tab=claims";
    // A receipt is part of its purchase invoice (phase 2, one step); a receipt without an invoice is in «الاستلامات».
    case "GRN": return extra.invoiceId ? `/dashboard/purchases/invoices/${encodeURIComponent(extra.invoiceId)}` : "/dashboard/purchases?tab=receipts";
    case "ROAST_BATCH": case "BLEND": return `/dashboard/accounting/inventory?view=batches${range}`;
    case "PACKAGING_RUN": return extra.lotId ? `/dashboard/inventory/lots/${encodeURIComponent(extra.lotId)}` : "/dashboard/packaging";
    case "STOCK_ADJUSTMENT": return extra.countSessionId ? `/dashboard/inventory?count=${encodeURIComponent(extra.countSessionId)}` : "/dashboard/inventory?view=ledger";
    case "STOCK_TRANSFER": return `/dashboard/inventory/transfers/${id}`;
    case "QC_DISPOSITION": return "/dashboard/qc";
    case "OPENING_VALUATION": case "OPENING_STOCK": return "/dashboard/accounting/inventory?view=opening";
    case "COMMISSION": return "/dashboard/commissions/review";
    case "YEAR_END": return "/dashboard/accounting/periods";
    case "RECURRING": return `/dashboard/accounting/recurring/${id}`;
    case "DEFERRAL_RUN": return `/dashboard/accounting/deferrals?view=runs&run=${id}`;
    default: return sourceModule === "hr" ? "/dashboard/hr/payroll" : null;
  }
}

/** A stock holder's own page (the item / lot), when it has one; else the operations inventory on its category. */
export function holderHref(kind: string, h: { labelCode?: string | null; entityId: string; categoryId?: string | null }): string {
  if (kind === "GREEN_BEAN" && h.labelCode) return `/dashboard/inventory/lots/${encodeURIComponent(h.labelCode)}`;
  if (kind === "FG_LOT") return `/dashboard/inventory/lots/${encodeURIComponent(h.entityId)}`;
  return h.categoryId ? `/dashboard/inventory?cat=${encodeURIComponent(h.categoryId)}` : "/dashboard/inventory";
}

/**
 * Old addresses of the accounting screens (before phase 4 the close checklist and the statement linked `?tab=…`, which
 * the pages never read). These map such a `tab` to the view that holds it now; the pages replace the address.
 */
export const LEGACY_INVENTORY_TAB: Record<string, string> = { reconciliation: "value", value: "value", batches: "batches", grni: "grni", receipts: "grni", opening: "opening", policy: "policy" };
export const LEGACY_AP_TAB: Record<string, string> = { payments: "payments", aging: "aging", reconciliation: "aging", invoices: "invoices" };
