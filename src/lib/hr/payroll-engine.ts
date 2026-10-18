// Native HR — the payroll calculation for ONE person and ONE month. Pure: no database, no
// clock, no HTTP. Everything it needs arrives as plain values, so every business example
// can be asserted directly (tests/hr/unit/payroll-engine.test.ts).
//
// ── What is policy and what is arithmetic ──
// The day basis, overtime multiplier, deduction cap, which components unpaid leave and
// overtime are computed on, and every contribution rate come from the effective-dated
// payroll policy. NONE of them is decided here, and none ships with an approved value: the
// policy row says whether its values are still a proposal. This file only applies them.
import { D, Decimal, ZERO, round2, sum } from "./money";
import { addDays, dayString, daysInclusive, localDay, monthBounds } from "./dates";

export type Component = "BASIC" | "HOUSING" | "TRANSPORT" | "OTHER";
export const COMPONENTS: Component[] = ["BASIC", "HOUSING", "TRANSPORT", "OTHER"];

export type DayBasis = "CALENDAR_DAYS" | "FIXED_30";

export type CompSegment = {
  id: string;
  effectiveFrom: Date;
  effectiveTo: Date | null;
  basic: Decimal;
  housing: Decimal;
  transport: Decimal;
  other: Decimal;
};

export type EnginePolicy = {
  id: string;
  version: number;
  dayBasis: DayBasis;
  standardDailyHours: Decimal;
  overtimeMultiplier: Decimal;
  maxDeductionPercent: Decimal;
  unpaidLeaveComponents: Component[];
  overtimeComponents: Component[];
  isProposal: boolean;
  /**
   * P-2 findings 2/3: the deduction categories as the policy configures them (every value an
   * accountant decision). Absent = the original behaviour (only advance installments capped, on
   * gross) — kept for the engine's worked examples; payroll runs always pass it.
   */
  deductions?: DeductionConfig;
};

/** P-2 finding 3: the four deduction categories, modelled separately. */
export type DeductionCategory = "UNEARNED_PAY" | "LOAN_RECOVERY" | "STATUTORY" | "OTHER";
export const DEDUCTION_CATEGORIES: DeductionCategory[] = ["UNEARNED_PAY", "LOAN_RECOVERY", "STATUTORY", "OTHER"];

export type DeductionConfig = {
  /** false: the cap base is guaranteed pay only (no commission, overtime or one-off earnings). */
  capBaseIncludesVariable: boolean;
  /**
   * Review P2-B7 (S-3.3): true → the cap base is the wage due AFTER unearned pay (the unpaid-leave
   * deduction is taken off the base first). An accountant decision per policy version; no default.
   */
  capBaseAfterUnearned: boolean;
  /** Per-category cap, % of the cap base. */
  categoryCapPercent: Record<DeductionCategory, Decimal>;
  /** Categories the overall cap (policy maxDeductionPercent) covers. */
  overallCovers: DeductionCategory[];
  /** All four categories, in the order they apply. */
  priority: DeductionCategory[];
  /** What a non-deferrable category over its cap (or over the overall cap) does to the line. */
  onExceed: "WARN" | "BLOCK";
};

/** Which category a deduction item belongs to (advance installments are LOAN_RECOVERY). */
export function deductionCategoryOf(code: string): DeductionCategory | null {
  if (code === "UNPAID_LEAVE") return "UNEARNED_PAY";
  if (code === "ADVANCE_INSTALLMENT") return "LOAN_RECOVERY";
  if (code.startsWith("CONTRIB_EE:")) return "STATUTORY";
  if (code === "ADJUSTMENT_DEDUCTION") return "OTHER";
  return null;
}

/** Earnings that are not guaranteed pay: excluded from the cap base unless the policy says otherwise. */
export const VARIABLE_EARNINGS = ["OVERTIME", "COMMISSION", "ADJUSTMENT_EARNING"];

export type EngineContribution = {
  code: string;
  nameAr: string;
  employeeRatePercent: Decimal;
  employerRatePercent: Decimal;
  baseComponents: Component[];
  monthlyBaseCap: Decimal | null;
};

export type EngineInput = {
  month: string;
  policy: EnginePolicy;
  hireDate: Date;
  separationDate: Date | null;
  compensations: CompSegment[];
  /** Calendar days of APPROVED unpaid leave inside the month (caller expands requests). */
  unpaidLeaveDays: Date[];
  overtime: { id: string; workDate: Date; minutes: number }[];
  commissions: { reservationKey: string; periodStart: Date; amount: Decimal }[];
  installments: { id: string; advanceNo: string; seq: number; amount: Decimal }[];
  adjustments: { id: string; kind: "EARNING" | "DEDUCTION"; amount: Decimal; reason: string }[];
  contributions: EngineContribution[];
  /** Rules exist but the person's contribution group is unknown. */
  contributionGroupMissing: boolean;
  absentDays: number;
  openAttendanceDays: number;
};

export type EngineItem = {
  code: string;
  kind: "EARNING" | "DEDUCTION" | "EMPLOYER";
  amount: Decimal;
  quantity?: Decimal;
  rate?: Decimal;
  sourceType?: string;
  sourceId?: string;
  description: string;
  /** DEDUCTION items under a deduction config: the category and the position it was applied in. */
  category?: DeductionCategory;
  applyOrder?: number;
};

/** BLOCKING stops submission and approval; WARNING and INFO never do (WARNING: a check is incomplete). */
export type EngineException = { code: string; severity: "BLOCKING" | "WARNING" | "INFO"; message: string };

export type EngineResult = {
  employed: boolean;
  payableDays: Decimal;
  items: EngineItem[];
  gross: Decimal;
  deductions: Decimal;
  net: Decimal;
  employer: Decimal;
  exceptions: EngineException[];
  blocking: boolean;
  includedInstallmentIds: string[];
  deferredInstallmentIds: string[];
  usedOvertimeIds: string[];
  snapshot: Record<string, unknown>;
};

const monthly = (s: CompSegment, c: Component): Decimal =>
  c === "BASIC" ? s.basic : c === "HOUSING" ? s.housing : c === "TRANSPORT" ? s.transport : s.other;

const COMPONENT_CODE: Record<Component, string> = {
  BASIC: "BASIC",
  HOUSING: "HOUSING",
  TRANSPORT: "TRANSPORT",
  OTHER: "OTHER_ALLOWANCE",
};
const CATEGORY_AR: Record<DeductionCategory, string> = {
  UNEARNED_PAY: "الأجر غير المستحق",
  LOAN_RECOVERY: "استرداد السلف",
  STATUTORY: "الاشتراكات النظامية",
  OTHER: "الاستقطاعات الأخرى",
};
const COMPONENT_AR: Record<Component, string> = {
  BASIC: "الراتب الأساسي",
  HOUSING: "بدل السكن",
  TRANSPORT: "بدل النقل",
  OTHER: "بدلات أخرى",
};

/**
 * Position of a calendar day on a 30-day month (the "30/360" convention): the last day of
 * any month is day 30; otherwise min(day, 30). The day before the 1st is position 0.
 *
 * FIXED_30 days in [from, to] = pos(to) − pos(from − 1). Consequences, all asserted in the
 * tests: a full month is 30 days whatever its length; 1–15 March and 16–31 March are 15 + 15;
 * 15–28 February is 16; a change effective on the 31st takes effect from the next month.
 * This is the PROPOSED reading of "30 fixed days" and needs the accountant's confirmation.
 */
export function pos30(d: Date): number {
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  return d.getUTCDate() === last ? 30 : Math.min(d.getUTCDate(), 30);
}

export function fixed30Days(from: Date, to: Date): number {
  if (to < from) return 0;
  const prev = addDays(from, -1);
  const prevPos = prev.getUTCMonth() !== from.getUTCMonth() ? 0 : pos30(prev);
  return Math.max(0, pos30(to) - prevPos);
}

export function rangeDays(basis: DayBasis, from: Date, to: Date): number {
  return basis === "FIXED_30" ? fixed30Days(from, to) : daysInclusive(from, to);
}

export function calculatePayroll(input: EngineInput): EngineResult {
  const { start, end, days: monthDays } = monthBounds(input.month);
  const p = input.policy;
  const basisDays = p.dayBasis === "FIXED_30" ? 30 : monthDays;
  const exceptions: EngineException[] = [];
  const items: EngineItem[] = [];

  const from = input.hireDate > start ? input.hireDate : start;
  const to = input.separationDate && input.separationDate < end ? input.separationDate : end;
  if (from > to) {
    return {
      employed: false, payableDays: ZERO, items: [], gross: ZERO, deductions: ZERO, net: ZERO, employer: ZERO,
      exceptions: [], blocking: false, includedInstallmentIds: [], deferredInstallmentIds: [], usedOvertimeIds: [],
      snapshot: {},
    };
  }

  // ── Compensation segments clipped to the employed range ──
  const segs = [...input.compensations]
    .sort((a, b) => a.effectiveFrom.getTime() - b.effectiveFrom.getTime())
    .map((s) => {
      const sf = s.effectiveFrom > from ? s.effectiveFrom : from;
      const st = s.effectiveTo && s.effectiveTo < to ? s.effectiveTo : to;
      return { seg: s, from: sf, to: st, days: sf <= st ? rangeDays(p.dayBasis, sf, st) : 0, calendarDays: sf <= st ? daysInclusive(sf, st) : 0 };
    })
    .filter((x) => x.calendarDays > 0);

  const coveredCalendarDays = segs.reduce((a, s) => a + s.calendarDays, 0);
  const employedCalendarDays = daysInclusive(from, to);
  if (coveredCalendarDays < employedCalendarDays) {
    exceptions.push({
      code: "NO_COMPENSATION",
      severity: "BLOCKING",
      message: `لا يوجد راتب مسجّل لـ ${employedCalendarDays - coveredCalendarDays} يوم عمل في هذا الشهر.`,
    });
  }
  const payableDays = segs.reduce((a, s) => a + s.days, 0);
  if (from > start || to < end) {
    exceptions.push({
      code: "PARTIAL_MONTH",
      severity: "INFO",
      // P-2 rev3 item 6: calendar days and pay units are named apart (never one mixed figure).
      message: `على رأس العمل من ${dayString(from)} إلى ${dayString(to)} (${employedCalendarDays} يومًا تقويميًا): ${payableDays} من ${basisDays} وحدة أجر (${p.dayBasis === "FIXED_30" ? "30 يومًا ثابتة" : "أيام الشهر الفعلية"}).`,
    });
  }

  const segFor = (d: Date) => segs.find((s) => s.from <= d && d <= s.to);

  // ── Earnings per component ──
  const earned: Record<Component, Decimal> = { BASIC: ZERO, HOUSING: ZERO, TRANSPORT: ZERO, OTHER: ZERO };
  for (const c of COMPONENTS) {
    let raw = ZERO;
    for (const s of segs) raw = raw.plus(monthly(s.seg, c).times(s.days).dividedBy(basisDays));
    earned[c] = round2(raw);
    if (earned[c].greaterThan(0)) {
      items.push({
        code: COMPONENT_CODE[c],
        kind: "EARNING",
        amount: earned[c],
        quantity: D(payableDays),
        description: segs.length > 1
          ? `${COMPONENT_AR[c]} (${segs.map((s) => `${monthly(s.seg, c).toFixed(2)} × ${s.days}/${basisDays}`).join(" + ")})`
          : `${COMPONENT_AR[c]} (${payableDays}/${basisDays})`,
      });
    }
  }

  // ── Overtime: approved minutes × hourly rate × multiplier ──
  const usedOvertimeIds: string[] = [];
  let otRaw = ZERO;
  let otMinutes = 0;
  for (const o of input.overtime) {
    const s = segFor(o.workDate);
    if (!s) continue;
    const base = sum(p.overtimeComponents.map((c) => monthly(s.seg, c)));
    const hourly = base.dividedBy(basisDays).dividedBy(p.standardDailyHours);
    otRaw = otRaw.plus(hourly.times(o.minutes).dividedBy(60).times(p.overtimeMultiplier));
    otMinutes += o.minutes;
    usedOvertimeIds.push(o.id);
  }
  if (otMinutes > 0) {
    items.push({
      code: "OVERTIME",
      kind: "EARNING",
      amount: round2(otRaw),
      quantity: D(otMinutes).dividedBy(60).toDecimalPlaces(4),
      rate: p.overtimeMultiplier,
      sourceType: "HrOvertime",
      description: `عمل إضافي معتمد ${(otMinutes / 60).toFixed(2)} ساعة × ${p.overtimeMultiplier.toFixed(2)}`,
    });
  }

  for (const c of input.commissions) {
    items.push({
      code: "COMMISSION",
      kind: "EARNING",
      amount: round2(c.amount),
      sourceType: "CommissionPeriod",
      sourceId: c.reservationKey,
      // The period is stored as the Riyadh month start in UTC (e.g. 2026-08-31T21:00Z for
      // September); its label is that month in Asia/Riyadh, not the UTC month before it.
      description: `عمولة معتمدة · ${dayString(localDay(c.periodStart, "Asia/Riyadh")).slice(0, 7)}`,
    });
  }
  for (const a of input.adjustments.filter((x) => x.kind === "EARNING")) {
    items.push({ code: "ADJUSTMENT_EARNING", kind: "EARNING", amount: round2(a.amount), sourceType: "HrPayrollAdjustment", sourceId: a.id, description: a.reason });
  }

  const gross = round2(sum(items.filter((i) => i.kind === "EARNING").map((i) => i.amount)));

  // ── Unpaid leave: one day's rate of the configured components per day, never more than earned ──
  const unpaid = input.unpaidLeaveDays.filter((d) => d >= from && d <= to);
  if (unpaid.length > 0) {
    let raw = ZERO;
    for (const d of unpaid) {
      const s = segFor(d);
      if (!s) continue;
      raw = raw.plus(sum(p.unpaidLeaveComponents.map((c) => monthly(s.seg, c))).dividedBy(basisDays));
    }
    const cap = sum(p.unpaidLeaveComponents.map((c) => earned[c]));
    const amount = round2(raw.greaterThan(cap) ? cap : raw);
    if (amount.greaterThan(0)) {
      items.push({
        code: "UNPAID_LEAVE",
        kind: "DEDUCTION",
        amount,
        quantity: D(unpaid.length),
        sourceType: "HrLeaveRequest",
        description: `إجازة بدون راتب ${unpaid.length} يوم`,
      });
    }
    exceptions.push({ code: "UNPAID_LEAVE", severity: "INFO", message: `خُصم ${unpaid.length} يوم إجازة بدون راتب.` });
  }

  // ── Contributions (configured rules only) ──
  if (input.contributionGroupMissing) {
    exceptions.push({
      code: "CONTRIBUTION_GROUP_MISSING",
      severity: "BLOCKING",
      message: "توجد قواعد اشتراكات سارية لكن فئة اشتراك الموظف غير مسجّلة.",
    });
  }
  let employer = ZERO;
  for (const r of input.contributions) {
    let base = sum(r.baseComponents.map((c) => earned[c]));
    if (r.monthlyBaseCap && base.greaterThan(r.monthlyBaseCap)) base = r.monthlyBaseCap;
    const ee = round2(base.times(r.employeeRatePercent).dividedBy(100));
    const er = round2(base.times(r.employerRatePercent).dividedBy(100));
    if (ee.greaterThan(0)) items.push({ code: `CONTRIB_EE:${r.code}`, kind: "DEDUCTION", amount: ee, rate: r.employeeRatePercent, quantity: base, description: `${r.nameAr} · حصة الموظف` });
    if (er.greaterThan(0)) items.push({ code: `CONTRIB_ER:${r.code}`, kind: "EMPLOYER", amount: er, rate: r.employerRatePercent, quantity: base, description: `${r.nameAr} · حصة صاحب العمل` });
    employer = employer.plus(er);
  }

  for (const a of input.adjustments.filter((x) => x.kind === "DEDUCTION")) {
    items.push({ code: "ADJUSTMENT_DEDUCTION", kind: "DEDUCTION", amount: round2(a.amount), sourceType: "HrPayrollAdjustment", sourceId: a.id, description: a.reason });
  }

  // ── Advance installments, oldest first, deferred past the deduction cap ──
  const includedInstallmentIds: string[] = [];
  const deferredInstallmentIds: string[] = [];
  const installmentItem = (inst: EngineInput["installments"][number], extra: Partial<EngineItem> = {}): EngineItem => ({
    code: "ADVANCE_INSTALLMENT",
    kind: "DEDUCTION",
    amount: round2(inst.amount),
    sourceType: "HrAdvanceInstallment",
    sourceId: inst.id,
    description: `قسط سلفة ${inst.advanceNo} (${inst.seq})`,
    ...extra,
  });
  let capAmount: Decimal;
  let deductions: Decimal;
  let deductionPlan: Record<string, unknown> | null = null;
  if (!p.deductions) {
    // Original behaviour: only installments are capped, against gross.
    capAmount = round2(gross.times(p.maxDeductionPercent).dividedBy(100));
    deductions = sum(items.filter((i) => i.kind === "DEDUCTION").map((i) => i.amount));
    for (const inst of input.installments) {
      if (deductions.plus(inst.amount).lessThanOrEqualTo(capAmount)) {
        items.push(installmentItem(inst));
        deductions = deductions.plus(inst.amount);
        includedInstallmentIds.push(inst.id);
      } else {
        deferredInstallmentIds.push(inst.id);
      }
    }
  } else {
    // P-2 findings 2/3: categories applied in the policy's priority order. Each category has its
    // own cap and the overall cap (maxDeductionPercent) covers the categories the policy lists,
    // all on the cap base (guaranteed pay unless the policy includes variable pay). Only loan
    // recovery is deferrable: an installment that does not fit is deferred WHOLE (never partly,
    // never written off). A non-deferrable category over a cap is never trimmed: it is flagged
    // (WARN → INFO, BLOCK → BLOCKING) as the policy says. No amount is ever invented here.
    const cfg = p.deductions;
    const variable = sum(items.filter((i) => i.kind === "EARNING" && VARIABLE_EARNINGS.includes(i.code)).map((i) => i.amount));
    const unearned = cfg.capBaseAfterUnearned ? sum(items.filter((i) => i.kind === "DEDUCTION" && deductionCategoryOf(i.code) === "UNEARNED_PAY").map((i) => i.amount)) : ZERO;
    const capBase = Decimal.max(ZERO, round2((cfg.capBaseIncludesVariable ? gross : gross.minus(variable)).minus(unearned)));
    capAmount = round2(capBase.times(p.maxDeductionPercent).dividedBy(100));
    const catCap = (c: DeductionCategory) => round2(capBase.times(cfg.categoryCapPercent[c]).dividedBy(100));
    const covers = (c: DeductionCategory) => cfg.overallCovers.includes(c);
    const severity = cfg.onExceed === "BLOCK" ? "BLOCKING" : "INFO";
    const totals = Object.fromEntries(DEDUCTION_CATEGORIES.map((c) => [c, ZERO])) as Record<DeductionCategory, Decimal>;
    const overCap: string[] = [];
    let covered = ZERO;
    let order = 0;
    let overallFlagged = false;
    for (const cat of cfg.priority) {
      if (cat === "LOAN_RECOVERY") {
        const loanCap = catCap(cat);
        for (const inst of input.installments) {
          const amt = round2(inst.amount);
          // Validated on every run: an installment above a cap on its own can never be taken.
          if (amt.greaterThan(loanCap) || (covers(cat) && amt.greaterThan(capAmount))) overCap.push(`${inst.advanceNo} (${inst.seq})`);
          if (totals[cat].plus(amt).lessThanOrEqualTo(loanCap) && (!covers(cat) || covered.plus(amt).lessThanOrEqualTo(capAmount))) {
            items.push(installmentItem(inst, { category: cat, applyOrder: ++order }));
            totals[cat] = totals[cat].plus(amt);
            if (covers(cat)) covered = covered.plus(amt);
            includedInstallmentIds.push(inst.id);
          } else {
            deferredInstallmentIds.push(inst.id);
          }
        }
        continue;
      }
      for (const it of items) {
        if (it.kind !== "DEDUCTION" || deductionCategoryOf(it.code) !== cat) continue;
        it.category = cat;
        it.applyOrder = ++order;
        totals[cat] = totals[cat].plus(it.amount);
      }
      if (totals[cat].greaterThan(catCap(cat))) {
        exceptions.push({ code: "DEDUCTION_CATEGORY_CAP", severity, message: `${CATEGORY_AR[cat]} ${totals[cat].toFixed(2)} تتجاوز حدها ${catCap(cat).toFixed(2)} (${cfg.categoryCapPercent[cat].toFixed(2)}% من ${capBase.toFixed(2)}).` });
      }
      if (covers(cat)) {
        covered = covered.plus(totals[cat]);
        if (!overallFlagged && covered.greaterThan(capAmount)) {
          overallFlagged = true;
          exceptions.push({ code: "DEDUCTION_OVERALL_CAP", severity, message: `الاستقطاعات المشمولة بالحد العام ${covered.toFixed(2)} تتجاوز ${capAmount.toFixed(2)} (${p.maxDeductionPercent.toFixed(2)}% من ${capBase.toFixed(2)}).` });
        }
      }
    }
    if (overCap.length) {
      exceptions.push({ code: "INSTALLMENT_EXCEEDS_CAP", severity: "INFO", message: `قسط السلفة ${overCap.join("، ")} يتجاوز حد الاستقطاع بمفرده، فلن يُستقطع حتى يُعاد جدولته أو يُحصَّل بإجراء معتمد.` });
    }
    deductions = sum(items.filter((i) => i.kind === "DEDUCTION").map((i) => i.amount));
    deductionPlan = {
      capBase: capBase.toFixed(2), capBaseIncludesVariable: cfg.capBaseIncludesVariable, capBaseAfterUnearned: cfg.capBaseAfterUnearned, overallCap: capAmount.toFixed(2), overallCovers: cfg.overallCovers,
      priority: cfg.priority, onExceed: cfg.onExceed, covered: covered.toFixed(2),
      categories: Object.fromEntries(DEDUCTION_CATEGORIES.map((c) => [c, { capPercent: cfg.categoryCapPercent[c].toString(), cap: catCap(c).toFixed(2), total: totals[c].toFixed(2) }])),
    };
  }
  if (deferredInstallmentIds.length > 0) {
    exceptions.push({
      code: "INSTALLMENT_DEFERRED",
      severity: "INFO",
      message: `أُجّل ${deferredInstallmentIds.length} قسط سلفة: الاستقطاعات ستتجاوز ${p.maxDeductionPercent.toFixed(2)}% من الإجمالي.`,
    });
  }

  deductions = round2(deductions);
  const net = round2(gross.minus(deductions));
  if (net.lessThan(0)) {
    exceptions.push({ code: "NEGATIVE_NET", severity: "BLOCKING", message: `سيكون الصافي ${net.toFixed(2)}. عالج الاستقطاعات قبل الإرسال للاعتماد.` });
  }
  if (input.absentDays > 0) {
    exceptions.push({
      code: "ABSENCES",
      severity: "INFO",
      message: `${input.absentDays} يوم غياب مسجّل. لا يُخصم تلقائيًا: سجّل إجازة بدون راتب أو تسوية إن كان الخصم مقصودًا.`,
    });
  }
  if (input.openAttendanceDays > 0) {
    exceptions.push({ code: "OPEN_ATTENDANCE", severity: "INFO", message: `${input.openAttendanceDays} يوم حضور بلا تسجيل انصراف.` });
  }
  if (p.isProposal) {
    exceptions.push({ code: "POLICY_PROPOSAL", severity: "INFO", message: `قيم سياسة الرواتب v${p.version} مقترحة ولم يؤكدها المالك أو المحاسب بعد.` });
  }

  const unpaidDays = unpaid.length;
  return {
    employed: true,
    payableDays: D(Math.max(0, payableDays - unpaidDays)),
    items,
    gross,
    deductions,
    net,
    employer: round2(employer),
    exceptions,
    blocking: exceptions.some((e) => e.severity === "BLOCKING"),
    includedInstallmentIds,
    deferredInstallmentIds,
    usedOvertimeIds,
    snapshot: {
      month: input.month,
      policy: { id: p.id, version: p.version, dayBasis: p.dayBasis, basisDays, standardDailyHours: p.standardDailyHours.toString(), overtimeMultiplier: p.overtimeMultiplier.toString(), maxDeductionPercent: p.maxDeductionPercent.toString(), unpaidLeaveComponents: p.unpaidLeaveComponents, overtimeComponents: p.overtimeComponents, isProposal: p.isProposal },
      employed: { from: dayString(from), to: dayString(to) },
      segments: segs.map((s) => ({ id: s.seg.id, from: dayString(s.from), to: dayString(s.to), days: s.days, basic: s.seg.basic.toFixed(2), housing: s.seg.housing.toFixed(2), transport: s.seg.transport.toFixed(2), other: s.seg.other.toFixed(2) })),
      unpaidLeaveDays: unpaid.map(dayString),
      overtimeMinutes: otMinutes,
      contributions: input.contributions.map((c) => ({ code: c.code, employee: c.employeeRatePercent.toString(), employer: c.employerRatePercent.toString(), base: c.baseComponents, cap: c.monthlyBaseCap?.toString() ?? null })),
      deductionCap: capAmount.toFixed(2),
      // P-2 finding 2: which installments this line deferred (counted per advance across approved runs).
      deferredInstallments: deferredInstallmentIds,
      ...(deductionPlan ? { deductionPlan } : {}),
    },
  };
}
