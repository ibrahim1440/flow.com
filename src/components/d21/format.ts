/**
 * Dates and day counts the way the approved screens write them (FREEZE.md decision D1):
 * operational screens use the short form — «15 أكتوبر», «اليوم 14:00», «أمس» — and keep
 * dd/mm/yyyy for anything outside the current year. Latin digits in both languages.
 */

const AR_MONTHS = ["يناير", "فبراير", "مارس", "أبريل", "مايو", "يونيو", "يوليو", "أغسطس", "سبتمبر", "أكتوبر", "نوفمبر", "ديسمبر"];
const EN_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const AR_DAYS = ["الأحد", "الاثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"];
const EN_DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const pad = (n: number) => String(n).padStart(2, "0");
const valid = (v: string | Date | null | undefined): Date | null => {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};
const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();

/** Whole calendar days from today to `v` (negative = in the past). */
export function daysFromToday(v: string | Date, now = new Date()): number {
  const d = new Date(v);
  return Math.round((startOf(d) - startOf(now)) / 86_400_000);
}

/** «15 أكتوبر» · "15 Oct"; another year → dd/mm/yyyy. */
export function shortDate(v: string | Date | null | undefined, lang: "ar" | "en"): string {
  const d = valid(v);
  if (!d) return "—";
  if (d.getFullYear() !== new Date().getFullYear()) return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
  return lang === "ar" ? `${d.getDate()} ${AR_MONTHS[d.getMonth()]}` : `${d.getDate()} ${EN_MONTHS[d.getMonth()]}`;
}

/** «10 أكتوبر 2026» — ONE date format for the batch-24 sales screens (council fix round 1, P0-11): day, month name, year. */
export function longDate(v: string | Date | null | undefined, lang: "ar" | "en"): string {
  const d = valid(v);
  if (!d) return "—";
  return lang === "ar" ? `${d.getDate()} ${AR_MONTHS[d.getMonth()]} ${d.getFullYear()}` : `${d.getDate()} ${EN_MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

/** A quantity with no «.00»: up to 3 decimals, trailing zeros dropped, thousands separated (44 → «44», 1.5 → «1.5»). */
export function qtyText(v: number | string | null | undefined): string {
  const n = Number(v);
  if (!Number.isFinite(n)) return "—";
  return n.toLocaleString("en-US", { maximumFractionDigits: 3 });
}

/** «اليوم 14:00», «أمس 09:10», otherwise «الأحد 4 أكتوبر 12:00». */
export function dueText(v: string | Date | null | undefined, lang: "ar" | "en"): string {
  const d = valid(v);
  if (!d) return "—";
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const n = daysFromToday(d);
  if (n === 0) return `${lang === "ar" ? "اليوم" : "Today"} ${time}`;
  if (n === 1) return `${lang === "ar" ? "غدًا" : "Tomorrow"} ${time}`;
  if (n === -1) return `${lang === "ar" ? "أمس" : "Yesterday"} ${time}`;
  const day = lang === "ar" ? AR_DAYS[d.getDay()] : EN_DAYS[d.getDay()];
  return `${day} ${shortDate(d, lang)} ${time}`;
}

/** Arabic counted noun for days: يوم واحد · يومين · 3 أيام · 11 يومًا. */
export function dayCount(n: number, lang: "ar" | "en"): string {
  const a = Math.abs(n);
  if (lang === "en") return `${a} day${a === 1 ? "" : "s"}`;
  if (a === 1) return "يوم واحد";
  if (a === 2) return "يومين";
  if (a >= 3 && a <= 10) return `${a} أيام`;
  return `${a} يومًا`;
}

/** The unit after a large day figure («22 يومًا»): the noun alone, agreeing with the number. */
export function dayUnit(n: number, lang: "ar" | "en"): string {
  const a = Math.abs(n);
  if (lang === "en") return a === 1 ? "day" : "days";
  if (a >= 3 && a <= 10) return "أيام";
  if (a >= 11) return "يومًا";
  return "يوم";
}

/** «بعد 9 أيام» · «منذ يومين» · «اليوم». */
export function relativeDays(v: string | Date, lang: "ar" | "en"): string {
  const n = daysFromToday(v);
  if (n === 0) return lang === "ar" ? "اليوم" : "today";
  if (lang === "ar") return n > 0 ? `بعد ${dayCount(n, lang)}` : `منذ ${dayCount(n, lang)}`;
  return n > 0 ? `in ${dayCount(n, lang)}` : `${dayCount(n, lang)} ago`;
}

/** Whole numbers with grouping, Latin digits: 90,000. */
export function whole(v: string | number): string {
  const n = typeof v === "string" ? Number(v) : v;
  if (!Number.isFinite(n)) return "—";
  return Math.round(n).toLocaleString("en-US");
}

/** Two decimals with grouping: 103,500.00. */
export function money2(v: string | number): string {
  const n = typeof v === "string" ? Number(v) : v;
  if (!Number.isFinite(n)) return "—";
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function currencyLabel(code: string, lang: "ar" | "en"): string {
  if (lang === "en") return code;
  return code === "SAR" ? "ر.س" : code;
}
