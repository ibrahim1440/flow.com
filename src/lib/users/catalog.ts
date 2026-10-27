// «المستخدمون والأدوار والصلاحيات» (Figma Phase 8, page 596:2) — the permission catalogue as the
// screens name it. Pure: no server dependency, shared by the routes, the pages and the tests.
//
// The module and action KEYS are the existing ones (src/lib/auth-shared.ts) and are not changed;
// this file only gives them their Arabic labels, groups them into the owner's groups (P-6, users.py
// GROUPS) and says which are SENSITIVE (P-3). The labels drawn in Figma are used where Figma draws
// them; the others are drafts subject to the owner's terminology review (O-8).
import { ALL_MODULES, MODULE_SUB_PRIVILEGES } from "@/lib/auth-shared";
import { PRIVILEGED_MODULES, PRIVILEGED_SUBS } from "@/lib/auth/privileged";

export type Bi = { ar: string; en: string };

/** users.py MOD — plus the two modules added after Phase 8 (automation, hr). */
export const MODULE_AR: Record<string, Bi> = {
  dashboard: { ar: "لوحة التشغيل", en: "Operations dashboard" },
  inventory: { ar: "المخزون", en: "Inventory" },
  orders: { ar: "الطلبات", en: "Orders" },
  production: { ar: "الإنتاج والتحميص", en: "Production & roasting" },
  qc: { ar: "الجودة", en: "Quality" },
  packaging: { ar: "التعبئة", en: "Packaging" },
  dispatch: { ar: "التسليم", en: "Dispatch" },
  history: { ar: "سجل الإنتاج", en: "Production history" },
  analytics: { ar: "التحليلات", en: "Analytics" },
  labels: { ar: "الملصقات", en: "Labels" },
  employees: { ar: "إدارة المستخدمين", en: "User management" },
  cupping: { ar: "التذوق", en: "Cupping" },
  settings: { ar: "الإعدادات", en: "Settings" },
  customers: { ar: "العملاء", en: "Customers" },
  accounting: { ar: "المحاسبة", en: "Accounting" },
  sales: { ar: "المبيعات والصفقات", en: "Sales & deals" },
  commissions: { ar: "العمولات", en: "Commissions" },
  finance: { ar: "المالية", en: "Finance" },
  automation: { ar: "الأتمتة والواتساب", en: "Automation & WhatsApp" },
  hr: { ar: "الموارد البشرية", en: "Human resources" },
  marketing: { ar: "التسويق الذكي", en: "Smart marketing" },
  purchases: { ar: "المشتريات وفواتير الموردين", en: "Purchases & supplier invoices" },
  workspace: { ar: "مساحة عملي", en: "My Workspace" },
};

/** P-6 · the owner's groups → existing modules (users.py GROUPS; HR and automation placed by this batch). */
export const GROUPS: { key: string; ar: string; en: string; modules: string[] }[] = [
  { key: "sales", ar: "المبيعات", en: "Sales", modules: ["orders", "customers", "sales", "commissions"] },
  { key: "inventory", ar: "المخزون", en: "Inventory", modules: ["inventory", "purchases"] },
  { key: "production", ar: "الإنتاج", en: "Production", modules: ["production", "history"] },
  { key: "quality", ar: "الجودة", en: "Quality", modules: ["qc", "cupping"] },
  { key: "packing", ar: "التعبئة والتجهيز", en: "Packing & dispatch", modules: ["packaging", "labels", "dispatch"] },
  { key: "accounting", ar: "المحاسبة", en: "Accounting", modules: ["accounting"] },
  { key: "finance", ar: "المالية", en: "Finance", modules: ["finance"] },
  { key: "hr", ar: "الموارد البشرية", en: "Human resources", modules: ["hr"] },
  { key: "marketing", ar: "التسويق", en: "Marketing", modules: ["marketing"] },
  { key: "admin", ar: "الإدارة", en: "Administration", modules: ["employees", "dashboard", "analytics", "workspace"] },
  { key: "settings", ar: "الإعدادات", en: "Settings", modules: ["settings", "automation"] },
];

/** Every module is in exactly one group (checked by the unit tests). */
export const GROUP_OF: Record<string, string> = Object.fromEntries(GROUPS.flatMap((g) => g.modules.map((m) => [m, g.key])));

/** users.py SUBS where Figma draws the action; the rest are drafts (O-8). */
export const SUB_AR: Record<string, Record<string, string>> = {
  qc: { create_record: "تسجيل نتائج الجودة", edit_record: "تعديل سجلات الجودة", view_records: "عرض سجل الجودة", manage: "اعتماد لجنة الجودة وروابط الضيوف", finalize_override: "اعتماد استثنائي بأقل من الحد الأدنى", manage_profiles: "إدارة ملفات التحميص واعتماد مواصفة الجودة", approve_exception: "اعتماد استثناءات الجودة", dispose: "التصرف في الدفعات المحجوزة" },
  production: {
    start_batch: "بدء التحميص ومتابعته", roast_to_stock: "تحميص للمخزون دون طلب", blend: "خلط الدفعات", view_history: "عرض الدفعات المكتملة",
    cancel_batch: "إلغاء الدفعات وحذفها", edit_date: "تعديل تاريخ الدفعة بأثر رجعي",
    manage_roasters: "إدارة المحامص وصيانتها وإسناد المشغّلين", manage_schedule: "إدارة جدول التحميص واعتماد الخطط",
  },
  inventory: { receive: "استلام البن الأخضر", adjust: "تسوية المخزون وتعديله", override: "تجاوز المخزون للدفعات الملغاة", valuation: "تقييم المخزون وتكلفة الإنتاج" },
  purchases: { invoices: "إدخال فواتير الموردين وتقديمها للاعتماد", received_change: "إلغاء/تعديل فاتورة مستلمة (يعكس استلامها)" },
  workspace: { assign_any: "إسناد المهام لأي موظف وإدارة أي مهمة", team_view: "عرض مهام وتقويم وأعباء جميع الموظفين" },
  sales: {
    lead_write: "إنشاء العملاء المحتملين وتعديلهم", lead_assign: "إسناد العميل المحتمل أو تغيير مالكه", lead_convert: "تحويل العميل المحتمل إلى عميل وصفقة",
    lead_import: "استيراد عملاء محتملين من ملف", lead_export: "تصدير العملاء المحتملين", deal_close: "إغلاق الصفقة بربح أو خسارة", deal_reopen: "إعادة فتح صفقة مغلقة",
    quote_write: "إنشاء عروض الأسعار وتعديلها", quote_approve_discount: "اعتماد خصم فوق حد الاعتماد", stage_manage: "ضبط مراحل الصفقات",
    collection_submit: "تسجيل تحصيل على صفقة يملكها", collection_view_team: "عرض تحصيلات الفريق",
    invoices_view: "عرض فواتير المبيعات والإشعارات", invoices_create: "إنشاء مسودات الفواتير وتعديلها", invoices_issue: "إصدار الفاتورة الضريبية",
    invoices_cancel: "إلغاء مسودة فاتورة", invoices_credit_note: "إعداد الإشعارات الدائنة والمدينة وإصدارها",
  },
  customers: { manage: "إدارة تفضيلات تحميص العملاء", sales_hold: "إيقاف البيع للعملاء" },
  commissions: {
    view_own: "عرض عمولتي", view_team: "عرض عمولات الفريق", manage_plans: "إنشاء خطط العمولة وتعديلها", manage_settings: "إعدادات العمولات وتهيئة العملاء الحاليين", approve: "اعتماد العمولة المستحقة",
    record_payout: "تسجيل صرف العمولة", collection_verify: "التحقق من تحصيل مسجّل", collection_reject: "رفض تحصيل مسجّل", collection_reverse: "عكس تحصيل معتمد",
    sandbox_collections: "أحداث تحصيل تجريبية (بيئة الاختبار فقط)",
  },
  orders: {
    create: "إنشاء الطلبات", edit: "تعديل الطلبات", delete: "حذف الطلبات", approve: "اعتماد الطلبات أو رفضها",
    prepare_review: "قرارات مراجعة التجهيز", manage_status: "إيقاف الطلبات واستئنافها وإلغاؤها وإكمالها",
  },
  dispatch: { mark_delivered: "تأكيد التسليم" },
  labels: {
    print: "إنشاء الملصقات وطباعتها", profile_manage: "إدارة ملفات الورق والطابعات", template_manage: "إدارة قوالب الملصقات المحفوظة",
    cupping_named_scorers: "طباعة أسماء المقيّمين على ملصقات التذوق",
  },
  employees: { create: "إضافة المستخدمين", edit: "تعديل صلاحيات المستخدمين", manage_access: "مستخدم متقدّم · إدارة صلاحيات المستخدمين" },
  settings: { reset: "إعادة ضبط المصنع (مسح كل البيانات)", training_reset: "إعادة تعيين بيانات التدريب" },
  accounting: {
    settings_manage: "إدارة إعدادات المحاسبة", coa_manage: "إدارة دليل الحسابات", tax_category_manage: "إدارة الفئات الضريبية",
    period_lock: "قفل الفترات المحاسبية", period_close: "إقفال الفترات المحاسبية", journal_create: "إنشاء قيود اليومية", journal_submit: "تقديم قيود اليومية",
    journal_approve: "اعتماد قيود اليومية", journal_post: "ترحيل قيود اليومية", journal_reverse: "عكس القيود المرحّلة", export_view: "عرض سجلات التصدير",
    period_reopen: "إعادة فتح فترة مقفلة نهائيًا", opening_balance: "الأرصدة الافتتاحية (إدخالها وترحيلها)",
    ar: "الذمم المدينة: تخصيص التحصيلات وكشوف العملاء وأعمار الديون",
    ap: "الذمم الدائنة: ترحيل فواتير الموردين وتسجيل السداد",
    zatca_view: "الفوترة الإلكترونية: عرض الوحدات وسجل الإرسال والطابور", zatca_onboard: "الفوترة الإلكترونية: تسجيل الوحدات وتجديد الشهادات وتشغيل الربط",
    zatca_resubmit: "الفوترة الإلكترونية: إعادة إرسال مستند معلّق أو متعثر", zatca_xml: "الفوترة الإلكترونية: تنزيل ملف XML الموقّع أو المعتمد",
  },
  finance: {
    txn_enter: "إدخال الحركات البنكية واستيرادها وتصنيفها", reconcile: "مطابقة الحسابات مع كشوف البنك",
    budget_prepare: "إعداد الميزانيات والالتزامات والتوقعات وقواعد التخصيص", budget_approve: "اعتماد الميزانيات وتعديلاتها ونسب التخصيص",
    allocate: "تشغيل التخصيص والحجز وتسجيل المدفوعات", transfer_approve: "اعتماد التحويل بين فئات التخصيص",
    spend_override_approve: "اعتماد الصرف فوق حد الفئة أو رصيدها", period_close: "إقفال فترات الميزانية أو إعادة فتحها",
    all_branches: "الوصول على مستوى المنشأة (كل الفروع)", settings_manage: "إدارة إعدادات المالية والحسابات والفئات ووصول الفروع",
  },
  marketing: {
    content_manage: "إنشاء المحتوى والتصاميم والمنشورات وتعديل التقويم", campaigns_manage: "إنشاء الحملات وتعديلها وروابط التتبع والأهداف",
    publish: "إرسال المحتوى للنشر وتشغيل قائمة النشر", approve: "اعتماد طلبات التسويق أو رفضها (لا يعتمد طلبه)",
    budget_manage: "تخطيط الميزانيات وحدود الإنفاق", revenue_view: "الاطلاع على الإيرادات والإسناد وتكلفة الاكتساب والعائد والربحية",
    customers_data: "الاطلاع على بيانات تواصل عملاء المتجر والموافقات وسجل الرسائل", messaging_manage: "إدارة قوالب الواتساب والرحلات وحملات الرسائل",
    ads_manage: "تعديل الحملات الإعلانية الحية على المنصات", integrations_manage: "ربط المنصات وحفظ التوكنات وأسرار الويبهوك",
    automation_manage: "إعدادات التسويق وسياسة الاعتماد ومفاتيح الإيقاف الطارئ", ai_use: "استخدام استوديو الذكاء الاصطناعي (ينشئ مسودات بتكلفة)",
  },
  automation: {
    manage_rules: "إنشاء قواعد الأتمتة وتعديلها وتشغيلها", manage_connection: "ربط رقم الواتساب أو فصله وضبط الإرسال",
    manage_messages: "إعادة إرسال الرسائل أو إلغاؤها",
  },
  hr: {
    directory: "دليل الموظفين (دون الرواتب والهوية والبنك)", people_manage: "إنشاء الأشخاص وتعديلهم والأقسام والحالة",
    private_view: "الاطلاع على الهوية والبنك والطوارئ (كل اطلاع مسجّل)", documents_view: "تنزيل مستندات الموظفين (مسجّل)",
    documents_manage: "رفع مستندات الموظفين وحذفها", contracts_manage: "العقود والرواتب", attendance_manage: "تسجيل الحضور والورديات",
    attendance_approve: "اعتماد تصحيحات الحضور والعمل الإضافي", leave_manage: "تسجيل الإجازات والأرصدة", leave_approve: "اعتماد الإجازات أو رفضها",
    payroll_prepare: "إعداد مسيرات الرواتب", payroll_approve: "اعتماد بنود الرواتب والمسيرات", payroll_pay: "تسجيل صرف الرواتب",
    payroll_cancel_approved: "إلغاء مسير معتمد غير مصروف", advances_manage: "تسجيل طلبات السلف وسدادها", advances_approve: "اعتماد السلف أو رفضها",
    advances_disburse: "تسجيل صرف السلف", recruit: "التوظيف والمقابلات والعروض", assets_manage: "تسليم عهد المنشأة واستلامها",
    performance_manage: "التدريب والتقييم والمخالفات", offboard: "إنهاء الخدمة والمخالصة", policy_manage: "سياسة الرواتب وأنواع الإجازات والاشتراكات",
    all_branches: "التصرف في موظفي كل الفروع",
  },
};

/** The modules' action keys, in the order the existing catalogue lists them. */
export function subsOf(module: string): string[] {
  return (MODULE_SUB_PRIVILEGES[module] ?? []).map((s) => s.key);
}

export function subLabel(module: string, sub: string, lang: "ar" | "en" = "ar"): string {
  if (lang === "en") return MODULE_SUB_PRIVILEGES[module]?.find((s) => s.key === sub)?.label ?? sub;
  return SUB_AR[module]?.[sub] ?? MODULE_SUB_PRIVILEGES[module]?.find((s) => s.key === sub)?.label ?? sub;
}

export function moduleLabel(module: string, lang: "ar" | "en" = "ar"): string {
  return MODULE_AR[module]?.[lang] ?? module;
}

/**
 * P-3 · sensitive privileges: everything the existing model already treats as PRIVILEGED (verified
 * individual, step-up — src/lib/auth/privileged.ts), plus the four actions Figma marks «حساس» that
 * the model does not (users.py SUBS). Module level: access to a privileged module (finance,
 * accounting) is itself sensitive.
 */
export const DESIGN_SENSITIVE: [string, string][] = [["qc", "manage"], ["qc", "manage_profiles"], ["production", "cancel_batch"], ["production", "edit_date"], ["sales", "lead_export"]];

export function isSensitive(module: string, sub: string | null): boolean {
  if (sub === null) return (PRIVILEGED_MODULES as readonly string[]).includes(module);
  return PRIVILEGED_SUBS.some(([m, s]) => m === module && s === sub) || DESIGN_SENSITIVE.some(([m, s]) => m === module && s === sub);
}

export const LEVEL_AR: Record<string, string> = { none: "لا وصول", view: "عرض", edit: "تعديل" };
export const LEVEL_EN: Record<string, string> = { none: "No access", view: "View", edit: "Edit" };

/**
 * The system templates (read-only, O-3), named as the frames name them (UR-05), with «بلا وصول» —
 * the starting point of every new account (P-1) — for the `custom` key with no custom role.
 */
export const SYSTEM_ROLES: { key: string; ar: string; en: string; descAr: string; descEn: string }[] = [
  { key: "admin", ar: "مدير المنشأة", en: "Owner / manager", descAr: "كل الوحدات بمستوى تعديل.", descEn: "Every module at edit." },
  { key: "inventory", ar: "مدير المخزون", en: "Inventory manager", descAr: "المخزون واستلام البن ولوحة التشغيل.", descEn: "Inventory, receiving and the dashboard." },
  { key: "roasting", ar: "رئيس التحميص والإنتاج", en: "Head roaster", descAr: "الإنتاج والتحميص والتعبئة والتذوق؛ عرض المخزون والطلبات.", descEn: "Production, packaging and cupping; views inventory and orders." },
  { key: "qc", ar: "الجودة", en: "Quality", descAr: "سجلات الجودة والتذوق.", descEn: "Quality records and cupping." },
  { key: "dispatch", ar: "الشحن والتوزيع", en: "Dispatch", descAr: "التسليم والملصقات؛ عرض الطلبات.", descEn: "Dispatch and labels; views orders." },
];
export const NO_ACCESS_ROLE = { key: "custom", ar: "بلا وصول", en: "No access", descAr: "الافتراضي. لا يرى المستخدم إلا صفحة ملفه.", descEn: "The default. The user sees only their profile." };

export function systemRole(key: string) {
  return SYSTEM_ROLES.find((r) => r.key === key) ?? (key === "custom" ? NO_ACCESS_ROLE : null);
}

/** Every module of the model is placed in one group and labelled (unit-tested). */
export function catalogGaps(): string[] {
  const gaps: string[] = [];
  for (const m of ALL_MODULES) {
    if (!GROUP_OF[m]) gaps.push(`group:${m}`);
    if (!MODULE_AR[m]) gaps.push(`label:${m}`);
    for (const s of subsOf(m)) if (!SUB_AR[m]?.[s]) gaps.push(`sub:${m}.${s}`);
  }
  return gaps;
}
