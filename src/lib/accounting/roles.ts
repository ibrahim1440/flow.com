// Accounting core A1 — the SYSTEM POSTING ROLES. Later phases post only by role ("debit AR, credit SALES_REVENUE,
// credit VAT_OUTPUT"), never by an account number; the owner maps each role to an account of the chart
// (AccountRole, «ربط الحسابات»). Pure catalogue: no database. docs/accounting/POSTING-CONTRACT.md §3 lists the
// same roles with their events.
export type AccountTypeKey = "ASSET" | "LIABILITY" | "EQUITY" | "REVENUE" | "EXPENSE";
export type RolePhase = "A1" | "A2" | "A3";

export type RoleDef = {
  key: string;
  ar: string;
  en: string;
  group: "cash" | "receivables" | "payables" | "revenue" | "tax" | "inventory" | "cost" | "payroll" | "commission" | "equity" | "other";
  /** The phase whose events post to it (the readiness check lists unmapped roles per phase). */
  phase: RolePhase;
  /** The account types the role may map to (a mapping to another type is refused). */
  types: AccountTypeKey[];
  /** The account code of the default chart (src/lib/accounting/coa-template.ts) it maps to on seeding. */
  seedCode: string;
  /** Activation refuses while unmapped (A1's own postings need it). */
  requiredForActivation?: boolean;
};

export const ACCOUNT_ROLES: RoleDef[] = [
  { key: "CASH", ar: "النقدية في الصندوق", en: "Cash on hand", group: "cash", phase: "A2", types: ["ASSET"], seedCode: "1111" },
  { key: "BANK", ar: "البنك", en: "Bank", group: "cash", phase: "A2", types: ["ASSET"], seedCode: "1121" },
  { key: "CARD_CLEARING", ar: "مدفوعات البطاقات تحت التسوية", en: "Card payments clearing", group: "cash", phase: "A2", types: ["ASSET"], seedCode: "1131" },
  { key: "DELIVERY_APP_RECEIVABLE", ar: "مستحقات تطبيقات التوصيل", en: "Delivery-app receivable", group: "cash", phase: "A2", types: ["ASSET"], seedCode: "1133" },
  { key: "AR", ar: "الذمم المدينة", en: "Accounts receivable", group: "receivables", phase: "A2", types: ["ASSET"], seedCode: "1140" },
  { key: "CUSTOMER_ADVANCES", ar: "دفعات مقدمة من العملاء", en: "Customer advances", group: "receivables", phase: "A2", types: ["LIABILITY"], seedCode: "2155" },
  { key: "AP", ar: "الذمم الدائنة", en: "Accounts payable", group: "payables", phase: "A3", types: ["LIABILITY"], seedCode: "2110" },
  { key: "GRNI", ar: "بضاعة مستلمة لم تُرحَّل فاتورتها", en: "Received, not yet billed in the books", group: "payables", phase: "A3", types: ["LIABILITY"], seedCode: "2115" },
  { key: "SUPPLIER_ADVANCES", ar: "دفعات مقدمة للموردين", en: "Supplier advances", group: "payables", phase: "A3", types: ["ASSET"], seedCode: "1165" },
  { key: "SUPPLIER_CLAIMS", ar: "مطالبات الموردين", en: "Supplier claims", group: "payables", phase: "A3", types: ["ASSET"], seedCode: "1167" },
  { key: "SALES_REVENUE", ar: "إيرادات المبيعات (الجملة)", en: "Sales revenue (wholesale)", group: "revenue", phase: "A2", types: ["REVENUE"], seedCode: "4200" },
  { key: "SALES_REVENUE_CAFE", ar: "إيرادات المقهى", en: "Sales revenue (café)", group: "revenue", phase: "A2", types: ["REVENUE"], seedCode: "4100" },
  { key: "SALES_REVENUE_ONLINE", ar: "إيرادات المتجر الإلكتروني", en: "Sales revenue (online)", group: "revenue", phase: "A2", types: ["REVENUE"], seedCode: "4300" },
  { key: "SALES_RETURNS", ar: "مردودات وخصومات المبيعات", en: "Sales returns & discounts", group: "revenue", phase: "A2", types: ["REVENUE"], seedCode: "4900" },
  { key: "VAT_OUTPUT", ar: "ضريبة القيمة المضافة - المخرجات", en: "VAT output", group: "tax", phase: "A2", types: ["LIABILITY"], seedCode: "2120" },
  { key: "VAT_INPUT", ar: "ضريبة القيمة المضافة - المدخلات", en: "VAT input", group: "tax", phase: "A3", types: ["ASSET"], seedCode: "1170" },
  { key: "VAT_NET_PAYABLE", ar: "ضريبة القيمة المضافة - صافي مستحق", en: "VAT net payable", group: "tax", phase: "A3", types: ["LIABILITY"], seedCode: "2125" },
  { key: "INVENTORY_GREEN", ar: "مخزون البن الأخضر", en: "Inventory – green coffee", group: "inventory", phase: "A3", types: ["ASSET"], seedCode: "1151" },
  { key: "WIP_ROASTING", ar: "إنتاج تحت التشغيل - التحميص", en: "WIP – roasting", group: "inventory", phase: "A3", types: ["ASSET"], seedCode: "1156" },
  { key: "INVENTORY_ROASTED", ar: "مخزون البن المحمص", en: "Inventory – roasted coffee", group: "inventory", phase: "A3", types: ["ASSET"], seedCode: "1152" },
  { key: "INVENTORY_PACKED", ar: "مخزون المنتجات المعبأة", en: "Inventory – packed coffee", group: "inventory", phase: "A3", types: ["ASSET"], seedCode: "1153" },
  { key: "INVENTORY_PACKAGING", ar: "مخزون مواد التغليف", en: "Inventory – packaging", group: "inventory", phase: "A3", types: ["ASSET"], seedCode: "1155" },
  { key: "INVENTORY_CAFE", ar: "مخزون مواد المقهى", en: "Inventory – café consumables", group: "inventory", phase: "A3", types: ["ASSET"], seedCode: "1154" },
  { key: "COGS", ar: "تكلفة المبيعات (الجملة)", en: "COGS (wholesale)", group: "cost", phase: "A3", types: ["EXPENSE"], seedCode: "5200" },
  { key: "COGS_CAFE", ar: "تكلفة مبيعات المقهى", en: "COGS (café)", group: "cost", phase: "A3", types: ["EXPENSE"], seedCode: "5100" },
  { key: "ROAST_LOSS", ar: "فاقد التحميص غير الطبيعي", en: "Abnormal roast loss", group: "cost", phase: "A3", types: ["EXPENSE"], seedCode: "5410" },
  { key: "WASTAGE", ar: "الهالك والتالف", en: "Wastage & spoilage", group: "cost", phase: "A3", types: ["EXPENSE"], seedCode: "5400" },
  { key: "INVENTORY_VARIANCE", ar: "فروقات الجرد", en: "Inventory count variance", group: "cost", phase: "A3", types: ["EXPENSE"], seedCode: "5500" },
  { key: "PURCHASE_SHORTAGE", ar: "خسائر نقص المشتريات", en: "Purchase shortage losses", group: "cost", phase: "A3", types: ["EXPENSE"], seedCode: "5420" },
  { key: "APPLIED_ROASTING_OVERHEAD", ar: "تكاليف التحميص غير المباشرة المحملة", en: "Applied roasting overhead", group: "cost", phase: "A3", types: ["EXPENSE"], seedCode: "5600" },
  { key: "SALARIES_EXPENSE", ar: "الرواتب والأجور", en: "Salaries expense", group: "payroll", phase: "A3", types: ["EXPENSE"], seedCode: "6100" },
  { key: "SALARIES_PAYABLE", ar: "الرواتب المستحقة", en: "Salaries payable", group: "payroll", phase: "A3", types: ["LIABILITY"], seedCode: "2130" },
  { key: "GOSI_EXPENSE", ar: "التأمينات الاجتماعية - حصة الشركة", en: "GOSI expense (employer)", group: "payroll", phase: "A3", types: ["EXPENSE"], seedCode: "6110" },
  { key: "GOSI_PAYABLE", ar: "التأمينات الاجتماعية المستحقة", en: "GOSI payable", group: "payroll", phase: "A3", types: ["LIABILITY"], seedCode: "2135" },
  { key: "EOSB_EXPENSE", ar: "مكافأة نهاية الخدمة", en: "End-of-service expense", group: "payroll", phase: "A3", types: ["EXPENSE"], seedCode: "6120" },
  { key: "EOSB_PROVISION", ar: "مخصص مكافأة نهاية الخدمة", en: "End-of-service provision", group: "payroll", phase: "A3", types: ["LIABILITY"], seedCode: "2210" },
  { key: "EMPLOYEE_ADVANCES", ar: "سلف الموظفين", en: "Employee advances", group: "payroll", phase: "A3", types: ["ASSET"], seedCode: "1180" },
  { key: "COMMISSION_EXPENSE", ar: "عمولات المبيعات", en: "Sales commission expense", group: "commission", phase: "A3", types: ["EXPENSE"], seedCode: "6150" },
  { key: "COMMISSION_PAYABLE", ar: "عمولات مستحقة الدفع", en: "Commissions payable", group: "commission", phase: "A3", types: ["LIABILITY"], seedCode: "2145" },
  { key: "BANK_FEES", ar: "رسوم البنوك ونقاط البيع", en: "Bank & POS fees", group: "other", phase: "A2", types: ["EXPENSE"], seedCode: "6310" },
  { key: "DELIVERY_APP_COMMISSION", ar: "عمولات تطبيقات التوصيل", en: "Delivery-app commissions", group: "other", phase: "A2", types: ["EXPENSE"], seedCode: "6300" },
  { key: "ROUNDING", ar: "فروقات التقريب", en: "Rounding differences", group: "other", phase: "A1", types: ["EXPENSE"], seedCode: "6900", requiredForActivation: true },
  { key: "OPENING_BALANCE_EQUITY", ar: "حقوق ملكية الأرصدة الافتتاحية", en: "Opening balance equity", group: "equity", phase: "A1", types: ["EQUITY"], seedCode: "3900", requiredForActivation: true },
  { key: "RETAINED_EARNINGS", ar: "الأرباح المبقاة", en: "Retained earnings", group: "equity", phase: "A1", types: ["EQUITY"], seedCode: "3300" },
];

export type AccountRoleKey = (typeof ACCOUNT_ROLES)[number]["key"];

const BY_KEY = new Map(ACCOUNT_ROLES.map((r) => [r.key, r]));
export const roleDef = (key: string): RoleDef | undefined => BY_KEY.get(key);
export const isRoleKey = (key: unknown): key is string => typeof key === "string" && BY_KEY.has(key);
export const ACTIVATION_ROLES = ACCOUNT_ROLES.filter((r) => r.requiredForActivation).map((r) => r.key);
export const rolesOfPhase = (phase: RolePhase) => ACCOUNT_ROLES.filter((r) => r.phase === phase).map((r) => r.key);
