// The plan's calendar arithmetic (pure, client- and test-safe): Riyadh calendar days as ISO strings, weeks from Sunday,
// working days Sunday–Thursday. Split from plan.tsx (D8, 6 Nov 2026) so the period navigation is unit-tested.
export type Period = "DAY" | "WEEK" | "MONTH";

export const WD_AR = ["الأحد", "الإثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"];
export const WD_EN = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
export const MONTH_AR = ["يناير", "فبراير", "مارس", "أبريل", "مايو", "يونيو", "يوليو", "أغسطس", "سبتمبر", "أكتوبر", "نوفمبر", "ديسمبر"];

export const DAY = 86_400_000;
export const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
export const wd = (iso: string) => new Date(`${iso}T00:00:00Z`).getUTCDay();
export const dayNum = (iso: string) => Number(iso.slice(8, 10));
export const dayName = (iso: string, ar: boolean) => (ar ? WD_AR : WD_EN)[wd(iso)];
export const weekOf = (iso: string) => addDays(iso, -wd(iso));
/** The week new items go to: the week shown, or (on «اليوم» / «الشهر») this week. */
export const addWeek = (p: { period: Period; start: string; weekStart: string; today: string }) => (p.period === "WEEK" ? p.weekStart : weekOf(p.start > p.today ? p.start : p.today));
/**
 * The days «خطّط بند» offers, from the period on screen: «اليوم» → today; «الأسبوع» → the days left in the week;
 * «الشهر» → the days left in the month, week by week. Working days (Sunday–Thursday); a past period offers this week.
 */
export function pickDays(p: { period: Period; start: string; end: string; today: string }): { week: string; days: string[] }[] {
  let from = p.start > p.today ? p.start : p.today;
  let to = p.period === "DAY" ? addDays(p.start, 1) : p.end;
  if (from >= to) { from = p.today; to = addDays(weekOf(p.today), 7); }
  const out: { week: string; days: string[] }[] = [];
  for (let d = from; d < to; d = addDays(d, 1)) {
    if (wd(d) > 4 && d !== p.today) continue;
    const w = weekOf(d);
    const g = out.find((x) => x.week === w);
    if (g) g.days.push(d); else out.push({ week: w, days: [d] });
  }
  return out;
}
export const weekLabel = (w: string, today: string, ar: boolean) => {
  const cur = weekOf(today);
  if (w === cur) return ar ? "هالأسبوع" : "This week";
  if (w === addDays(cur, 7)) return ar ? "الأسبوع الجاي" : "Next week";
  return ar ? `أسبوع ${dayNum(w)}–${dayNum(addDays(w, 6))}` : `Week of ${dayNum(w)}`;
};
/**
 * The period on screen named from today (D8, owner-approved 6 Nov 2026: the rep plans any week or month ahead):
 * «خطة هذا الأسبوع / الأسبوع الجاي / الأسبوع الماضي / أسبوع 15–21», «خطة هذا الشهر / الشهر الجاي / شهر ديسمبر»,
 * «خطة اليوم / بكرة / أمس / الثلاثاء 10». Pure.
 */
export function periodTitle(period: Period, start: string, today: string, ar: boolean): string {
  if (period === "WEEK") {
    const cur = weekOf(today);
    if (start === cur) return ar ? "خطة هذا الأسبوع" : "This week's plan";
    if (start === addDays(cur, 7)) return ar ? "خطة الأسبوع الجاي" : "Next week's plan";
    if (start === addDays(cur, -7)) return ar ? "خطة الأسبوع الماضي" : "Last week's plan";
    return ar ? `خطة أسبوع ${dayNum(start)}–${dayNum(addDays(start, 6))} ${MONTH_AR[Number(addDays(start, 6).slice(5, 7)) - 1]}` : `Plan · week of ${start}`;
  }
  if (period === "MONTH") {
    const m = (iso: string) => Number(iso.slice(0, 4)) * 12 + Number(iso.slice(5, 7)) - 1;
    const d = m(start) - m(today);
    if (d === 0) return ar ? "خطة هذا الشهر" : "This month's plan";
    if (d === 1) return ar ? "خطة الشهر الجاي" : "Next month's plan";
    if (d === -1) return ar ? "خطة الشهر الماضي" : "Last month's plan";
    return ar ? `خطة شهر ${MONTH_AR[Number(start.slice(5, 7)) - 1]}` : `Plan · ${start.slice(0, 7)}`;
  }
  if (start === today) return ar ? "خطة اليوم" : "Today's plan";
  if (start === addDays(today, 1)) return ar ? "خطة بكرة" : "Tomorrow's plan";
  if (start === addDays(today, -1)) return ar ? "خطة أمس" : "Yesterday's plan";
  return ar ? `خطة ${dayName(start, true)} ${dayNum(start)}` : `Plan · ${start}`;
}
/** The first day of the period one step before (-1) or after (+1) the one starting at `start`. Pure. */
export function stepPeriod(period: Period, start: string, dir: 1 | -1): string {
  if (period === "DAY") return addDays(start, dir);
  if (period === "WEEK") return addDays(start, 7 * dir);
  const y = Number(start.slice(0, 4)), mo = Number(start.slice(5, 7)) - 1 + dir;
  const yy = y + Math.floor(mo / 12), mm = ((mo % 12) + 12) % 12;
  return `${yy}-${String(mm + 1).padStart(2, "0")}-01`;
}
/** The period containing `day`: the day itself, its week's Sunday, or its month's 1st. Pure. */
export const periodStartOfDay = (period: Period, day: string) => (period === "DAY" ? day : period === "WEEK" ? weekOf(day) : `${day.slice(0, 7)}-01`);
