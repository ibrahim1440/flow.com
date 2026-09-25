import type { Prisma as PrismaNS } from "@/generated/prisma/client";
import { stageFor, advancesForward } from "./stages";

type Tx = PrismaNS.TransactionClient;

/**
 * What the quotation lifecycle does to the deal underneath it.
 *
 * ── Why this is server-side and not a button ──
 * "Issue the quotation, then remember to drag the card" is a process that works until
 * somebody is busy. The board then describes the work somebody remembered to record rather
 * than the work that happened, and the forecast is built on the difference. Issuing a
 * quotation IS the deal reaching the quotation stage; the two are one act and are written
 * in one transaction.
 *
 * ── Forward only ──
 * Every function here refuses to move a deal backwards. A second quotation issued on a deal
 * already in Negotiation does not drag it back, and a Won or Lost deal is never quietly
 * reopened. The automation exists to stop work being lost, never to undo a decision a
 * person made.
 */

/**
 * Why a quotation did not move the deal. Every one of these is an ordinary outcome, not an
 * error: the quotation is still issued and the reason is reported so a screen can say so.
 */
export type StageAdvance =
  | { moved: true; stageId: string }
  | { moved: false; reason: "NOT_CONFIGURED" | "NO_DEAL" | "DEAL_CLOSED" | "ALREADY_THERE" | "WOULD_GO_BACKWARDS" };

/**
 * Move an open deal to the configured Quotation stage, if it is not already there or past it.
 *
 * ── Why an unconfigured stage does not refuse here ──
 * Qualification cannot proceed without a target stage — there is nowhere to put the deal, so
 * `requireStageFor` refuses and names the settings screen. Issuing a quotation is different:
 * the quotation is the act, and moving the card is automation layered on top of it. A
 * deployment that has not set a Quotation stage yet must still be able to send a customer a
 * price; refusing would make an unconfigured setting block the primary job of the module.
 *
 * So this reports what it did and why, and the caller surfaces it. The deal can be moved by
 * hand, and the screen can say the automation is not configured — which is a far better
 * outcome than a 409 on a quotation that was otherwise perfectly valid.
 */
export async function advanceToQuotationStage(
  tx: Tx,
  opportunityId: string,
  actorId: string,
): Promise<StageAdvance> {
  const stage = await stageFor(tx, "QUOTATION");
  if (!stage) return { moved: false, reason: "NOT_CONFIGURED" };

  const locked = await tx.$queryRaw<
    { id: string; stageId: string; outcome: string; position: number }[]
  >`
    SELECT o."id", o."stageId", o."outcome"::text AS outcome, s."position"
      FROM "Opportunity" o
      JOIN "PipelineStage" s ON s."id" = o."stageId"
     WHERE o."id" = ${opportunityId}
       FOR UPDATE OF o
  `;
  const deal = locked[0];
  if (!deal) return { moved: false, reason: "NO_DEAL" };

  // A closed deal is not re-staged by a quotation. Re-issuing on a won deal is unusual but
  // legal; silently dragging it back into the pipeline is not.
  if (deal.outcome !== "OPEN") return { moved: false, reason: "DEAL_CLOSED" };
  if (deal.stageId === stage.id) return { moved: false, reason: "ALREADY_THERE" };
  if (!advancesForward(deal.position, stage.position)) return { moved: false, reason: "WOULD_GO_BACKWARDS" };

  await tx.opportunity.update({
    where: { id: opportunityId },
    data: { stageId: stage.id },
  });
  await tx.opportunityStageEvent.create({
    data: {
      opportunityId,
      fromStageId: deal.stageId,
      toStageId: stage.id,
      fromOutcome: deal.outcome as "OPEN",
      toOutcome: "OPEN",
      reason: "Automatic: a quotation was issued",
      actorId,
    },
  });
  return { moved: true, stageId: stage.id };
}

/**
 * Mark a deal Won because the customer accepted its quotation.
 *
 * Runs in the same transaction as the acceptance, so there is never a moment where a
 * quotation is accepted and the deal it belongs to is not won.
 *
 * Idempotent: a replayed acceptance finds the deal already Won and writes nothing. The
 * stage is deliberately left alone — where a deal was won is a fact worth keeping, and
 * moving every won deal into a "Closed" column erases it.
 */
export async function winOnAcceptedQuote(
  tx: Tx,
  opportunityId: string,
  actorId: string,
): Promise<boolean> {
  const locked = await tx.$queryRaw<{ id: string; stageId: string; outcome: string; customerId: string | null }[]>`
    SELECT "id", "stageId", "outcome"::text AS outcome, "customerId"
      FROM "Opportunity"
     WHERE "id" = ${opportunityId}
       FOR UPDATE
  `;
  const deal = locked[0];
  if (!deal) return false;

  // Already decided. A replay, or a deal somebody closed by hand a moment earlier — either
  // way this is not the place to overrule it.
  if (deal.outcome !== "OPEN") return false;

  // The same rule `transitionOpportunity` enforces: Won is the claim that this became real
  // business, so it has to name the customer it became business with. Checked here too
  // rather than assumed, because this path does not go through that function.
  if (!deal.customerId) return false;

  await tx.opportunity.update({
    where: { id: opportunityId },
    data: { outcome: "WON", closedAt: new Date(), lostReason: null },
  });
  await tx.opportunityStageEvent.create({
    data: {
      opportunityId,
      fromStageId: deal.stageId,
      toStageId: deal.stageId,
      fromOutcome: "OPEN",
      toOutcome: "WON",
      reason: "Automatic: the customer accepted the quotation",
      actorId,
    },
  });
  return true;
}
