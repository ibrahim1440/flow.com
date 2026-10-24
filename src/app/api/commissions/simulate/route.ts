import { NextResponse } from "@/lib/api-response";
import { prisma } from "@/lib/db";
import { requireSub } from "@/lib/auth-server";
import { handleDomainError } from "@/lib/api-error";
import { parseComponents, simulate, type OrderMix, type Scenario } from "@/lib/services/commissions/builder";
import { Decimal, parseFiniteDecimal, roundMoney } from "@/lib/services/commissions/engine";
import { fixedPayFor, maySeePay } from "@/lib/services/commissions/fixed-pay";

/**
 * POST /api/commissions/simulate — «محاكاة» inside the plan editor, like the workbook's Simulation
 * sheet: the plan's components as they stand in the editor (saved or not), a target, scenarios at a
 * percentage of target and custom amounts, and the order mix (first / second / third+ as fixed
 * amounts, or as a percentage split of each scenario). Pure computation: nothing is read but the
 * optional employee's fixed pay, nothing is written.
 *
 * Fixed pay (for «إجمالي التعويض الشهري») comes from HR for the chosen employee, and only for a
 * caller who may see pay (maySeePay); otherwise a figure the caller typed for the simulation is
 * used, or none — the column is then left empty.
 */
export async function POST(request: Request) {
  const { user, error } = await requireSub("commissions", "manage_plans");
  if (error) return error;
  let b: Record<string, unknown>;
  try {
    b = ((await request.json()) ?? {}) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  try {
    const { components, problems } = parseComponents(b.components);
    if (!components) throw { _appCode: 400, message: problems[0].messageAr, errorEn: problems[0].message, problems };
    const target = parseFiniteDecimal(b.target ?? "");
    if (!target || target.lessThanOrEqualTo(0)) throw { _appCode: 400, message: "The target must be a number above zero." };

    const m = (b.mix ?? {}) as Record<string, unknown>;
    const list = (v: unknown) => (Array.isArray(v) ? v.slice(0, 20).map((x) => String(x ?? "0")) : []);
    const mix: OrderMix = m.mode === "PERCENT" ? { mode: "PERCENT", percents: list(m.percents) } : { mode: "AMOUNTS", amounts: list(m.amounts) };
    for (const v of mix.mode === "PERCENT" ? mix.percents : mix.amounts) {
      const d = parseFiniteDecimal(v);
      if (!d || d.lessThan(0)) throw { _appCode: 400, message: "Every order-mix value must be a number of 0 or more." };
    }
    const scenarios: Scenario[] = (Array.isArray(b.scenarios) ? b.scenarios : []).slice(0, 30).map((raw, i) => {
      const s = (raw ?? {}) as Record<string, unknown>;
      const label = typeof s.label === "string" && s.label.trim() ? s.label.trim().slice(0, 60) : `#${i + 1}`;
      const amount = s.amount !== undefined && s.amount !== null && s.amount !== "" ? String(s.amount) : undefined;
      const percentOfTarget = amount === undefined ? String(s.percentOfTarget ?? "") : undefined;
      const d = parseFiniteDecimal(amount ?? percentOfTarget ?? "");
      if (!d || d.lessThan(0)) throw { _appCode: 400, message: "Every scenario needs a percentage of target or an amount of 0 or more." };
      return { label, amount, percentOfTarget };
    });

    let fixedPay: string | null = null;
    let fixedPaySource: "HR" | "INPUT" | null = null;
    const employeeId = typeof b.employeeId === "string" ? b.employeeId : "";
    if (employeeId && maySeePay(user.permissions)) {
      const pay = await fixedPayFor(prisma, employeeId, new Date());
      if (pay) { fixedPay = pay.total; fixedPaySource = "HR"; }
    }
    if (!fixedPay && b.fixedPay !== undefined && b.fixedPay !== null && b.fixedPay !== "") {
      const d = parseFiniteDecimal(b.fixedPay);
      if (!d || d.lessThan(0)) throw { _appCode: 400, message: "The fixed pay must be a number of 0 or more." };
      fixedPay = d.toString(); fixedPaySource = "INPUT";
    }
    const opt = (v: unknown) => (v === undefined || v === null || v === "" ? null : String(v));
    for (const v of [opt(b.discretionaryAmount), opt(b.overrideAmount)]) {
      if (v !== null && (!parseFiniteDecimal(v) || parseFiniteDecimal(v)!.lessThan(0))) {
        throw { _appCode: 400, message: "A management amount must be a number of 0 or more." };
      }
    }

    const out = simulate({
      components, target: target.toString(), mix, scenarios, fixedPay,
      discretionaryAmount: opt(b.discretionaryAmount), overrideAmount: opt(b.overrideAmount),
    });
    // Exact figures (the workbook does not round) and their two-place display.
    const r2 = (d: Decimal) => roundMoney(d).toFixed(2);
    const row = (r: typeof out.base) => ({
      label: r.label,
      sales: r.sales.toString(),
      achievementPercent: r.achievementPercent.toString(),
      clientCommission: r.clientCommission.toString(),
      targetBonus: r.targetBonus.toString(),
      overTargetIncentive: r.overTargetIncentive.toString(),
      totalVariable: r.totalVariable.toString(),
      totalMonthly: r.totalMonthly ? r.totalMonthly.toString() : null,
      // The same, rounded half-up to two places for display (string formatting would truncate).
      rounded: {
        sales: r2(r.sales), achievementPercent: r.achievementPercent.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2),
        clientCommission: r2(r.clientCommission), targetBonus: r2(r.targetBonus), overTargetIncentive: r2(r.overTargetIncentive),
        totalVariable: r2(r.totalVariable), totalMonthly: r.totalMonthly ? r2(r.totalMonthly) : null,
      },
    });
    return NextResponse.json({ base: row(out.base), rows: out.rows.map(row), fixedPay, fixedPaySource });
  } catch (err) {
    return handleDomainError(err);
  }
}
