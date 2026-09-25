import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireSub } from "@/lib/auth-server";
import { handleDomainError } from "@/lib/api-error";
import { hasSubPrivilege } from "@/lib/auth-shared";
import {
  Decimal, ZERO, roundMoney, riyadhMonthStart, riyadhMonthEnd,
} from "@/lib/services/commissions/engine";
import { periodStatement } from "@/lib/services/commissions/accrual";

/**
 * GET /api/commissions/review — the team's commission for a Riyadh month, for approval.
 *
 * ── Two figures, from two places, on purpose ──
 * `statement` comes from the append-only ledger and is the authority on what is owed.
 * `accruals` are the per-collection rows that explain it. They must agree, so this endpoint
 * computes the difference and reports it rather than showing one of them and hoping: a
 * reconciliation that is only checked when somebody complains is not a control.
 *
 * ── It is behind view_team, not view_own ──
 * Reading the whole team's earnings is a different act from reading your own, and the
 * endpoint that does it cannot be pointed at yourself-only by accident.
 */
export async function GET(request: Request) {
  const { user, error } = await requireSub("commissions", "view_team");
  if (error) return error;

  const url = new URL(request.url);
  const monthParam = url.searchParams.get("month");
  const at = monthParam ? new Date(`${monthParam}-15T00:00:00Z`) : new Date();
  if (Number.isNaN(at.getTime())) {
    return NextResponse.json({ error: "month must look like 2026-09." }, { status: 400 });
  }
  const periodStart = riyadhMonthStart(at);
  const periodEnd = riyadhMonthEnd(at);

  try {
    const accruals = await prisma.commissionAccrual.findMany({
      where: { periodStart },
      orderBy: [{ employeeId: "asc" }, { createdAt: "asc" }],
      take: 2000,
      select: {
        id: true, employeeId: true, qualifyingBase: true, sharePercent: true,
        effectiveRatePercent: true, amount: true, currency: true, status: true,
        approvedById: true, approvedAt: true, createdAt: true,
        employee: { select: { id: true, name: true, active: true } },
        collectionEvent: {
          select: {
            id: true, externalRef: true, sourceSystem: true, collectedAt: true, status: true,
            amountGross: true, amountTax: true, amountNonQualifying: true,
            customer: { select: { id: true, name: true } },
          },
        },
        planVersion: {
          select: {
            id: true, version: true, baseRatePercent: true, tierMode: true,
            plan: { select: { code: true, name: true, nameAr: true } },
          },
        },
      },
    });

    const employeeIds = [...new Set(accruals.map((a) => a.employeeId))];

    // The ledger's answer per employee, computed by the same function the employee's own
    // screen uses — so the reviewer and the earner cannot be shown different numbers.
    const statements = await Promise.all(
      employeeIds.map(async (employeeId) => {
        const s = await periodStatement(prisma, employeeId, periodStart);
        const fromAccruals = roundMoney(
          accruals
            .filter((a) => a.employeeId === employeeId)
            .reduce((acc, a) => acc.plus(a.amount), ZERO),
        );
        const ledgerAccrued = roundMoney(s.accrued);

        // ── Why the comparison is not simply ledger-vs-rows ──
        // An accrual row tracks its collection's CURRENT contribution while it is still
        // unapproved: reversing that collection decrements the row back to zero, and the
        // rows keep matching the ledger. Once the row is approved or paid it is frozen —
        // restating a figure somebody has already been told they earned is the exact thing
        // the append-only ledger exists to prevent — so a later reversal leaves the row at
        // its approved amount and posts a compensating entry instead.
        //
        // Comparing the ledger against the raw row total therefore reported a difference on
        // every period where an APPROVED accrual had since been reversed. On the preview
        // data that read "off by -200.00" with nothing whatsoever wrong: 250.00 accrued in
        // five entries, 200.00 given back in four, 50.00 owed, and five frozen rows still
        // saying what they said when they were approved. A control that goes red whenever a
        // refund has happened is a control reviewers learn to click past.
        //
        // The frozen-and-since-reversed rows are identifiable structurally — approved or
        // paid, against an event now marked REVERSED — so they are subtracted, and the
        // control keeps its teeth for every other kind of disagreement.
        const mine = accruals.filter((a) => a.employeeId === employeeId);
        const frozenAndReversed = roundMoney(
          mine
            .filter(
              (a) =>
                (a.status === "APPROVED" || a.status === "PAID") &&
                a.collectionEvent?.status === "REVERSED",
            )
            .reduce((acc, a) => acc.plus(a.amount), ZERO),
        );
        const expectedFromRows = roundMoney(fromAccruals.minus(frozenAndReversed));

        return {
          employeeId,
          name: accruals.find((a) => a.employeeId === employeeId)?.employee.name ?? employeeId,
          accrued: ledgerAccrued.toFixed(2),
          accrualEntries: roundMoney(s.accrualEntries).toFixed(2),
          reversals: s.reversals.toFixed(2),
          adjustments: s.adjustments.toFixed(2),
          paid: s.paid.toFixed(2),
          outstanding: s.outstanding.toFixed(2),
          accrualRowsTotal: fromAccruals.toFixed(2),
          /** Of the rows above, the part frozen at approval and since reversed. */
          frozenReversedTotal: frozenAndReversed.toFixed(2),
          expectedFromRows: expectedFromRows.toFixed(2),
          // Zero on a healthy period. Surfaced rather than asserted quietly, because the
          // one time it is not zero is the one time somebody needs to know.
          reconciliationDifference: roundMoney(ledgerAccrued.minus(expectedFromRows)).toFixed(2),
          reconciled: ledgerAccrued.equals(expectedFromRows),
          pendingCount: accruals.filter((a) => a.employeeId === employeeId && a.status === "ACCRUED").length,
          approvedCount: accruals.filter((a) => a.employeeId === employeeId && a.status === "APPROVED").length,
        };
      }),
    );

    const totals = statements.reduce(
      (acc, s) => ({
        accrued: acc.accrued.plus(new Decimal(s.accrued)),
        adjustments: acc.adjustments.plus(new Decimal(s.adjustments)),
        paid: acc.paid.plus(new Decimal(s.paid)),
        outstanding: acc.outstanding.plus(new Decimal(s.outstanding)),
      }),
      { accrued: ZERO, adjustments: ZERO, paid: ZERO, outstanding: ZERO },
    );

    const sources = [...new Set(accruals.map((a) => a.collectionEvent.sourceSystem))];
    const sandboxOnly = sources.length > 0 && sources.every((s) => s === "SANDBOX");

    return NextResponse.json({
      periodStart,
      periodEnd,
      employees: statements,
      accruals,
      totals: {
        accrued: totals.accrued.toFixed(2),
        adjustments: totals.adjustments.toFixed(2),
        paid: totals.paid.toFixed(2),
        outstanding: totals.outstanding.toFixed(2),
      },
      can: {
        approve: hasSubPrivilege(user.permissions, "commissions", "approve"),
        recordPayout: hasSubPrivilege(user.permissions, "commissions", "record_payout"),
        managePlans: hasSubPrivilege(user.permissions, "commissions", "manage_plans"),
      },
      collectionSources: sources,
      sandbox: sandboxOnly,
      notice: sandboxOnly
        ? "Every figure here traces to the sandbox collection source. No real payment has been " +
          "received, and approving does not make one."
        : null,
    });
  } catch (err) {
    return handleDomainError(err);
  }
}
