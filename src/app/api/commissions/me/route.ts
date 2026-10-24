import { NextResponse } from "@/lib/api-response";
import { prisma } from "@/lib/db";
import { requireSub } from "@/lib/auth-server";
import { handlePrismaError } from "@/lib/api-error";
import { riyadhMonthStart, riyadhMonthEnd, ZERO } from "@/lib/services/commissions/engine";
import { periodStatement } from "@/lib/services/commissions/accrual";
import { netCollectedByEmployee, targetProgress } from "@/lib/services/sales/performance";
import { componentsVersionForPeriod, computeBuilderPeriod, serializePeriod } from "@/lib/services/commissions/builder-period";
import { nextThreshold, readComponents, templateByKey } from "@/lib/services/commissions/builder";
import { fixedPayFor, maySeePay } from "@/lib/services/commissions/fixed-pay";

/**
 * GET /api/commissions/me — what the signed-in employee has earned in a period.
 *
 * Scoped to the caller by construction: the employee id comes from the session, never from
 * the query string, so there is no id to tamper with. Someone who needs to see another
 * person's commission needs view_team and a different endpoint — this one cannot be pointed
 * at a colleague.
 */
export async function GET(request: Request) {
  const { user, error } = await requireSub("commissions", "view_own");
  if (error) return error;

  const url = new URL(request.url);
  const monthParam = url.searchParams.get("month");

  try {
    // Periods are Riyadh months. An absent or unparseable month means "this one" rather than
    // an error, so the screen has something to show on first load.
    const at = monthParam ? new Date(`${monthParam}-15T00:00:00Z`) : new Date();
    if (Number.isNaN(at.getTime())) {
      return NextResponse.json({ error: "month must look like 2026-09." }, { status: 400 });
    }
    const periodStart = riyadhMonthStart(at);
    const periodEnd = riyadhMonthEnd(at);

    const raw = await periodStatement(prisma, user.id, periodStart);
    // Fixed to two places, exactly as the team review endpoint formats it. Serialising the
    // Decimal straight through gives "50" here and "50.00" there for the same money, and
    // the person comparing their own screen with their manager's is the one who notices.
    const statement = {
      periodStart: raw.periodStart,
      accrued: raw.accrued.toFixed(2),
      adjustments: raw.adjustments.toFixed(2),
      paid: raw.paid.toFixed(2),
      outstanding: raw.outstanding.toFixed(2),
    };

    // The accruals behind the total, each carrying the figures that explain it: the base it
    // was computed from, the share applied, and the effective rate. A commission screen that
    // shows only a final number gives its reader no way to check it.
    const accruals = await prisma.commissionAccrual.findMany({
      where: { employeeId: user.id, periodStart },
      orderBy: { createdAt: "asc" },
      select: {
        id: true, qualifyingBase: true, sharePercent: true, effectiveRatePercent: true,
        amount: true, currency: true, status: true, approvedAt: true, createdAt: true,
        collectionEvent: {
          select: {
            externalRef: true, sourceSystem: true, collectedAt: true, amountGross: true,
            amountTax: true, amountNonQualifying: true,
            customer: { select: { id: true, name: true } },
          },
        },
        planVersion: {
          select: {
            version: true, baseRatePercent: true, tierMode: true,
            plan: { select: { code: true, name: true, nameAr: true } },
          },
        },
      },
    });

    const ledger = await prisma.commissionLedgerEntry.findMany({
      where: { employeeId: user.id, periodStart },
      orderBy: { createdAt: "asc" },
      select: { id: true, type: true, amount: true, reason: true, createdAt: true },
    });

    const target = await prisma.salesTarget.findUnique({
      where: { employeeId_periodStart: { employeeId: user.id, periodStart } },
      select: { targetAmount: true, bonusAmount: true, currency: true },
    });

    // The month's target progress, measured exactly as the targets screen measures it: net
    // collected (qualifying base of recorded collections, split-aware) against the target.
    // Additive and read-only — no commission, target or payout figure changes by it.
    const achieved = (await netCollectedByEmployee(prisma, periodStart, periodEnd)).get(user.id);
    const progress = target ? targetProgress(target.targetAmount, achieved ?? ZERO) : null;

    // ── Commission plan builder ──
    // The plan the caller is on for the month, and — for a COMPONENTS plan — the month's estimate
    // (A, B, C, achievement, the next threshold), computed live from collected and approved money
    // only, read-only. The caller's own figures and nobody else's: every id is the session's.
    const assignment = await prisma.commissionAssignment.findFirst({
      where: { employeeId: user.id, effectiveFrom: { lt: periodEnd }, OR: [{ effectiveTo: null }, { effectiveTo: { gt: periodStart } }] },
      orderBy: { effectiveFrom: "desc" },
      select: {
        effectiveFrom: true, effectiveTo: true,
        plan: { select: { code: true, name: true, nameAr: true, templateKey: true } },
        planVersion: { select: { id: true, version: true, baseRatePercent: true, tierMode: true, components: true, currency: true, effectiveFrom: true } },
      },
    });
    let plan = null;
    let builder = null;
    if (assignment) {
      const components = assignment.planVersion.components !== null ? readComponents(assignment.planVersion.components) : null;
      const template = assignment.plan.templateKey ? templateByKey(assignment.plan.templateKey) : null;
      plan = {
        code: assignment.plan.code, name: assignment.plan.name, nameAr: assignment.plan.nameAr,
        version: assignment.planVersion.version, kind: components ? "COMPONENTS" : "TIERED",
        baseRatePercent: assignment.planVersion.baseRatePercent, currency: assignment.planVersion.currency,
        assignedFrom: assignment.effectiveFrom, assignedTo: assignment.effectiveTo,
        components, explanations: template?.explanations ?? null,
      };
      const versionId = await componentsVersionForPeriod(prisma, user.id, at);
      if (versionId) {
        const p = await computeBuilderPeriod(prisma, { employeeId: user.id, planVersionId: versionId, at });
        const next = nextThreshold(p.components, p.computation.qualifiedBase, p.computation.target);
        builder = {
          ...serializePeriod(p),
          next: next ? { percent: next.percent, amountToGo: next.amountToGo.toFixed(2) } : null,
          estimate: true,
        };
      }
    }
    const history = await prisma.commissionPeriodResult.findMany({
      where: { employeeId: user.id },
      orderBy: { periodStart: "desc" },
      take: 12,
      select: {
        periodStart: true, targetAmount: true, qualifiedBase: true, achievementPercent: true,
        clientCommission: true, targetBonus: true, overTargetIncentive: true, totalVariable: true, decisionStatus: true,
        planVersion: { select: { version: true, plan: { select: { code: true } } } },
      },
    });
    const money = (d: { toFixed: (n: number) => string } | null) => (d === null ? null : d.toFixed(2));
    const historyOut = history.map((h) => ({
      ...h,
      targetAmount: money(h.targetAmount), qualifiedBase: money(h.qualifiedBase),
      achievementPercent: h.achievementPercent === null ? null : h.achievementPercent.toFixed(6),
      clientCommission: money(h.clientCommission), targetBonus: money(h.targetBonus),
      overTargetIncentive: money(h.overTargetIncentive), totalVariable: money(h.totalVariable),
    }));
    // Fixed pay only for a caller who holds an HR pay duty; never otherwise, the earner included.
    const fixedPay = maySeePay(user.permissions) ? await fixedPayFor(prisma, user.id, at) : null;

    // Says plainly where the money figures came from. Every accrual in this build traces to
    // the sandbox source, and the screen must not present that as a settled payable.
    const sources = [...new Set(accruals.map((a) => a.collectionEvent.sourceSystem))];
    const sandboxOnly = sources.length > 0 && sources.every((s) => s === "SANDBOX");

    return NextResponse.json({
      periodStart,
      periodEnd,
      statement,
      accruals,
      ledger,
      target,
      progress,
      plan,
      builder,
      history: historyOut,
      fixedPay,
      collectionSources: sources,
      sandbox: sandboxOnly,
      notice: sandboxOnly
        ? "These figures come from the sandbox collection source. No real payment has been received and no payout has been made."
        : null,
    });
  } catch (err) {
    return handlePrismaError(err);
  }
}
