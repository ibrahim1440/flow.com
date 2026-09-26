// Time-phasing of a monthly budget line: how much of the month's plan was due by a date.
//
// A mid-month actual is compared against the plan DUE by that date, never against the whole
// month. Methods:
//   DUE_DATE        the whole amount falls due on the line's due date (default). A line
//                   with no due date is treated as due on the last day of the month.
//   CUSTOM_WEIGHTS  { "1": 2, "15": 1, ... } day-of-month → weight; due in proportion.
//   STRAIGHT_LINE   evenly per day. Only when explicitly chosen for the line.
// The last day of the month always yields the full planned amount, exactly.

import { daysInMonth, monthEnd } from "./dates";
import type { Minor } from "./money";

export type Phasing = "DUE_DATE" | "CUSTOM_WEIGHTS" | "STRAIGHT_LINE";

export type PhasedLine = {
  planned: Minor;
  phasing: Phasing;
  dueDate?: string | null;
  weights?: Record<string, number> | null;
};

export function plannedThrough(line: PhasedLine, month: string, reportDate: string): Minor {
  const end = monthEnd(month);
  if (reportDate >= end) return line.planned;
  if (reportDate < `${month}-01`) return 0;
  const day = Number(reportDate.slice(8, 10));
  const dim = daysInMonth(month);

  switch (line.phasing) {
    case "DUE_DATE": {
      const due = line.dueDate && line.dueDate.startsWith(month) ? line.dueDate : end;
      return reportDate >= due ? line.planned : 0;
    }
    case "STRAIGHT_LINE":
      return Math.floor((line.planned * day) / dim);
    case "CUSTOM_WEIGHTS": {
      const w = line.weights ?? {};
      let total = 0;
      let upTo = 0;
      for (const [k, v] of Object.entries(w)) {
        const d = Math.min(Number(k), dim);
        if (!Number.isInteger(d) || d < 1 || !(v > 0)) continue;
        total += v;
        if (d <= day) upTo += v;
      }
      if (total === 0) return reportDate >= end ? line.planned : 0;
      return Number((BigInt(line.planned) * BigInt(Math.round(upTo * 1000))) / BigInt(Math.round(total * 1000)));
    }
  }
}

export function validateWeights(raw: unknown): Record<string, number> | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const d = Number(k);
    if (!Number.isInteger(d) || d < 1 || d > 31) return null;
    if (typeof v !== "number" || !(v > 0) || v > 1_000_000) return null;
    out[String(d)] = v;
  }
  return Object.keys(out).length ? out : null;
}
