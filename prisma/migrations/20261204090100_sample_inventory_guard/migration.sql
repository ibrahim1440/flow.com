-- Sales samples issued from stock, part 2 (docs/sales/SAMPLES_INVENTORY.md). ADDITIVE ONLY, one transaction. Separate
-- from 20261204090000_sample_inventory because it names the enum value 'SAMPLE' that migration adds, and a new enum
-- value may not be used in the transaction that added it.
--
-- The database backstop for «a sample never deducts twice»: at most ONE finished-goods movement per (sample, lot).
-- The issue service already guarantees it (the sample row is locked and moved REQUESTED/PREPARING → SENT in the same
-- transaction as the deduction, so a retry or a concurrent issue replays); this makes a second deduction impossible
-- even for a future caller that bypasses the service. Partial: no other source document is affected.
-- Row counts touched: none (no movement has sourceDocType 'SAMPLE' before this release).
-- Rollback: DROP INDEX "InventoryMovement_sample_lot_once";
BEGIN;

CREATE UNIQUE INDEX "InventoryMovement_sample_lot_once"
  ON "InventoryMovement" ("sourceDocId", "referenceEntityId")
  WHERE "sourceDocType" = 'SAMPLE';

COMMIT;
