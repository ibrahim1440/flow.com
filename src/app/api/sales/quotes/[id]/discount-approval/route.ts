import { NextResponse } from "@/lib/api-response";
import { prisma, TX_OPTS } from "@/lib/db";
import { requireSub } from "@/lib/auth-server";
import { handleDomainError } from "@/lib/api-error";
import { seesAllSales, NOT_FOUND_MESSAGE } from "@/lib/services/sales/scope";
import { decideDiscount } from "@/lib/services/sales/quotes";
import { discountThreshold } from "@/lib/services/sales/quote-settings";
import { isSimpleMode } from "@/lib/simple-mode";

type Params = { params: Promise<{ id: string }> };

/**
 * POST /api/sales/quotes/[id]/discount-approval — approve or refuse the discount on a draft
 * (Figma 181:1609, the list's preview drawer; and the quotation page).
 *
 * Body: { decision: "APPROVE" | "REJECT", note?: string } (a refusal needs a note).
 *
 * The privilege is the one that already authorises a discount above the threshold:
 * sales › quote_approve_discount, through `requireSub` — so its privileged gate (verified
 * individual, and a recent step-up: 401 REAUTH_REQUIRED, which the dashboard dialog handles)
 * applies exactly as it does when the approval is given by issuing. Scoped like every quotation
 * route (another rep's quotation is 404 to a caller who does not see all sales).
 *
 * The rules (draft only, above the threshold in force, four eyes unless SIMPLE MODE, a reason for
 * a refusal, cleared when the figures change) and the audit row are in `decideDiscount`, in one
 * transaction with the quotation lock.
 */
export async function POST(request: Request, { params }: Params) {
  const { user, error } = await requireSub("sales", "quote_approve_discount");
  if (error) return error;
  const { id } = await params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const b = (body ?? {}) as Record<string, unknown>;
  const decision = typeof b.decision === "string" ? b.decision.toUpperCase() : "";
  if (decision !== "APPROVE" && decision !== "REJECT") {
    return NextResponse.json({ error: "decision must be APPROVE or REJECT." }, { status: 400 });
  }
  if (b.note !== undefined && b.note !== null && typeof b.note !== "string") {
    return NextResponse.json({ error: "note must be text." }, { status: 400 });
  }

  try {
    const visible = await prisma.quote.findFirst({
      where: { id, ...(seesAllSales(user.permissions) ? {} : { opportunity: { ownerId: user.id } }) },
      select: { id: true },
    });
    if (!visible) return NextResponse.json({ error: NOT_FOUND_MESSAGE }, { status: 404 });

    const actor = await prisma.employee.findUnique({ where: { id: user.id }, select: { name: true } });
    const result = await prisma.$transaction(async (tx) => decideDiscount(tx, {
      quoteId: id,
      decision,
      note: typeof b.note === "string" ? b.note : null,
      actor: { id: user.id, name: actor?.name ?? null },
      threshold: await discountThreshold(tx),
      // SIMPLE MODE: the one admin may approve a discount on a quotation they raised.
      forbidSelfApproval: !isSimpleMode(),
    }), TX_OPTS);
    return NextResponse.json(result);
  } catch (err) {
    return handleDomainError(err);
  }
}
