-- Open items on journal lines (historically correct subledger reports and cash-flow attribution).
--
-- A line on a receivables or payables control account records WHICH document it opens or settles:
-- the supplier bill a payment pays, the invoice a receipt, credit note or advance settles, or the
-- credit note that is left as the customer's credit. The tag is written when the journal is
-- posted and, like every other column of a posted line, can never change (JournalEntryLine_guard).
-- Reversals and voids copy it from the original line (translators/mirror.ts), so they undo exactly
-- what the original did, on their own date. Aging, statements and the cash-flow attribution of
-- supplier payments are read from these posted lines by entry date, so a report for an earlier
-- date is unaffected by anything done later.
--
-- No backfill: no environment with accounting journals exists outside disposable test databases.

ALTER TABLE "JournalEntryLine" ADD COLUMN "openItemType" TEXT, ADD COLUMN "openItemId" TEXT;
ALTER TABLE "JournalEntryLine" ADD CONSTRAINT "JournalEntryLine_open_item_check" CHECK (
  ("openItemType" IS NULL) = ("openItemId" IS NULL)
  AND ("openItemType" IS NULL OR "openItemType" IN ('SUPPLIER_BILL', 'SALES_INVOICE', 'CREDIT_NOTE')));
CREATE INDEX "JournalEntryLine_accountId_openItemId_idx" ON "JournalEntryLine"("accountId", "openItemId");

-- Re-applying a credit note's unapplied balance to another invoice moves the credit between open
-- items; it now posts (Dr receivables · credit note / Cr receivables · invoice, net zero) so the
-- ledger alone tells which invoice is open on any date. Releasing it (when the credit note is
-- reversed) posts the mirror.
ALTER TABLE "ArAllocation" ADD COLUMN "isReallocation" BOOLEAN NOT NULL DEFAULT false;

CREATE OR REPLACE FUNCTION acc_guard_ar_allocation_kind() RETURNS trigger AS $$
BEGIN
  IF NEW."isReallocation" IS DISTINCT FROM OLD."isReallocation" THEN
    RAISE EXCEPTION 'An allocation cannot be edited; switch it off and allocate again' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "ArAllocation_kind_guard" BEFORE UPDATE ON "ArAllocation"
  FOR EACH ROW EXECUTE FUNCTION acc_guard_ar_allocation_kind();

CREATE OR REPLACE FUNCTION acc_emit_credit_reallocation_event() RETURNS trigger AS $$
DECLARE et text; at timestamp; cust text;
BEGIN
  IF NOT NEW."isReallocation" OR NEW."creditNoteId" IS NULL THEN RETURN NULL; END IF;
  IF TG_OP = 'INSERT' THEN et := 'ar.credit.allocated'; at := NEW."allocatedOn"::timestamp;
  ELSIF OLD."active" AND NOT NEW."active" THEN et := 'ar.credit.released'; at := NEW."removedAt";
  ELSE RETURN NULL;
  END IF;
  SELECT "customerId" INTO cust FROM "SalesInvoice" WHERE "id" = NEW."invoiceId";
  INSERT INTO "AccountingEvent" ("id", "eventType", "sourceModule", "sourceDocumentId", "sourceEventId",
    "idempotencyKey", "occurredAt", "payload", "status", "partyKey", "createdAt", "updatedAt")
  VALUES ('ae_' || replace(gen_random_uuid()::text, '-', ''), et, 'receivables', NEW."id", NEW."id" || ':' || et,
    'receivables:' || NEW."id" || ':' || et, at,
    jsonb_build_object('allocationId', NEW."id", 'customerId', cust, 'amount', NEW."amount"::text),
    'PENDING', 'CUSTOMER:' || cust, now(), now())
  ON CONFLICT ("idempotencyKey") DO NOTHING;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "ArAllocation_accounting_outbox" AFTER INSERT OR UPDATE OF "active" ON "ArAllocation"
  FOR EACH ROW EXECUTE FUNCTION acc_emit_credit_reallocation_event();
