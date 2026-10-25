// «مساحة عملي» — how times read on the screens, always in Asia/Riyadh (whatever the device's zone).
// Pure; Latin digits as the rest of the ERP (FREEZE.md D1). Unit-tested.
import { riyadhParts, startOfRiyadhDay } from "./time";

type Lang = "ar" | "en";
const AR_MONTHS = ["يناير", "فبراير", "مارس", "أبريل", "مايو", "يونيو", "يوليو", "أغسطس", "سبتمبر", "أكتوبر", "نوفمبر", "ديسمبر"];
const EN_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const AR_DAYS = ["الأحد", "الاثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"];
const EN_DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const DAY = 86_400_000;

const d = (v: Date | string) => (v instanceof Date ? v : new Date(v));

/** «3:00 م» · "3:00 PM". */
export function timeOf(v: Date | string, lang: Lang): string {
  const p = riyadhParts(d(v));
  const h12 = p.hour % 12 === 0 ? 12 : p.hour % 12;
  const mm = String(p.minute).padStart(2, "0");
  return lang === "ar" ? `${h12}:${mm} ${p.hour < 12 ? "ص" : "م"}` : `${h12}:${mm} ${p.hour < 12 ? "AM" : "PM"}`;
}

/** «الأحد 25 أكتوبر» · "Sun 25 Oct" (another year: «25 أكتوبر 2027»). */
export function dayOf(v: Date | string, lang: Lang, now = new Date()): string {
  const p = riyadhParts(d(v));
  const year = p.year !== riyadhParts(now).year ? ` ${p.year}` : "";
  return lang === "ar" ? `${AR_DAYS[p.weekday]} ${p.day} ${AR_MONTHS[p.month - 1]}${year}` : `${EN_DAYS[p.weekday]} ${p.day} ${EN_MONTHS[p.month - 1]}${year}`;
}

/** Whole Riyadh days from today to `v`. */
export function daysFrom(v: Date | string, now = new Date()): number {
  return Math.round((startOfRiyadhDay(d(v)).getTime() - startOfRiyadhDay(now).getTime()) / DAY);
}

/** «اليوم 3:00 م» · «غدًا 9:00 ص» · «أمس 4:00 م» · «الأحد 2 نوفمبر 10:00 ص». */
export function dueLabel(v: Date | string, lang: Lang, now = new Date()): string {
  const n = daysFrom(v, now);
  const t = timeOf(v, lang);
  if (n === 0) return `${lang === "ar" ? "اليوم" : "Today"} ${t}`;
  if (n === 1) return `${lang === "ar" ? "غدًا" : "Tomorrow"} ${t}`;
  if (n === -1) return `${lang === "ar" ? "أمس" : "Yesterday"} ${t}`;
  return `${dayOf(v, lang, now)} ${t}`;
}

/** A duration in words: «ساعة واحدة», «ساعتين», «3 ساعات», «يومين», «45 دقيقة». */
export function span(ms: number, lang: Lang): string {
  const min = Math.max(1, Math.round(Math.abs(ms) / 60_000));
  const ar = (n: number, one: string, two: string, few: string, many: string) => (n === 1 ? one : n === 2 ? two : n <= 10 ? `${n} ${few}` : `${n} ${many}`);
  if (min < 60) return lang === "ar" ? ar(min, "دقيقة واحدة", "دقيقتين", "دقائق", "دقيقة") : `${min} min`;
  const h = Math.round(min / 60);
  if (h < 24) return lang === "ar" ? ar(h, "ساعة واحدة", "ساعتين", "ساعات", "ساعة") : `${h} h`;
  const days = Math.round(h / 24);
  return lang === "ar" ? ar(days, "يوم واحد", "يومين", "أيام", "يومًا") : `${days} day${days === 1 ? "" : "s"}`;
}

/** «متأخرة ساعتين» · "2 h overdue". */
export function overdueBy(due: Date | string, lang: Lang, now = new Date()): string {
  const s = span(now.getTime() - d(due).getTime(), lang);
  return lang === "ar" ? `متأخرة ${s}` : `${s} overdue`;
}

/** «منذ 5 ساعات» · "5 h ago". */
export function ago(v: Date | string, lang: Lang, now = new Date()): string {
  const s = span(now.getTime() - d(v).getTime(), lang);
  return lang === "ar" ? `منذ ${s}` : `${s} ago`;
}

/** Greeting by the Riyadh hour. */
export function greeting(lang: Lang, now = new Date()): string {
  const h = riyadhParts(now).hour;
  if (lang === "en") return h < 12 ? "Good morning" : "Good evening";
  return h < 12 ? "صباح الخير" : "مساء الخير";
}

/** «أكتوبر 2026» · "Oct 2026" for a "YYYY-MM". */
export function monthOf(ym: string, lang: Lang): string {
  const [y, m] = ym.split("-").map(Number);
  return `${(lang === "ar" ? AR_MONTHS : EN_MONTHS)[m - 1]} ${y}`;
}
