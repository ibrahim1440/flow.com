// Budget pacing and the guard every automatic spend change passes. Pure.

import { round, type Num } from "./kpi";

export type PeriodSpan = { start: Date; end: Date; days: number };

/** "2026-11" or "2026-Q4" → its span (UTC dates of the company's calendar days). */
export function periodSpan(period: string): PeriodSpan {
  const m = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(period);
  const q = /^(\d{4})-Q([1-4])$/.exec(period);
  let start: Date, end: Date;
  if (m) {
    start = new Date(Date.UTC(+m[1], +m[2] - 1, 1));
    end = new Date(Date.UTC(+m[1], +m[2], 1));
  } else if (q) {
    start = new Date(Date.UTC(+q[1], (+q[2] - 1) * 3, 1));
    end = new Date(Date.UTC(+q[1], +q[2] * 3, 1));
  } else {
    throw new Error("period must be YYYY-MM or YYYY-Qn");
  }
  return { start, end, days: Math.round((end.getTime() - start.getTime()) / 86_400_000) };
}

export function isValidPeriod(period: string): boolean {
  return /^\d{4}-(0[1-9]|1[0-2]|Q[1-4])$/.test(period);
}

export type Pacing = {
  planned: number;
  actual: Num;
  remaining: Num;
  daysElapsed: number;
  daysTotal: number;
  /** Spend expected by today at an even rate. */
  expectedToDate: number;
  /** Projected spend at period end at the current run rate. */
  forecast: Num;
  /** forecast − planned (positive = projected overspend). */
  forecastVariance: Num;
  usedPct: Num;
  status: "NO_DATA" | "UNDER" | "ON_TRACK" | "OVER_PACE" | "EXCEEDED";
};

/** `today` counts as elapsed through its end; actual is spend reported so far (null = none reported). */
export function pacing(planned: number, actual: Num, span: PeriodSpan, today: Date, tolerance = 0.1): Pacing {
  const elapsedMs = Math.min(Math.max(today.getTime() - span.start.getTime() + 86_400_000, 0), span.end.getTime() - span.start.getTime());
  const daysElapsed = Math.min(span.days, Math.floor(elapsedMs / 86_400_000));
  const expectedToDate = round((planned * daysElapsed) / span.days);
  if (actual === null) {
    return { planned, actual, remaining: null, daysElapsed, daysTotal: span.days, expectedToDate, forecast: null, forecastVariance: null, usedPct: null, status: "NO_DATA" };
  }
  const forecast = daysElapsed > 0 ? round((actual / daysElapsed) * span.days) : null;
  let status: Pacing["status"] = "ON_TRACK";
  if (actual > planned) status = "EXCEEDED";
  else if (forecast !== null && forecast > planned * (1 + tolerance)) status = "OVER_PACE";
  else if (forecast !== null && forecast < planned * (1 - tolerance)) status = "UNDER";
  return {
    planned, actual, remaining: round(planned - actual), daysElapsed, daysTotal: span.days, expectedToDate,
    forecast, forecastVariance: forecast === null ? null : round(forecast - planned), usedPct: planned > 0 ? round((actual / planned) * 100, 1) : null, status,
  };
}

export type SpendChange = { currentDaily: number; proposedDaily: number };

/**
 * Whether an AUTOMATIC daily-budget change may run without a person. Every condition must hold:
 * the rule is enabled, the change is an increase within the line's cap step, the new daily amount
 * stays under the line's daily cap, the period has headroom for the rest of the days, and no kill
 * switch is on. Anything else goes to approval — returned with the reason.
 */
export function autoChangeAllowed(args: {
  change: SpendChange;
  ruleEnabled: boolean;
  maxAutoIncreasePct: Num;
  dailyCap: Num;
  headroom: Num;
  daysLeft: number;
  killed: boolean;
}): { allowed: true } | { allowed: false; reasonAr: string } {
  const { change, ruleEnabled, maxAutoIncreasePct, dailyCap, headroom, daysLeft, killed } = args;
  if (killed) return { allowed: false, reasonAr: "الإيقاف الطارئ للإعلانات مفعّل." };
  if (!ruleEnabled) return { allowed: false, reasonAr: "القاعدة الآلية غير مفعّلة." };
  if (maxAutoIncreasePct === null || maxAutoIncreasePct <= 0) return { allowed: false, reasonAr: "لا يوجد حد أقصى معتمد للزيادة التلقائية." };
  if (change.proposedDaily <= change.currentDaily) return { allowed: false, reasonAr: "التخفيض أو الإيقاف يمر عبر الموافقة." };
  if (change.currentDaily <= 0) return { allowed: false, reasonAr: "لا ميزانية يومية حالية يُقاس عليها." };
  const step = (change.proposedDaily - change.currentDaily) / change.currentDaily;
  if (step > maxAutoIncreasePct + 1e-9) return { allowed: false, reasonAr: `الزيادة ${Math.round(step * 100)}% تتجاوز الحد المعتمد ${Math.round(maxAutoIncreasePct * 100)}%.` };
  if (dailyCap !== null && change.proposedDaily > dailyCap) return { allowed: false, reasonAr: "تتجاوز الحد اليومي للبند." };
  if (headroom === null) return { allowed: false, reasonAr: "لا ميزانية معتمدة للفترة." };
  if (change.proposedDaily * daysLeft > headroom) return { allowed: false, reasonAr: "لا يتسع المتبقي من الميزانية لبقية الفترة." };
  return { allowed: true };
}
