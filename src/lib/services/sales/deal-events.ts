import type { Prisma } from "@/generated/prisma/client";
import { automationListens, emitAutomationEvent } from "@/lib/automation/emit";

type Tx = Prisma.TransactionClient;

/**
 * Raise "sales.deal_stage_changed" for a deal that moved stage or changed outcome, in the
 * transaction of the move (src/lib/automation/emit.ts). The stage code is read only when a rule
 * listens, so a deployment without WhatsApp rules pays nothing for this.
 */
export async function emitDealMoved(
  tx: Tx,
  m: { opportunityId: string; fromStageId: string | null; toStageId: string | null; fromOutcome: string | null; toOutcome: string | null; actorId: string | null },
): Promise<void> {
  if (m.fromStageId === m.toStageId && m.fromOutcome === m.toOutcome) return;
  if (!(await automationListens("sales.deal_stage_changed"))) return;
  const stage = m.toStageId ? await tx.pipelineStage.findUnique({ where: { id: m.toStageId }, select: { code: true } }) : null;
  await emitAutomationEvent(tx, {
    eventType: "sales.deal_stage_changed",
    subjectType: "Opportunity",
    subjectId: m.opportunityId,
    payload: {
      fromStageId: m.fromStageId,
      toStageId: m.toStageId,
      toStageCode: stage?.code ?? null,
      fromOutcome: m.fromOutcome,
      toOutcome: m.toOutcome,
    },
    actorId: m.actorId,
  });
}
