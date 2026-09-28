// Posting roles and accounting policies the engine knows about. Account codes are never
// hard-coded in a translator: a translator asks for a role, and AccountMapping says which
// account plays it. Policies are the approvable statements a posting depends on.

export type RoleDef = { role: string; en: string; ar: string; usedBy: string };

export const POSTING_ROLES: RoleDef[] = [
  { role: "COMMISSION_EXPENSE", en: "Sales commission expense", ar: "مصروف عمولات المبيعات", usedBy: "commissions" },
  { role: "COMMISSION_PAYABLE", en: "Commissions payable (control)", ar: "عمولات مستحقة الدفع (حساب مراقبة)", usedBy: "commissions" },
  { role: "COMMISSION_PAYMENT_CLEARING", en: "Commission payments clearing", ar: "حساب وسيط لمدفوعات العمولات", usedBy: "commissions" },
  { role: "RETAINED_EARNINGS", en: "Retained earnings (year-end close)", ar: "الأرباح المبقاة (إقفال السنة)", usedBy: "closing" },
  { role: "OPENING_BALANCE_EQUITY", en: "Opening balance equity (cutover)", ar: "حقوق ملكية الأرصدة الافتتاحية", usedBy: "opening" },
  { role: "AP_CONTROL", en: "Trade payables (control)", ar: "ذمم دائنة تجارية (حساب مراقبة)", usedBy: "payables" },
  { role: "GRNI", en: "Goods received not invoiced (stock lines until valuation)", ar: "بضاعة مستلمة لم تصل فاتورتها (بنود المخزون حتى التقييم)", usedBy: "payables" },
  { role: "INPUT_VAT", en: "Input VAT", ar: "ضريبة القيمة المضافة على المدخلات", usedBy: "payables" },
  { role: "SUPPLIER_ADVANCES", en: "Supplier advances", ar: "دفعات مقدمة للموردين", usedBy: "bank" },
  { role: "BANK_FEES", en: "Bank fees", ar: "رسوم بنكية", usedBy: "bank" },
  { role: "AR_CONTROL", en: "Trade receivables (control)", ar: "ذمم مدينة تجارية (حساب مراقبة)", usedBy: "receivables" },
  { role: "CUSTOMER_ADVANCES", en: "Customer advances (control)", ar: "دفعات مقدمة من العملاء (حساب مراقبة)", usedBy: "receivables" },
  { role: "OUTPUT_VAT", en: "Output VAT", ar: "ضريبة القيمة المضافة على المخرجات", usedBy: "receivables" },
  { role: "SALES_REVENUE", en: "Sales revenue (default for invoice lines)", ar: "إيرادات المبيعات (الافتراضي لبنود الفواتير)", usedBy: "receivables" },
  { role: "SALES_RETURNS", en: "Sales returns and allowances (credit notes)", ar: "مردودات وخصومات المبيعات (إشعارات دائنة)", usedBy: "receivables" },
  { role: "INVENTORY_RAW", en: "Inventory — raw materials (green coffee, milk, bakery ingredients)", ar: "مخزون المواد الخام (بن أخضر، حليب، مكونات المخبز)", usedBy: "inventory" },
  { role: "INVENTORY_PACKAGING", en: "Inventory — packaging and consumables", ar: "مخزون مواد التغليف والمستهلكات", usedBy: "inventory" },
  { role: "INVENTORY_WIP", en: "Inventory — work in progress (roasted coffee not yet packed)", ar: "مخزون تحت التشغيل (بن محمص لم يُعبأ)", usedBy: "inventory" },
  { role: "INVENTORY_FINISHED", en: "Inventory — finished goods", ar: "مخزون البضاعة التامة الصنع", usedBy: "inventory" },
  { role: "INVENTORY_RESALE", en: "Inventory — goods for resale", ar: "مخزون البضاعة بغرض البيع", usedBy: "inventory" },
  { role: "COGS", en: "Cost of goods sold (and café internal use)", ar: "تكلفة البضاعة المباعة (والاستهلاك الداخلي للمقهى)", usedBy: "inventory" },
  { role: "ABNORMAL_LOSS", en: "Abnormal production loss (beyond the approved band)", ar: "فاقد إنتاج غير طبيعي (يتجاوز النطاق المعتمد)", usedBy: "inventory" },
  { role: "WASTE_CALIBRATION", en: "Calibration waste", ar: "هدر المعايرة", usedBy: "inventory" },
  { role: "WASTE_QC", en: "QC testing waste", ar: "هدر اختبارات الجودة", usedBy: "inventory" },
  { role: "WASTE_TRAINING", en: "Training waste", ar: "هدر التدريب", usedBy: "inventory" },
  { role: "INVENTORY_VARIANCE", en: "Inventory variance, spoilage and count differences", ar: "فروقات المخزون والتلف وفروق الجرد", usedBy: "inventory" },
];

export const ROLE_SET = new Set(POSTING_ROLES.map((r) => r.role));

export type PolicyDef = { key: string; en: string; ar: string; governs: string[]; defaultStatement: string };

export const POLICIES: PolicyDef[] = [
  {
    key: "commissions.recognition",
    en: "Sales commission recognition",
    ar: "إثبات عمولات المبيعات",
    governs: ["commission.accrual", "commission.reversal", "commission.adjustment", "commission.payout"],
    defaultStatement:
      "يُثبت مصروف العمولة والالتزام المقابل عندما يُنتج تحصيلٌ تحققت منه المالية حركةً في دفتر العمولات، بتاريخ تلك الحركة وبالمبلغ الذي يحسبه إصدار الخطة المعتمد. " +
      "تُثبت العكوس والتسويات عند تسجيلها ولا يُعدَّل قيد سابق. يسوّي الصرفُ الالتزامَ مقابل حساب وسيط لمدفوعات العمولات، ويُقفل البنكُ ذلك الحساب عند المطابقة فلا يُحمَّل المصروف مرتين. " +
      "لا يُرحّل إلا من إصدارات خطط معتمدة محاسبياً.\n\n" +
      "Commission expense and the related liability are recognised when a finance-verified sales collection " +
      "produces a commission ledger movement, on that movement's date, for the amount the approved plan version " +
      "computes. Reversals and adjustments are recognised when recorded, never by editing an earlier entry. " +
      "A payout settles the liability against the commission payments clearing account; the bank payment clears " +
      "that account when it is matched, so the payment is not expensed twice. Only plan versions approved for " +
      "accounting may post.",
  },
];

POLICIES.push(
  {
    key: "payables.recognition",
    en: "Supplier bill recognition",
    ar: "إثبات فواتير الموردين",
    governs: ["ap.bill.posted", "ap.bill.reversed"],
    defaultStatement:
      "تُثبت فاتورة المورد عند ترحيلها بعد اعتمادها من شخص غير مُعدّها، بتاريخ الفاتورة: مدين حساب المصروف أو الأصل لكل بند (وبنود البضاعة على حساب بضاعة مستلمة لم تصل فاتورتها حتى يُفعَّل تقييم المخزون)، ومدين ضريبة المدخلات بمبلغ الضريبة القابلة للاسترداد، ودائن الذمم الدائنة بإجمالي الفاتورة للمورد. " +
      "لا تُسترد ضريبة المدخلات إلا إذا كان للمورد رقم تسجيل ضريبي. يُعكس القيد بقيد مقابل ولا يُعدَّل، ولا يُعكس ما دامت عليه مدفوعات مطابقة. الدفع لا يُثبت من الفاتورة بل من سطر البنك المطابق.\n\n" +
      "A supplier bill is recognised when posted, after approval by someone other than its preparer, on the bill date: " +
      "each line's expense or asset account is debited (goods-received lines to goods received not invoiced until inventory " +
      "valuation is active), input VAT is debited for the recoverable tax, and trade payables are credited with the bill " +
      "total for the supplier. Input VAT is claimed only when the supplier has a VAT registration number. A posted bill is " +
      "reversed by a mirror entry, never edited, and cannot be reversed while payments are matched to it. Payment is " +
      "recognised from the matched bank line, not from the bill.",
  },
  {
    key: "bank.posting",
    en: "Bank transactions to the ledger",
    ar: "ترحيل الحركات البنكية إلى دفتر الأستاذ",
    governs: ["bank.transaction.confirmed", "bank.transaction.voided"],
    defaultStatement:
      "تُرحّل الحركة البنكية المؤكدة والمراجَعة من تاريخ بدء الترحيل البنكي بتاريخها: الطرف النقدي على حساب الأستاذ المرتبط بالحساب البنكي، والطرف المقابل على حساب فئة الميزانية لكل تقسيم. " +
      "التقسيم على حساب الذمم الدائنة لا يُرحّل إلا بقدر مطابقته لفواتير موردين مرحّلة. التحويل بين حسابات الشركة يُرحّل مرة واحدة. متحصلات العملاء وتسويات نقاط البيع لا تُرحّل قبل وحدة الذمم المدينة. إلغاء حركة مرحّلة يُنشئ قيداً عكسياً.\n\n" +
      "A confirmed and reviewed bank transaction dated on or after the bank posting start date posts on its date: the cash " +
      "side to the ledger account mapped to the cash account, the other side to each split's category account. A split on " +
      "the payables control account posts only to the extent it is matched to posted supplier bills. A transfer between " +
      "company accounts posts once. Customer receipts and POS/gateway settlements do not post until the receivables stage " +
      "exists. Voiding a posted transaction posts its mirror.",
  },
);

POLICIES.push(
  {
    key: "receivables.recognition",
    en: "Sales invoices, credit notes and receivables",
    ar: "فواتير المبيعات والإشعارات الدائنة والذمم المدينة",
    governs: ["ar.invoice.posted", "ar.invoice.reversed", "ar.credit_note.posted", "ar.credit_note.reversed", "ar.credit.allocated", "ar.credit.released"],
    defaultStatement:
      "تُثبت فاتورة المبيعات عند ترحيلها بعد اعتمادها من شخص غير مُعدّها، بتاريخ إصدارها (قرار توقيت الإيراد D-4: عند انتقال السيطرة — التسليم أو الأداء): مدين الذمم المدينة بإجمالي الفاتورة للعميل، ودائن حساب الإيراد لكل بند بصافيه، ودائن ضريبة المخرجات. " +
      "الإشعار الدائن يُصدر مقابل فاتورة مرحّلة ولا يتجاوز رصيدها: مدين المردودات والخصومات ومدين ضريبة المخرجات ودائن الذمم المدينة. الفاتورة المرحّلة لا تُعدّل؛ تُعكس بقيد مقابل ما لم يُخصص لها تحصيل أو إشعار. " +
      "التحصيل لا يُثبت من الفاتورة بل من سطر البنك المسند للعميل. تكلفة المبيعات تنتظر تقييم المخزون (D-1).\n\n" +
      "A sales invoice is recognised when posted, after approval by someone other than its preparer, on its issue date " +
      "(decision D-4, revenue timing: at transfer of control — delivery or performance): receivables are debited with the " +
      "invoice total for the customer, each line's revenue account is credited with its net amount, and output VAT is " +
      "credited. A credit note is issued against a posted invoice and never exceeds it: sales returns and allowances and " +
      "output VAT are debited and receivables credited. A posted invoice is never edited; it is reversed by a mirror entry " +
      "unless receipts or credits are allocated to it. Collection is recognised from the bank line assigned to the customer, " +
      "not from the invoice. Cost of sales waits for inventory valuation (D-1).",
  },
  {
    key: "receivables.advances",
    en: "Customer advances and VAT on advances",
    ar: "الدفعات المقدمة من العملاء وضريبتها",
    governs: ["ar.advance.applied", "ar.advance.reversed"],
    defaultStatement:
      "ما يزيد من تحصيل العميل عن الفواتير المرحّلة المفتوحة له عند إسناد التحصيل يُثبت دفعةً مقدمة (التزام) للعميل. " +
      "قرار D-2 (إعداد «ضريبة الدفعات المقدمة»): عند اختيار «عند الاستلام» تُحتسب ضريبة المخرجات على الدفعة المقدمة يوم استلامها وتُصدر فاتورة ضريبية للدفعة، وتُعكس تلك الضريبة عند تطبيق الدفعة على الفاتورة النهائية التي تحمل ضريبتها كاملة. " +
      "تطبيق الدفعة على فاتورة ينقل المبلغ من الدفعات المقدمة إلى الذمم المدينة.\n\n" +
      "The part of a customer receipt above the customer's open posted invoices at assignment is recognised as a customer " +
      "advance (a liability). Decision D-2 (setting \"VAT on advances\"): when set to at receipt, output VAT is charged on the " +
      "advance when received, with a prepayment tax invoice, and reversed when the advance is applied to the final invoice, " +
      "which carries the full VAT. Applying an advance to an invoice moves the amount from customer advances to receivables.",
  },
  {
    key: "inventory.costing",
    en: "Inventory valuation and production costing (D-1)",
    ar: "تقييم المخزون وتكاليف الإنتاج (D-1)",
    governs: ["inv.document.posted"],
    defaultStatement:
      "يُقيَّم المخزون بطريقة التكلفة المختارة في إعداد «طريقة تكلفة المخزون» (قرار D-1)، لكل صنف وموقع. الاستلام من المورد: مدين المخزون بتكلفة الاستلام ودائن «بضاعة مستلمة لم تصل فاتورتها». " +
      "الإنتاج (التحميص، التعبئة، الخبز): تُصرف المدخلات بتكلفتها وتُحمَّل على المخرجات؛ الفاقد داخل نطاق الفاقد المعتمد للعملية يُمتص في تكلفة المخرجات، وما يتجاوزه يُقيَّم بتكلفة وحدة المخرجات المتوقعة ويُحمَّل على «فاقد إنتاج غير طبيعي». " +
      "البيع: تكلفة البضاعة المباعة بتاريخ فاتورة المبيعات المرحّلة. هدر المعايرة والجودة والتدريب يُحمَّل على حساباته، والتلف وفروق الجرد على «فروقات المخزون»، والاستهلاك الداخلي للمقهى على تكلفة المبيعات. " +
      "التكاليف الإضافية (الشحن والجمارك) وفرق سعر فاتورة المورد عن الاستلام تُضاف للمخزون المتبقي من ذلك الاستلام، وما استُهلك منه يُحمَّل على تكلفة المبيعات (أو يُحمَّل كله على الفروقات حسب الإعداد). " +
      "لا يُرحّل مستند بتاريخ يسبق حركة مرحّلة للصنف والموقع نفسيهما، ولا يُسمح برصيد سالب.\n\n" +
      "Inventory is valued per item and location by the method chosen in the setting \"inventory costing method\" (decision D-1). " +
      "A goods receipt debits inventory at the receipt cost and credits goods received not invoiced. Production (roasting, packing, " +
      "baking) issues inputs at cost into the outputs; loss within the process's approved loss band is absorbed into the output cost, " +
      "loss beyond it is valued at the cost per unit of expected output and charged to abnormal production loss. Cost of sales is " +
      "recognised on the date of the posted sales invoice. Calibration, QC and training waste go to their accounts, spoilage and count " +
      "differences to inventory variance, and café internal use to cost of sales. Landed costs (freight, customs) and a supplier bill's " +
      "price difference from the receipt are added to what is still on hand from that receipt, the part already used going to cost of " +
      "sales (or all to variance, per the setting). No document posts on a date before a posted movement of the same item and location, " +
      "and stock never goes negative.",
  },
);

export const POLICY_BY_EVENT = new Map<string, string>(
  POLICIES.flatMap((p) => p.governs.map((e) => [e, p.key] as [string, string])),
);
