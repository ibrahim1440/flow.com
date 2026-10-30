-- «للعميل من كل محصول عيّنة واحدة» — one sample of each product per customer; a second needs the sales manager
-- (owner decision, docs/sales/SAMPLES_INVENTORY.md §2). ADDITIVE ONLY, one transaction (PostgreSQL 16 / 17).
--
--   "SampleShipment"."approvalRequired" (false on every existing row): this request is a SECOND (or later) sample of
--     the same coffee product for the same customer, so it waits for a manager before dispatch may see or issue it.
--   "approvedById" / "approvedAt": the manager who approved it, and when (a manager's own request records the manager).
--   "declinedById" / "declinedAt": the manager who declined it, and when — a declined request is CANCELLED with it.
--   "approvalNote": the manager's note (required for a decline: the reason the rep reads).
--   CHECK "SampleShipment_approval_shape": who and when go together; never both approved and declined; only a request
--     that needs approval carries a decision; only a stock sample needs one; a decline is CANCELLED and has its reason.
--   CHECK "SampleShipment_approval_before_issue": a request that needs approval is never issued without it — the
--     database's backstop behind the issue service's refusal (services/sales/sample-issue.ts).
--   Partial index: the requests awaiting a decision (the manager's «بانتظار اعتمادي» list).
-- Row counts touched: none (new columns take their defaults; no existing row is rewritten; every existing row meets
-- both CHECKs: approvalRequired false, no decision).
-- Rollback: docs/hr/migration-review/rollback-20261205090000_sample_approval.sql.
BEGIN;

ALTER TABLE "SampleShipment"
  ADD COLUMN "approvalRequired" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "approvedById"     TEXT,
  ADD COLUMN "approvedAt"       TIMESTAMP(3),
  ADD COLUMN "declinedById"     TEXT,
  ADD COLUMN "declinedAt"       TIMESTAMP(3),
  ADD COLUMN "approvalNote"     TEXT;

ALTER TABLE "SampleShipment" ADD CONSTRAINT "SampleShipment_approval_shape" CHECK (
  ("approvedAt" IS NULL) = ("approvedById" IS NULL)
  AND ("declinedAt" IS NULL) = ("declinedById" IS NULL)
  AND ("approvedAt" IS NULL OR "declinedAt" IS NULL)
  AND ("approvalRequired" OR ("approvedAt" IS NULL AND "declinedAt" IS NULL))
  AND (NOT "approvalRequired" OR "fromStock")
  AND ("declinedAt" IS NULL OR ("status"::text = 'CANCELLED' AND length(btrim(coalesce("approvalNote", ''))) > 0))
);

ALTER TABLE "SampleShipment" ADD CONSTRAINT "SampleShipment_approval_before_issue" CHECK (
  "issuedAt" IS NULL OR NOT "approvalRequired" OR "approvedAt" IS NOT NULL
);

CREATE INDEX "SampleShipment_awaiting_approval_idx" ON "SampleShipment"("createdAt")
  WHERE "approvalRequired" AND "approvedAt" IS NULL AND "declinedAt" IS NULL;

COMMIT;
