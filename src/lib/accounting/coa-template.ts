// Accounting core A1 — the DEFAULT chart of accounts for a specialty-coffee roastery + café in KSA (SOCPA /
// IFRS for SMEs), seeded ONLY when the owner asks («تهيئة دليل الحسابات»: POST /api/accounting/coa/seed; never
// automatically). Based on the accounting council's starting chart (council assets/chart-of-accounts.csv),
// adapted (each change marked ★ below):
//   ★ 1156 WIP – roasting (the roast batch holds cost between green issue and roasted output);
//   ★ 1165 supplier advances, 2155 customer advances (the AP / AR prepayment sides);
//   ★ 2145 commissions payable and 6150 sales commission expense (the commission engine's accrual / payout);
//   ★ 3900 opening balance equity (the opening-balance wizard's counter-entry, cleared to 3300 by the accountant);
//   ★ 5410 abnormal roast loss (normal loss is absorbed into roasted cost; only loss above standard is expensed);
//   ★ branch cash accounts are generic (1111 main branch, 1112 roastery) — the owner renames / adds branches.
// Control accounts (AR, AP, inventory, VAT, GRNI, payroll and commission liabilities) refuse MANUAL journals:
// they are fed by their sub-ledgers through the posting engine. Everything here is editable after seeding.
import type { AccountTypeKey } from "./roles";

export type CoaRow = {
  code: string;
  ar: string;
  en: string;
  type: AccountTypeKey;
  normal: "DEBIT" | "CREDIT";
  parent: string | null;
  postable: boolean;
  control: string | null;
  manual: boolean;
};

const A = "ASSET", L = "LIABILITY", E = "EQUITY", R = "REVENUE", X = "EXPENSE";
const D = "DEBIT", C = "CREDIT";
type T = [string, string, string, AccountTypeKey, "DEBIT" | "CREDIT", string | null, boolean, (string | null)?, boolean?];

const ROWS: T[] = [
  ["1000", "الأصول", "Assets", A, D, null, false],
  ["1100", "الأصول المتداولة", "Current assets", A, D, "1000", false],
  ["1110", "النقدية في الصناديق", "Cash on hand", A, D, "1100", false],
  ["1111", "صندوق الفرع الرئيسي", "Cash – main branch", A, D, "1110", true, "CASH"],
  ["1112", "صندوق المحمصة", "Cash – roastery", A, D, "1110", true, "CASH"],
  ["1120", "البنوك", "Banks", A, D, "1100", false],
  ["1121", "البنك - الحساب الجاري", "Bank – current account", A, D, "1120", true, "BANK"],
  ["1130", "حسابات وسيطة للتحصيل", "Clearing accounts", A, D, "1100", false],
  ["1131", "مدى - تحت التسوية", "mada card clearing", A, D, "1130", true, "CLEARING"],
  ["1132", "فيزا/ماستركارد - تحت التسوية", "Visa / Mastercard clearing", A, D, "1130", true, "CLEARING"],
  ["1133", "تطبيقات التوصيل - مستحقات", "Delivery-apps receivable", A, D, "1130", true, "CLEARING"],
  ["1140", "الذمم المدينة - عملاء الجملة", "Accounts receivable – B2B", A, D, "1100", true, "AR", false],
  ["1145", "مخصص الخسائر الائتمانية المتوقعة", "Expected credit loss allowance", A, C, "1100", true],
  ["1150", "المخزون", "Inventory", A, D, "1100", false],
  ["1151", "مخزون البن الأخضر", "Inventory – green coffee", A, D, "1150", true, "INVENTORY", false],
  ["1152", "مخزون البن المحمص", "Inventory – roasted coffee", A, D, "1150", true, "INVENTORY", false],
  ["1153", "مخزون المنتجات المعبأة", "Inventory – packed retail coffee", A, D, "1150", true, "INVENTORY", false],
  ["1154", "مخزون مواد المقهى", "Inventory – café consumables", A, D, "1150", true, "INVENTORY", false],
  ["1155", "مخزون مواد التغليف", "Inventory – packaging", A, D, "1150", true, "INVENTORY", false],
  ["1156", "إنتاج تحت التشغيل - التحميص", "Work in progress – roasting", A, D, "1150", true, "INVENTORY", false],
  ["1160", "مصروفات مدفوعة مقدماً", "Prepaid expenses", A, D, "1100", true],
  ["1165", "دفعات مقدمة للموردين", "Advances to suppliers", A, D, "1100", true],
  ["1170", "ضريبة القيمة المضافة - المدخلات", "VAT input recoverable", A, D, "1100", true, "VAT_INPUT", false],
  ["1180", "سلف الموظفين", "Employee advances", A, D, "1100", true],
  ["1200", "الأصول غير المتداولة", "Non-current assets", A, D, "1000", false],
  ["1210", "الآلات والمعدات (المحمصة والمكائن)", "Machinery & equipment (roaster, espresso)", A, D, "1200", true, "FIXED_ASSET"],
  ["1220", "تجهيزات وديكورات الفروع", "Leasehold improvements", A, D, "1200", true, "FIXED_ASSET"],
  ["1230", "الأثاث والأجهزة", "Furniture & IT equipment", A, D, "1200", true, "FIXED_ASSET"],
  ["1240", "السيارات", "Vehicles", A, D, "1200", true, "FIXED_ASSET"],
  ["1250", "حق استخدام الأصول المستأجرة", "Right-of-use assets", A, D, "1200", true],
  ["1290", "مجمع الإهلاك", "Accumulated depreciation", A, C, "1200", true, "FIXED_ASSET"],
  ["2000", "الالتزامات", "Liabilities", L, C, null, false],
  ["2100", "الالتزامات المتداولة", "Current liabilities", L, C, "2000", false],
  ["2110", "الذمم الدائنة - الموردين", "Accounts payable – suppliers", L, C, "2100", true, "AP", false],
  ["2115", "بضاعة مستلمة لم تصل فاتورتها", "Goods received not invoiced", L, C, "2100", true, "CLEARING", false],
  ["2120", "ضريبة القيمة المضافة - المخرجات", "VAT output payable", L, C, "2100", true, "VAT_OUTPUT", false],
  ["2125", "ضريبة القيمة المضافة - صافي مستحق", "VAT net payable", L, C, "2100", true],
  ["2130", "الرواتب المستحقة", "Salaries payable", L, C, "2100", true, "PAYROLL", false],
  ["2135", "التأمينات الاجتماعية المستحقة", "GOSI payable", L, C, "2100", true, "PAYROLL", false],
  ["2140", "مصروفات مستحقة", "Accrued expenses", L, C, "2100", true],
  ["2145", "عمولات مستحقة الدفع", "Commissions payable", L, C, "2100", true, "COMMISSION", false],
  ["2150", "إيرادات مؤجلة - بطاقات الهدايا والولاء", "Deferred revenue – gift cards & loyalty", L, C, "2100", true],
  ["2155", "دفعات مقدمة من العملاء", "Customer advances", L, C, "2100", true],
  ["2160", "إكراميات مستحقة للموظفين", "Tips payable to staff", L, C, "2100", true],
  ["2170", "الزكاة المستحقة", "Zakat payable", L, C, "2100", true],
  ["2180", "التزامات الإيجار - متداولة", "Lease liabilities – current", L, C, "2100", true],
  ["2200", "الالتزامات غير المتداولة", "Non-current liabilities", L, C, "2000", false],
  ["2210", "مخصص مكافأة نهاية الخدمة", "End-of-service benefits provision", L, C, "2200", true, "PAYROLL", false],
  ["2220", "قروض وتمويل طويل الأجل", "Long-term financing", L, C, "2200", true],
  ["2230", "التزامات الإيجار - غير متداولة", "Lease liabilities – non-current", L, C, "2200", true],
  ["3000", "حقوق الملكية", "Equity", E, C, null, false],
  ["3100", "رأس المال", "Share capital", E, C, "3000", true],
  ["3200", "الاحتياطي النظامي", "Statutory reserve", E, C, "3000", true],
  ["3300", "الأرباح المبقاة", "Retained earnings", E, C, "3000", true],
  ["3400", "جاري الشركاء", "Partners' current account", E, C, "3000", true],
  ["3900", "حقوق ملكية الأرصدة الافتتاحية", "Opening balance equity", E, C, "3000", true],
  ["4000", "الإيرادات", "Revenue", R, C, null, false],
  ["4100", "إيرادات المقهى", "Revenue – café", R, C, "4000", true],
  ["4200", "إيرادات الجملة", "Revenue – wholesale B2B", R, C, "4000", true],
  ["4300", "إيرادات المتجر الإلكتروني", "Revenue – online store", R, C, "4000", true],
  ["4400", "إيرادات تطبيقات التوصيل", "Revenue – delivery apps", R, C, "4000", true],
  ["4900", "مردودات وخصومات المبيعات", "Sales returns & discounts", R, D, "4000", true],
  ["5000", "تكلفة المبيعات", "Cost of sales", X, D, null, false],
  ["5100", "تكلفة مبيعات المقهى", "COGS – café", X, D, "5000", true],
  ["5200", "تكلفة مبيعات الجملة", "COGS – wholesale", X, D, "5000", true],
  ["5300", "تكلفة مبيعات المتجر الإلكتروني", "COGS – online", X, D, "5000", true],
  ["5400", "الهالك والتالف", "Wastage & spoilage", X, D, "5000", true],
  ["5410", "فاقد التحميص غير الطبيعي", "Abnormal roast loss", X, D, "5000", true],
  ["5500", "فروقات الجرد", "Inventory count variance", X, D, "5000", true],
  ["5600", "تكاليف التحميص غير المباشرة المحملة", "Applied roasting overhead", X, C, "5000", true],
  ["6000", "المصروفات التشغيلية", "Operating expenses", X, D, null, false],
  ["6100", "الرواتب والأجور", "Salaries & wages", X, D, "6000", true],
  ["6110", "التأمينات الاجتماعية - حصة الشركة", "GOSI – employer share", X, D, "6000", true],
  ["6120", "مكافأة نهاية الخدمة", "End-of-service expense", X, D, "6000", true],
  ["6130", "رسوم الإقامات ومكتب العمل", "Iqama & labour office fees", X, D, "6000", true],
  ["6150", "عمولات المبيعات", "Sales commissions", X, D, "6000", true],
  ["6200", "الإيجارات (قصيرة الأجل)", "Rent – short-term", X, D, "6000", true],
  ["6210", "الكهرباء والمياه", "Utilities", X, D, "6000", true],
  ["6220", "الصيانة", "Maintenance", X, D, "6000", true],
  ["6300", "عمولات تطبيقات التوصيل", "Delivery-app commissions", X, D, "6000", true],
  ["6310", "رسوم البنوك ونقاط البيع", "Bank & POS fees", X, D, "6000", true],
  ["6400", "التسويق والإعلان", "Marketing & advertising", X, D, "6000", true],
  ["6500", "الاشتراكات والبرمجيات", "Software & subscriptions", X, D, "6000", true],
  ["6600", "الإهلاك", "Depreciation", X, D, "6000", true],
  ["6610", "إهلاك حق الاستخدام", "Right-of-use depreciation", X, D, "6000", true],
  ["6700", "الرسوم الحكومية والتراخيص", "Government fees & licences", X, D, "6000", true],
  ["6800", "مصروفات متنوعة", "Miscellaneous", X, D, "6000", true],
  ["6900", "فروقات التقريب", "Rounding differences", X, D, "6000", true],
  ["7000", "المصروفات الأخرى والتمويلية", "Other & finance costs", X, D, null, false],
  ["7100", "تكاليف التمويل", "Finance costs", X, D, "7000", true],
  ["7200", "فوائد عقود الإيجار", "Lease interest", X, D, "7000", true],
  ["8000", "الزكاة", "Zakat", X, D, null, false],
  ["8100", "مصروف الزكاة", "Zakat expense", X, D, "8000", true],
];

export const COA_TEMPLATE_KEY = "hiqbah-roastery-cafe-ksa-v1";

export const COA_TEMPLATE: CoaRow[] = ROWS.map(([code, ar, en, type, normal, parent, postable, control, manual]) => ({
  code, ar, en, type, normal, parent, postable, control: control ?? null, manual: manual ?? true,
}));
