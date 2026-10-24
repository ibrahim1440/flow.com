import { NextResponse } from "@/lib/api-response";
import { prisma, TX_OPTS } from "@/lib/db";
import { requireSub } from "@/lib/auth-server";
import { handleDomainError } from "@/lib/api-error";
import { createPlan, parseVersionBody } from "@/lib/services/commissions/plans";
import { maySeePay } from "@/lib/services/commissions/fixed-pay";

/**
 * Commission plans.
 *
 * `manage_plans` gates everything here, and the service refuses self-assignment on top of
 * that — because `manage_plans` can legitimately belong to a sales manager who is
 * themselves on a plan, and the privilege alone would then let them set their own rate.
 */

/** GET /api/commissions/plans — every plan, its versions and who is on them. */
export async function GET() {
  const { user, error } = await requireSub("commissions", "manage_plans");
  if (error) return error;

  try {
    const plans = await prisma.commissionPlan.findMany({
      orderBy: [{ isActive: "desc" }, { code: "asc" }],
      select: {
        id: true, code: true, name: true, nameAr: true, description: true, isActive: true,
        templateKey: true, createdAt: true,
        versions: {
          orderBy: { version: "desc" },
          select: {
            id: true, version: true, basis: true, tierMode: true, baseRatePercent: true,
            currency: true, effectiveFrom: true, effectiveTo: true, createdAt: true,
            // Commission plan builder: null for a tiered version, the components otherwise.
            components: true,
            tiers: {
              orderBy: { position: "asc" },
              select: { id: true, fromAmount: true, toAmount: true, ratePercent: true, position: true },
            },
            // What freezes a version: anything accrued against it can no longer be edited.
            _count: { select: { accruals: true, assignments: true, ledgerEntries: true, periodResults: true, bonusDecisions: true } },
          },
        },
        _count: { select: { assignments: true } },
      },
    });

    // Whether the simulation may show fixed pay from HR (maySeePay); the figure itself is fetched per request.
    return NextResponse.json({ plans, canSeePay: maySeePay(user.permissions) });
  } catch (err) {
    return handleDomainError(err);
  }
}

/** POST /api/commissions/plans — create a plan with its first version. */
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

  try {
    const version = parseVersionBody((b.version ?? b) as Record<string, unknown>);

    const created = await prisma.$transaction(
      (tx) =>
        createPlan(tx, {
          code: String(b.code ?? ""),
          name: String(b.name ?? ""),
          nameAr: typeof b.nameAr === "string" ? b.nameAr : null,
          description: typeof b.description === "string" ? b.description : null,
          version,
          actorId: user.id,
        }),
      TX_OPTS,
    );

    return NextResponse.json(created, { status: 201 });
  } catch (err) {
    return handleDomainError(err);
  }
}
