import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireSub } from "@/lib/auth-server";
import { handlePrismaError } from "@/lib/api-error";
import { riyadhMonthStart, riyadhMonthEnd } from "@/lib/services/commissions/engine";
import { periodStatement } from "@/lib/services/commissions/accrual";

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
