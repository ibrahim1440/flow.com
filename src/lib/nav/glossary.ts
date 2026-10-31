/**
 * THE TERMINOLOGY GLOSSARY (Qoyod-parity program, phase 2) — our wording → Qoyod's, in ONE place.
 *
 * Owner decision: Qoyod's wording applies INSIDE THE ACCOUNTANT WORKSPACE ONLY («واجهة المحاسب»); the rest of the
 * system keeps its own wording. So nothing here renames a registry node, a page or an API message by itself: a
 * caller asks `term(key, lang, accountant)` (or the `useTerm()` hook in `@/components/chrome/terms`) and gets Qoyod's
 * word only while the accountant workspace is drawn. The accountant sidebar (`./accountant`) reads its labels from
 * here too, so the sidebar, the trail, the page titles and the tabs cannot disagree.
 *
 * The same table, for people, is the program's GLOSSARY.md. Add a row here first, then there.
 */
export type Term = {
  /** Our wording today (the rest of the system keeps it). */
  ours: { ar: string; en: string };
  /** Qoyod's wording (the accountant workspace). */
  qoyod: { ar: string; en: string };
  /** Where our wording appears, for the reader of GLOSSARY.md. */
  where?: string;
};

export const GLOSSARY = {
  dashboard: { ours: { ar: "نظرة عامة", en: "Overview" }, qoyod: { ar: "لوحة المتابعة", en: "Dashboard" }, where: "accounting overview tab" },
  sales: { ours: { ar: "المبيعات", en: "Sales" }, qoyod: { ar: "المبيعات", en: "Sales" } },
  customers: { ours: { ar: "العملاء", en: "Customers" }, qoyod: { ar: "العملاء", en: "Customers" } },
  quotes: { ours: { ar: "عروض الأسعار", en: "Quotations" }, qoyod: { ar: "عروض الأسعار", en: "Quotes" } },
  salesInvoices: { ours: { ar: "الفواتير الضريبية", en: "Tax invoices" }, qoyod: { ar: "فواتير المبيعات", en: "Sales invoices" }, where: "«الفواتير والتحصيل» › invoices tab" },
  // BATCH 22 WP-C: the accountant's queue of tax invoice requests (Sales requests, the accountant issues).
  invoiceRequests: { ours: { ar: "طلبات الفواتير", en: "Invoice requests" }, qoyod: { ar: "طلبات الفواتير", en: "Invoice requests" }, where: "/dashboard/sales/invoices?view=requests" },
  creditNotes: { ours: { ar: "إشعارات دائنة / مدينة", en: "Credit / debit notes" }, qoyod: { ar: "الإشعارات الدائنة", en: "Credit notes" }, where: "«الفواتير والتحصيل» › notes tab" },
  collections: { ours: { ar: "التحصيل", en: "Collections" }, qoyod: { ar: "سندات العملاء", en: "Customer receipts" }, where: "/dashboard/sales/collections" },
  // Qoyod's slot «مركز إدارة الذمم المدينة» is a paid add-on portal we do not have; our receivables aging takes the slot,
  // named for what it is (coordinator decision, QOYOD-REF §5.1).
  arCenter: { ours: { ar: "أعمار الذمم وكشوف العملاء", en: "AR aging & statements" }, qoyod: { ar: "أعمار الذمم المدينة", en: "Receivables aging" }, where: "/dashboard/sales/receivables (in Qoyod's «مركز إدارة الذمم المدينة» slot)" },
  purchases: { ours: { ar: "المشتريات", en: "Purchases" }, qoyod: { ar: "المشتريات", en: "Purchases" } },
  suppliers: { ours: { ar: "الموردون", en: "Suppliers" }, qoyod: { ar: "الموردين", en: "Suppliers" }, where: "«المشتريات» › suppliers tab" },
  purchaseOrders: { ours: { ar: "أوامر الشراء", en: "Purchase orders" }, qoyod: { ar: "أوامر الشراء", en: "Purchase orders" }, where: "deferred (owner decision)" },
  purchaseInvoices: { ours: { ar: "فواتير الموردين", en: "Supplier invoices" }, qoyod: { ar: "فواتير المشتريات", en: "Purchase invoices" }, where: "/dashboard/purchases/invoices" },
  supplierClaims: { ours: { ar: "مطالبات / إشعارات المورد", en: "Supplier claims / notes" }, qoyod: { ar: "الإشعارات المدينة", en: "Debit notes" }, where: "«المشتريات» › claims tab" },
  simpleBills: { ours: { ar: "فاتورة مشتريات (مصروف)", en: "Purchase invoice (expense)" }, qoyod: { ar: "فواتير بسيطة", en: "Simple bills" }, where: "/dashboard/purchases?tab=invoices&kind=SIMPLE (+ /dashboard/purchases/invoices/new?mode=expense)" },
  supplierPayments: { ours: { ar: "مدفوعات الموردين", en: "Supplier payments" }, qoyod: { ar: "سندات الموردين", en: "Supplier vouchers" }, where: "/dashboard/accounting/ap (payments)" },
  productsCosts: { ours: { ar: "تقييم المخزون", en: "Inventory valuation" }, qoyod: { ar: "المنتجات والتكاليف", en: "Products & costs" }, where: "/dashboard/accounting/inventory (read-only for the accountant)" },
  locations: { ours: { ar: "مواقع المخزون", en: "Stock locations" }, qoyod: { ar: "المواقع", en: "Locations" }, where: "/dashboard/inventory/locations" },
  productionOrders: { ours: { ar: "أوامر الإنتاج", en: "Production orders" }, qoyod: { ar: "أوامر التصنيع", en: "Manufacturing orders" }, where: "/dashboard/production-orders" },
  fixedAssets: { ours: { ar: "الأصول الثابتة", en: "Fixed assets" }, qoyod: { ar: "الأصول الثابتة", en: "Fixed assets" } },
  depreciation: { ours: { ar: "الإهلاك", en: "Depreciation" }, qoyod: { ar: "الإهلاك", en: "Depreciation" } },
  disposals: { ours: { ar: "الاستبعادات", en: "Disposals" }, qoyod: { ar: "الاستبعادات", en: "Disposals" } },
  additions: { ours: { ar: "الإضافات", en: "Additions" }, qoyod: { ar: "الإضافات", en: "Additions" } },
  payroll: { ours: { ar: "مسيرات الرواتب", en: "Payroll runs" }, qoyod: { ar: "الرواتب", en: "Payroll" }, where: "/dashboard/hr/payroll" },
  accounting: { ours: { ar: "المحاسبة", en: "Accounting" }, qoyod: { ar: "المحاسبة", en: "Accounting" } },
  deferrals: { ours: { ar: "قوالب التأجيل", en: "Deferral templates" }, qoyod: { ar: "قوالب التأجيل", en: "Deferral templates" } },
  easyJournals: { ours: { ar: "القيود السهلة", en: "Journal templates" }, qoyod: { ar: "قيود سهلة", en: "Easy journals" } },
  journals: { ours: { ar: "القيود اليومية", en: "Journal entries" }, qoyod: { ar: "قيود محاسبية يدوية", en: "Manual journal entries" }, where: "/dashboard/accounting/journals" },
  chart: { ours: { ar: "دليل الحسابات", en: "Chart of accounts" }, qoyod: { ar: "شجرة الحسابات", en: "Chart of accounts" }, where: "/dashboard/accounting/chart" },
  budgets: { ours: { ar: "الموازنات", en: "Budgets" }, qoyod: { ar: "الموازنات", en: "Budgets" } },
  commercialDocs: { ours: { ar: "مستندات القيود (المصدر)", en: "Source documents" }, qoyod: { ar: "المستندات التجارية", en: "Commercial documents" } },
  quality: { ours: { ar: "قائمة الإقفال والمطابقة", en: "Close checklist & reconciliation" }, qoyod: { ar: "جودة المحاسبة", en: "Accounting quality" }, where: "/dashboard/accounting/periods (close)" },
  // «استيراد البيانات» (accounting › data_import): the go-live master-data import from Excel / Qoyod.
  dataImport: { ours: { ar: "استيراد البيانات", en: "Data import" }, qoyod: { ar: "استيراد البيانات", en: "Data import" }, where: "/dashboard/accounting/data-import (Settings › data import for the admin role)" },
  recurring: { ours: { ar: "المعاملات المتكررة", en: "Recurring transactions" }, qoyod: { ar: "المعاملات المتكررة", en: "Recurring transactions" } },
  reports: { ours: { ar: "التقارير", en: "Reports" }, qoyod: { ar: "التقارير", en: "Reports" } },
  allReports: { ours: { ar: "التقارير المالية", en: "Financial reports" }, qoyod: { ar: "كل التقارير", en: "All reports" }, where: "/dashboard/accounting/reports" },
  reportLog: { ours: { ar: "سجل التدقيق", en: "Audit log" }, qoyod: { ar: "سجل التقارير", en: "Report log" } },
  settings: { ours: { ar: "الإعدادات", en: "Settings" }, qoyod: { ar: "الإعدادات", en: "Settings" } },
  generalSettings: { ours: { ar: "المنشأة", en: "Organisation" }, qoyod: { ar: "الإعدادات العامة", en: "General settings" }, where: "/dashboard/settings" },
  fiscalPeriods: { ours: { ar: "الفترات المالية", en: "Fiscal periods" }, qoyod: { ar: "السنوات المالية", en: "Fiscal years" }, where: "/dashboard/accounting/periods" },
  dimensions: { ours: { ar: "الفروع ومراكز التكلفة", en: "Branches & cost centres" }, qoyod: { ar: "إعدادات الأبعاد", en: "Dimension settings" } },
  invoiceDetails: { ours: { ar: "الفوترة والضرائب", en: "Invoicing & tax" }, qoyod: { ar: "تفاصيل الفاتورة", en: "Invoice details" }, where: "/dashboard/settings/invoicing" },
  einvoicing: { ours: { ar: "الفوترة الإلكترونية", en: "E-invoicing" }, qoyod: { ar: "الربط الالكتروني", en: "E-invoicing link" }, where: "/dashboard/accounting/zatca" },
  currencies: { ours: { ar: "العملات الأجنبية", en: "Foreign currencies" }, qoyod: { ar: "العملات الأجنبية", en: "Foreign currencies" } },
  taxes: { ours: { ar: "الضريبة", en: "VAT" }, qoyod: { ar: "الضرائب", en: "Taxes" }, where: "/dashboard/accounting/tax" },
  payrollSettings: { ours: { ar: "إعدادات الموارد البشرية", en: "HR settings" }, qoyod: { ar: "إعدادات الرواتب", en: "Payroll settings" }, where: "/dashboard/hr/settings" },
  users: { ours: { ar: "المستخدمون والصلاحيات", en: "Users & permissions" }, qoyod: { ar: "المستخدمين", en: "Users" }, where: "/dashboard/employees" },
  paymentTerms: { ours: { ar: "شروط الدفع", en: "Payment terms" }, qoyod: { ar: "شروط الدفع", en: "Payment terms" } },
  customFields: { ours: { ar: "الحقول الإضافية", en: "Custom fields" }, qoyod: { ar: "الحقول الإضافية", en: "Custom fields" } },
  attachments: { ours: { ar: "المرفقات", en: "Attachments" }, qoyod: { ar: "المرفقات", en: "Attachments" } },
  productAttributes: { ours: { ar: "إعدادات المنتجات", en: "Product settings" }, qoyod: { ar: "خصائص المنتجات", en: "Product attributes" }, where: "/dashboard/settings/products" },
  quickCreate: { ours: { ar: "جديد", en: "New" }, qoyod: { ar: "الإنشاء السريع", en: "Quick create" }, where: "top bar «جديد»" },
  home: { ours: { ar: "الرئيسية", en: "Home" }, qoyod: { ar: "الصفحة الرئيسية", en: "Home" } },
  // Phase 3 (builder qb-pages): the list / form words of the accountant's 7 daily pages. «ours» is the word the page
  // uses today; the Qoyod variant of a page (accountant workspace only) asks for these.
  listCreate: { ours: { ar: "فاتورة مبيعات", en: "Sales invoice" }, qoyod: { ar: "إنشاء", en: "Create" }, where: "list page primary button" },
  colRef: { ours: { ar: "الفاتورة", en: "Invoice" }, qoyod: { ar: "المرجع", en: "Reference" }, where: "list column: document number" },
  colCustomer: { ours: { ar: "العميل", en: "Customer" }, qoyod: { ar: "العميل", en: "Customer" } },
  colSupplier: { ours: { ar: "المورد", en: "Supplier" }, qoyod: { ar: "المورد", en: "Supplier" } },
  colDate: { ours: { ar: "الإصدار", en: "Issued" }, qoyod: { ar: "التاريخ", en: "Date" }, where: "list column: document date" },
  colDue: { ours: { ar: "الاستحقاق", en: "Due" }, qoyod: { ar: "تاريخ الاستحقاق", en: "Due date" }, where: "list column" },
  colTotal: { ours: { ar: "الإجمالي", en: "Total" }, qoyod: { ar: "الإجمالي", en: "Total" } },
  colGrand: { ours: { ar: "الإجمالي", en: "Total" }, qoyod: { ar: "القيمة الاجمالية", en: "Total amount" }, where: "sales / purchase lists (QOYOD-REF §1.5)" },
  colBalance: { ours: { ar: "المتبقي", en: "Remaining" }, qoyod: { ar: "الرصيد", en: "Balance" }, where: "sales / purchase lists: the open amount" },
  colIssued: { ours: { ar: "الإصدار", en: "Issued" }, qoyod: { ar: "تاريخ الإصدار", en: "Issue date" }, where: "sales list" },
  colUnallocated: { ours: { ar: "غير مخصص", en: "Unallocated" }, qoyod: { ar: "المبلغ غير المخصص", en: "Unallocated amount" }, where: "receipts / vouchers" },
  colPaid: { ours: { ar: "المدفوع", en: "Paid" }, qoyod: { ar: "المدفوع", en: "Paid" } },
  colRemaining: { ours: { ar: "المتبقي", en: "Remaining" }, qoyod: { ar: "المتبقي", en: "Remaining" } },
  colStatus: { ours: { ar: "السداد", en: "Payment" }, qoyod: { ar: "الحالة", en: "Status" }, where: "list column: one status pill" },
  colOptions: { ours: { ar: "الإجراءات", en: "Actions" }, qoyod: { ar: "الخيارات", en: "Options" }, where: "list column: row actions" },
  colDescription: { ours: { ar: "الوصف", en: "Description" }, qoyod: { ar: "الوصف", en: "Description" } },
  colSource: { ours: { ar: "المصدر", en: "Source" }, qoyod: { ar: "المصدر", en: "Source" } },
  colType: { ours: { ar: "النوع", en: "Type" }, qoyod: { ar: "النوع", en: "Type" } },
  colAmount: { ours: { ar: "المبلغ", en: "Amount" }, qoyod: { ar: "المبلغ", en: "Amount" } },
  colMethod: { ours: { ar: "الطريقة", en: "Method" }, qoyod: { ar: "طريقة الدفع", en: "Payment method" }, where: "receipts / payments lists" },
  rowView: { ours: { ar: "فتح", en: "Open" }, qoyod: { ar: "عرض", en: "View" }, where: "row action" },
  saveDraft: { ours: { ar: "حفظ المسودة", en: "Save draft" }, qoyod: { ar: "حفظ كمسودة", en: "Save as draft" }, where: "new sales invoice" },
  recordPayment: { ours: { ar: "تسجيل سداد", en: "Record a payment" }, qoyod: { ar: "إنشاء", en: "Create" }, where: "supplier payments button" },
  newJournal: { ours: { ar: "قيد يدوي", en: "Manual journal" }, qoyod: { ar: "إنشاء قيد يدوي", en: "Create a manual journal" }, where: "journals button" },
} as const satisfies Record<string, Term>;

export type TermKey = keyof typeof GLOSSARY;

/** The word for `key`: Qoyod's inside the accountant workspace, ours everywhere else. */
export function term(key: TermKey, lang: string, accountant: boolean): string {
  const t: Term = GLOSSARY[key];
  const side = accountant ? t.qoyod : t.ours;
  return lang === "en" ? side.en : side.ar;
}

/** Qoyod's word for `key` (the accountant workspace's own labels). */
export function qoyodTerm(key: TermKey, lang: string): string {
  return term(key, lang, true);
}
