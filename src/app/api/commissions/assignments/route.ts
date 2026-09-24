import { NextResponse } from "next/server";
import { prisma, TX_OPTS } from "@/lib/db";
import { requireSub } from "@/lib/auth-server";
import { handleDomainError } from "@/lib/api-error";
import { assignPlan, endAssignment } from "@/lib/services/commissions/plans";

/**
 * Who is on which commission plan.
 *
 * Every response here names an employee and the rate they are paid at, which is among the
 * most sensitive data in the system — so the whole route is behind `manage_plans` rather
 * than behind ordinary commission access. Somebody who may see the team's commission
 * figures does not automatically get to see everyone's contract terms.
 */

/** GET /api/commissions/assignments — current and historical assignments. */
export async function GET(request: Request) {
  const { error } = await requireSub("commissions", "manage_plans");
  if (error) return error;

  const url = new URL(request.url);
  const employeeId = url.searchParams.get("employeeId");

  try {
    const [assignments, employees] = await Promise.all([
      prisma.commissionAssignment.findMany({
        where: employeeId ? { employeeId } : {},
        orderBy: [{ employeeId: "asc" }, { effectiveFrom: "desc" }],
        take: 500,
        select: {
          id: true, employeeId: true, effectiveFrom: true, effectiveTo: true, createdAt: true,
          employee: { select: { id: true, name: true, role: true, active: true } },
          plan: { select: { id: true, code: true, name: true, nameAr: true } },
          planVersion: {
            select: {
              id: true, version: true, baseRatePercent: true, tierMode: true, currency: true,
              effectiveFrom: true, effectiveTo: true,
              tiers: {
                orderBy: { position: "asc" },
                select: { fromAmount: true, toAmount: true, ratePercent: true },
              },
            },
          },
        },
      }),

      // The picker's source. Only the fields an assignment screen needs — never the
      // permission blob, the PIN verifier or the lookup selector.
      prisma.employee.findMany({
        where: { active: true },
        orderBy: { name: "asc" },
        select: { id: true, name: true, role: true },
      }),
    ]);

    const now = Date.now();
    const rows = assignments.map((a) => ({
      ...a,
      live: a.effectiveFrom.getTime() <= now && (a.effectiveTo === null || a.effectiveTo.getTime() > now),
    }));

    return NextResponse.json({ assignments: rows, employees });
  } catch (err) {
    return handleDomainError(err);
  }
}

/** POST /api/commissions/assignments — put someone on a plan version for a period. */
export async function POST(request: Request) {
  const { user, error } = await requireSub("commissions", "manage_plans");
  if (error) return error;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const b = (body ?? {}) as Record<string, unknown>;

  const employeeId = typeof b.employeeId === "string" ? b.employeeId : "";
  const planVersionId = typeof b.planVersionId === "string" ? b.planVersionId : "";
  if (!employeeId || !planVersionId) {
    return NextResponse.json({ error: "employeeId and planVersionId are required." }, { status: 400 });
  }

  const effectiveFrom = new Date(String(b.effectiveFrom ?? ""));
  if (Number.isNaN(effectiveFrom.getTime())) {
    return NextResponse.json({ error: "effectiveFrom is required and must be a date." }, { status: 400 });
  }
  let effectiveTo: Date | null = null;
  if (b.effectiveTo) {
    effectiveTo = new Date(String(b.effectiveTo));
    if (Number.isNaN(effectiveTo.getTime())) {
      return NextResponse.json({ error: "effectiveTo is not a date." }, { status: 400 });
    }
  }

  try {
    const created = await prisma.$transaction(
      (tx) => assignPlan(tx, { employeeId, planVersionId, effectiveFrom, effectiveTo, actorId: user.id }),
      TX_OPTS,
    );
    return NextResponse.json(created, { status: 201 });
  } catch (err) {
    return handleDomainError(err);
  }
}

/**
 * PATCH /api/commissions/assignments — end an assignment.
 *
 * Ending, not deleting. Money has accrued under it and the accrual rows reach the plan
 * version through it; removing the row would leave a payslip nobody could explain.
 */
export async function PATCH(request: Request) {
  const { user, error } = await requireSub("commissions", "manage_plans");
  if (error) return error;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const b = (body ?? {}) as Record<string, unknown>;

  const assignmentId = typeof b.assignmentId === "string" ? b.assignmentId : "";
  if (!assignmentId) {
    return NextResponse.json({ error: "assignmentId is required." }, { status: 400 });
  }
  const effectiveTo = new Date(String(b.effectiveTo ?? ""));
  if (Number.isNaN(effectiveTo.getTime())) {
    return NextResponse.json({ error: "effectiveTo is required and must be a date." }, { status: 400 });
  }

  try {
    const updated = await prisma.$transaction(
      (tx) => endAssignment(tx, { assignmentId, effectiveTo, actorId: user.id }),
      TX_OPTS,
    );
    return NextResponse.json(updated);
  } catch (err) {
    return handleDomainError(err);
  }
}
