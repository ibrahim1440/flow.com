import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireModule, requireSub } from "@/lib/auth-server";
import { handleDomainError } from "@/lib/api-error";
import { hasSubPrivilege } from "@/lib/auth-shared";
import { seesAllSales, collectionWhere, NOT_FOUND_MESSAGE } from "@/lib/services/sales/scope";
import { collectionSummary } from "@/lib/services/sales/collections";
import { serialiseSummary } from "@/app/api/sales/collections/route";
import { Decimal } from "@/lib/services/commissions/engine";

type Params = { params: Promise<{ id: string }> };

/**
 * GET /api/sales/opportunities/[id] — everything the deal screen shows.
 *
 * One request rather than six. The deal page needs the deal, its quotations, its samples,
 * its activities, its stage history, its split owners and the orders raised from it; six
 * round trips on a connection that crosses the public internet is the difference between a
 * screen that opens and a screen an operator gives up on.
 *
 * Scoped in the WHERE clause. A deal that is not yours reads as 404 — not 403 — because
 * confirming that a deal exists names a customer relationship to somebody with no business
 * knowing about it.
 */
export async function GET(_request: Request, { params }: Params) {
  const { user, error } = await requireModule("sales");
  if (error) return error;
  const { id } = await params;

  try {
    const deal = await prisma.opportunity.findFirst({
      where: { id, ...(seesAllSales(user.permissions) ? {} : { ownerId: user.id }) },
      select: {
        id: true, title: true, outcome: true, lostReason: true, closedAt: true,
        amount: true, currency: true, probability: true,
        expectedCloseAt: true, nextFollowUpAt: true, createdAt: true, updatedAt: true,
        stage: { select: { id: true, code: true, nameEn: true, nameAr: true, position: true, probability: true } },
        customer: { select: { id: true, name: true, nameAr: true, phone: true, email: true, address: true } },
        owner: { select: { id: true, name: true } },
        owners: {
          orderBy: { effectiveFrom: "asc" },
          select: {
            id: true, sharePercent: true, effectiveFrom: true,
            employee: { select: { id: true, name: true } },
          },
        },
        conversion: {
          select: { leadId: true, convertedAt: true, customerCreated: true, lead: { select: { companyName: true } } },
        },
        quotes: {
          orderBy: [{ revision: "desc" }, { createdAt: "desc" }],
          select: {
            id: true, quoteNumber: true, revision: true, status: true, currency: true,
            validUntil: true, subtotal: true, discountTotal: true, taxTotal: true, grandTotal: true,
            issuedAt: true, acceptedAt: true, rejectedAt: true, rejectionNote: true,
            discountApprovedAt: true, supersedesId: true,
            _count: { select: { lines: true, orderLinks: true } },
          },
        },
        samples: {
          orderBy: { createdAt: "desc" },
          select: {
            id: true, description: true, quantity: true, unit: true, status: true,
            sentAt: true, feedbackAt: true, feedbackScore: true, feedbackNotes: true, createdAt: true,
            productSku: { select: { id: true, skuCode: true, name: true } },
          },
        },
        activities: {
          orderBy: [{ completedAt: { sort: "asc", nulls: "first" } }, { createdAt: "desc" }],
          take: 100,
          select: {
            id: true, type: true, subject: true, body: true, dueAt: true, completedAt: true,
            createdAt: true, owner: { select: { id: true, name: true } },
          },
        },
        stageEvents: {
          orderBy: { createdAt: "desc" },
          take: 50,
          select: {
            id: true, fromStageId: true, toStageId: true, fromOutcome: true, toOutcome: true,
            reason: true, actorId: true, createdAt: true,
            toStage: { select: { nameEn: true, nameAr: true } },
          },
        },
        orderLinks: {
          orderBy: { createdAt: "desc" },
          select: {
            id: true, isFirstOrder: true, createdAt: true, quoteId: true,
            order: { select: { id: true, orderNumber: true, status: true, createdAt: true } },
          },
        },
      },
    });
    if (!deal) return NextResponse.json({ error: NOT_FOUND_MESSAGE }, { status: 404 });

    // Stage names for the history, resolved once rather than joined onto every event.
    const stages = await prisma.pipelineStage.findMany({
      select: { id: true, code: true, nameEn: true, nameAr: true, position: true, probability: true, isActive: true },
      orderBy: { position: "asc" },
    });

    // The money against this deal. Computed rather than stored: a "collected so far"
    // column and a list of collections are two things that can disagree, and the one
    // people would believe is the one that is wrong.
    const collections = await prisma.salesCollection.findMany({
      where: { opportunityId: id, ...collectionWhere(user.permissions, user.id) },
      orderBy: { submittedAt: "desc" },
      select: {
        id: true, status: true, amountGross: true, amountTax: true, amountNet: true,
        currency: true, paymentMethod: true, collectedAt: true, referenceNumber: true,
        submittedAt: true, decidedAt: true, decisionReason: true,
        reversedAt: true, reversalReason: true,
        submittedBy: { select: { id: true, name: true } },
        decidedBy: { select: { id: true, name: true } },
        _count: { select: { evidence: true } },
        collectionEvent: {
          select: {
            accruals: {
              select: { amount: true, status: true, employee: { select: { id: true, name: true } } },
            },
          },
        },
      },
    });

    return NextResponse.json({
      deal,
      stages,
      collections,
      collectionSummary: serialiseSummary(await collectionSummary(prisma, id)),
      can: {
        write: hasSubPrivilege(user.permissions, "sales", "lead_write"),
        close: hasSubPrivilege(user.permissions, "sales", "deal_close"),
        reopen: hasSubPrivilege(user.permissions, "sales", "deal_reopen"),
        quote: hasSubPrivilege(user.permissions, "sales", "quote_write"),
        approveDiscount: hasSubPrivilege(user.permissions, "sales", "quote_approve_discount"),
        assign: seesAllSales(user.permissions),
        createOrder: hasSubPrivilege(user.permissions, "orders", "create"),
        submitCollection: hasSubPrivilege(user.permissions, "sales", "collection_submit"),
        verifyCollection: hasSubPrivilege(user.permissions, "commissions", "collection_verify"),
        rejectCollection: hasSubPrivilege(user.permissions, "commissions", "collection_reject"),
        reverseCollection: hasSubPrivilege(user.permissions, "commissions", "collection_reverse"),
      },
    });
  } catch (err) {
    return handleDomainError(err);
  }
}

/**
 * PATCH /api/sales/opportunities/[id] — edit the deal's own fields.
 *
 * Stage and outcome are deliberately NOT editable here. They go through
 * POST .../transition, which is where the rules live: a lost deal needs a reason, a won one
 * needs a customer and an accepted quotation, and reopening needs its own privilege. If this
 * endpoint accepted `outcome` it would be a second, unguarded way to close a deal.
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
  const b = (body ?? {}) as Record<string, unknown>;

  try {
    const existing = await prisma.opportunity.findUnique({
      where: { id },
      select: { id: true, ownerId: true, outcome: true },
    });
    if (!existing) return NextResponse.json({ error: NOT_FOUND_MESSAGE }, { status: 404 });

    const canAssign = seesAllSales(user.permissions);
    if (!canAssign && existing.ownerId !== user.id) {
      return NextResponse.json({ error: NOT_FOUND_MESSAGE }, { status: 404 });
    }
    if (existing.outcome !== "OPEN") {
      return NextResponse.json(
        {
          error:
            `This deal is ${existing.outcome.toLowerCase()}. Reopen it before editing, so the ` +
            "change is recorded as a decision rather than as a quiet correction.",
        },
        { status: 409 },
      );
    }

    const data: Record<string, unknown> = {};

    if (typeof b.title === "string") {
      const v = b.title.trim();
      if (v.length < 2) throw { _appCode: 400, message: "A deal needs a title." };
      data.title = v;
    }
    if (b.amount !== undefined) {
      let d: Decimal;
      try {
        d = new Decimal(String(b.amount));
      } catch {
        throw { _appCode: 400, message: "The expected value is not a number." };
      }
      if (d.isNegative()) throw { _appCode: 400, message: "The expected value cannot be negative." };
      data.amount = d;
    }
    if (b.probability !== undefined) {
      const p = Number(b.probability);
      if (!Number.isInteger(p) || p < 0 || p > 100) {
        throw { _appCode: 400, message: "Probability is a whole number between 0 and 100." };
      }
      data.probability = p;
    }
    for (const key of ["expectedCloseAt", "nextFollowUpAt"] as const) {
      if (b[key] === null) {
        data[key] = null;
      } else if (typeof b[key] === "string" && b[key]) {
        const d = new Date(b[key] as string);
        if (Number.isNaN(d.getTime())) throw { _appCode: 400, message: `${key} is not a date.` };
        data[key] = d;
      }
    }
    if (typeof b.customerId === "string" && b.customerId) {
      const customer = await prisma.customer.findUnique({
        where: { id: b.customerId },
        select: { id: true },
      });
      if (!customer) throw { _appCode: 400, message: "That customer does not exist." };
      data.customerId = b.customerId;
    }
    if (typeof b.ownerId === "string" && b.ownerId && b.ownerId !== existing.ownerId) {
      if (!canAssign) {
        throw { _appCode: 403, message: "Reassigning a deal needs the lead-assign permission." };
      }
      const target = await prisma.employee.findUnique({
        where: { id: b.ownerId },
        select: { id: true, active: true },
      });
      if (!target || !target.active) throw { _appCode: 400, message: "That employee cannot own a deal." };
      data.ownerId = b.ownerId;
    }
    if (typeof b.currency === "string" && b.currency !== "SAR") {
      throw {
        _appCode: 400,
        message: "Only SAR deals are supported; there is no exchange-rate policy configured.",
      };
    }

    if (Object.keys(data).length === 0) {
      return NextResponse.json({ error: "Nothing to change." }, { status: 400 });
    }

    const deal = await prisma.opportunity.update({
      where: { id },
      data,
      select: {
        id: true, title: true, amount: true, probability: true, expectedCloseAt: true,
        nextFollowUpAt: true, ownerId: true, customerId: true,
      },
    });

    // An owner change is pipeline history, not a silent field edit: the duration report and
    // "who moved this" both read these events.
    if (data.ownerId) {
      await prisma.opportunityStageEvent.create({
        data: {
          opportunityId: id,
          reason: `Owner changed to ${data.ownerId as string}`,
          actorId: user.id,
        },
      });
    }

    return NextResponse.json({ deal });
  } catch (err) {
    return handleDomainError(err);
  }
}
