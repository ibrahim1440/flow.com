import { NextResponse } from "@/lib/api-response";
import { prisma } from "@/lib/db";
import { requireModule, requireSub } from "@/lib/auth-server";
import { handleDomainError } from "@/lib/api-error";
import { hasSubPrivilege } from "@/lib/auth-shared";
import { seesAllSales, collectionWhere, NOT_FOUND_MESSAGE } from "@/lib/services/sales/scope";
import { collectionSummary, collectionAction } from "@/lib/services/sales/collections";
import { serialiseSummary } from "@/app/api/sales/collections/route";
import { parseFiniteDecimal } from "@/lib/services/commissions/engine";
import { discountApprovalState } from "@/lib/services/sales/quotes";
import { discountThreshold } from "@/lib/services/sales/quote-settings";
import { approvesSamples, sampleApprovalState } from "@/lib/services/sales/sample-rules";
import { sampledProductIds } from "@/lib/services/sales/sample-request";
import { customerInScope } from "@/lib/services/sales/customer-access";
import { customerBalance } from "@/lib/services/customers/balance";
import { canViewInvoices } from "@/lib/services/invoicing/access";

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
        id: true, title: true, outcome: true, lostReason: true, lostReasonCode: true, closedAt: true,
        amount: true, currency: true, probability: true,
        expectedCloseAt: true, nextFollowUpAt: true, createdAt: true, updatedAt: true,
        // «تحليل الاحتياج» (20261204100000_pipeline_qualification); edited at …/needs.
        businessType: true, needSummary: true, expectedMonthlyKg: true, agreedNextStep: true,
        stage: { select: { id: true, code: true, nameEn: true, nameAr: true, position: true, probability: true, purpose: true } },
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
          select: { leadId: true, convertedAt: true, customerCreated: true, convertedById: true, lead: { select: { companyName: true, contactName: true, phone: true, source: true } } },
        },
        quotes: {
          orderBy: [{ revision: "desc" }, { createdAt: "desc" }],
          select: {
            id: true, quoteNumber: true, revision: true, status: true, currency: true,
            validUntil: true, subtotal: true, discountTotal: true, taxTotal: true, grandTotal: true,
            issuedAt: true, acceptedAt: true, rejectedAt: true, rejectionNote: true,
            discountApprovedAt: true, supersedesId: true,
            // For `discountApproval` below (the stage primary action «request approval»).
            discountApprovedById: true, discountApprovedPercent: true, discountRejectedAt: true,
            // The VAT rate is per line; the deal page names it only when every line agrees.
            lines: { select: { taxRatePercent: true } },
            _count: { select: { lines: true, orderLinks: true } },
          },
        },
        samples: {
          orderBy: { createdAt: "desc" },
          select: {
            id: true, description: true, quantity: true, unit: true, status: true,
            sentAt: true, feedbackAt: true, feedbackScore: true, feedbackNotes: true, createdAt: true,
            // Issued from stock by dispatch (docs/sales/SAMPLES_INVENTORY.md). The cost stays out of a sales answer.
            fromStock: true, issuedAt: true,
            // A second sample of a product for this customer and its manager's decision (20261205090000_sample_approval).
            approvalRequired: true, approvedAt: true, declinedAt: true, approvalNote: true,
            productSku: { select: { id: true, skuCode: true, name: true, nameAr: true } },
          },
        },
        activities: {
          orderBy: [{ completedAt: { sort: "asc", nulls: "first" } }, { createdAt: "desc" }],
          take: 100,
          select: {
            id: true, type: true, subject: true, body: true, outcome: true, dueAt: true, completedAt: true,
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

    // Each quotation's discount-approval state, by the rule the quotation screens use, so the
    // deal page can say «needs approval» instead of «follow the quotation» (stage-actions.ts).
    const threshold = await discountThreshold(prisma);
    const quotes = deal.quotes.map((q) => ({ ...q, discountApproval: discountApprovalState(q, threshold) }));

    // Stage names for the history, resolved once rather than joined onto every event.
    const stages = await prisma.pipelineStage.findMany({
      // `purpose`: the deal page's primary action is chosen per stage purpose (stage-actions.ts).
      select: { id: true, code: true, nameEn: true, nameAr: true, position: true, probability: true, isActive: true, purpose: true },
      orderBy: [{ position: "asc" }, { code: "asc" }],
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

    const summary = await collectionSummary(prisma, id);

    // «للعميل من كل محصول عيّنة واحدة»: the coffee products this customer has already had a sample of (on any deal,
    // not cancelled), so the sample dialog can say before sending that a second one waits for the manager. Product
    // ids only — no other deal's detail leaves this answer.
    const sampledProducts = await sampledProductIds(prisma, { customerId: deal.customer?.id ?? null, opportunityId: deal.id });

    // Who did it, for the history lines whose record names the person (the conversion and
    // stage/outcome changes). Quotation issue and sample dispatch record no actor, so none is shown.
    const actorIds = [...new Set([deal.conversion?.convertedById, ...deal.stageEvents.map((e) => e.actorId)]
      .filter((x): x is string => !!x))];
    const actors = Object.fromEntries((actorIds.length ? await prisma.employee.findMany({
      where: { id: { in: actorIds } }, select: { id: true, name: true },
    }) : []).map((e) => [e.id, e.name]));

    // The customer panel's «الرصيد المستحق» (release item I-44): the customer file's own figure, over the deals
    // the viewer sees (services/customers/balance.ts) — AR once invoiced, else accepted quotations not invoiced.
    const balance = deal.customer
      ? await customerBalance(prisma, deal.customer.id, seesAllSales(user.permissions) ? {} : { ownerId: user.id }, canViewInvoices(user.permissions), new Date())
      : null;

    return NextResponse.json({
      deal: { ...deal, quotes, samples: deal.samples.map((s) => ({ ...s, approval: sampleApprovalState(s) })), customerBalance: balance },
      sampledProductIds: sampledProducts,
      stages,
      actors,
      collections,
      collectionSummary: serialiseSummary(summary),
      // The verdict, not the ingredients. The panel used to be handed a privilege flag and
      // left to work the rest out, which is how a reviewer whose role predated the privilege
      // got a blank space instead of a reason.
      collectionAction: collectionAction({
        hasSubmitPrivilege: hasSubPrivilege(user.permissions, "sales", "collection_submit"),
        // The deal was already fetched under the caller's scope — an out-of-scope deal 404s
        // above and never reaches here — so anything visible at this point is in scope.
        inScope: true,
        summary,
      }),
      can: {
        write: hasSubPrivilege(user.permissions, "sales", "lead_write"),
        close: hasSubPrivilege(user.permissions, "sales", "deal_close"),
        reopen: hasSubPrivilege(user.permissions, "sales", "deal_reopen"),
        quote: hasSubPrivilege(user.permissions, "sales", "quote_write"),
        approveDiscount: hasSubPrivilege(user.permissions, "sales", "quote_approve_discount"),
        assign: seesAllSales(user.permissions),
        // A customer's second sample of a product: the sales manager or the administrator approves it.
        approveSample: approvesSamples(user.permissions),
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
      const d = parseFiniteDecimal(b.amount);
      if (!d) throw { _appCode: 400, message: "The expected value is not a number." };
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
      // Release gate N1: relinking a deal to a customer outside the rep's book would pull that customer
      // into it (a deal widens the book, services/sales/scope.ts). Refused as missing — and BEFORE any
      // existence read, so the answer does not tell a rep whether somebody else's customer exists.
      if (!(await customerInScope(user, b.customerId))) throw { _appCode: 404, message: NOT_FOUND_MESSAGE };
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
