import { NextResponse } from "next/server";
import { prisma, TX_OPTS } from "@/lib/db";
import { requireSub } from "@/lib/auth-server";
import { handleDomainError } from "@/lib/api-error";
import { seesAllSales, NOT_FOUND_MESSAGE } from "@/lib/services/sales/scope";
import { Decimal, validateSplits } from "@/lib/services/commissions/engine";

type Params = { params: Promise<{ id: string }> };

/**
 * PUT /api/sales/opportunities/[id]/owners — set the split attribution on a deal.
 *
 * Splitting a deal decides who gets paid, so this needs the assign privilege rather than
 * ordinary write access: a rep must not be able to write themselves into a colleague's deal.
 *
 * ── Splits divide the BASE, not the finished commission ──
 * That distinction is enforced in the accrual service, and it is the reason this endpoint
 * stores percentages rather than amounts. With tiers, splitting a computed commission would
 * hand each person a slice of somebody else's tier progress.
 *
 * ── History is not re-pointed ──
 * A new split takes effect from its own `effectiveFrom`, which defaults to now. Accruals
 * already written keep pointing where they pointed: what was earned stays earned, and a
 * reassignment tomorrow does not quietly move last month's money.
 */
export async function PUT(request: Request, { params }: Params) {
  const { user, error } = await requireSub("sales", "lead_assign");
  if (error) return error;
  const { id } = await params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const b = (body ?? {}) as Record<string, unknown>;

  if (!Array.isArray(b.splits)) {
    return NextResponse.json({ error: "splits must be an array." }, { status: 400 });
  }
  if (b.splits.length > 10) {
    return NextResponse.json(
      { error: "A deal may be split between at most ten people." },
      { status: 400 },
    );
  }

  const effectiveFrom = typeof b.effectiveFrom === "string" && b.effectiveFrom
    ? new Date(b.effectiveFrom)
    : new Date();
  if (Number.isNaN(effectiveFrom.getTime())) {
    return NextResponse.json({ error: "effectiveFrom is not a date." }, { status: 400 });
  }

  try {
    const deal = await prisma.opportunity.findFirst({
      where: { id, ...(seesAllSales(user.permissions) ? {} : { ownerId: user.id }) },
      select: { id: true, ownerId: true, outcome: true },
    });
    if (!deal) return NextResponse.json({ error: NOT_FOUND_MESSAGE }, { status: 404 });

    const splits: { employeeId: string; sharePercent: Decimal }[] = [];
    for (const raw of b.splits as unknown[]) {
      const s = (raw ?? {}) as Record<string, unknown>;
      if (typeof s.employeeId !== "string" || !s.employeeId) {
        throw { _appCode: 400, message: "Each split needs an employeeId." };
      }
      let pct: Decimal;
      try {
        pct = new Decimal(String(s.sharePercent));
      } catch {
        throw { _appCode: 400, message: "Each split needs a numeric sharePercent." };
      }
      splits.push({ employeeId: s.employeeId, sharePercent: pct });
    }

    // Clearing the splits is a legitimate act: it returns the whole base to the single owner.
    if (splits.length > 0) {
      const problems = validateSplits(splits);
      if (problems.length > 0) {
        throw { _appCode: 400, message: problems[0].message, problems };
      }

      const employees = await prisma.employee.findMany({
        where: { id: { in: splits.map((s) => s.employeeId) } },
        select: { id: true, active: true, name: true },
      });
      const byId = new Map(employees.map((e) => [e.id, e]));
      for (const s of splits) {
        const e = byId.get(s.employeeId);
        if (!e) throw { _appCode: 400, message: "One of those employees does not exist." };
        if (!e.active) {
          throw { _appCode: 400, message: `${e.name} is inactive and cannot be credited a share.` };
        }
      }
    }

    await prisma.$transaction(async (tx) => {
      await tx.opportunityOwner.deleteMany({ where: { opportunityId: id } });
      if (splits.length > 0) {
        await tx.opportunityOwner.createMany({
          data: splits.map((s) => ({
            opportunityId: id,
            employeeId: s.employeeId,
            sharePercent: s.sharePercent,
            effectiveFrom,
          })),
        });
      }
      await tx.opportunityStageEvent.create({
        data: {
          opportunityId: id,
          reason:
            splits.length === 0
              ? "Split attribution cleared; the deal owner takes the whole base"
              : `Split attribution set: ${splits.map((s) => `${s.sharePercent.toString()}%`).join(" / ")}`,
          actorId: user.id,
        },
      });
    }, TX_OPTS);

    const owners = await prisma.opportunityOwner.findMany({
      where: { opportunityId: id },
      select: {
        id: true, sharePercent: true, effectiveFrom: true,
        employee: { select: { id: true, name: true } },
      },
    });

    return NextResponse.json({
      owners,
      notice:
        "Commission already accrued is unchanged. This split applies to collections recorded " +
        "from its effective date onwards.",
    });
  } catch (err) {
    return handleDomainError(err);
  }
}
