import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireModule, requireSub } from "@/lib/auth-server";
import { handleDomainError } from "@/lib/api-error";
import { seesAllSales } from "@/lib/services/sales/scope";
import {
  Decimal, ZERO, roundMoney, riyadhMonthStart, riyadhMonthEnd, qualifyingBase,
} from "@/lib/services/commissions/engine";

/**
 * Monthly sales targets.
 *
 * ── A target is not a commission rate ──
 * They are deliberately separate models and separate screens. Hitting a target may pay a
 * bonus, but the bonus is a figure someone decides and records, not something the accrual
 * engine adds to a rate. Merging the two is how a person ends up paid twice for one month.
 *
 * ── Progress is measured against collections, not against deals ──
 * Because that is what the commission is measured against. A target tracked on deal value
 * and a commission paid on cash collected disagree for months at a time, and the rep is
 * looking at the wrong one at exactly the moment they care most.
 */

function periodFrom(monthParam: string | null): { start: Date; end: Date } | null {
  const at = monthParam ? new Date(`${monthParam}-15T00:00:00Z`) : new Date();
  if (Number.isNaN(at.getTime())) return null;
  return { start: riyadhMonthStart(at), end: riyadhMonthEnd(at) };
}

/** GET /api/sales/targets — targets and progress for a Riyadh month. */
export async function GET(request: Request) {
  const { user, error } = await requireModule("sales");
  if (error) return error;

  const url = new URL(request.url);
  const period = periodFrom(url.searchParams.get("month"));
  if (!period) return NextResponse.json({ error: "month must look like 2026-09." }, { status: 400 });

  const scopeAll = seesAllSales(user.permissions);

  try {
    const targets = await prisma.salesTarget.findMany({
      where: {
        periodStart: period.start,
        ...(scopeAll ? {} : { employeeId: user.id }),
      },
      orderBy: { targetAmount: "desc" },
      select: {
        id: true, employeeId: true, periodStart: true, periodEnd: true,
        targetAmount: true, bonusAmount: true, currency: true, note: true,
        employee: { select: { id: true, name: true, active: true } },
      },
    });

    // Collections in the period, attributed the way the accrual engine attributes them:
    // through the deal's splits when it has them, otherwise wholly to the deal's owner.
    const events = await prisma.collectionEvent.findMany({
      where: { status: "RECORDED", collectedAt: { gte: period.start, lt: period.end } },
      select: {
        id: true, amountGross: true, amountTax: true, amountNonQualifying: true,
        collectedAt: true, sourceSystem: true,
        opportunityId: true,
      },
    });

    const oppIds = [...new Set(events.map((e) => e.opportunityId).filter((x): x is string => !!x))];
    const opps = oppIds.length
      ? await prisma.opportunity.findMany({
          where: { id: { in: oppIds } },
          select: {
            id: true, ownerId: true,
            owners: { select: { employeeId: true, sharePercent: true, effectiveFrom: true } },
          },
        })
      : [];
    const oppById = new Map(opps.map((o) => [o.id, o]));

    const collected = new Map<string, Decimal>();
    const add = (employeeId: string, amount: Decimal) =>
      collected.set(employeeId, roundMoney((collected.get(employeeId) ?? ZERO).plus(amount)));

    for (const e of events) {
      if (!e.opportunityId) continue;
      const opp = oppById.get(e.opportunityId);
      if (!opp) continue;
      const base = qualifyingBase({
        amountGross: e.amountGross,
        amountTax: e.amountTax,
        amountNonQualifying: e.amountNonQualifying,
      });
      const live = opp.owners.filter((o) => o.effectiveFrom.getTime() <= e.collectedAt.getTime());
      if (live.length === 0) {
        add(opp.ownerId, base);
      } else {
        for (const o of live) {
          add(o.employeeId, roundMoney(base.times(o.sharePercent).dividedBy(100)));
        }
      }
    }

    const sources = [...new Set(events.map((e) => e.sourceSystem))];

    const rows = targets.map((t) => {
      const achieved = collected.get(t.employeeId) ?? ZERO;
      const pct = t.targetAmount.isZero()
        ? ZERO
        : achieved.times(100).dividedBy(t.targetAmount).toDecimalPlaces(1);
      return {
        ...t,
        achieved: achieved.toFixed(2),
        achievedPercent: pct.toString(),
        // Stated rather than left for the reader to work out from a bar that is 96% full.
        met: achieved.greaterThanOrEqualTo(t.targetAmount),
        shortfall: roundMoney(Decimal.max(ZERO, t.targetAmount.minus(achieved))).toFixed(2),
      };
    });

    return NextResponse.json({
      periodStart: period.start,
      periodEnd: period.end,
      rows,
      scope: scopeAll ? "all" : "own",
      collectionSources: sources,
      sandbox: sources.length > 0 && sources.every((s) => s === "SANDBOX"),
      notice:
        sources.length > 0 && sources.every((s) => s === "SANDBOX")
          ? "Progress is measured from the sandbox collection source. No real payment has been received."
          : null,
    });
  } catch (err) {
    return handleDomainError(err);
  }
}

/**
 * PUT /api/sales/targets — set or replace one employee's target for a month.
 *
 * Setting a target is a management act (`lead_assign`, the same privilege that governs who
 * works on what), and nobody sets their own — the same reasoning as commission plans, and
 * for the same reason: a target with a bonus attached is pay.
 */
export async function PUT(request: Request) {
  const { user, error } = await requireSub("sales", "lead_assign");
  if (error) return error;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const b = (body ?? {}) as Record<string, unknown>;

  const employeeId = typeof b.employeeId === "string" ? b.employeeId : "";
  if (!employeeId) return NextResponse.json({ error: "employeeId is required." }, { status: 400 });
  if (employeeId === user.id) {
    return NextResponse.json(
      { error: "You cannot set your own target. Ask another manager to set it." },
      { status: 403 },
    );
  }

  const period = periodFrom(typeof b.month === "string" ? b.month : null);
  if (!period) return NextResponse.json({ error: "month must look like 2026-09." }, { status: 400 });

  let targetAmount: Decimal;
  let bonusAmount: Decimal;
  try {
    targetAmount = new Decimal(String(b.targetAmount ?? "0"));
    bonusAmount = new Decimal(String(b.bonusAmount ?? "0"));
  } catch {
    return NextResponse.json({ error: "The amounts must be numbers." }, { status: 400 });
  }
  if (targetAmount.isNegative() || bonusAmount.isNegative()) {
    return NextResponse.json({ error: "Amounts cannot be negative." }, { status: 400 });
  }
  if (targetAmount.isZero()) {
    return NextResponse.json(
      { error: "A target of zero is met by doing nothing. Remove the target instead." },
      { status: 400 },
    );
  }
  if (typeof b.currency === "string" && b.currency !== "SAR") {
    return NextResponse.json({ error: "Targets are set in SAR." }, { status: 400 });
  }

  try {
    const employee = await prisma.employee.findUnique({
      where: { id: employeeId },
      select: { id: true, active: true },
    });
    if (!employee) return NextResponse.json({ error: "Employee not found." }, { status: 404 });
    if (!employee.active) {
      return NextResponse.json({ error: "An inactive employee cannot be given a target." }, { status: 400 });
    }

    const target = await prisma.salesTarget.upsert({
      where: { employeeId_periodStart: { employeeId, periodStart: period.start } },
      create: {
        employeeId,
        periodStart: period.start,
        periodEnd: period.end,
        targetAmount: roundMoney(targetAmount),
        bonusAmount: roundMoney(bonusAmount),
        note: typeof b.note === "string" ? b.note.trim() || null : null,
        createdById: user.id,
      },
      update: {
        targetAmount: roundMoney(targetAmount),
        bonusAmount: roundMoney(bonusAmount),
        note: typeof b.note === "string" ? b.note.trim() || null : undefined,
      },
      select: {
        id: true, employeeId: true, periodStart: true, targetAmount: true,
        bonusAmount: true, currency: true, note: true,
      },
    });

    return NextResponse.json({ target });
  } catch (err) {
    return handleDomainError(err);
  }
}

/** DELETE /api/sales/targets?employeeId=…&month=… — remove a target set in error. */
export async function DELETE(request: Request) {
  const { user, error } = await requireSub("sales", "lead_assign");
  if (error) return error;

  const url = new URL(request.url);
  const employeeId = url.searchParams.get("employeeId") ?? "";
  const period = periodFrom(url.searchParams.get("month"));
  if (!employeeId || !period) {
    return NextResponse.json({ error: "employeeId and month are required." }, { status: 400 });
  }
  if (employeeId === user.id) {
    return NextResponse.json({ error: "You cannot change your own target." }, { status: 403 });
  }

  try {
    await prisma.salesTarget.delete({
      where: { employeeId_periodStart: { employeeId, periodStart: period.start } },
    });
    return NextResponse.json({ deleted: true });
  } catch (err) {
    return handleDomainError(err);
  }
}
