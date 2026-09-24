import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireModule, requireSub } from "@/lib/auth-server";
import { handleDomainError } from "@/lib/api-error";
import { seesAllSales } from "@/lib/services/sales/scope";
import { Decimal } from "@/lib/services/commissions/engine";

/**
 * Sample shipments.
 *
 * ── This does NOT move stock, deliberately ──
 * The roastery already has a packaging and inventory path with its own guards, its own
 * reconciliation and its own audit trail. A CRM screen that decremented a shelf would be a
 * second way into the same inventory — exactly the defect the packaging rework on this
 * codebase was spent closing. A sample record says what was promised and what came back;
 * the coffee itself leaves through dispatch like everything else.
 *
 * That limit is stated in the response so nobody has to infer it from the absence of a
 * stock movement.
 */
const STOCK_NOTICE =
  "Recording a sample does not move stock. Issue the coffee through the normal inventory " +
  "and dispatch path; this is the follow-up record.";

const STATUSES = ["PREPARING", "SENT", "FEEDBACK_RECEIVED", "CANCELLED"];

/** GET /api/sales/samples — outstanding samples, for the follow-up view. */
export async function GET(request: Request) {
  const { user, error } = await requireModule("sales");
  if (error) return error;

  const url = new URL(request.url);
  const status = url.searchParams.get("status");
  const scopeAll = seesAllSales(user.permissions);

  try {
    const rows = await prisma.sampleShipment.findMany({
      where: {
        ...(status && STATUSES.includes(status) ? { status: status as never } : {}),
        // Scoped through the deal, because a sample has no owner of its own — the deal does.
        ...(scopeAll ? {} : { opportunity: { ownerId: user.id } }),
      },
      orderBy: [{ status: "asc" }, { createdAt: "desc" }],
      take: 200,
      select: {
        id: true, description: true, quantity: true, unit: true, status: true,
        sentAt: true, feedbackAt: true, feedbackScore: true, feedbackNotes: true, createdAt: true,
        productSku: { select: { id: true, skuCode: true, name: true } },
        opportunity: {
          select: {
            id: true, title: true, outcome: true,
            customer: { select: { id: true, name: true } },
            owner: { select: { id: true, name: true } },
          },
        },
      },
    });

    return NextResponse.json({ rows, scope: scopeAll ? "all" : "own", notice: STOCK_NOTICE });
  } catch (err) {
    return handleDomainError(err);
  }
}

/** POST /api/sales/samples — record a sample being prepared or sent for a deal. */
export async function POST(request: Request) {
  const { user, error } = await requireSub("sales", "lead_write");
  if (error) return error;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const b = (body ?? {}) as Record<string, unknown>;

  const opportunityId = typeof b.opportunityId === "string" ? b.opportunityId : "";
  if (!opportunityId) {
    return NextResponse.json({ error: "A sample belongs to a deal." }, { status: 400 });
  }

  const productSkuId = typeof b.productSkuId === "string" && b.productSkuId ? b.productSkuId : null;
  const description = typeof b.description === "string" ? b.description.trim() : "";
  if (!productSkuId && description.length < 2) {
    return NextResponse.json(
      { error: "Say what the sample is: pick a product, or describe it." },
      { status: 400 },
    );
  }

  let quantity: Decimal;
  try {
    quantity = new Decimal(String(b.quantity ?? 0));
  } catch {
    return NextResponse.json({ error: "quantity is not a number." }, { status: 400 });
  }
  if (quantity.lessThanOrEqualTo(0)) {
    return NextResponse.json({ error: "A sample quantity must be greater than zero." }, { status: 400 });
  }

  const unit = typeof b.unit === "string" && ["KG", "GRAM", "UNIT"].includes(b.unit) ? b.unit : "KG";
  const status = typeof b.status === "string" && STATUSES.includes(b.status) ? b.status : "PREPARING";

  try {
    const deal = await prisma.opportunity.findFirst({
      where: {
        id: opportunityId,
        ...(seesAllSales(user.permissions) ? {} : { ownerId: user.id }),
      },
      select: { id: true, outcome: true },
    });
    if (!deal) return NextResponse.json({ error: "Deal not found." }, { status: 404 });
    if (deal.outcome !== "OPEN") {
      return NextResponse.json(
        { error: `This deal is ${deal.outcome.toLowerCase()}; sending it a sample records nothing useful.` },
        { status: 409 },
      );
    }

    if (productSkuId) {
      const sku = await prisma.productSKU.findUnique({
        where: { id: productSkuId },
        select: { id: true, isActive: true, skuCode: true },
      });
      if (!sku) return NextResponse.json({ error: "That product does not exist." }, { status: 400 });
      if (!sku.isActive) {
        return NextResponse.json(
          { error: `"${sku.skuCode}" is inactive and cannot be sampled.` },
          { status: 400 },
        );
      }
    }

    const sample = await prisma.sampleShipment.create({
      data: {
        opportunityId,
        productSkuId,
        description: description || null,
        quantity,
        unit,
        status: status as never,
        sentAt: status === "SENT" ? new Date() : null,
        createdById: user.id,
      },
      select: { id: true, status: true, quantity: true, unit: true, sentAt: true },
    });

    // A sample that nobody follows up is a sample that was given away. The task is created
    // with it rather than left to the rep's memory.
    if (status === "SENT" && b.createFollowUp !== false) {
      const due = new Date(Date.now() + 7 * 86400_000);
      await prisma.activity.create({
        data: {
          type: "SAMPLE_FOLLOW_UP",
          subject: `Follow up on sample: ${description || "product sample"}`,
          opportunityId,
          dueAt: due,
          ownerId: user.id,
        },
      });
    }

    return NextResponse.json({ sample, notice: STOCK_NOTICE }, { status: 201 });
  } catch (err) {
    return handleDomainError(err);
  }
}
