-- 20261231220000_cost_state — accounting review 2026-11, fix B: stock with an unknown cost is not consumed.
--   "CostItem"."costState": KNOWN | ZERO_DOCUMENTED | UNKNOWN — whether the holder's cost is COMPLETE. A value above
--   zero does not say so (a finished lot can hold its materials' cost while the coffee's cost is missing).
--   "CostItem"."costGap": what is missing when UNKNOWN (shown in the refusal and the valuation report).
-- Additive: two nullable columns and one CHECK. No existing row is read or written: a holder that predates this
-- migration keeps NULL and its state is derived on read from its movements (lib/accounting/ops/cost-state.ts).
-- No balance, movement or journal entry is changed. The column grants of the table cover the new columns.
BEGIN;

ALTER TABLE "CostItem" ADD COLUMN "costState" TEXT;
ALTER TABLE "CostItem" ADD COLUMN "costGap" TEXT;
ALTER TABLE "CostItem" ADD CONSTRAINT "CostItem_costState_check" CHECK ("costState" IS NULL OR "costState" IN ('KNOWN', 'ZERO_DOCUMENTED', 'UNKNOWN'));
ALTER TABLE "CostItem" ADD CONSTRAINT "CostItem_costGap_check" CHECK ("costGap" IS NULL OR length("costGap") <= 500);

COMMIT;
