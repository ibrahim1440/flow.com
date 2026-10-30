import { NextResponse } from "@/lib/api-response";
import { prisma } from "@/lib/db";
import { requireModule, requireSub } from "@/lib/auth-server";
import { handleDomainError } from "@/lib/api-error";
import { seesAllSales, NOT_FOUND_MESSAGE } from "@/lib/services/sales/scope";
import { parseNeedsPatch, qualificationMissing } from "@/lib/services/sales/needs";

type Params = { params: Promise<{ id: string }> };

/**
 * «تحليل الاحتياج» of one deal (migration 20261204100000_pipeline_qualification).
 *
 * Needs analysis is a detail of the Qualified Opportunity stage, so it lives on the deal and is
 * edited here rather than through a stage of its own. Four nullable facts — business type, what
 * they need, the expected monthly kilograms and the agreed next step — copied from the lead when
 * it converted and corrected here as the conversation goes on.
 *
 * Scoped like every deal endpoint: a deal that is not yours (and you do not see all sales) reads
 * as 404, never 403, so the refusal does not confirm that the deal exists.
 */
const SELECT = {
  id: true, businessType: true, needSummary: true, expectedMonthlyKg: true, agreedNextStep: true,
} as const;

function present(n: { id: string; businessType: string | null; needSummary: string | null; expectedMonthlyKg: { toString(): string } | null; agreedNextStep: string | null }) {
  return {
    opportunityId: n.id,
    businessType: n.businessType,
    needSummary: n.needSummary,
    expectedMonthlyKg: n.expectedMonthlyKg === null ? null : n.expectedMonthlyKg.toString(),
    agreedNextStep: n.agreedNextStep,
    // What the qualification minimum still lacks — the deal page's primary action reads it.
    missing: qualificationMissing(n),
  };
}

/** GET /api/sales/opportunities/[id]/needs */
export async function GET(_request: Request, { params }: Params) {
  const { user, error } = await requireModule("sales");
  if (error) return error;
  const { id } = await params;
  try {
    const deal = await prisma.opportunity.findFirst({
      where: { id, ...(seesAllSales(user.permissions) ? {} : { ownerId: user.id }) },
      select: SELECT,
    });
    if (!deal) return NextResponse.json({ error: NOT_FOUND_MESSAGE }, { status: 404 });
    return NextResponse.json({ needs: present(deal) });
  } catch (err) {
    return handleDomainError(err);
  }
}

/**
 * PATCH /api/sales/opportunities/[id]/needs — `{ businessType?, needSummary?, expectedMonthlyKg?, agreedNextStep? }`.
 *
 * Partial: an absent key is unchanged, "" or null clears it. Needs sales › lead_write, like every
 * other edit of a deal. A won or lost deal is not edited (reopen it first), for the same reason
 * PATCH /api/sales/opportunities/[id] refuses: a correction to a closed deal is a decision, not a
 * quiet edit.
 */
export async function PATCH(request: Request, { params }: Params) {
  const { user, error } = await requireSub("sales", "lead_write");
  if (error) return error;
  const { id } = await params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const parsed = parseNeedsPatch((body ?? {}) as Record<string, unknown>);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error, errorAr: parsed.errorAr, code: "INVALID_NEEDS" }, { status: 400 });
  if (Object.keys(parsed.data).length === 0) {
    return NextResponse.json({ error: "Nothing to change.", errorAr: "لا يوجد ما يُغيَّر." }, { status: 400 });
  }

  try {
    const existing = await prisma.opportunity.findFirst({
      where: { id, ...(seesAllSales(user.permissions) ? {} : { ownerId: user.id }) },
      select: { id: true, outcome: true },
    });
    if (!existing) return NextResponse.json({ error: NOT_FOUND_MESSAGE }, { status: 404 });
    if (existing.outcome !== "OPEN") {
      return NextResponse.json({
        error: `This deal is ${existing.outcome.toLowerCase()}. Reopen it before editing its needs.`,
        errorAr: "الصفقة مغلقة. أعد فتحها قبل تعديل تحليل الاحتياج.",
        code: "DEAL_CLOSED",
      }, { status: 409 });
    }
    const deal = await prisma.opportunity.update({ where: { id }, data: parsed.data, select: SELECT });
    return NextResponse.json({ needs: present(deal) });
  } catch (err) {
    return handleDomainError(err);
  }
}
