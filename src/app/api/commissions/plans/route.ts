import { NextResponse } from "next/server";
import { prisma, TX_OPTS } from "@/lib/db";
import { requireSub } from "@/lib/auth-server";
import { handleDomainError } from "@/lib/api-error";
import { Decimal } from "@/lib/services/commissions/engine";
import { createPlan, type TierInput, type VersionInput } from "@/lib/services/commissions/plans";

/**
 * Commission plans.
 *
 * `manage_plans` gates everything here, and the service refuses self-assignment on top of
 * that — because `manage_plans` can legitimately belong to a sales manager who is
 * themselves on a plan, and the privilege alone would then let them set their own rate.
 */

/** GET /api/commissions/plans — every plan, its versions and who is on them. */
export async function GET() {
  const { error } = await requireSub("commissions", "manage_plans");
  if (error) return error;

  try {
    const plans = await prisma.commissionPlan.findMany({
      orderBy: [{ isActive: "desc" }, { code: "asc" }],
      select: {
        id: true, code: true, name: true, nameAr: true, description: true, isActive: true,
        createdAt: true,
        versions: {
          orderBy: { version: "desc" },
          select: {
            id: true, version: true, basis: true, tierMode: true, baseRatePercent: true,
            currency: true, effectiveFrom: true, effectiveTo: true, createdAt: true,
            tiers: {
              orderBy: { position: "asc" },
              select: { id: true, fromAmount: true, toAmount: true, ratePercent: true, position: true },
            },
            // What freezes a version: anything accrued against it can no longer be edited.
            _count: { select: { accruals: true, assignments: true } },
          },
        },
        _count: { select: { assignments: true } },
      },
    });

    return NextResponse.json({ plans });
  } catch (err) {
    return handleDomainError(err);
  }
}

/**
 * Turn request JSON into a validated version input.
 *
 * Amounts and rates arrive as strings and become Decimals here. A rate that passes through
 * a float is a rate that is already approximate before any arithmetic has happened.
 */
function parseVersion(b: Record<string, unknown>): VersionInput {
  const dec = (v: unknown, field: string): Decimal => {
    try {
      return new Decimal(String(v));
    } catch {
      throw { _appCode: 400, message: `${field} is not a number.` };
    }
  };

  const effectiveFrom = new Date(String(b.effectiveFrom ?? ""));
  if (Number.isNaN(effectiveFrom.getTime())) {
    throw { _appCode: 400, message: "effectiveFrom is required and must be a date." };
  }
  let effectiveTo: Date | null = null;
  if (b.effectiveTo) {
    effectiveTo = new Date(String(b.effectiveTo));
    if (Number.isNaN(effectiveTo.getTime())) {
      throw { _appCode: 400, message: "effectiveTo is not a date." };
    }
  }

  const rawTiers = Array.isArray(b.tiers) ? b.tiers : [];
  if (rawTiers.length > 20) {
    throw { _appCode: 400, message: "A plan version may have at most 20 tiers." };
  }
  const tiers: TierInput[] = rawTiers.map((raw, i) => {
    const t = (raw ?? {}) as Record<string, unknown>;
    return {
      fromAmount: dec(t.fromAmount ?? "0", `Tier ${i + 1} start`),
      toAmount:
        t.toAmount === null || t.toAmount === undefined || t.toAmount === ""
          ? null
          : dec(t.toAmount, `Tier ${i + 1} end`),
      ratePercent: dec(t.ratePercent ?? "0", `Tier ${i + 1} rate`),
    };
  });

  return {
    baseRatePercent: dec(b.baseRatePercent ?? "0", "The base rate"),
    tierMode: b.tierMode === "RETROACTIVE" ? "RETROACTIVE" : "INCREMENTAL",
    currency: typeof b.currency === "string" ? b.currency : "SAR",
    effectiveFrom,
    effectiveTo,
    tiers,
  };
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
    const version = parseVersion((b.version ?? b) as Record<string, unknown>);

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
