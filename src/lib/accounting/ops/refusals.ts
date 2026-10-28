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
  // Phase 2 — the one-step purchase invoice («فاتورة مشتريات»: receive + bill in one save).
  RECEIPT_REVERSED: { status: 409, en: "The goods receipt was reversed; it can no longer be matched.", ar: "سند الاستلام معكوس، فلا يُطابَق بعد الآن." },
  INVOICE_RECEIVED: { status: 409, en: "This invoice received the goods itself: it is not deleted or edited as a plain draft. Edit it or cancel it from Purchases — the receipt is reversed with it.", ar: "هذه الفاتورة استلمت البضاعة بنفسها، فلا تُحذف ولا تُعدَّل كمسودة عادية. عدّلها أو ألغها من «المشتريات» ويُعكس الاستلام معها." },
  INVOICE_POSTED_RECEIVED: { status: 409, en: "The invoice is approved and posted: its received goods stay in stock. A supplier return comes in a later phase; the bill alone can be cancelled from the invoice (accounts payable).", ar: "الفاتورة معتمدة ومرحّلة، فتبقى بضاعتها المستلمة في المخزون. مرتجع المورد يأتي في مرحلة لاحقة؛ ويمكن إلغاء الفاتورة وحدها من صفحتها (الذمم الدائنة)." },
  RECEIVE_REQUIRED: { status: 403, en: "Receiving into stock (or reversing a receipt) needs the Inventory › Receive permission.", ar: "الاستلام في المخزون أو عكسه يحتاج صلاحية «المخزون › استلام»." },
  RECEIVED_CHANGE_REQUIRED: { status: 403, en: "Cancelling or editing a received invoice (its receipt is reversed) needs the Purchases › Cancel/edit a received invoice permission.", ar: "إلغاء الفاتورة المستلمة أو تعديلها (يُعكس استلامها) يحتاج صلاحية «المشتريات › إلغاء/تعديل فاتورة مستلمة»." },
  // Phase 2 — purchase VAT categories (purchase-tax.ts; check the rules against zatca.gov.sa before filing).
  TAX_CATEGORY_INVALID: { status: 400, en: "Choose the line's VAT category (standard, not recoverable, zero-rated, exempt, out of scope, import or reverse charge).", ar: "اختر فئة ضريبة السطر (أساسية، غير قابلة للاسترداد، صفرية، معفاة، خارج النطاق، استيراد، احتساب عكسي)." },
  TAX_SUPPLIER_VAT_REQUIRED: { status: 409, en: "Input VAT at the standard rate is claimed only on a tax invoice from a VAT-registered supplier: add the supplier's VAT number, or choose «Standard 15% · not recoverable» or «Out of scope / supplier not registered».", ar: "ضريبة المدخلات بالنسبة الأساسية لا تُسترد إلا بفاتورة ضريبية من مورد مسجّل: أضف الرقم الضريبي للمورد، أو اختر «أساسية 15% · غير قابلة للاسترداد» أو «خارج النطاق / مورد غير مسجل»." },
  TAX_CUSTOMS_REQUIRED: { status: 409, en: "Import VAT paid at customs is claimed on the customs declaration: enter its number and date on the invoice.", ar: "ضريبة الاستيراد المدفوعة في الجمارك تُسترد بالبيان الجمركي: أدخل رقمه وتاريخه في الفاتورة." },
  TAX_IMPORT_LINE: { status: 400, en: "Import VAT is its own line («Import VAT at customs», on the customs value), and that line uses the import category only.", ar: "ضريبة الاستيراد سطر مستقل («ضريبة استيراد عبر الجمارك» على القيمة الجمركية)، ولا يُستخدم معه إلا فئة الاستيراد." },
  TAX_IMPORT_VALUE: { status: 400, en: "Enter the customs value the import VAT is computed on.", ar: "أدخل القيمة الجمركية التي تُحسب عليها ضريبة الاستيراد." },
  TAX_RC_NON_RESIDENT: { status: 409, en: "The reverse charge applies to a non-resident supplier: mark the supplier as non-resident, or choose another VAT category.", ar: "الاحتساب العكسي لمورد غير مقيم: علّم المورد كغير مقيم، أو اختر فئة ضريبة أخرى." },
  TAX_RC_SERVICES: { status: 400, en: "The reverse charge is for services bought from abroad (an expense line); goods imported through customs use the import VAT line.", ar: "الاحتساب العكسي للخدمات المستوردة (سطر مصروف)؛ والبضائع المستوردة عبر الجمارك تُسجَّل بسطر ضريبة الاستيراد." },
  // ── Council review of 6d6d10e7 ──
  PURCHASE_INVOICE_SERVICE_ONLY: { status: 409, en: "This is a one-step purchase invoice with stock lines still to receive: save, receive and submit it from Purchases (the accounts-payable route would post value with no goods received).", ar: "هذه فاتورة مشتريات بخطوة واحدة فيها أصناف لم تُستلم بعد: احفظها واستلمها وقدّمها من «المشتريات» (مسار الذمم الدائنة كان سيرحّل قيمة بلا بضاعة مستلمة)." },
  LEGACY_STOCK_DRAFT: { status: 409, en: "This draft was entered through the accounts-payable API with stock lines that only add cost (no goods received); the purchase invoice cannot open it. Cancel it and enter the bill again as a purchase invoice (a landed cost line adds cost to a receipt).", ar: "أُدخلت هذه المسودة عبر واجهة الذمم الدائنة بسطور مخزون تضيف تكلفة فقط (بلا بضاعة مستلمة)، فلا تفتحها فاتورة المشتريات. ألغها وأدخل الفاتورة من جديد كفاتورة مشتريات (سطر «تكلفة إضافية على شحنة» يضيف التكلفة إلى استلام)." },
  LEGACY_AP_ROUTE_GONE: { status: 410, en: "Supplier invoices are entered as purchase invoices now (POST /api/purchases/invoices): one document for stock, expenses, import VAT and landed costs.", ar: "تُدخل فواتير الموردين الآن كفواتير مشتريات (POST /api/purchases/invoices): مستند واحد للمخزون والمصروفات وضريبة الاستيراد والتكاليف الإضافية." },
  TAX_IMPORT_SUPPLIER: { status: 400, en: "Import VAT is billed by customs or a clearing agent (set the supplier's kind), never by a foreign goods supplier or a non-resident.", ar: "ضريبة الاستيراد تُفوتر من الجمارك أو المخلّص الجمركي (حدّد نوع المورد)، لا من مورد البضاعة الأجنبي ولا من مورد غير مقيم." },
  LANDED_COST_TARGET: { status: 400, en: "A landed cost names the goods receipt it is added to (a receipt that is not reversed) and its type: freight, customs duty, clearance or insurance.", ar: "التكلفة الإضافية تحدد الاستلام الذي تُضاف إليه (استلام غير معكوس) ونوعها: شحن أو رسوم جمركية أو تخليص أو تأمين." },
  LANDED_COST_TAX: { status: 400, en: "A landed cost takes «standard 15% recoverable», «standard 15% not recoverable», «out of scope» or, for a non-resident's freight, «reverse charge».", ar: "التكلفة الإضافية فئتها «أساسية 15% قابلة للاسترداد» أو «غير قابلة للاسترداد» أو «خارج النطاق» أو — لشحن مورد غير مقيم — «احتساب عكسي»." },
  RECEIPT_HAS_LANDED_COST: { status: 409, en: "Landed costs were added to this receipt on another invoice: cancel that invoice first, then the receipt can be reversed.", ar: "أُضيفت تكاليف إضافية إلى هذا الاستلام في فاتورة أخرى: ألغِ تلك الفاتورة أولًا ثم يمكن عكس الاستلام." },
  INVOICE_STALE: { status: 409, en: "Someone changed this invoice since you opened it. Reload it and make your change again.", ar: "عدّل شخص آخر هذه الفاتورة منذ فتحتها. أعد تحميلها ثم أعد تعديلك." },
  INVOICE_RECEIVED_RETURN: { status: 409, en: "This invoice received the goods itself, so it is not returned to draft: its preparer edits it (the changed receipts are reversed) or cancels it.", ar: "هذه الفاتورة استلمت البضاعة بنفسها فلا تُعاد للمسودة: يعدّلها مُعدّها (تُعكس الاستلامات المتغيرة) أو يلغيها." },
  INVOICE_NUMBER_ISSUED: { status: 409, en: "This draft already has its invoice number, so it is not deleted: cancel it instead (it stays as «Cancelled» and the number is never reused).", ar: "لهذه المسودة رقم فاتورة صادر، فلا تُحذف: ألغها بدلًا من ذلك (تبقى «ملغاة» ولا يُعاد استخدام الرقم)." },
  RECEIVED_DATE_INVALID: { status: 400, en: "The receipt date is today or earlier, and not before the item's last stock cost movement.", ar: "تاريخ الاستلام اليوم أو قبله، ولا يسبق آخر حركة تكلفة على الصنف." },
  TAX_CATEGORY_FROZEN: { status: 409, en: "The purchase VAT codes (P-*) are system codes: their code, rate, type, scope and treatment never change.", ar: "رموز ضريبة المشتريات (P-*) رموز نظام: لا يتغير رمزها ولا نسبتها ولا نوعها ولا نطاقها ولا معالجتها." },
  TAX_CATEGORY_PURCHASES_ONLY: { status: 400, en: "This tax category is for purchase invoices only (P-*); use a sales tax category here.", ar: "فئة الضريبة هذه لفواتير المشتريات فقط (P-*)؛ استخدم هنا فئة ضريبة مبيعات." },
  STOCK_LINE_INVALID: { status: 400, en: "A stock line needs its item, a quantity above zero and a unit cost above zero.", ar: "سطر المخزون يحتاج الصنف وكمية أكبر من صفر وتكلفة وحدة أكبر من صفر." },
  PAYMENT_ALLOCATION: { status: 400, en: "Apply the payment to this supplier's posted invoices (at most what each still owes) and, for the rest, to its unpaid opening balance.", ar: "طبّق مبلغ السداد على فواتير المورد المرحّلة (بحدّ أقصى المتبقي على كل فاتورة)، والباقي على رصيده الافتتاحي غير المسدَّد." },
  PAYMENT_STATE: { status: 409, en: "The payment is not in a state that allows this.", ar: "حالة السداد لا تسمح بهذا الإجراء." },
  ROLE_ACCOUNT_TYPE: { status: 400, en: "The expense category must post to an active, postable expense or asset account.", ar: "فئة المصروف تُرحَّل إلى حساب مصروف أو أصل نشط قابل للترحيل." },
  CATEGORY_CODE_EXISTS: { status: 409, en: "An expense category with this code exists already.", ar: "توجد فئة مصروف بهذا الرمز." },
  OPENING_ALREADY_POSTED: { status: 409, en: "The opening balances are posted: the opening inventory valuation is final.", ar: "رُحّلت الأرصدة الافتتاحية؛ تقييم المخزون الافتتاحي نهائي." },
  THRESHOLD_INVALID: { status: 400, en: "The abnormal-loss threshold is a percentage from 0 to 99.99, or empty (every loss is normal).", ar: "حد الفاقد غير الطبيعي نسبة من 0 إلى 99.99، أو فارغ (كل الفاقد طبيعي)." },
  COST_UNIT_INVALID: { status: 400, en: "A unit cost is a decimal ≥ 0 with at most 6 decimals.", ar: "تكلفة الوحدة رقم عشري ≥ 0 بست خانات عشرية كحد أقصى." },
  COST_MOVE_IMMUTABLE: { status: 409, en: "The cost sub-ledger is append-only.", ar: "سجل التكلفة لا يُعدَّل ولا يُحذف." },
  AP_INVOICE_POSTED: { status: 409, en: "A posted supplier invoice is frozen.", ar: "فاتورة المورد المرحّلة مجمّدة." },
  // Review L-3: the commission payable is kept per employee (party = the HR record), so the ledger refuses an accrual
  // or a payout for a login that is not linked to an HR employee rather than post it with no party.
  COMMISSION_NO_HR_PERSON: { status: 409, en: "This sales login is not linked to an employee record in HR, so its commission cannot be booked to the employee's commission payable. Link the login to its HR employee (HR › Employees), then retry.", ar: "حساب المندوب غير مرتبط بسجل موظف في الموارد البشرية، فلا تُقيَّد عمولته على ذمة الموظف. اربط الحساب بسجل الموظف (الموارد البشرية › الموظفون) ثم أعد المحاولة." },
  // «نقص من المورد» (20261119090000_supplier_shortfall).
  SHORTFALL_INVALID: { status: 400, en: "The quantity on the supplier's invoice is at least the quantity received (at most 4 decimals); the shortfall is the difference.", ar: "الكمية في فاتورة المورد لا تقل عن الكمية المستلمة (4 خانات عشرية كحد أقصى)، والنقص هو الفرق." },
  SHORTFALL_REASON: { status: 400, en: "Writing a shortfall off as a loss needs a reason (3 characters or more).", ar: "تسجيل النقص كخسارة يحتاج سببًا (3 أحرف على الأقل)." },
  SHORTFALL_LOSS_REQUIRED: { status: 403, en: "Writing a supplier shortfall off as a loss needs the Inventory › Adjust permission and a fresh confirmation; claim it from the supplier instead.", ar: "تسجيل نقص المورد كخسارة يحتاج صلاحية «المخزون › تسوية» وتأكيد الهوية؛ أو طالب المورد به بدلًا من ذلك." },
  SHORTFALL_TAX: { status: 400, en: "A shortfall is recorded on a stock line whose VAT is recoverable or nil (a not-recoverable VAT is part of the cost).", ar: "يُسجَّل النقص على سطر مخزون ضريبته قابلة للاسترداد أو بلا ضريبة (الضريبة غير القابلة للاسترداد جزء من التكلفة)." },
  CLAIM_SETTLED: { status: 409, en: "A supplier claim on this invoice is already settled in part or in full (credit note, replacement or abandonment): undo that first.", ar: "مطالبة المورد على هذه الفاتورة سُوّيت كليًا أو جزئيًا (إشعار دائن أو بضاعة بديلة أو تنازل): ألغِ التسوية أولًا." },
  CLAIM_STATE: { status: 409, en: "The supplier claim is not open.", ar: "مطالبة المورد ليست مفتوحة." },
  CLAIM_AMOUNT: { status: 400, en: "The amount is above zero and at most what is still open on the claim.", ar: "المبلغ أكبر من صفر ولا يتجاوز المتبقي المفتوح من المطالبة." },
  CREDIT_NOTE_VAT: { status: 400, en: "The credit note's VAT is the computed one within ±0.01 (and at most the claim's open VAT): expected", ar: "ضريبة الإشعار هي المحسوبة بفارق ±0.01 على الأكثر (ولا تتجاوز ضريبة المطالبة المفتوحة): المتوقع" },
  CLAIM_OPENING_PENDING: { status: 409, en: "This claim was opened before accounting went live, so the books hold it only through the opening balances: apply the opening valuation (its «open supplier claims» line) and post the opening first.", ar: "فُتحت هذه المطالبة قبل تفعيل المحاسبة، فلا تظهر في الدفاتر إلا عبر الأرصدة الافتتاحية: طبّق التقييم الافتتاحي (سطر «مطالبات الموردين المفتوحة») ورحّل الأرصدة الافتتاحية أولًا." },
  CLAIM_FROZEN: { status: 409, en: "A supplier claim's, settlement's or credit note's amounts never change; cancel and record it again.", ar: "مبالغ المطالبة أو تسويتها أو الإشعار الدائن لا تتغير؛ ألغِه وسجّله من جديد." },
  CREDIT_NOTE_STATE: { status: 409, en: "The supplier credit note is not in a state that allows this.", ar: "حالة الإشعار الدائن لا تسمح بهذا الإجراء." },
  GRN_CLAIM_REPLACEMENT: { status: 409, en: "This receipt is replacement goods for a supplier claim (already billed on the claim's invoice); it is not matched to another bill.", ar: "هذا الاستلام بضاعة بديلة عن مطالبة مورد (مفوترة في فاتورة المطالبة)، فلا يُطابَق بفاتورة أخرى." },
  CREDIT_NOTE_REF_REQUIRED: { status: 400, en: "Enter the supplier's credit note number.", ar: "أدخل رقم الإشعار الدائن لدى المورد." },
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
  if (/AP_CLAIM_KEPT/.test(message)) return opsRefuse("CLAIM_SETTLED");
  if (/AP_CLAIM_FROZEN|AP_CREDIT_NOTE_FROZEN/.test(message)) return opsRefuse("CLAIM_FROZEN");
  if (/AP_INVOICE_POSTED/.test(message)) return opsRefuse("AP_INVOICE_POSTED");
  if (/AP_INVOICE_DELETE/.test(message)) return opsRefuse("INVOICE_NUMBER_ISSUED");
  if (/TAX_CATEGORY_FROZEN/.test(message)) return opsRefuse("TAX_CATEGORY_FROZEN");
  if (/SupplierInvoice_supplier_ref_live_key/.test(message)) return opsRefuse("SUPPLIER_REF_DUPLICATE");
  return null;
}
