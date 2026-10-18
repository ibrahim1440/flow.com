// Native HR — payroll CONTROLS around the engine (P-2 findings 1, 5, 10). Pure: no database.
//
// Nothing here computes or changes a pay amount. Each function looks at what the unchanged engine
// (./payroll-engine) produced and at the approved inputs, and reports what a reviewer must see:
//   · unpaidLeaveControls — a BLOCKING exception when approved unpaid leave covers the whole
//     payable period yet pay of the components unpaid leave is meant to remove is still left
//     (finding 1: e.g. February FIXED_30, 6,000 − 6,000 × 28/30 = 400). Review P1-A1 / P2-A3:
//     nothing but corrected leave / attendance data clears it — no attestation (the amount rule
//     is the accountant's decision D-2a, still open) and no deduction adjustment (an ordinary
//     deduction would book unearned pay as a liability, OTHER_DEDUCTIONS_PAYABLE); when the same day is held
//     by two approved unpaid leaves (it would be deducted twice); and when an approved unpaid leave
//     is of a leave type still marked as a proposal (E-1: proposals never move money);
//   · singleRoundingDifference — the per-component vs single rounding difference of a line, read
//     from its stored snapshot (finding 5 / E-4), reported only;
//   · dedupeDays — one entry per calendar day.
import { D, Decimal, ZERO, round2, sum } from "./money";
import { addDays, dayString, monthBounds, parseDay } from "./dates";
import type { Component, EngineException } from "./payroll-engine";

const COMPONENT_CODE: Record<Component, string> = { BASIC: "BASIC", HOUSING: "HOUSING", TRANSPORT: "TRANSPORT", OTHER: "OTHER_ALLOWANCE" };
export const FIXED_PAY_CODES = Object.values(COMPONENT_CODE);

export type UnpaidLeave = { id: string; startDate: Date; endDate: Date; leaveTypeCode: string; leaveTypeProposal: boolean };
export type ControlItem = { code: string; kind: string; amount: Decimal };

export const UNPAID_FULL_PERIOD = "UNPAID_FULL_PERIOD";
export const UNPAID_LEAVE_OVERLAP = "UNPAID_LEAVE_OVERLAP";
export const LEAVE_TYPE_PROPOSAL = "LEAVE_TYPE_PROPOSAL";

/** Unique calendar days, in order. */
export function dedupeDays(days: Date[]): Date[] {
  const m = new Map<string, Date>();
  for (const d of days) m.set(dayString(d), d);
  return [...m.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, d]) => d);
}

export type UnpaidControlResult = {
  exceptions: EngineException[];
  /** Every calendar day of the payable period lies inside an approved unpaid leave. */
  fullPeriod: boolean;
  /** Pay left of the policy's unpaid-leave components after the unpaid-leave deduction only (≥ 0). */
  remainder: Decimal;
  overlapDays: string[];
  proposalLeaveTypes: string[];
};

/**
 * `employed`: the payable period of the line (the engine's employed range, YYYY-MM-DD) or null.
 *
 * Review P1-A1: a whole payable period of approved unpaid leave with pay still left is BLOCKING,
 * and NOTHING in the payroll run clears it — no second-person attestation (the remainder is the
 * open accountant decision D-2a; an attestation cannot decide it) and no deduction adjustment
 * (P2-A3: only the UNPAID_LEAVE deduction counts against the remainder, so an ordinary deduction
 * neither shrinks it nor books unearned pay to OTHER_DEDUCTIONS_PAYABLE). It clears only when the
 * leave / attendance data is corrected, or once an approved D-2a rule changes the engine.
 */
export function unpaidLeaveControls(input: {
  month: string;
  employed: { from: string; to: string } | null;
  leaves: UnpaidLeave[];
  items: ControlItem[];
  unpaidLeaveComponents: Component[];
}): UnpaidControlResult {
  const { start, end } = monthBounds(input.month);
  const exceptions: EngineException[] = [];
  const inMonth = input.leaves.filter((l) => l.startDate <= end && l.endDate >= start);

  // Overlap: a calendar day of the month held by two approved unpaid leaves.
  const count = new Map<string, number>();
  for (const l of inMonth) for (let d = l.startDate > start ? l.startDate : start; d <= (l.endDate < end ? l.endDate : end); d = addDays(d, 1)) count.set(dayString(d), (count.get(dayString(d)) ?? 0) + 1);
  const overlapDays = [...count.entries()].filter(([, n]) => n > 1).map(([k]) => k).sort();
  if (overlapDays.length) exceptions.push({ code: UNPAID_LEAVE_OVERLAP, severity: "BLOCKING", message: `إجازات بدون راتب معتمدة متداخلة في ${overlapDays.length} يوم (${overlapDays[0]}${overlapDays.length > 1 ? ` … ${overlapDays[overlapDays.length - 1]}` : ""}). لا يُخصم اليوم مرتين: صحّح الإجازات ثم أعد البناء.` });

  const proposalLeaveTypes = [...new Set(inMonth.filter((l) => l.leaveTypeProposal).map((l) => l.leaveTypeCode))].sort();
  if (proposalLeaveTypes.length) exceptions.push({ code: LEAVE_TYPE_PROPOSAL, severity: "BLOCKING", message: `نوع الإجازة ${proposalLeaveTypes.join("، ")} ما زال مقترحًا ويؤثر في الراتب. يؤكده مسؤول سياسات ثانٍ قبل احتساب المسيّر.` });

  let fullPeriod = false;
  let remainder = ZERO;
  if (input.employed) {
    const from = parseDay(input.employed.from), to = parseDay(input.employed.to);
    fullPeriod = from <= to;
    for (let d = from; d <= to && fullPeriod; d = addDays(d, 1)) if (!(count.get(dayString(d)) ?? 0)) fullPeriod = false;
    if (fullPeriod) {
      const codes = new Set(input.unpaidLeaveComponents.map((c) => COMPONENT_CODE[c]));
      const earned = sum(input.items.filter((i) => i.kind === "EARNING" && codes.has(i.code)).map((i) => i.amount));
      // P2-A3: only the unpaid-leave deduction itself — never a deduction adjustment.
      const taken = sum(input.items.filter((i) => i.kind === "DEDUCTION" && i.code === "UNPAID_LEAVE").map((i) => i.amount));
      remainder = round2(earned.minus(taken));
      if (remainder.lessThan(0)) remainder = ZERO;
      // P1-A1: always BLOCKING; no attestation or adjustment can release it (D-2a is open).
      if (remainder.greaterThan(0)) exceptions.push({ code: UNPAID_FULL_PERIOD, severity: "BLOCKING", message: `الفترة المستحقة كلها (${input.employed.from} → ${input.employed.to}) إجازة بدون راتب معتمدة، ومع ذلك يتبقى ${remainder.toFixed(2)} من مكونات الخصم. لا يُصرف ولا يُرفع الحظر بإقرار أو باستقطاع: صحّح بيانات الإجازة أو الحضور ثم أعد البناء (قاعدة الاحتساب قرار المحاسب D-2a).` });
    }
  }
  return { exceptions, fullPeriod, remainder, overlapDays, proposalLeaveTypes };
}

/**
 * P-2 rev3 item 6 — the day figures of a line, each in ONE unit, never mixed (display only: nothing
 * here changes an amount; D-1 and D-2a are open):
 *   · calendarServiceDays — calendar days of service in the month (employed from → to);
 *   · unpaidCalendarDays — calendar days of approved unpaid leave within that service;
 *   · basisUnits / serviceUnits — the pay basis (FIXED_30: 30; CALENDAR_DAYS: the month's days) and
 *     the units of it the service earns (FIXED_30 counts by the 30-day rule: 1 day on 28 Feb is 3);
 *   · unpaidDeductedUnits — the units the configured unpaid-leave rule deducted (today one per
 *     unpaid WORKING day; weekends are not deducted — D-2a);
 *   · payUnits = serviceUnits − unpaidDeductedUnits (≥ 0): what the amount is computed on;
 *   · payslipDays — the figure printed on the payslip: payUnits, or 0 when the whole period is
 *     unpaid leave (status BLOCKED_FULL_UNPAID when pay is still left — the line is BLOCKING and
 *     never paid — or FULL_UNPAID when nothing is left).
 */
export type DayBreakdown = {
  basis: string; basisUnits: number; serviceFrom: string; serviceTo: string;
  calendarServiceDays: number; unpaidCalendarDays: number; unpaidDeductedUnits: number; unpaidCounting: "WORKING_DAYS";
  serviceUnits: number; payUnits: number; payslipDays: number; status: "PAYABLE" | "BLOCKED_FULL_UNPAID" | "FULL_UNPAID";
};

export function dayBreakdown(input: { basis: string; basisUnits: number; employed: { from: string; to: string }; serviceUnits: number; leaves: { startDate: Date; endDate: Date }[]; unpaidDeductedUnits: number; fullPeriod: boolean; remainder: Decimal }): DayBreakdown {
  const from = parseDay(input.employed.from), to = parseDay(input.employed.to);
  const unpaid = new Set<string>();
  for (const l of input.leaves) for (let d = l.startDate > from ? l.startDate : from; d <= (l.endDate < to ? l.endDate : to); d = addDays(d, 1)) unpaid.add(dayString(d));
  let calendarServiceDays = 0;
  for (let d = from; d <= to; d = addDays(d, 1)) calendarServiceDays++;
  const payUnits = Math.max(0, input.serviceUnits - input.unpaidDeductedUnits);
  const status = input.fullPeriod ? (input.remainder.greaterThan(0) ? "BLOCKED_FULL_UNPAID" : "FULL_UNPAID") : "PAYABLE";
  return {
    basis: input.basis, basisUnits: input.basisUnits, serviceFrom: input.employed.from, serviceTo: input.employed.to,
    calendarServiceDays, unpaidCalendarDays: unpaid.size, unpaidDeductedUnits: input.unpaidDeductedUnits, unpaidCounting: "WORKING_DAYS",
    serviceUnits: input.serviceUnits, payUnits, payslipDays: status === "PAYABLE" ? payUnits : 0, status,
  };
}

/**
 * Finding 5 / E-4, informational only: the line's fixed pay as stored (rounded per component)
 * against the same pay rounded once, from the line's stored snapshot (segments × days ÷ basis).
 * Null when the snapshot does not carry segments (correction lines, older shapes).
 */
export function singleRoundingDifference(snapshot: unknown, items: { code: string; kind: string; amount: { toString(): string } }[]): { perComponent: string; singleRounded: string; differenceHalalas: number } | null {
  const s = snapshot as { policy?: { basisDays?: number }; segments?: { days?: number; basic?: string; housing?: string; transport?: string; other?: string }[] } | null;
  if (!s || typeof s.policy?.basisDays !== "number" || !Array.isArray(s.segments) || s.segments.length === 0) return null;
  const basis = s.policy.basisDays;
  let raw = ZERO;
  for (const g of s.segments) {
    const monthly = D(g.basic ?? "0").plus(D(g.housing ?? "0")).plus(D(g.transport ?? "0")).plus(D(g.other ?? "0"));
    raw = raw.plus(monthly.times(g.days ?? 0).dividedBy(basis));
  }
  const single = round2(raw);
  const perComponent = sum(items.filter((i) => i.kind === "EARNING" && FIXED_PAY_CODES.includes(i.code)).map((i) => D(i.amount.toString())));
  return { perComponent: perComponent.toFixed(2), singleRounded: single.toFixed(2), differenceHalalas: perComponent.minus(single).times(100).toNumber() };
}
