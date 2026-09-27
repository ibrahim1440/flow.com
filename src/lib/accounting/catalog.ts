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

export const POLICY_BY_EVENT = new Map<string, string>(
  POLICIES.flatMap((p) => p.governs.map((e) => [e, p.key] as [string, string])),
);
