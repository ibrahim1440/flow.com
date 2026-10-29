// «الموازنات» / «قوالب التأجيل» — the shared labels of the two screens (pure).
export type Branch = { id: string; code: string; nameAr: string | null; nameEn: string };
export type AccountRef = { id: string; code: string; nameAr: string | null; nameEn: string };

export const BUDGET_STATUS: Record<string, [string, string, string]> = {
  DRAFT: ["مسودة", "Draft", "neutral"], APPROVED: ["معتمدة · مقفلة", "Approved · locked", "success"], ARCHIVED: ["مؤرشفة", "Archived", "cancelled"],
};
export const SCHEDULE_STATUS: Record<string, [string, string, string]> = {
  ACTIVE: ["نشط", "Active", "info"], COMPLETED: ["مكتمل", "Completed", "success"], CANCELLED: ["ملغى", "Cancelled", "cancelled"],
};
export const RUN_STATUS: Record<string, [string, string, string]> = {
  POSTED: ["مرحّل", "Posted", "success"], SKIPPED: ["مسجّل بلا قيد (قبل بدء المحاسبة)", "Recorded, no entry (before go-live)", "warning"], REVERSED: ["معكوس", "Reversed", "cancelled"],
};
export const LINE_STATUS: Record<string, [string, string, string]> = {
  PENDING: ["لم يُعترف به", "Pending", "neutral"], RECOGNIZED: ["معترف به", "Recognised", "success"],
};
export const KIND_LABEL: Record<string, [string, string]> = { PREPAID_EXPENSE: ["مصروف مدفوع مقدماً", "Prepaid expense"], DEFERRED_REVENUE: ["إيراد مؤجل (خدمات زمنية فقط)", "Deferred revenue (time-based services only)"] };
/** Council F3: what deferred revenue here is, and what it is not. */
export const DEFERRED_SCOPE: [string, string] = [
  "الإيراد المؤجل هنا للخدمات التي تُقدَّم بمرور الوقت فقط (اشتراك خدمة أو صيانة أو تدريب لمدة محددة). اشتراكات البن التي تُسلَّم شحنةً بشحنة وبطاقات الهدايا لا تُعالَج هنا: يُعترف بإيرادها عند التسليم أو الاستخدام، لا بالتوزيع الشهري.",
  "Deferred revenue here is for services delivered over time only (a service, maintenance or training subscription for a fixed term). Coffee subscriptions delivered shipment by shipment and gift cards are NOT handled here: their revenue is recognised on delivery or redemption, not spread by month.",
];
/** Council F8: the DAILY_PRORATA convention. */
export const PRORATA_HELP: [string, string] = [
  "بالأيام: يُقسم المبلغ على عدد الأشهر لحصة شهرية، ويأخذ شهر البدء من الحصة نسبة أيامه المتبقية (من يوم البدء حتى آخر الشهر ÷ أيام الشهر)، ثم أشهر كاملة، ويقع الباقي في شهر إضافي بعد الأخير. البدء في أول الشهر = من شهر البدء. التقريب بالهللة للأسفل والباقي في الشهر الأخير.",
  "By days: the amount ÷ months is the monthly share; the start month takes the share × its remaining days (start day to month end ÷ days in that month), full months follow, and the rest falls in one extra month after the last. A start on the 1st = from the start month. Halalas are rounded down, the remainder goes to the last month.",
];
export const RULE_LABEL: Record<string, [string, string]> = {
  START_MONTH: ["من شهر البدء (شهر كامل)", "From the start month (a full month)"],
  NEXT_MONTH: ["من الشهر التالي", "From the next month"],
  DAILY_PRORATA: ["بالأيام من تاريخ البدء", "By days from the start date"],
};
export const MONTHS_AR = ["يناير", "فبراير", "مارس", "أبريل", "مايو", "يونيو", "يوليو", "أغسطس", "سبتمبر", "أكتوبر", "نوفمبر", "ديسمبر"];
export const MONTHS_EN = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const accName = (a: AccountRef | null | undefined, ar: boolean) => (a ? `${a.code} · ${ar ? a.nameAr ?? a.nameEn : a.nameEn}` : "—");
