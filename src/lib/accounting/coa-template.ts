// A starting chart of accounts for a Saudi roastery / café / bakery business. It is a
// TEMPLATE for the accountant to review before go-live (docs/accounting/POLICIES.md), not a
// statement of the company's approved chart. Codes named in the accounting spec (2410
// customer advances, 5700 inventory variance, 6500 delivery, 6900 bank fees) are kept.
// VAT accounts accept manual journals until the invoicing subledger exists (POS / sales
// summaries are journalised by hand today); switch allowManualPosting off when it does.
import type { AccountControlKind, AccountType } from "@/generated/prisma/client";

export type TemplateAccount = {
  code: string; en: string; ar: string; type: AccountType; parent?: string;
  control?: AccountControlKind; manual?: boolean; header?: boolean;
};

export const COA_TEMPLATE: TemplateAccount[] = [
  { code: "1", en: "Assets", ar: "الأصول", type: "ASSET", header: true },
  { code: "11", en: "Current assets", ar: "الأصول المتداولة", type: "ASSET", parent: "1", header: true },
  { code: "1110", en: "Cash on hand", ar: "النقدية في الصندوق", type: "ASSET", parent: "11", control: "CASH" },
  { code: "1120", en: "Bank accounts", ar: "الحسابات البنكية", type: "ASSET", parent: "11", control: "CASH" },
  { code: "1130", en: "Trade receivables", ar: "ذمم مدينة تجارية", type: "ASSET", parent: "11", control: "RECEIVABLE", manual: false },
  { code: "1140", en: "Employee custody and advances", ar: "عهد وسلف الموظفين", type: "ASSET", parent: "11" },
  { code: "1150", en: "Prepaid expenses", ar: "مصروفات مدفوعة مقدماً", type: "ASSET", parent: "11" },
  { code: "1160", en: "Input VAT", ar: "ضريبة القيمة المضافة على المدخلات", type: "ASSET", parent: "11", control: "TAX", manual: true },
  { code: "117", en: "Inventory", ar: "المخزون", type: "ASSET", parent: "11", header: true },
  { code: "1171", en: "Inventory — raw materials", ar: "مخزون مواد خام", type: "ASSET", parent: "117", control: "INVENTORY", manual: false },
  { code: "1172", en: "Inventory — packaging and consumables", ar: "مخزون مواد تغليف ومستهلكات", type: "ASSET", parent: "117", control: "INVENTORY", manual: false },
  { code: "1173", en: "Inventory — work in progress", ar: "مخزون إنتاج تحت التشغيل", type: "ASSET", parent: "117", control: "INVENTORY", manual: false },
  { code: "1174", en: "Inventory — finished goods", ar: "مخزون بضاعة تامة الصنع", type: "ASSET", parent: "117", control: "INVENTORY", manual: false },
  { code: "1175", en: "Inventory — goods for resale", ar: "مخزون بضاعة بغرض البيع", type: "ASSET", parent: "117", control: "INVENTORY", manual: false },
  { code: "12", en: "Non-current assets", ar: "الأصول غير المتداولة", type: "ASSET", parent: "1", header: true },
  { code: "1210", en: "Machinery and equipment", ar: "الآلات والمعدات", type: "ASSET", parent: "12" },
  { code: "1220", en: "Furniture and fit-out", ar: "الأثاث والتجهيزات", type: "ASSET", parent: "12" },
  { code: "1230", en: "Vehicles", ar: "السيارات", type: "ASSET", parent: "12" },
  { code: "1290", en: "Accumulated depreciation", ar: "مجمع الإهلاك", type: "ASSET", parent: "12" },
  { code: "2", en: "Liabilities", ar: "الالتزامات", type: "LIABILITY", header: true },
  { code: "21", en: "Current liabilities", ar: "الالتزامات المتداولة", type: "LIABILITY", parent: "2", header: true },
  { code: "2110", en: "Trade payables", ar: "ذمم دائنة تجارية", type: "LIABILITY", parent: "21", control: "PAYABLE", manual: false },
  { code: "2120", en: "Goods received not invoiced", ar: "بضاعة مستلمة لم تصل فاتورتها", type: "LIABILITY", parent: "21", control: "CLEARING", manual: false },
  { code: "2130", en: "Accrued expenses", ar: "مصروفات مستحقة", type: "LIABILITY", parent: "21" },
  { code: "2140", en: "Commissions payable", ar: "عمولات مستحقة الدفع", type: "LIABILITY", parent: "21", control: "COMMISSION_PAYABLE", manual: false },
  { code: "2150", en: "Salaries payable", ar: "رواتب مستحقة", type: "LIABILITY", parent: "21" },
  { code: "2160", en: "GOSI payable", ar: "التأمينات الاجتماعية المستحقة", type: "LIABILITY", parent: "21" },
  { code: "2170", en: "Output VAT", ar: "ضريبة القيمة المضافة على المخرجات", type: "LIABILITY", parent: "21", control: "TAX", manual: true },
  { code: "2180", en: "Zakat payable", ar: "الزكاة المستحقة", type: "LIABILITY", parent: "21" },
  { code: "2190", en: "Payments clearing", ar: "حساب وسيط للمدفوعات", type: "LIABILITY", parent: "21", control: "CLEARING", manual: false },
  { code: "2410", en: "Customer advances", ar: "دفعات مقدمة من العملاء", type: "LIABILITY", parent: "21", control: "CUSTOMER_ADVANCES", manual: false },
  { code: "22", en: "Non-current liabilities", ar: "الالتزامات غير المتداولة", type: "LIABILITY", parent: "2", header: true },
  { code: "2210", en: "End-of-service benefits", ar: "مخصص مكافأة نهاية الخدمة", type: "LIABILITY", parent: "22" },
  { code: "3", en: "Equity", ar: "حقوق الملكية", type: "EQUITY", header: true },
  { code: "3100", en: "Capital", ar: "رأس المال", type: "EQUITY", parent: "3" },
  { code: "3200", en: "Retained earnings", ar: "الأرباح المبقاة", type: "EQUITY", parent: "3" },
  { code: "3900", en: "Opening balance equity", ar: "حقوق ملكية الأرصدة الافتتاحية", type: "EQUITY", parent: "3" },
  { code: "4", en: "Revenue", ar: "الإيرادات", type: "REVENUE", header: true },
  { code: "4100", en: "Sales — roasted and packaged coffee", ar: "مبيعات القهوة المحمصة والمعبأة", type: "REVENUE", parent: "4" },
  { code: "4200", en: "Sales — café", ar: "مبيعات المقهى", type: "REVENUE", parent: "4" },
  { code: "4300", en: "Sales — bakery and desserts", ar: "مبيعات المخبوزات والحلويات", type: "REVENUE", parent: "4" },
  { code: "4900", en: "Sales returns and discounts", ar: "مردودات وخصومات المبيعات", type: "REVENUE", parent: "4" },
  { code: "5", en: "Cost of sales", ar: "تكلفة المبيعات", type: "EXPENSE", header: true },
  { code: "5100", en: "Cost of goods sold", ar: "تكلفة البضاعة المباعة", type: "EXPENSE", parent: "5" },
  { code: "5300", en: "Abnormal roasting loss", ar: "فاقد تحميص غير طبيعي", type: "EXPENSE", parent: "5" },
  { code: "5400", en: "Calibration waste", ar: "هدر المعايرة", type: "EXPENSE", parent: "5" },
  { code: "5500", en: "QC testing waste", ar: "هدر اختبارات الجودة", type: "EXPENSE", parent: "5" },
  { code: "5600", en: "Training waste", ar: "هدر التدريب", type: "EXPENSE", parent: "5" },
  { code: "5700", en: "Inventory variance / shrinkage", ar: "فروقات وعجز المخزون", type: "EXPENSE", parent: "5" },
  { code: "6", en: "Operating expenses", ar: "المصروفات التشغيلية", type: "EXPENSE", header: true },
  { code: "6100", en: "Salaries and wages", ar: "الرواتب والأجور", type: "EXPENSE", parent: "6" },
  { code: "6150", en: "Sales commissions", ar: "عمولات المبيعات", type: "EXPENSE", parent: "6" },
  { code: "6200", en: "Rent", ar: "الإيجار", type: "EXPENSE", parent: "6" },
  { code: "6300", en: "Utilities", ar: "المرافق", type: "EXPENSE", parent: "6" },
  { code: "6400", en: "Marketing", ar: "التسويق", type: "EXPENSE", parent: "6" },
  { code: "6500", en: "Delivery and shipping", ar: "التوصيل والشحن", type: "EXPENSE", parent: "6" },
  { code: "6600", en: "Depreciation", ar: "الإهلاك", type: "EXPENSE", parent: "6" },
  { code: "6700", en: "Repairs and maintenance", ar: "الصيانة والإصلاح", type: "EXPENSE", parent: "6" },
  { code: "6800", en: "Professional fees", ar: "أتعاب مهنية", type: "EXPENSE", parent: "6" },
  { code: "6900", en: "Bank fees", ar: "رسوم بنكية", type: "EXPENSE", parent: "6" },
  { code: "6950", en: "Zakat", ar: "الزكاة", type: "EXPENSE", parent: "6" },
];

/** Default role → template code. Applied with the template; each is editable afterwards. */
export const TEMPLATE_MAPPINGS: Record<string, string> = {
  COMMISSION_EXPENSE: "6150",
  COMMISSION_PAYABLE: "2140",
  COMMISSION_PAYMENT_CLEARING: "2190",
  RETAINED_EARNINGS: "3200",
  OPENING_BALANCE_EQUITY: "3900",
};
