/**
 * Manual stock adjustments: the reason rule (inventory-adjustment-reason.ts, re-exported here)
 * and the one place that books a counted adjustment.
 */
import type { Db } from "@/lib/hr/core";
import { auditPrivilegedInventory } from "./inventory-privileged-audit";
import { ADJUSTMENT_NOOP_THRESHOLD } from "./stock-quantity";
import { onAdjustment } from "@/lib/accounting/ops/inventory-events";

export {
  normalizeAdjustmentReason,
  ADJUSTMENT_REASON_MAX_LENGTH,
  ADJUSTMENT_REASON_MIN_LENGTH,
  type AdjustmentReasonDecision,
} from "./inventory-adjustment-reason";

// ─── The adjustment itself ─────────────────────────────────────────────────────────────────
//
// The ONE place that books a counted adjustment (an ADJUSTMENT movement). Three callers, all
// gated by inventory › adjust (stockChangeGate) before they reach it:
//   · POST /api/inventory/adjust            — one green-coffee lot counted;
//   · PATCH /api/materials/:id              — one packaging material counted;
//   · POST /api/inventory/counts/:id/post   — a count session, every counted line in one step.
// Extracted from the first two routes unchanged, so a count session moves the ledger and the
// balances exactly as a single count always has: lock the row, read the balance, a 1 g / 0.001
// no-op threshold, one ADJUSTMENT movement (MANUAL_ADJUSTMENT, before / after / delta, the login,
// the reason), the new balance, and the INVENTORY_ADJUSTED person audit — all in the caller's
// transaction, so they commit or roll back together.


export { ADJUSTMENT_NOOP_THRESHOLD };

export type AdjustmentKind = "GREEN_BEAN" | "MATERIAL";

export type AdjustmentUser = Parameters<typeof auditPrivilegedInventory>[1];

export type AdjustmentResult = {
  noChange: boolean;
  previousQuantity: number;
  newQuantity: number;
  quantityChanged: number;
  movementId: string | null;
  unit: string;
};

/**
 * Book a counted adjustment of one item.
 *
 * `target` is the new on-hand quantity, or a function of the balance read under the row lock
 * (a count session applies its observed variance to the balance as it stands at posting:
 * `(current) => current + variance`). The resulting quantity must be finite and ≥ 0, or the
 * caller's transaction is aborted with a 409 (`_appCode`), like the routes' own refusals.
 *
 * `sourceDocId` is null for a single count, the count session id for a session line.
 */
export async function applyInventoryAdjustment(
  tx: Db,
  user: AdjustmentUser,
  a: {
    kind: AdjustmentKind;
    entityId: string;
    target: number | ((current: number) => number);
    reason: string;
    sourceDocId?: string | null;
    details?: Record<string, unknown>;
  },
): Promise<AdjustmentResult> {
  // Lock the row before reading the balance (see the routes' comments: it serialises against a
  // concurrent delete of the coffee, a receipt of the material, or another count).
  let previousQuantity: number;
  let unit: string;
  if (a.kind === "GREEN_BEAN") {
    const locked = await tx.$queryRaw<{ id: string; quantityKg: number }[]>`
      SELECT "id", "quantityKg" FROM "GreenBean" WHERE "id" = ${a.entityId} FOR UPDATE`;
    if (!locked[0]) throw { _appCode: 404, message: "Green bean not found." };
    previousQuantity = locked[0].quantityKg;
    unit = "kg";
  } else {
    const locked = await tx.$queryRaw<{ id: string; quantityOnHand: number; unitOfMeasure: string }[]>`
      SELECT "id", "quantityOnHand", "unitOfMeasure"::text AS "unitOfMeasure" FROM "MaterialItem" WHERE "id" = ${a.entityId} FOR UPDATE`;
    if (!locked[0]) throw { _appCode: 404, message: "Material not found." };
    previousQuantity = locked[0].quantityOnHand;
    unit = locked[0].unitOfMeasure;
  }

  const newQuantity = typeof a.target === "function" ? Number(a.target(previousQuantity).toFixed(4)) : a.target;
  if (!Number.isFinite(newQuantity) || newQuantity < 0) {
    throw { _appCode: 409, message: `The adjustment would leave a negative or invalid balance (${previousQuantity} → ${newQuantity}).` };
  }
  const quantityChanged = Number((newQuantity - previousQuantity).toFixed(4));
  if (Math.abs(quantityChanged) < ADJUSTMENT_NOOP_THRESHOLD) {
    return { noChange: true, previousQuantity, newQuantity: previousQuantity, quantityChanged: 0, movementId: null, unit };
  }

  const movement = await tx.inventoryMovement.create({
    data: {
      type: "ADJUSTMENT",
      category: a.kind === "GREEN_BEAN" ? "RAW_MATERIAL" : "PACKAGING_MATERIAL",
      referenceEntityId: a.entityId,
      quantityChanged,
      previousQuantity,
      newQuantity,
      sourceDocType: "MANUAL_ADJUSTMENT",
      sourceDocId: a.sourceDocId ?? null,
      userId: user.id,
      notes: a.reason,
    },
  });

  if (a.kind === "GREEN_BEAN") {
    await tx.greenBean.update({ where: { id: a.entityId }, data: { quantityKg: newQuantity } });
  } else {
    await tx.materialItem.update({ where: { id: a.entityId }, data: { quantityOnHand: newQuantity } });
  }

  // The responsible person, not only the login (owner decision, inventory Option A).
  // Accounting A3: the count's gain / loss at the moving average → INVENTORY_VARIANCE (reason carried).
  await onAdjustment(tx, { kind: a.kind, entityId: a.entityId, qtyChange: quantityChanged, newQty: newQuantity, movementId: movement.id, reason: a.reason, actor: user.id });

  await auditPrivilegedInventory(tx, user, {
    action: "INVENTORY_ADJUSTED",
    entityType: a.kind === "GREEN_BEAN" ? "GreenBean" : "MaterialItem",
    entityId: a.entityId,
    reason: a.reason,
    beforeQuantity: previousQuantity,
    afterQuantity: newQuantity,
    unit,
    details: { movementId: movement.id, previousQuantity, newQuantity, quantityChanged, ...(a.details ?? {}) },
  });

  return { noChange: false, previousQuantity, newQuantity, quantityChanged, movementId: movement.id, unit };
}
