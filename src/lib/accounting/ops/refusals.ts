// Accounting A3 — the refusals of the operational posting, the cost sub-ledger and AP: Arabic first, English, a
// stable code and an HTTP status (the same AccountingError the A1 core throws, so every route answers it alike).
import { AccountingError } from "../errors";

type R = { status: number; en: string; ar: string };

export const OPS_REFUSALS = {
  OPS_BAD_INPUT: { status: 400, en: "The request is not valid.", ar: "الطلب غير صالح." },
  OPS_NOT_FOUND: { status: 404, en: "Not found.", ar: "غير موجود." },
  SUPPLIER_REQUIRED: { status: 400, en: "Choose the supplier.", ar: "اختر المورد." },
  SUPPLIER_REF_REQUIRED: { status: 400, en: "Enter the supplier's invoice number.", ar: "أدخل رقم فاتورة المورد." },
  SUPPLIER_REF_DUPLICATE: { status: 409, en: "This supplier invoice number is already recorded for this supplier.", ar: "رقم فاتورة المورد هذا مسجّل مسبقًا لهذا المورد." },
  INVOICE_LINES_REQUIRED: { status: 400, en: "An invoice needs at least one line with an amount.", ar: "الفاتورة تحتاج سطرًا واحدًا على الأقل بمبلغ." },
  INVOICE_STATE: { status: 409, en: "The supplier invoice is not in a state that allows this.", ar: "حالة فاتورة المورد لا تسمح بهذا الإجراء." },
  INVOICE_PAID: { status: 409, en: "Payments are applied to this invoice: void them before cancelling it.", ar: "على الفاتورة سداد مطبّق؛ ألغِ السداد قبل إلغاء الفاتورة." },
  SOD_OWN_INVOICE: { status: 403, en: "You entered, edited or submitted this invoice, so another person approves and posts it (segregation of duties).", ar: "أدخلت هذه الفاتورة أو عدّلتها أو قدّمتها، فيعتمدها ويرحّلها شخص آخر (فصل المهام)." },
  GRN_NOT_FOUND: { status: 400, en: "The goods receipt was not found.", ar: "سند الاستلام غير موجود." },
  GRN_OTHER_SUPPLIER: { status: 409, en: "The goods receipt belongs to another supplier.", ar: "سند الاستلام لمورد آخر." },
  GRN_ALREADY_MATCHED: { status: 409, en: "The goods receipt is already matched to another live invoice.", ar: "سند الاستلام مطابق لفاتورة أخرى قائمة." },
  GRN_NOT_COSTED: { status: 409, en: "The goods receipt has no recorded value in the cost ledger; enter it as a stock line instead.", ar: "سند الاستلام ليست له قيمة في سجل التكلفة؛ أدخله سطر مخزون." },
  EXPENSE_CATEGORY_INVALID: { status: 400, en: "Choose an active expense category.", ar: "اختر فئة مصروف نشطة." },
  STOCK_ITEM_INVALID: { status: 400, en: "Choose the stock item (green coffee or material).", ar: "اختر صنف المخزون (بن أخضر أو مادة)." },
  PAYMENT_ALLOCATION: { status: 400, en: "Apply the payment to this supplier's posted invoices (at most what each still owes) and, for the rest, to its unpaid opening balance.", ar: "طبّق مبلغ السداد على فواتير المورد المرحّلة (بحدّ أقصى المتبقي على كل فاتورة)، والباقي على رصيده الافتتاحي غير المسدَّد." },
  PAYMENT_STATE: { status: 409, en: "The payment is not in a state that allows this.", ar: "حالة السداد لا تسمح بهذا الإجراء." },
  ROLE_ACCOUNT_TYPE: { status: 400, en: "The expense category must post to an active, postable expense or asset account.", ar: "فئة المصروف تُرحَّل إلى حساب مصروف أو أصل نشط قابل للترحيل." },
  CATEGORY_CODE_EXISTS: { status: 409, en: "An expense category with this code exists already.", ar: "توجد فئة مصروف بهذا الرمز." },
  OPENING_ALREADY_POSTED: { status: 409, en: "The opening balances are posted: the opening inventory valuation is final.", ar: "رُحّلت الأرصدة الافتتاحية؛ تقييم المخزون الافتتاحي نهائي." },
  THRESHOLD_INVALID: { status: 400, en: "The abnormal-loss threshold is a percentage from 0 to 99.99, or empty (every loss is normal).", ar: "حد الفاقد غير الطبيعي نسبة من 0 إلى 99.99، أو فارغ (كل الفاقد طبيعي)." },
  COST_UNIT_INVALID: { status: 400, en: "A unit cost is a decimal ≥ 0 with at most 6 decimals.", ar: "تكلفة الوحدة رقم عشري ≥ 0 بست خانات عشرية كحد أقصى." },
  COST_MOVE_IMMUTABLE: { status: 409, en: "The cost sub-ledger is append-only.", ar: "سجل التكلفة لا يُعدَّل ولا يُحذف." },
  AP_INVOICE_POSTED: { status: 409, en: "A posted supplier invoice is frozen.", ar: "فاتورة المورد المرحّلة مجمّدة." },
} satisfies Record<string, R>;

export type OpsRefusalCode = keyof typeof OPS_REFUSALS;

export function opsRefuse(code: OpsRefusalCode, detail?: string, detailAr?: string): AccountingError {
  const r: R = OPS_REFUSALS[code];
  return new AccountingError(detail ? `${r.en} ${detail}` : r.en, r.status, code, detailAr ? `${r.ar} ${detailAr}` : r.ar);
}

/** The A3 database guards ("COST_MOVE_IMMUTABLE: …", "AP_INVOICE_POSTED: …"), as coded refusals. */
export function opsDbRefusal(message: string): AccountingError | null {
  if (/COST_MOVE_(IMMUTABLE|PENDING)/.test(message)) return opsRefuse("COST_MOVE_IMMUTABLE");
  if (/AP_INVOICE_PAID/.test(message)) return opsRefuse("INVOICE_PAID");
  if (/AP_INVOICE_POSTED/.test(message)) return opsRefuse("AP_INVOICE_POSTED");
  if (/SupplierInvoice_supplier_ref_live_key/.test(message)) return opsRefuse("SUPPLIER_REF_DUPLICATE");
  return null;
}
