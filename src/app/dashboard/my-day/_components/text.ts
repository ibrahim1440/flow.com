// «يومي» — the words of the page, in both languages, in one place (plain Saudi Arabic; Latin digits with separators).
// Pure, so the tests read the same sentences the rep reads (tests/sales/unit/my-day.test.ts).

export type Lang = "ar" | "en";
export type Tier = "VIP" | "REGULAR" | "SMALL" | "QUIET";
export type Reason =
  | { code: "LATE"; daysLate: number; intervalDays: number }
  | { code: "DUE"; intervalDays: number }
  | { code: "EXPECTED"; inDays: number; intervalDays: number }
  | { code: "SAMPLE"; daysSinceSent: number; sampleId: string; dealId: string }
  | { code: "FOLLOW_UP"; dealId: string; dealTitle: string; amount: string; overdueDays: number }
  | { code: "NO_CONTACT"; days: number | null; thresholdDays: number }
  | { code: "CALLED"; daysLate: number; intervalDays: number; calledDaysAgo: number; awaitDays: number };

/** 12,450 — grouping with Latin digits in both languages (sales/_components/ui.tsx `num`). */
export const n = (v: number | string, places = 0): string => {
  const x = typeof v === "string" ? Number(v) : v;
  if (!Number.isFinite(x)) return "—";
  return x.toLocaleString("en-US", { minimumFractionDigits: places, maximumFractionDigits: places });
};

/** «يوم واحد» · «يومين» · «3 أيام» · «12 يوم» (Saudi-plain); "1 day" / "3 days". */
export function days(d: number, lang: Lang): string {
  if (lang === "en") return `${n(d)} ${d === 1 ? "day" : "days"}`;
  if (d === 1) return "يوم واحد";
  if (d === 2) return "يومين";
  if (d >= 3 && d <= 10) return `${n(d)} أيام`;
  return `${n(d)} يوم`;
}

/**
 * The weekly streak, personal only: «🔥 3 أسابيع متتالية فوق 80% من هدفك». `third` (a manager reading a rep's day,
 * council fix round 2 item 8): the third person — «من هدفه».
 */
export function streakText(w: number, lang: Lang, third = false): string {
  if (lang === "en") return `${n(w)} week${w === 1 ? "" : "s"} in a row above 80% of ${third ? "the" : "your"} target`;
  const of = third ? "من هدفه" : "من هدفك";
  if (w === 1) return third ? `أسبوعه اللي فات فوق 80% ${of}` : `أسبوعك اللي فات فوق 80% ${of}`;
  const word = w === 2 ? "أسبوعين" : w <= 10 ? `${n(w)} أسابيع` : `${n(w)} أسبوع`;
  return `${word} ورا بعض فوق 80% ${of}`;
}

export const TIER_LABEL: Record<Tier, { ar: string; en: string }> = {
  VIP: { ar: "VIP", en: "VIP" },
  REGULAR: { ar: "عادي", en: "Regular" },
  SMALL: { ar: "صغير", en: "Small" },
  QUIET: { ar: "بدون طلبات حديثة", en: "No recent orders" },
};

export type PillTone = "bad" | "warn" | "info" | "pri" | "ok";

/** The coloured pill next to the customer's name: what is wrong today, in three words. */
export function reasonPill(r: Reason, lang: Lang): { text: string; tone: PillTone } {
  const ar = lang === "ar";
  switch (r.code) {
    case "LATE": return { tone: "bad", text: ar ? `متأخر ${days(r.daysLate, lang)}` : `${days(r.daysLate, lang)} late` };
    case "DUE": return { tone: "warn", text: ar ? "حان موعد طلبه" : "Order due" };
    case "EXPECTED": return { tone: "warn", text: r.inDays === 0 ? (ar ? "متوقع يطلب اليوم" : "Expected to order today") : ar ? `متوقع يطلب خلال ${days(r.inDays, lang)}` : `Expected to order within ${days(r.inDays, lang)}` };
    case "SAMPLE": return { tone: "info", text: ar ? "عيّنة بدون رد" : "Sample, no feedback" };
    case "FOLLOW_UP": return { tone: "pri", text: ar ? "موعد متابعة" : "Follow-up due" };
    case "NO_CONTACT": return { tone: "warn", text: r.days === null ? (ar ? "ما تواصلت معه" : "Never contacted") : ar ? `ما تواصلت ${days(r.days, lang)}` : `No contact for ${days(r.days, lang)}` };
    case "CALLED": return { tone: "ok", text: ar ? "كلّمته — بانتظار الطلب" : "Called — awaiting the order" };
  }
}

/** The one-line «why» under the name. `third`: a manager reading a rep's day (third person, council fix round 3). */
export function whyLine(item: { reason: Reason; tier: Tier | null; intervalDays: number | null; lastContactDays: number | null; kgPerMonth: number }, lang: Lang, third = false): string {
  const ar = lang === "ar";
  const r = item.reason;
  const parts: string[] = [];
  if (r.code === "SAMPLE") parts.push(ar ? (third ? `أرسل عيّنة قبل ${days(r.daysSinceSent, lang)}، وما سجّل رأيهم` : `أرسلت عيّنة قبل ${days(r.daysSinceSent, lang)}، وما سجّلت رأيهم`) : `Sample sent ${days(r.daysSinceSent, lang)} ago, no feedback recorded`);
  else if (r.code === "FOLLOW_UP") parts.push(ar ? `${r.dealTitle} · ${n(r.amount)} ريال` : `${r.dealTitle} · SAR ${n(r.amount)}`);
  else if (r.code === "NO_CONTACT") parts.push(ar ? `المعتاد ${third ? "يتواصل" : "تتواصل"} كل ${days(r.thresholdDays, lang)}` : `Usually in touch every ${days(r.thresholdDays, lang)}`);
  else if (r.code === "CALLED") parts.push(ar ? `متأخر ${days(r.daysLate, lang)} · يطلع من القائمة لما يطلب، أو يرجع بعد ${days(r.awaitDays, lang)} بدون طلب`
    : `${days(r.daysLate, lang)} late · leaves the list when the order comes, or is back after ${days(r.awaitDays, lang)} without one`);
  else if (item.intervalDays) parts.push(ar ? `عادةً يطلب كل ${days(item.intervalDays, lang)}` : `Usually orders every ${days(item.intervalDays, lang)}`);
  if (item.kgPerMonth > 0 && r.code !== "FOLLOW_UP") parts.push(ar ? `${n(item.kgPerMonth)} كجم بالشهر` : `${n(item.kgPerMonth)} kg/month`);
  if (item.tier) parts.push(ar ? TIER_LABEL[item.tier].ar : TIER_LABEL[item.tier].en);
  if (r.code !== "NO_CONTACT") {
    if (item.lastContactDays !== null) parts.push(item.lastContactDays === 0 ? (ar ? (third ? "تواصل اليوم" : "تواصلت اليوم") : "contacted today") : ar ? `آخر تواصل قبل ${days(item.lastContactDays, lang)}` : `last contact ${days(item.lastContactDays, lang)} ago`);
  }
  return parts.join(" · ");
}

/** wa.me wants the number in international form without «+»: a Saudi 05… number becomes 9665…; null when unusable. */
export function waNumber(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const d = phone.replace(/[^\d+]/g, "").replace(/^\+/, "").replace(/^00/, "");
  if (/^05\d{8}$/.test(d)) return `966${d.slice(1)}`;
  if (/^5\d{8}$/.test(d)) return `966${d}`;
  if (/^9665\d{8}$/.test(d)) return d;
  if (/^\d{8,15}$/.test(d)) return d;
  return null;
}

export function telHref(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const d = phone.replace(/[^\d+]/g, "");
  return d.length >= 6 ? `tel:${d}` : null;
}

const MONTHS_AR = ["يناير", "فبراير", "مارس", "أبريل", "مايو", "يونيو", "يوليو", "أغسطس", "سبتمبر", "أكتوبر", "نوفمبر", "ديسمبر"];
const MONTHS_EN = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DAYS_AR = ["الأحد", "الاثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"];
const DAYS_EN = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** "2026-10" → «أكتوبر» / "October". */
export function monthName(key: string, lang: Lang): string {
  const m = Number(key.slice(5, 7)) - 1;
  return (lang === "ar" ? MONTHS_AR : MONTHS_EN)[m] ?? key;
}

/** The Riyadh date line: «الخميس 30 أكتوبر». */
export function todayLine(now: Date, lang: Lang): string {
  const r = new Date(now.getTime() + 3 * 3_600_000);
  const day = (lang === "ar" ? DAYS_AR : DAYS_EN)[r.getUTCDay()];
  const month = (lang === "ar" ? MONTHS_AR : MONTHS_EN)[r.getUTCMonth()];
  return lang === "ar" ? `${day} ${r.getUTCDate()} ${month}` : `${day} ${r.getUTCDate()} ${month}`;
}

/** «صباح الخير» before noon (Riyadh), «مساء الخير» after. */
export function greeting(now: Date, firstName: string, lang: Lang): string {
  const h = new Date(now.getTime() + 3 * 3_600_000).getUTCHours();
  if (lang === "en") return `${h < 12 ? "Good morning" : "Good evening"}, ${firstName}`;
  return `${h < 12 ? "صباح الخير" : "مساء الخير"} يا ${firstName}`;
}
