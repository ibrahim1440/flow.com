// D16 «خطتي» — the plain logic of the plan screens (no React, no CSS), shared by khitati.tsx and plan-week.tsx and unit-
// tested (tests/sales/unit/plan-d16.test.ts): the working week's days, the day strip and its labels, a time's label, and
// «خطّط أسبوعك»'s suggestions and days.
import { addDays, dayName, dayNum, MONTH_AR, wd, weekOf } from "./plan-dates";

export type AMetric = "VISITS" | "CALLS" | "QUOTES" | "COLLECTION" | "SAMPLES";
// ─── Days and times (Riyadh dates "YYYY-MM-DD"; the working week is Sunday–Thursday) ──────────────────────────────
export const isWork = (iso: string) => wd(iso) <= 4;
export function nextWork(iso: string): string { let d = addDays(iso, 1); while (!isWork(d)) d = addDays(d, 1); return d; }
/** The day strip of «أضف لخطتي»: today (or the next working day), then the next four working days. */
export function stripDays(today: string): string[] {
  const out = [isWork(today) ? today : nextWork(today)];
  while (out.length < 5) out.push(nextWork(out[out.length - 1]));
  return out;
}
/** «اليوم» / «بكرة» / «الأربعاء 11»; outside this week the month too («الأحد 15 نوفمبر») — D16 gate. */
export const dayLabel = (iso: string, today: string, ar: boolean) => {
  if (iso === today) return ar ? "اليوم" : "Today";
  if (iso === addDays(today, 1)) return ar ? "بكرة" : "Tomorrow";
  const base = `${dayName(iso, ar)} ${dayNum(iso)}`;
  if (weekOf(iso) === weekOf(today)) return base;
  return `${base} ${ar ? MONTH_AR[Number(iso.slice(5, 7)) - 1] : new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-GB", { month: "short", timeZone: "UTC" })}`;
};
/** "14:05" → «2:05 م» / «2:05 PM». */
export function timeLabel(hhmm: string, ar: boolean): string {
  const [h, m] = hhmm.split(":").map(Number);
  const h12 = ((h + 11) % 12) + 1;
  return `${h12}:${String(m).padStart(2, "0")} ${ar ? (h < 12 ? "ص" : "م") : h < 12 ? "AM" : "PM"}`;
}

export type WeekSource = {
  callList: { customerId: string | null; name: string; nameAr: string | null; reason: { code: string; daysLate?: number; intervalDays?: number; days?: number | null } }[];
  contracts: { customerId: string; customerName: string; daysLeft: number }[];
  owed: { customerId: string; name: string; nameAr: string | null; net: string; oldestDays: number }[];
};
export type Group = "late" | "owed" | "contract" | "quiet" | "added";
export type Sug = { id: string; name: string; why: string; group: Group; kind: AMetric; pick: boolean };
export const GROUPS: { g: Group; ar: string; en: string }[] = [
  { g: "late", ar: "طلبهم متأخر عن عادتهم", en: "Late to reorder" },
  { g: "owed", ar: "عليهم تحصيل متأخر", en: "Money owed" },
  { g: "contract", ar: "عقدهم قرب يخلص", en: "Contract ending soon" },
  { g: "quiet", ar: "ما تواصلت معهم من فترة", en: "Not contacted lately" },
  { g: "added", ar: "أضفتهم أنت", en: "Added by you" },
];
export const CYCLE: AMetric[] = ["VISITS", "CALLS", "QUOTES", "COLLECTION", "SAMPLES"];

/** The suggestions, one per customer (the first reason wins), from what «يومي» already computed. */
export function suggestionsOf(src: WeekSource, ar: boolean): Sug[] {
  const out: Sug[] = [];
  const seen = new Set<string>();
  const push = (s: Sug) => { if (!s.id || seen.has(s.id)) return; seen.add(s.id); out.push(s); };
  const nm = (x: { name: string; nameAr: string | null }) => (ar ? x.nameAr || x.name : x.name);
  for (const c of src.callList.filter((x) => x.reason.code === "LATE" || x.reason.code === "DUE").slice(0, 6)) {
    const r = c.reason;
    push({ id: c.customerId ?? "", name: nm(c), group: "late", kind: "CALLS", pick: true,
      why: r.code === "LATE" ? (ar ? `يطلب كل ${r.intervalDays} يوم · متأخر ${r.daysLate} يوم` : `Orders every ${r.intervalDays}d · ${r.daysLate}d late`) : ar ? `يطلب كل ${r.intervalDays} يوم · حان موعده` : `Orders every ${r.intervalDays}d · due now` });
  }
  for (const o of [...src.owed].sort((a, b) => b.oldestDays - a.oldestDays).slice(0, 6)) {
    push({ id: o.customerId, name: nm(o), group: "owed", kind: "COLLECTION", pick: o.oldestDays >= 30,
      why: ar ? `${Number(o.net).toLocaleString("en-US", { maximumFractionDigits: 0 })} ⃁ · أقدم فاتورة قبل ${o.oldestDays} يوم` : `SAR ${Number(o.net).toLocaleString("en-US", { maximumFractionDigits: 0 })} · oldest ${o.oldestDays}d` });
  }
  for (const c of src.contracts.slice(0, 6)) {
    push({ id: c.customerId, name: c.customerName, group: "contract", kind: "VISITS", pick: false, why: ar ? `العقد يخلص بعد ${c.daysLeft} يوم` : `Contract ends in ${c.daysLeft}d` });
  }
  for (const c of src.callList.filter((x) => x.reason.code === "NO_CONTACT").slice(0, 6)) {
    push({ id: c.customerId ?? "", name: nm(c), group: "quiet", kind: "VISITS", pick: true,
      why: c.reason.days ? (ar ? `آخر تواصل قبل ${c.reason.days} يوم` : `Last contact ${c.reason.days}d ago`) : ar ? "ما تواصلت معه أبد" : "Never contacted" });
  }
  return out;
}

/** The week the planner fills: this week from today (Sunday–Thursday), or next week on a Friday or Saturday. */
export function planDays(today: string): string[] {
  const first = isWork(today) ? today : nextWork(today);
  const ws = weekOf(first);
  return [0, 1, 2, 3, 4].map((n) => addDays(ws, n)).filter((d) => d >= first);
}
