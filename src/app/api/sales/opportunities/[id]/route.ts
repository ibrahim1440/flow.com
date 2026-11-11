import { NextResponse } from "@/lib/api-response";
import { lastClosedQuote } from "@/lib/services/sales/deal-amount";
import { prisma } from "@/lib/db";
import { requireModule, requireSub } from "@/lib/auth-server";
import { handleDomainError } from "@/lib/api-error";
import { canEdit, hasSubPrivilege } from "@/lib/auth-shared";
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
import { dealNextStep } from "@/lib/services/sales/next-step";
import type { StagePurpose } from "@/lib/services/sales/stages";
import { scheduleDealFollowUp } from "@/lib/services/sales/follow-through";
import { approvesMove, isGeneralManager, movesDirectly } from "@/lib/services/sales/stage-move";
import { redactCollectionRow, seesCollectionNet } from "@/lib/services/sales/collection-visibility";

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
            // Pipeline v2: a system follow-up's key (`sample:<id>`, `deal-follow-up:<id>`), so the page shows it once.
            sourceKey: true,
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

    // «المطلوب منك الآن» (pipeline v2 §2.5): computed HERE, on the server, from the deal as just read — the page
    // renders it and never decides on its own. my-day computes the same function from its own query.
    const samplesWithState = deal.samples.map((s) => ({ ...s, approval: sampleApprovalState(s) }));
    const activeAfter = stages.filter((s) => s.isActive && s.position > deal.stage.position);
    const nextStep = dealNextStep({
      outcome: deal.outcome as "OPEN" | "WON" | "LOST",
      hasCustomer: !!deal.customer,
      stagePurpose: deal.stage.purpose as StagePurpose | null,
      stageCode: deal.stage.code,
      hasNextStage: activeAfter.length > 0,
      businessType: deal.businessType, needSummary: deal.needSummary, agreedNextStep: deal.agreedNextStep,
      samples: samplesWithState.map((s) => ({ id: s.id, status: s.status, fromStock: s.fromStock, approval: s.approval, sentAt: s.sentAt })),
      quotes: quotes.map((q) => ({
        id: q.id, status: q.status, revision: q.revision, discountApproval: q.discountApproval,
        issuedAt: q.issuedAt, validUntil: q.validUntil, orderLinks: q._count.orderLinks,
      })),
      openActivities: deal.activities.filter((a) => !a.completedAt).map((a) => ({ id: a.id, type: a.type, dueAt: a.dueAt, sourceKey: a.sourceKey })),
      orderId: deal.orderLinks[0]?.order.id ?? null,
    }, new Date(), { approveDiscount: hasSubPrivilege(user.permissions, "sales", "quote_approve_discount"), approveSamples: approvesSamples(user.permissions) });

    // Owner decision 3: a rep's manual move waiting for a supervisor — «طلب نقل بانتظار اعتماد المشرف».
    const pending = await prisma.stageMoveRequest.findFirst({
      where: { opportunityId: id, status: "PENDING" },
      select: { id: true, fromStageId: true, toStageId: true, reason: true, requestedById: true, createdAt: true },
    });
    const lastDecided = pending ? null : await prisma.stageMoveRequest.findFirst({
      where: { opportunityId: id, status: "REJECTED", decidedAt: { gte: new Date(Date.now() - 14 * 86_400_000) } },
      orderBy: { decidedAt: "desc" },
      select: { id: true, toStageId: true, decisionNote: true, decidedById: true, decidedAt: true },
    });
    const moveNames = Object.fromEntries((await prisma.employee.findMany({
      where: { id: { in: [pending?.requestedById, lastDecided?.decidedById].filter((x): x is string => !!x) } }, select: { id: true, name: true },
    })).map((e) => [e.id, e.name]));
    const stageName = (sid: string) => stages.find((s) => s.id === sid);
    const pendingMove = pending ? {
      id: pending.id, toStageId: pending.toStageId,
      toStage: stageName(pending.toStageId) ? { nameAr: stageName(pending.toStageId)!.nameAr, nameEn: stageName(pending.toStageId)!.nameEn } : null,
      reason: pending.reason, requestedBy: moveNames[pending.requestedById] ?? null, createdAt: pending.createdAt,
      canDecide: approvesMove({ id: user.id, permissions: user.permissions, generalManager: await isGeneralManager(prisma, user.id) }) && pending.requestedById !== user.id,
      canWithdraw: pending.requestedById === user.id,
    } : null;
    const rejectedMove = lastDecided ? {
      id: lastDecided.id, toStage: stageName(lastDecided.toStageId) ? { nameAr: stageName(lastDecided.toStageId)!.nameAr, nameEn: stageName(lastDecided.toStageId)!.nameEn } : null,
      note: lastDecided.decisionNote, decidedBy: lastDecided.decidedById ? moveNames[lastDecided.decidedById] ?? null : null, decidedAt: lastDecided.decidedAt,
    } : null;

    return NextResponse.json({
      nextStep,
      pendingMove,
      rejectedMove,
      deal: { ...deal, quotes, samples: samplesWithState, customerBalance: balance, lastClosedQuote: await lastClosedQuote(prisma, deal.id) },
      sampledProductIds: sampledProducts,
      stages,
      actors,
      // R3-L1: a recorder reads no net basis and no commission rows.
      collections: seesCollectionNet(user.permissions) ? collections : collections.map(redactCollectionRow),
      collectionSummary: seesCollectionNet(user.permissions) ? serialiseSummary(summary) : { ...serialiseSummary(summary), approvedNet: null },
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
        // Owner decision 3: moves the deal between stages directly; without it a manual move is a request.
        moveDirectly: movesDirectly(user.permissions, await isGeneralManager(prisma, user.id)),
        // A customer's second sample of a product: the sales manager or the administrator approves it.
        approveSample: approvesSamples(user.permissions),
        // D22: «إرسال عيّنة» opens the tax invoice page's sample mode (it prepares the zero invoice — sample-send.ts), and a
        // deal with no customer is first made a customer (the shared new-customer form, POST /api/customers' own rule).
        sendSample: hasSubPrivilege(user.permissions, "sales", "lead_write") && hasSubPrivilege(user.permissions, "sales", "invoices_create"),
        makeCustomer: canEdit(user.permissions, "customers") || hasSubPrivilege(user.permissions, "sales", "lead_write") || hasSubPrivilege(user.permissions, "sales", "lead_convert"),
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
    if (b.expectedCloseAt === null) {
      data.expectedCloseAt = null;
    } else if (typeof b.expectedCloseAt === "string" && b.expectedCloseAt) {
      const d = new Date(b.expectedCloseAt);
      if (Number.isNaN(d.getTime())) throw { _appCode: 400, message: "expectedCloseAt is not a date." };
      data.expectedCloseAt = d;
    }
    // Pipeline v2 (D2, D4): the deal's follow-up date is no longer a free column. «جدولة متابعة» is ONE keyed TASK
    // activity (`deal-follow-up:<id>`) — scheduling again moves it — and the column is computed from what is open.
    // The field is still accepted for one release, routed through the same helper.
    let followUp: { dueAt: Date | null } | null = null;
    if (b.nextFollowUpAt === null) followUp = { dueAt: null };
    else if (typeof b.nextFollowUpAt === "string" && b.nextFollowUpAt) {
      const d = new Date(b.nextFollowUpAt);
      if (Number.isNaN(d.getTime())) throw { _appCode: 400, message: "nextFollowUpAt is not a date." };
      followUp = { dueAt: d };
    }
    const followUpSubject = typeof b.followUpSubject === "string" ? b.followUpSubject.slice(0, 200) : null;
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

    if (Object.keys(data).length === 0 && !followUp) {
      return NextResponse.json({ error: "Nothing to change." }, { status: 400 });
    }

    const deal = await prisma.$transaction(async (tx) => {
      if (Object.keys(data).length > 0) await tx.opportunity.update({ where: { id }, data });
      if (followUp) {
        await scheduleDealFollowUp(tx, { opportunityId: id, ownerId: (data.ownerId as string | undefined) ?? existing.ownerId, dueAt: followUp.dueAt, subject: followUpSubject });
      }
      return tx.opportunity.findUniqueOrThrow({
        where: { id },
        select: {
          id: true, title: true, amount: true, probability: true, expectedCloseAt: true,
          nextFollowUpAt: true, ownerId: true, customerId: true,
        },
      });
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
