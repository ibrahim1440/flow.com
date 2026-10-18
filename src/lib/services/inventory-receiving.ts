/**
 * The audit of a ROUTINE packaging-material receipt (inventory privileges Option A, review P2-4):
 * a delivery received under `inventory › receive` (POST /api/materials/:id/receive), or the opening
 * stock a material is created with (POST /api/materials). Not privileged — PIN-only receiving
 * staff do it — but it raises an on-hand balance, so it is attributable: the movement records the
 * login and the quantity, and this HrAuditLog row (append-only) adds the supplier / reference and
 * the login's session. Written in the caller's transaction: receipt and audit commit together.
 * Decreases are never receipts: a count is an adjustment (inventory › adjust, privileged).
 */
import { audit, type Db } from "@/lib/hr/core";

export async function auditInventoryReceipt(
  tx: Db,
  user: { id: string; name?: string | null; sessionId?: string },
  e: {
    entityId: string;
    opening: boolean;
    movementId: string;
    quantity: number;
    previousQuantity: number;
    newQuantity: number;
    supplier: { id: string; name: string } | null;
    reference: string | null;
    notes: string | null;
  },
) {
  await audit(tx, {
    action: e.opening ? "INVENTORY_OPENING_BALANCE" : "INVENTORY_RECEIVED",
    entityType: "MaterialItem",
    entityId: e.entityId,
    reason: e.notes,
    actorId: user.id,
    after: {
      movementId: e.movementId,
      quantity: e.quantity,
      previousQuantity: e.previousQuantity,
      newQuantity: e.newQuantity,
      supplier: e.supplier,
      reference: e.reference,
      login: { id: user.id, name: user.name ?? null, sessionId: user.sessionId ?? null },
    },
  });
}
