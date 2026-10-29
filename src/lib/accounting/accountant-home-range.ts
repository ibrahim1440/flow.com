// «لوحة المتابعة» — the period and its months (pure; unit-tested without a database). See ./accountant-home.ts.
import { dayText, riyadhDay } from "./dates";

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const monthKey = (d: string) => d.slice(0, 7);

/** The months of [from, to], the last twelve at most (Qoyod draws a year). */
export function monthsOf(from: string, to: string): string[] {
  const out: string[] = [];
  let y = Number(to.slice(0, 4)), m = Number(to.slice(5, 7));
  const stop = monthKey(from);
  while (out.length < 12) {
    const k = `${y}-${String(m).padStart(2, "0")}`;
    out.unshift(k);
    if (k <= stop) break;
    m -= 1; if (m === 0) { m = 12; y -= 1; }
  }
  return out;
}

export function defaultRange(today: Date = riyadhDay()): { from: string; to: string } {
  return { from: `${today.getUTCFullYear()}-01-01`, to: dayText(today) };
}

export function parseRange(from: string | null, to: string | null, today: Date = riyadhDay()): { from: string; to: string } {
  const d = defaultRange(today);
  const f = from && DAY.test(from) ? from : d.from;
  const t = to && DAY.test(to) ? to : d.to;
  return f <= t ? { from: f, to: t } : { from: t, to: f };
}

