// Native HR — shared bilingual strings (D5: English LTR variants of the approved Arabic
// screens; wording follows the EN HR frames on Figma page 1535:2 and its glossary in
// docs/design/direction-2.1-rc/EN-VARIANTS.md). Same shape as `translations.ts`; kept apart
// so the HR module's vocabulary does not grow the app-wide dictionary.
//
// Page-specific sentences use the `L(ar, en)` pair from `useHrI18n()` (the finance/CRM
// pattern); everything reused across HR screens lives here as a key.
import type { Lang } from "./translations";

type Dict = Record<string, { en: string; ar: string }>;

export const hrStrings = {
  // ── Common actions
  save:            { en: "Save",                 ar: "حفظ" },
  cancel:          { en: "Cancel",               ar: "إلغاء" },
  close:           { en: "Close",                ar: "إغلاق" },
  approve:         { en: "Approve",              ar: "اعتماد" },
  reject:          { en: "Reject",               ar: "رفض" },
  retry:           { en: "Try again",            ar: "إعادة المحاولة" },
  previous:        { en: "Previous",             ar: "السابق" },
  next:            { en: "Next",                 ar: "التالي" },
  clearFilters:    { en: "Clear filters",        ar: "مسح المرشحات" },
  all:             { en: "All",                  ar: "الكل" },
  search:          { en: "Search",               ar: "بحث" },
  submitForApproval: { en: "Submit for approval", ar: "إرسال للاعتماد" },
  openFile:        { en: "Open file",            ar: "فتح الملف" },
  none:            { en: "None",                 ar: "لا يوجد" },
  // ── States
  loading:         { en: "Loading…",             ar: "جارٍ التحميل…" },
  loadFailed:      { en: "Couldn’t load.",       ar: "تعذّر التحميل." },
  nothingChanged:  { en: "Nothing was changed.", ar: "لم يتغير أي شيء." },
  noPermissionTitle: { en: "You don’t have permission for this page", ar: "لا تملك صلاحية هذه الصفحة" },
  noPermissionBody:  { en: "A manager with permission to edit employees can grant it; the grant is logged.", ar: "يمنحها مدير يملك صلاحية تعديل الموظفين، ويُسجَّل المنح." },
  proposalTag:     { en: "Proposed · not approved", ar: "مقترح · غير معتمد" },
  // ── Common nouns
  employee:        { en: "Employee",             ar: "الموظف" },
  branch:          { en: "Branch",               ar: "الفرع" },
  department:      { en: "Department",           ar: "الإدارة" },
  status:          { en: "Status",               ar: "الحالة" },
  date:            { en: "Date",                 ar: "التاريخ" },
  amount:          { en: "Amount",               ar: "المبلغ" },
  reason:          { en: "Reason",               ar: "السبب" },
  note:            { en: "Note",                 ar: "الملاحظة" },
  type:            { en: "Type",                 ar: "النوع" },
  from:            { en: "From",                 ar: "من" },
  to:              { en: "To",                   ar: "إلى" },
  days:            { en: "Days",                 ar: "الأيام" },
  month:           { en: "Month",                ar: "الشهر" },
  wholeCompany:    { en: "Whole company",        ar: "الشركة كلها" },
} satisfies Dict;

export type HrKey = keyof typeof hrStrings;
export const hrTr = (key: HrKey, lang: Lang) => hrStrings[key][lang] ?? hrStrings[key].en;

export const MONTHS: Record<Lang, string[]> = {
  ar: ["يناير", "فبراير", "مارس", "أبريل", "مايو", "يونيو", "يوليو", "أغسطس", "سبتمبر", "أكتوبر", "نوفمبر", "ديسمبر"],
  en: ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"],
};
export const WEEKDAYS: Record<Lang, string[]> = {
  ar: ["الأحد", "الإثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"],
  en: ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"],
};
/** Short weekday names for operational captions in English («Sun–Tue»). */
export const WEEKDAYS_SHORT_EN = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** «سبتمبر 2026» / «September 2026» from "YYYY-MM". */
export function monthLabel(m: string, lang: Lang) {
  const [y, mm] = m.split("-").map(Number);
  if (!y || !mm) return m;
  return `${MONTHS[lang][mm - 1]} ${y}`;
}

/** Built-in leave types read by code in English; anything else keeps its stored Arabic name. */
const LEAVE_EN: Record<string, string> = { ANNUAL: "Annual", SICK: "Sick", UNPAID: "Unpaid", MATERNITY: "Maternity", PATERNITY: "Paternity", HAJJ: "Hajj", BEREAVEMENT: "Bereavement", MARRIAGE: "Marriage", EXAM: "Exam", EMERGENCY: "Emergency" };
export function leaveTypeName(t: { code?: string | null; nameAr: string } | null | undefined, lang: Lang) {
  if (!t) return "—";
  return lang === "en" && t.code && LEAVE_EN[t.code] ? LEAVE_EN[t.code] : t.nameAr;
}

/** Department / branch names: the stored English name in English when there is one. */
export function orgName(o: { nameAr?: string | null; nameEn?: string | null } | null | undefined, lang: Lang) {
  if (!o) return "—";
  return lang === "en" ? (o.nameEn || o.nameAr || "—") : (o.nameAr || o.nameEn || "—");
}

/** A person's name: the stored English name in English when there is one (names are never translated). */
export function personName(p: { fullNameAr: string; fullNameEn?: string | null } | null | undefined, lang: Lang) {
  if (!p) return "—";
  return lang === "en" && p.fullNameEn ? p.fullNameEn : p.fullNameAr;
}
