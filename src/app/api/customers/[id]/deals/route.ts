import { NextResponse } from "next/server";
import { prisma, TX_OPTS } from "@/lib/db";
import { requireSub } from "@/lib/auth-server";
import { handleDomainError } from "@/lib/api-error";
import { hasModuleAccess } from "@/lib/auth-shared";
import { parseFiniteDecimal, roundMoney } from "@/lib/services/commissions/engine";
import { requireStageFor } from "@/lib/services/sales/stages";
import { NOT_FOUND_MESSAGE } from "@/lib/services/sales/scope";

type Params = { params: Promise<{ id: string }> };

/** A second identical request inside this window returns the first deal instead of a twin. */
const REPLAY_WINDOW_MS = 30_000;

/**
 * POST /api/customers/[id]/deals — open a deal for an EXISTING customer, so a quotation can
 * be raised from the account page («عرض سعر»). A quotation belongs to a deal
 * (POST /api/sales/quotes refuses one without), and until now the only way to get a deal was to
 * convert a lead — which an existing customer no longer has.
 *
 * The rules of the conversion path are kept, none is relaxed:
 *   * the privilege is the one that creates deals today: sales › lead_convert (plus the
 *     customers module, whose record it is opened on);
 *   * the stage is resolved on the server, never taken from the request: the stage configured
 *     as Qualification — where the automation puts every new deal (`requireStageFor`); with
 *     none configured it refuses (409) rather than guessing a column;
 *   * the owner is the caller — never taken from the request; reassigning stays `lead_assign`;
 *   * it opens OPEN at the stage's start, with a stage event saying where it came from; winning
 *     it still needs an accepted quotation (`transitionOpportunity`), and nothing here touches
 *     quotations, discounts or orders.
 * A double click does not make two deals: the customer row is locked and the same caller's
 * identical request within 30 seconds returns the first deal (200, `replayed: true`).
 */
export async function POST(request: Request, { params }: Params) {
  const { user, error } = await requireSub("sales", "lead_convert");
  if (error) return error;
  if (!hasModuleAccess(user.permissions, "customers")) {
    return NextResponse.json({ error: "Insufficient permissions" }, { status: 403 });
  }
  const { id } = await params;
  let body: unknown;
  try { body = await request.json(); } catch { return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 }); }
  const b = (body ?? {}) as Record<string, unknown>;

  const rawTitle = typeof b.title === "string" ? b.title.trim() : "";
  if (rawTitle.length > 200) return NextResponse.json({ error: "The title is longer than 200 characters." }, { status: 400 });
  let amount = undefined as ReturnType<typeof roundMoney> | undefined;
  if (b.amount !== undefined && b.amount !== null && b.amount !== "") {
    const d = parseFiniteDecimal(b.amount);
    if (!d || d.isNegative()) return NextResponse.json({ error: "amount must be zero or more." }, { status: 400 });
    amount = roundMoney(d);
  }
  let expectedCloseAt: Date | null = null;
  if (typeof b.expectedCloseAt === "string" && b.expectedCloseAt) {
    expectedCloseAt = new Date(b.expectedCloseAt);
    if (Number.isNaN(expectedCloseAt.getTime())) return NextResponse.json({ error: "expectedCloseAt is not a date." }, { status: 400 });
  }

  try {
    const result = await prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<{ id: string; name: string }[]>`
        SELECT "id", "name" FROM "Customer" WHERE "id" = ${id} FOR UPDATE`;
      const customer = locked[0];
      if (!customer) throw { _appCode: 404, message: NOT_FOUND_MESSAGE };
      const title = rawTitle || customer.name;

      const recent = await tx.opportunity.findFirst({
        where: { customerId: id, ownerId: user.id, title, outcome: "OPEN", createdAt: { gte: new Date(Date.now() - REPLAY_WINDOW_MS) } },
        orderBy: { createdAt: "desc" },
        select: { id: true },
      });
      if (recent) return { opportunityId: recent.id, replayed: true };

      const stage = await requireStageFor(tx, "QUALIFICATION");
      const deal = await tx.opportunity.create({
        data: { title, customerId: id, stageId: stage.id, outcome: "OPEN", amount, expectedCloseAt, ownerId: user.id },
        select: { id: true },
      });
      await tx.opportunityStageEvent.create({
        data: { opportunityId: deal.id, toStageId: stage.id, toOutcome: "OPEN", reason: "Created from the customer account", actorId: user.id },
      });
      return { opportunityId: deal.id, replayed: false };
    }, TX_OPTS);
    return NextResponse.json(result, { status: result.replayed ? 200 : 201 });
  } catch (err) {
    return handleDomainError(err);
  }
}
