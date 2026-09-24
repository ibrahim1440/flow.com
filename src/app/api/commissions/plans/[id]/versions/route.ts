import { NextResponse } from "next/server";
import { prisma, TX_OPTS } from "@/lib/db";
import { requireSub } from "@/lib/auth-server";
import { handleDomainError } from "@/lib/api-error";
import { Decimal } from "@/lib/services/commissions/engine";
import { addPlanVersion, type TierInput, type VersionInput } from "@/lib/services/commissions/plans";

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
    if (Number.isNaN(effectiveTo.getTime())) throw { _appCode: 400, message: "effectiveTo is not a date." };
  }

  const rawTiers = Array.isArray(b.tiers) ? b.tiers : [];
  if (rawTiers.length > 20) throw { _appCode: 400, message: "A plan version may have at most 20 tiers." };
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
    const version = parseVersion((body ?? {}) as Record<string, unknown>);

    const created = await prisma.$transaction(
      (tx) => addPlanVersion(tx, { planId: id, version, actorId: user.id }),
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
