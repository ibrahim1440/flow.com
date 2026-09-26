// Rolling 13-week cash forecast. Pure.
//
// Cash only: opening cash is CONFIRMED money in the accounts; receipts are expected
// collections (never counted as cash until they arrive); payments are open obligations,
// payment requests not tied to an obligation, and planned payments. Internal allocations
// are NOT payments and are never subtracted here — they are earmarks of the same cash.
//
// Each week's closing balance is the next week's opening balance. Items dated before the
// first week (overdue) are placed in week 1: they are still expected.
//
// Conservative scenario: collections arrive `delayWeeks` later and only `collectPct`% of
// each arrives within the horizon. Payments are unchanged (obligations do not wait).

import { addDays } from "./dates";
import type { Minor } from "./money";

export type FlowItem = { date: string; amount: Minor; label: string; source: string; collection?: boolean };

export type Week = {
  index: number;
  start: string;
  end: string;
  opening: Minor;
  receipts: Minor;
  payments: Minor;
  closing: Minor;
};

export type ForecastResult = {
  weeks: Week[];
  lowestClosing: Minor;
  lowestWeek: number;
  firstShortfallWeek: number | null;
};

export function buildWeeks(start: string, count = 13): { start: string; end: string }[] {
  return Array.from({ length: count }, (_, i) => ({ start: addDays(start, i * 7), end: addDays(start, i * 7 + 6) }));
}

function weekIndex(weeks: { start: string; end: string }[], date: string): number {
  if (date < weeks[0].start) return 0;
  for (let i = 0; i < weeks.length; i++) if (date <= weeks[i].end) return i;
  return -1; // beyond horizon
}

export function runForecast(
  opening: Minor,
  start: string,
  receipts: FlowItem[],
  payments: FlowItem[],
  scenario: { delayWeeks: number; collectPct: number } | null = null,
  weeksCount = 13,
): ForecastResult {
  const frame = buildWeeks(start, weeksCount);
  const rec = new Array<Minor>(weeksCount).fill(0);
  const pay = new Array<Minor>(weeksCount).fill(0);

  for (const r of receipts) {
    let date = r.date;
    let amount = r.amount;
    if (scenario && r.collection !== false) {
      date = addDays(date < start ? start : date, scenario.delayWeeks * 7);
      amount = Math.floor((amount * scenario.collectPct) / 100);
    }
    const i = weekIndex(frame, date);
    if (i >= 0) rec[i] += amount;
  }
  for (const p of payments) {
    const i = weekIndex(frame, p.date);
    if (i >= 0) pay[i] += p.amount;
  }

  const weeks: Week[] = [];
  let open = opening;
  let lowest = Number.POSITIVE_INFINITY;
  let lowestWeek = 0;
  let firstShortfall: number | null = null;
  frame.forEach((w, i) => {
    const closing = open + rec[i] - pay[i];
    weeks.push({ index: i + 1, start: w.start, end: w.end, opening: open, receipts: rec[i], payments: pay[i], closing });
    if (closing < lowest) { lowest = closing; lowestWeek = i + 1; }
    if (closing < 0 && firstShortfall === null) firstShortfall = i + 1;
    open = closing;
  });
  return { weeks, lowestClosing: lowest, lowestWeek, firstShortfallWeek: firstShortfall };
}
