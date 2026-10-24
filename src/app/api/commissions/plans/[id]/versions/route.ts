import { NextResponse } from "@/lib/api-response";
import { prisma, TX_OPTS } from "@/lib/db";
import { requireSub } from "@/lib/auth-server";
import { handleDomainError } from "@/lib/api-error";
import { addPlanVersion, parseVersionBody } from "@/lib/services/commissions/plans";

type Params = { params: Promise<{ id: string }> };

/**
 * POST /api/commissions/plans/[id]/versions — change a plan's rules.
 *
 * There is no PATCH on a version, deliberately. A live rule edited in place would restate
 * commissions people have already been told they earned, and the first anybody would know
 * is a payslip disagreeing with last month's. A change is a new version with its own
 * effective date; the old one keeps governing the money earned under it, and
 * `selectPlanVersion` picks by the date the cash arrived.
 */
export async function POST(request: Request, { params }: Params) {
  const { user, error } = await requireSub("commissions", "manage_plans");
  if (error) return error;
  const { id } = await params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  try {
    const b = (body ?? {}) as Record<string, unknown>;
    const version = parseVersionBody(b);

    const created = await prisma.$transaction(
      // `moveAssignees`: carry the people on earlier versions of this plan over from the new start date.
      (tx) => addPlanVersion(tx, { planId: id, version, actorId: user.id, moveAssignees: b.moveAssignees === true }),
      TX_OPTS,
    );

    return NextResponse.json(
      {
        ...created,
        notice: created.closedPrevious
          ? "The previous version was closed at this one's start date, so there is never a moment with two live versions."
          : null,
      },
      { status: 201 },
    );
  } catch (err) {
    return handleDomainError(err);
  }
}
