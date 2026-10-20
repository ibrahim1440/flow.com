import type { Prisma } from "@/generated/prisma/client";
import { recalcOrderItemStatus } from "@/lib/services/order-fulfillment";
import { recalcProductionOrderStatus } from "@/lib/services/production-planning";
import { emitAutomationEvent } from "@/lib/automation/emit";

type Tx = Prisma.TransactionClient;

/**
 * The QC decision on a batch (production simplification item 5; owner decisions D1–D3).
 *
 *   · D1 — a batch needs at least `min` evaluator records (Settings › Production › QC, default 2)
 *     before its decision. The rule used to be a warning in the screen only; the server now holds it.
 *   · D2 — fewer than the minimum is an EXCEPTIONAL approval: the caller holds qc › finalize_override
 *     (privileged, step-up — checked by the route), sends override: true, a written overrideReason
 *     and confirmed: true, and the batch records the flag, the reason, who and when.
 *   · D3 / G26 — a decision that contradicts any evaluator needs a written reason, in both
 *     directions: passing a batch somebody rejected (as before) AND rejecting a batch somebody
 *     accepted (new). When the decision is also exceptional, the override reason may serve as the
 *     decision reason (one reason, one confirmation — the prototype's flow).
 *   · G05 — a rejected batch's unpacked roasted coffee is written off: a LOSS · ROASTED_COFFEE
 *     movement for roastedAvailableKg, which is set to 0. The order's demand then shows again in
 *     the roast queue (rejected roasts are not production progress anywhere in planning).
 *
 * `qcDecisionCheck` is pure (unit-tested); `applyQcDecision` writes, inside the caller's transaction.
 */
export { qcDecisionCheck, type QcOutcome, type QcDecisionInput, type QcDecisionRefusal, type QcDecisionOk } from "@/lib/qc-decision";
import type { QcOutcome, QcDecisionOk } from "@/lib/qc-decision";

export type QcDecisionApplied = { decided: boolean; lossKg: number };

/**
 * Commit one decision. Conditional on the status the request was validated against: a batch
 * decided by somebody else meanwhile is left alone (`decided: false`) — the single-batch route
 * turns that into a 409, the bulk route reports it.
 */
export async function applyQcDecision(tx: Tx, args: {
  batch: { id: string; status: string; orderItemId: string | null; productionOrderId: string | null; batchNumber?: string };
  outcome: QcOutcome;
  check: QcDecisionOk;
  min: number;
  actor: { id: string };
}): Promise<QcDecisionApplied> {
  const { batch, outcome, check, min, actor } = args;
  const now = new Date();
  const updated = await tx.roastingBatch.updateMany({
    where: { id: batch.id, status: batch.status },
    data: {
      status: outcome,
      qcClosedById: actor.id,
      // The guest link dies with the decision (D4: no evaluation after the verdict).
      qcToken: null,
      qcFinalDecisionReason: check.decisionReason,
      ...(check.overrideApplied
        ? { qcOverride: true, qcOverrideReason: check.overrideReason, qcOverrideById: actor.id, qcOverrideAt: now, qcOverrideMin: min }
        : {}),
    },
  });
  if (updated.count === 0) return { decided: false, lossKg: 0 };

  // Guests still pending can no longer evaluate: their invites close with the panel.
  await tx.qcInvite.updateMany({ where: { batchId: batch.id, status: "PENDING" }, data: { status: "CANCELLED", completedAt: now } });

  // G05: rejected roasted coffee leaves the books through the ledger, never silently. The row is
  // already locked by the update above, so the balance read here is the one being written off.
  let lossKg = 0;
  if (outcome === "Rejected") {
    const row = await tx.roastingBatch.findUnique({ where: { id: batch.id }, select: { roastedAvailableKg: true, batchNumber: true } });
    const available = +(row?.roastedAvailableKg ?? 0).toFixed(3);
    if (available > 0) {
      await tx.roastingBatch.update({ where: { id: batch.id }, data: { roastedAvailableKg: 0 } });
      await tx.inventoryMovement.create({
        data: {
          type: "LOSS",
          category: "ROASTED_COFFEE",
          referenceEntityId: batch.id,
          quantityChanged: -available,
          previousQuantity: available,
          newQuantity: 0,
          sourceDocType: "ROASTING_BATCH",
          sourceDocId: batch.id,
          userId: actor.id,
          notes: `QC rejected batch ${row?.batchNumber ?? ""}: roasted coffee written off.${check.decisionReason ? ` Reason: ${check.decisionReason}` : ""}`.slice(0, 1000),
        },
      });
      lossKg = available;
    }
  }

  // OrderItem before ProductionOrder (the canonical order every path takes).
  if (batch.orderItemId) await recalcOrderItemStatus(batch.orderItemId, tx);
  if (batch.productionOrderId) await recalcProductionOrderStatus(batch.productionOrderId, tx);

  await emitAutomationEvent(tx, {
    eventType: "qc.batch_finalized",
    subjectType: "RoastingBatch",
    subjectId: batch.id,
    // outcome and reason as before; override and lossKg are additive.
    payload: { outcome, reason: check.decisionReason, override: check.overrideApplied, lossKg },
    actorId: actor.id,
  });

  return { decided: true, lossKg };
}
