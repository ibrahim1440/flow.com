import { NextResponse } from "@/lib/api-response";
import { lastClosedQuotes } from "@/lib/services/sales/deal-amount";
import { prisma } from "@/lib/db";
import { requireModule } from "@/lib/auth-server";
import { handlePrismaError } from "@/lib/api-error";
import { hasSubPrivilege } from "@/lib/auth-shared";
import { dealNextStep } from "@/lib/services/sales/next-step";
import type { StagePurpose } from "@/lib/services/sales/stages";
import { discountApprovalState } from "@/lib/services/sales/quotes";
import { discountThreshold } from "@/lib/services/sales/quote-settings";
import { sampleApprovalState } from "@/lib/services/sales/sample-rules";
import { approvesMove, isGeneralManager, movesDirectly } from "@/lib/services/sales/stage-move";

/**
 * GET /api/sales/opportunities — the pipeline, with its stages.
 *
 * Returns the stages as well as the deals, because a Kanban with no columns is useless and
 * the columns are configuration rather than a constant in the client. Scoped in the WHERE
 * clause: a rep sees their own deals, and seeing everyone's is its own privilege.
 */
export async function GET() {
  const { user, error } = await requireModule("sales");
  if (error) return error;

  const seesAll = hasSubPrivilege(user.permissions, "sales", "lead_assign");

  try {
    const [stages, deals] = await Promise.all([
      prisma.pipelineStage.findMany({
        where: { isActive: true },
        orderBy: [{ position: "asc" }, { code: "asc" }],
        // `purpose`: pipeline v2 — the board draws the three stages and a collapsed «مغلقة».
        select: { id: true, code: true, nameEn: true, nameAr: true, position: true, probability: true, purpose: true },
      }),
      prisma.opportunity.findMany({
        where: seesAll ? {} : { ownerId: user.id },
        orderBy: [{ outcome: "asc" }, { expectedCloseAt: { sort: "asc", nulls: "last" } }],
        take: 300,
        select: {
          id: true, title: true, stageId: true, outcome: true, lostReason: true,
          amount: true, currency: true, probability: true,
          expectedCloseAt: true, nextFollowUpAt: true, closedAt: true, createdAt: true,
          customer: { select: { id: true, name: true, nameAr: true } },
          owner: { select: { id: true, name: true } },
          _count: { select: { quotes: true, samples: true, activities: true, orderLinks: true } },
          // The live quotations (newest revision first): the card names the latest, a won row
          // names the accepted one. Superseded revisions are history, not the deal's paperwork.
          quotes: {
            where: { status: { not: "SUPERSEDED" } },
            orderBy: [{ revision: "desc" }, { createdAt: "desc" }],
            take: 5,
            select: {
              id: true, quoteNumber: true, revision: true, status: true, acceptedAt: true, issuedAt: true, validUntil: true, createdAt: true,
              // Pipeline v2: the card's sub-status chip (next-step.ts) needs the discount state and the orders.
              subtotal: true, discountTotal: true, discountApprovedById: true, discountApprovedPercent: true, discountRejectedAt: true, approvalRequired: true, approvalBasisPercent: true,
              _count: { select: { orderLinks: true } },
            },
          },
          // Pipeline v2: what the card's «التالي: …» line is computed from (the deal page's own rule).
          stage: { select: { purpose: true, code: true } },
          businessType: true, needSummary: true, agreedNextStep: true,
          samples: {
            where: { status: { not: "CANCELLED" } },
            select: { id: true, status: true, fromStock: true, approvalRequired: true, approvedAt: true, declinedAt: true, sentAt: true },
          },
          // Owner decision 3: «طلب نقل بانتظار اعتماد المشرف» on the card.
          stageMoveRequests: {
            where: { status: "PENDING" },
            take: 1,
            select: { id: true, toStageId: true, requestedById: true, createdAt: true },
          },
          // Pipeline v2: «5 أيام في المرحلة» and the board's «انتقلت تلقائيًا» notice — the latest move into a stage.
          stageEvents: {
            where: { toStageId: { not: null } },
            orderBy: { createdAt: "desc" },
            take: 1,
            select: { createdAt: true, reason: true, fromStageId: true, toStageId: true, actorId: true },
          },
          // The next open activity, for the card's «مكالمة · 4 أكتوبر» line.
          activities: {
            where: { completedAt: null },
            orderBy: [{ dueAt: { sort: "asc", nulls: "last" } }, { createdAt: "asc" }],
            take: 1,
            select: { type: true, subject: true, dueAt: true },
          },
        },
      }),
    ]);

    const threshold = await discountThreshold(prisma);
    // Who decides a rep's move request (owner's rule): lead_assign, the administrator, or a «مدير عام» member.
    const gm = await isGeneralManager(prisma, user.id);
    const decider = approvesMove({ id: user.id, permissions: user.permissions, generalManager: gm });
    const now = new Date();
    // Soon batch round 2 (B): «آخر عرض مرفوض» for a deal left with no ACCEPTED / ISSUED quotation (read from Quote).
    const closed = await lastClosedQuotes(prisma, deals.map((x) => x.id));
    return NextResponse.json({
      stages,
      me: user.id,
      deals: deals.map(({ quotes, activities, samples, stageMoveRequests, stageEvents, stage, businessType, needSummary, agreedNextStep, ...d }) => {
        const accepted = quotes.find((q) => q.status === "ACCEPTED") ?? null;
        const ns = dealNextStep({
          outcome: d.outcome as "OPEN" | "WON" | "LOST", hasCustomer: !!d.customer, stagePurpose: stage.purpose as StagePurpose | null, stageCode: stage.code,
          businessType, needSummary, agreedNextStep,
          samples: samples.map((x) => ({ id: x.id, status: x.status, fromStock: x.fromStock, approval: sampleApprovalState(x), sentAt: x.sentAt })),
          quotes: quotes.map((q) => ({ id: q.id, status: q.status, revision: q.revision, issuedAt: q.issuedAt, validUntil: q.validUntil, createdAt: q.createdAt,
            orderLinks: q._count.orderLinks, discountApproval: discountApprovalState(q, threshold) })),
        }, now);
        const pending = stageMoveRequests[0] ?? null;
        const followUpLate = !!d.nextFollowUpAt && d.nextFollowUpAt < now;
        return {
          ...d,
          // Unchanged shape for existing readers: the accepted quotation, if any.
          quotes: accepted ? [{ id: accepted.id }] : [],
          lastClosedQuote: closed.get(d.id) ?? null,
          latestQuote: quotes[0] ? { id: quotes[0].id, quoteNumber: quotes[0].quoteNumber, revision: quotes[0].revision, status: quotes[0].status, acceptedAt: quotes[0].acceptedAt } : null,
          acceptedQuote: accepted ? { id: accepted.id, quoteNumber: accepted.quoteNumber, revision: accepted.revision, status: accepted.status, acceptedAt: accepted.acceptedAt } : null,
          nextActivity: activities[0] ?? null,
          // Pipeline v2: when the deal entered its stage, and how (an automatic move's reason starts «Automatic:»).
          stageSince: stageEvents[0]?.toStageId === d.stageId ? stageEvents[0].createdAt : d.createdAt,
          lastMove: stageEvents[0]?.fromStageId && stageEvents[0].toStageId === d.stageId
            ? { at: stageEvents[0].createdAt, reason: stageEvents[0].reason, byMe: stageEvents[0].actorId === user.id }
            : null,
          // Pipeline v2: the card's chip and «التالي: …» line — the same engine as the deal page (stable shape).
          nextStep: {
            phase: ns.phase, quoteState: ns.quoteState, quoteStateLabel: ns.quoteStateLabel,
            requiredNow: ns.requiredNow[0] ?? null,
            nextAction: ns.nextAction ? { key: ns.nextAction.key, ar: ns.nextAction.ar, en: ns.nextAction.en, disabled: !!ns.nextAction.disabled } : null,
          },
          pendingMove: pending ? {
            id: pending.id, toStageId: pending.toStageId, mine: pending.requestedById === user.id,
            canDecide: decider && pending.requestedById !== user.id,
          } : null,
          // «يحتاج تصرّفي»: an open deal of mine with a real next action (not a wait) or a late follow-up, or a request I decide.
          needsMe: d.outcome === "OPEN" && (
            (d.owner?.id === user.id && ((!!ns.nextAction && !ns.nextAction.disabled) || followUpLate))
            || (!!pending && decider && pending.requestedById !== user.id)),
        };
      }),
      scope: seesAll ? "all" : "own",
      can: {
        // Reported so the client can show the right controls, while the server re-checks
        // every one of them anyway. The client's copy is a convenience, not the gate.
        close: hasSubPrivilege(user.permissions, "sales", "deal_close"),
        reopen: hasSubPrivilege(user.permissions, "sales", "deal_reopen"),
        // Orders are made from an accepted quotation (`quotes/[id]/create-order`).
        createOrder: hasSubPrivilege(user.permissions, "orders", "create"),
        createLead: hasSubPrivilege(user.permissions, "sales", "lead_write"),
        // Pipeline v2: moving a card (drag, «نقل إلى…»): lead_write; direct only with deal_stage_move / lead_assign,
        // otherwise the move is a request a supervisor approves (owner decision 3).
        move: hasSubPrivilege(user.permissions, "sales", "lead_write"),
        moveDirectly: movesDirectly(user.permissions, gm),
      },
    });
  } catch (err) {
    return handlePrismaError(err);
  }
}
