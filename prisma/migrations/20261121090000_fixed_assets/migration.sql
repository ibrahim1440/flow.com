-- «الأصول الثابتة» (feat/fixed-assets, Qoyod-parity phase 4 item 3; the accounting council's design: IAS 16 / IFRS for
-- SMEs section 17). ADDITIVE ONLY, one transaction (PostgreSQL 16 / 17). The fixed-asset sub-ledger:
--
--   1. "FixedAssetCategory" — a default useful life (months), method (STRAIGHT_LINE; DECLINING_BALANCE with an annual
--      rate), a residual value % and the GL accounts of its assets (cost, accumulated depreciation, depreciation
--      expense, gain / loss on disposal; NULL = the posting role FA_COST / FA_ACCUMULATED_DEPRECIATION /
--      FA_DEPRECIATION_EXPENSE / FA_DISPOSAL_GAIN_LOSS). Seven categories are seeded (roasters, grinders, café
--      equipment, vehicles, furniture, IT, leasehold improvements); their cost account is set only when the default
--      chart is there (1210 / 1220 / 1230 / 1240). Never deleted (deactivated).
--   2. "FixedAsset" — the register: code, names, category, branch, location, supplier, the purchase-invoice EXPENSE line
--      it was capitalised from (optional), acquisition / in-service dates, cost, residual value, useful life, method,
--      status DRAFT → ACTIVE → FULLY_DEPRECIATED / DISPOSED, serial number, custodian (an HR employee id — no FK: the
--      verifier's check 14 keeps FKs out of Hr*), attachments ([{ name, url }], the journals' pattern) and its
--      schedule basis (basisDate / basisAccumulated: an addition starts a new basis, depreciated prospectively).
--   3. "FixedAssetEvent" — the sub-ledger rows (append-only): ACQUISITION / OPENING / ADDITION / DEPRECIATION / DISPOSAL,
--      each a cost and an accumulated-depreciation delta with its GL state (POSTED with its entry, SKIPPED before
--      go-live, OPENING through the opening balances). A reversal is a new row (reversesEventId). A DEFERRED constraint
--      trigger keeps every asset equal to its events at commit: cost = Σ cost, accumulated = Σ accumulated (a disposed
--      asset: both Σ = 0).
--   4. "FixedAssetDepreciationRun" / "FixedAssetDepreciationLine" — a monthly run: one balanced entry (Dr expense /
--      Cr accumulated by category and branch), one live line per (asset, month) (a partial unique index: the run is
--      idempotent per asset and month), reversed only by reversing the run (its lines voided, never deleted).
--   5. "FixedAssetAddition" (capital improvements; REVISION: a change of the useful life / residual value only, no
--      entry) and "FixedAssetDisposal" (sale or scrap: depreciation to the disposal day, cost and accumulated
--      derecognised, gain / loss; a disposal for value — sale or scrap — waits for the e-invoiced «بيع أصل ثابت» sales
--      line, council F1, so a disposal here has no proceeds and no VAT) — amounts frozen, POSTED → CANCELLED once.
--   6. A supplier invoice whose EXPENSE line was capitalised is not cancelled while the asset / addition stands
--      (fixed_asset_invoice_guard).
--   7. The posting roles FA_COST (1210), FA_ACCUMULATED_DEPRECIATION (1290), FA_DEPRECIATION_EXPENSE (6600) and
--      FA_DISPOSAL_GAIN_LOSS (7300 «أرباح وخسائر استبعاد الأصول الثابتة», added under 7000 when its code is free): on a
--      chart seeded from the default template, mapped when unmapped — never changing an account or a mapping that
--      exists (the supplier-shortfall pattern). Otherwise the accountant maps them («ربط الحسابات»).
--   8. The runtime role (flowcom_app), when it exists, is granted the new tables and functions.
-- Every new table is never deleted from (except a DRAFT asset), audited (ledger_audit_row) and not truncated.
-- Rollback: docs/hr/migration-review/rollback-20261121090000_fixed_assets.sql.
BEGIN;

-- 1 ─────────────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE "FixedAssetCategory" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL DEFAULT 'hiqbah',
  "code" TEXT NOT NULL,
  "nameAr" TEXT NOT NULL,
  "nameEn" TEXT,
  "usefulLifeMonths" INTEGER NOT NULL,
  "method" TEXT NOT NULL DEFAULT 'STRAIGHT_LINE',
  "decliningRatePercent" DECIMAL(7,4),
  "residualPercent" DECIMAL(5,2) NOT NULL DEFAULT 0,
  "costAccountId" TEXT,
  "accumAccountId" TEXT,
  "expenseAccountId" TEXT,
  "gainLossAccountId" TEXT,
  "zakatDeductible" BOOLEAN NOT NULL DEFAULT true,
  -- Leasehold improvements (council F5): an asset of the category names the lease end; its life is at most 60 months
  -- and ends by then (the application checks it on save, activation and any revision of the life).
  "isLeasehold" BOOLEAN NOT NULL DEFAULT false,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "createdBy" TEXT,
  "updatedBy" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "FixedAssetCategory_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "FixedAssetCategory_values_check" CHECK ("code" ~ '^[A-Z0-9_]{2,40}$' AND length(btrim("nameAr")) BETWEEN 1 AND 120
    AND "usefulLifeMonths" BETWEEN 1 AND 1200 AND "residualPercent" >= 0 AND "residualPercent" < 100
    AND "method" IN ('STRAIGHT_LINE', 'DECLINING_BALANCE')
    AND (("method" = 'DECLINING_BALANCE') = ("decliningRatePercent" IS NOT NULL))
    AND ("decliningRatePercent" IS NULL OR ("decliningRatePercent" > 0 AND "decliningRatePercent" <= 100)))
);
CREATE UNIQUE INDEX "FixedAssetCategory_code_key" ON "FixedAssetCategory"("code");
ALTER TABLE "FixedAssetCategory" ADD CONSTRAINT "FixedAssetCategory_costAccountId_fkey" FOREIGN KEY ("costAccountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "FixedAssetCategory" ADD CONSTRAINT "FixedAssetCategory_accumAccountId_fkey" FOREIGN KEY ("accumAccountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "FixedAssetCategory" ADD CONSTRAINT "FixedAssetCategory_expenseAccountId_fkey" FOREIGN KEY ("expenseAccountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "FixedAssetCategory" ADD CONSTRAINT "FixedAssetCategory_gainLossAccountId_fkey" FOREIGN KEY ("gainLossAccountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 2 ─────────────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE "FixedAsset" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL DEFAULT 'hiqbah',
  "code" TEXT NOT NULL,
  "nameAr" TEXT NOT NULL,
  "nameEn" TEXT,
  "categoryId" TEXT NOT NULL,
  "branchId" TEXT,
  "location" TEXT,
  "supplierId" TEXT,
  "supplierInvoiceId" TEXT,
  "supplierInvoiceLineId" TEXT,
  "acquisitionKind" TEXT NOT NULL,
  "counterAccountId" TEXT,
  "acquisitionDate" DATE NOT NULL,
  "inServiceDate" DATE,
  "cost" DECIMAL(18,2) NOT NULL,
  "residualValue" DECIMAL(18,2) NOT NULL DEFAULT 0,
  "usefulLifeMonths" INTEGER NOT NULL,
  "method" TEXT NOT NULL DEFAULT 'STRAIGHT_LINE',
  "decliningRatePercent" DECIMAL(7,4),
  "openingAccumulated" DECIMAL(18,2),
  "status" TEXT NOT NULL DEFAULT 'DRAFT',
  "serialNumber" TEXT,
  "custodianEmployeeId" TEXT,
  "attachments" JSONB,
  "notes" TEXT,
  -- «غير مخصوم من وعاء الزكاة» per asset (council F4): NULL = the category's setting; true / false overrides it.
  "zakatDeductible" BOOLEAN,
  -- The lease end of a leasehold improvement (council F5; frozen once the asset leaves DRAFT).
  "leaseEndDate" DATE,
  "accumulatedDepreciation" DECIMAL(18,2) NOT NULL DEFAULT 0,
  "depreciatedThrough" DATE,
  "basisDate" DATE,
  "basisAccumulated" DECIMAL(18,2),
  "activatedAt" TIMESTAMP(3),
  "activatedBy" TEXT,
  "createdBy" TEXT NOT NULL,
  "updatedBy" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "FixedAsset_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "FixedAsset_status_check" CHECK ("status" IN ('DRAFT', 'ACTIVE', 'FULLY_DEPRECIATED', 'DISPOSED')),
  -- A MANUAL acquisition names the account it was paid from whenever its entry posts (the application checks it then;
  -- before go-live, with no chart yet, it may be blank: the opening balances carry the asset).
  CONSTRAINT "FixedAsset_kind_check" CHECK ("acquisitionKind" IN ('PURCHASE_INVOICE', 'MANUAL', 'OPENING')
    AND ("acquisitionKind" <> 'PURCHASE_INVOICE' OR ("supplierInvoiceId" IS NOT NULL AND "supplierInvoiceLineId" IS NOT NULL))
    AND ("acquisitionKind" = 'PURCHASE_INVOICE' OR "supplierInvoiceLineId" IS NULL)
    AND (("acquisitionKind" = 'OPENING') = ("openingAccumulated" IS NOT NULL))),
  CONSTRAINT "FixedAsset_amounts_check" CHECK ("cost" >= 0 AND ("status" = 'DRAFT' OR "cost" > 0)
    AND "residualValue" >= 0 AND "residualValue" <= "cost"
    AND "accumulatedDepreciation" >= 0 AND "accumulatedDepreciation" <= "cost" - "residualValue"
    AND ("openingAccumulated" IS NULL OR ("openingAccumulated" >= 0 AND "openingAccumulated" <= "cost" - "residualValue"))
    AND ("basisAccumulated" IS NULL OR "basisAccumulated" >= 0)),
  CONSTRAINT "FixedAsset_schedule_check" CHECK ("usefulLifeMonths" BETWEEN 1 AND 1200
    AND "method" IN ('STRAIGHT_LINE', 'DECLINING_BALANCE')
    AND (("method" = 'DECLINING_BALANCE') = ("decliningRatePercent" IS NOT NULL))
    AND ("decliningRatePercent" IS NULL OR ("decliningRatePercent" > 0 AND "decliningRatePercent" <= 100))
    AND ("inServiceDate" IS NULL OR "inServiceDate" >= "acquisitionDate")
    AND ("leaseEndDate" IS NULL OR "leaseEndDate" > "acquisitionDate")
    AND ("status" = 'DRAFT' OR ("inServiceDate" IS NOT NULL AND "basisDate" IS NOT NULL AND "basisAccumulated" IS NOT NULL AND "activatedAt" IS NOT NULL))),
  CONSTRAINT "FixedAsset_text_check" CHECK (length(btrim("code")) BETWEEN 1 AND 40 AND length(btrim("nameAr")) BETWEEN 1 AND 200
    AND ("serialNumber" IS NULL OR length("serialNumber") <= 120) AND ("location" IS NULL OR length("location") <= 200)
    AND ("notes" IS NULL OR length("notes") <= 2000) AND ("attachments" IS NULL OR jsonb_typeof("attachments") = 'array'))
);
CREATE UNIQUE INDEX "FixedAsset_code_key" ON "FixedAsset"("code");
CREATE INDEX "FixedAsset_categoryId_status_idx" ON "FixedAsset"("categoryId", "status");
CREATE INDEX "FixedAsset_status_idx" ON "FixedAsset"("status");
CREATE INDEX "FixedAsset_supplierInvoiceLineId_idx" ON "FixedAsset"("supplierInvoiceLineId");
ALTER TABLE "FixedAsset" ADD CONSTRAINT "FixedAsset_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "FixedAssetCategory"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "FixedAsset" ADD CONSTRAINT "FixedAsset_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "FinBranch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "FixedAsset" ADD CONSTRAINT "FixedAsset_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "FixedAsset" ADD CONSTRAINT "FixedAsset_supplierInvoiceId_fkey" FOREIGN KEY ("supplierInvoiceId") REFERENCES "SupplierInvoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "FixedAsset" ADD CONSTRAINT "FixedAsset_supplierInvoiceLineId_fkey" FOREIGN KEY ("supplierInvoiceLineId") REFERENCES "SupplierInvoiceLine"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "FixedAsset" ADD CONSTRAINT "FixedAsset_counterAccountId_fkey" FOREIGN KEY ("counterAccountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 3 ─────────────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE "FixedAssetEvent" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL DEFAULT 'hiqbah',
  "assetId" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "eventDate" DATE NOT NULL,
  "costDelta" DECIMAL(18,2) NOT NULL DEFAULT 0,
  "accumDelta" DECIMAL(18,2) NOT NULL DEFAULT 0,
  "sourceType" TEXT NOT NULL,
  "sourceId" TEXT NOT NULL,
  "reversesEventId" TEXT,
  "glState" TEXT NOT NULL,
  "journalEntryId" TEXT,
  "createdBy" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "FixedAssetEvent_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "FixedAssetEvent_values_check" CHECK ("kind" IN ('ACQUISITION', 'OPENING', 'ADDITION', 'DEPRECIATION', 'DISPOSAL')
    AND "sourceType" IN ('ASSET', 'RUN', 'ADDITION', 'DISPOSAL')
    AND "glState" IN ('POSTED', 'SKIPPED', 'OPENING')
    AND ("glState" <> 'POSTED' OR "journalEntryId" IS NOT NULL)
    AND ("glState" <> 'OPENING' OR "kind" = 'OPENING')
    AND NOT ("costDelta" = 0 AND "accumDelta" = 0))
);
CREATE INDEX "FixedAssetEvent_assetId_eventDate_idx" ON "FixedAssetEvent"("assetId", "eventDate");
CREATE INDEX "FixedAssetEvent_source_idx" ON "FixedAssetEvent"("sourceType", "sourceId");
CREATE UNIQUE INDEX "FixedAssetEvent_reversesEventId_key" ON "FixedAssetEvent"("reversesEventId");
ALTER TABLE "FixedAssetEvent" ADD CONSTRAINT "FixedAssetEvent_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "FixedAsset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "FixedAssetEvent" ADD CONSTRAINT "FixedAssetEvent_reversesEventId_fkey" FOREIGN KEY ("reversesEventId") REFERENCES "FixedAssetEvent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 4 ─────────────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE "FixedAssetDepreciationRun" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL DEFAULT 'hiqbah',
  "number" TEXT NOT NULL,
  "year" INTEGER NOT NULL,
  "month" INTEGER NOT NULL,
  "periodEnd" DATE NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'POSTED',
  "totalAmount" DECIMAL(18,2) NOT NULL,
  "assetCount" INTEGER NOT NULL,
  "glState" TEXT NOT NULL,
  "journalEntryId" TEXT,
  "reversalEntryId" TEXT,
  "reversedAt" TIMESTAMP(3),
  "reversedBy" TEXT,
  "reverseReason" TEXT,
  "createdBy" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "FixedAssetDepreciationRun_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "FixedAssetDepreciationRun_values_check" CHECK ("month" BETWEEN 1 AND 12 AND "year" BETWEEN 2000 AND 2200
    AND "periodEnd" = (make_date("year", "month", 1) + interval '1 month' - interval '1 day')::date
    AND "status" IN ('POSTED', 'REVERSED') AND "totalAmount" > 0 AND "assetCount" > 0
    AND "glState" IN ('POSTED', 'SKIPPED') AND (("glState" = 'POSTED') = ("journalEntryId" IS NOT NULL))
    AND (("status" = 'REVERSED') = ("reversedAt" IS NOT NULL))
    AND ("status" <> 'REVERSED' OR length(btrim(coalesce("reverseReason", ''))) >= 3))
);
CREATE UNIQUE INDEX "FixedAssetDepreciationRun_number_key" ON "FixedAssetDepreciationRun"("number");
CREATE INDEX "FixedAssetDepreciationRun_year_month_idx" ON "FixedAssetDepreciationRun"("year", "month");

CREATE TABLE "FixedAssetDepreciationLine" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL DEFAULT 'hiqbah',
  "runId" TEXT NOT NULL,
  "assetId" TEXT NOT NULL,
  "periodKey" TEXT NOT NULL,
  "fromDate" DATE NOT NULL,
  "toDate" DATE NOT NULL,
  "amount" DECIMAL(18,2) NOT NULL,
  "categoryId" TEXT NOT NULL,
  "branchId" TEXT,
  "expenseAccountId" TEXT,
  "accumAccountId" TEXT,
  "voidedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "FixedAssetDepreciationLine_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "FixedAssetDepreciationLine_values_check" CHECK ("amount" > 0 AND "toDate" >= "fromDate" AND "periodKey" ~ '^[0-9]{4}-[0-9]{2}$'
    AND to_char("toDate", 'YYYY-MM') = "periodKey")
);
CREATE INDEX "FixedAssetDepreciationLine_runId_idx" ON "FixedAssetDepreciationLine"("runId");
-- The run is idempotent per (asset, month): one live line each.
CREATE UNIQUE INDEX "FixedAssetDepreciationLine_asset_period_live_key" ON "FixedAssetDepreciationLine"("assetId", "periodKey") WHERE "voidedAt" IS NULL;
ALTER TABLE "FixedAssetDepreciationLine" ADD CONSTRAINT "FixedAssetDepreciationLine_runId_fkey" FOREIGN KEY ("runId") REFERENCES "FixedAssetDepreciationRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "FixedAssetDepreciationLine" ADD CONSTRAINT "FixedAssetDepreciationLine_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "FixedAsset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 5 ─────────────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE "FixedAssetAddition" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL DEFAULT 'hiqbah',
  "number" TEXT NOT NULL,
  "assetId" TEXT NOT NULL,
  "additionDate" DATE NOT NULL,
  "amount" DECIMAL(18,2) NOT NULL,
  "kind" TEXT NOT NULL,
  "supplierInvoiceId" TEXT,
  "supplierInvoiceLineId" TEXT,
  "counterAccountId" TEXT,
  "description" TEXT NOT NULL,
  "newUsefulLifeMonths" INTEGER,
  "newResidualValue" DECIMAL(18,2),
  "before" JSONB NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'POSTED',
  "glState" TEXT NOT NULL,
  "journalEntryId" TEXT,
  "cancelEntryId" TEXT,
  "cancelledAt" TIMESTAMP(3),
  "cancelledBy" TEXT,
  "cancelReason" TEXT,
  "createdBy" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "FixedAssetAddition_pkey" PRIMARY KEY ("id"),
  -- REVISION (council F6): a change of estimate only — a new useful life and / or residual value, no amount, no entry
  -- (glState NONE), applied from its date onward (IAS 8.36 / SOCPA: prospective).
  CONSTRAINT "FixedAssetAddition_values_check" CHECK ("amount" >= 0 AND "kind" IN ('PURCHASE_INVOICE', 'MANUAL', 'REVISION')
    AND (("kind" = 'REVISION') = ("glState" = 'NONE'))
    AND ("kind" = 'REVISION' OR "amount" > 0)
    AND ("kind" <> 'REVISION' OR ("amount" = 0 AND "counterAccountId" IS NULL AND "supplierInvoiceId" IS NULL
         AND ("newUsefulLifeMonths" IS NOT NULL OR "newResidualValue" IS NOT NULL)))
    AND ("kind" <> 'PURCHASE_INVOICE' OR ("supplierInvoiceId" IS NOT NULL AND "supplierInvoiceLineId" IS NOT NULL))
    AND ("kind" <> 'MANUAL' OR "supplierInvoiceLineId" IS NULL)
    AND ("glState" <> 'POSTED' OR "kind" <> 'MANUAL' OR "counterAccountId" IS NOT NULL)
    AND ("newUsefulLifeMonths" IS NULL OR "newUsefulLifeMonths" BETWEEN 1 AND 1200) AND ("newResidualValue" IS NULL OR "newResidualValue" >= 0)
    AND length(btrim("description")) BETWEEN 1 AND 500
    AND "status" IN ('POSTED', 'CANCELLED') AND "glState" IN ('POSTED', 'SKIPPED', 'NONE') AND (("glState" = 'POSTED') = ("journalEntryId" IS NOT NULL))
    AND (("status" = 'CANCELLED') = ("cancelledAt" IS NOT NULL)) AND ("status" <> 'CANCELLED' OR length(btrim(coalesce("cancelReason", ''))) >= 3))
);
CREATE UNIQUE INDEX "FixedAssetAddition_number_key" ON "FixedAssetAddition"("number");
CREATE INDEX "FixedAssetAddition_assetId_idx" ON "FixedAssetAddition"("assetId");
CREATE INDEX "FixedAssetAddition_supplierInvoiceLineId_idx" ON "FixedAssetAddition"("supplierInvoiceLineId");
ALTER TABLE "FixedAssetAddition" ADD CONSTRAINT "FixedAssetAddition_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "FixedAsset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "FixedAssetAddition" ADD CONSTRAINT "FixedAssetAddition_supplierInvoiceId_fkey" FOREIGN KEY ("supplierInvoiceId") REFERENCES "SupplierInvoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "FixedAssetAddition" ADD CONSTRAINT "FixedAssetAddition_supplierInvoiceLineId_fkey" FOREIGN KEY ("supplierInvoiceLineId") REFERENCES "SupplierInvoiceLine"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "FixedAssetAddition" ADD CONSTRAINT "FixedAssetAddition_counterAccountId_fkey" FOREIGN KEY ("counterAccountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "FixedAssetDisposal" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL DEFAULT 'hiqbah',
  "number" TEXT NOT NULL,
  "assetId" TEXT NOT NULL,
  "disposalDate" DATE NOT NULL,
  "kind" TEXT NOT NULL,
  "proceedsNet" DECIMAL(18,2) NOT NULL DEFAULT 0,
  "vatRate" DECIMAL(5,2) NOT NULL DEFAULT 0,
  "vat" DECIMAL(18,2) NOT NULL DEFAULT 0,
  "proceedsAccountId" TEXT,
  "buyerName" TEXT,
  "taxInvoiceRef" TEXT,
  "catchUpDepreciation" DECIMAL(18,2) NOT NULL DEFAULT 0,
  "costRemoved" DECIMAL(18,2) NOT NULL,
  "accumRemoved" DECIMAL(18,2) NOT NULL,
  "gainLoss" DECIMAL(18,2) NOT NULL,
  "reason" TEXT,
  "before" JSONB NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'POSTED',
  "glState" TEXT NOT NULL,
  "journalEntryId" TEXT,
  "cancelEntryId" TEXT,
  "cancelledAt" TIMESTAMP(3),
  "cancelledBy" TEXT,
  "cancelReason" TEXT,
  "createdBy" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "FixedAssetDisposal_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "FixedAssetDisposal_values_check" CHECK ("kind" IN ('SALE', 'SCRAP')
    AND "proceedsNet" >= 0 AND "vat" >= 0 AND "vatRate" IN (0, 15) AND ("vatRate" > 0 OR "vat" = 0)
    AND ("kind" <> 'SCRAP' OR "vat" = 0)
    -- Council F1: any disposal for value (a sale, or scrap sold to a dealer) is a taxable supply that needs an issued
    -- e-invoice (a sales-invoice line «بيع أصل ثابت» — a follow-up): until then a disposal carries no proceeds and no VAT.
    AND "proceedsNet" = 0 AND "vat" = 0
    AND (("proceedsNet" + "vat" = 0) OR "proceedsAccountId" IS NOT NULL OR "glState" = 'SKIPPED')
    AND "catchUpDepreciation" >= 0 AND "costRemoved" > 0 AND "accumRemoved" >= 0 AND "accumRemoved" <= "costRemoved"
    AND "gainLoss" = "proceedsNet" - ("costRemoved" - "accumRemoved")
    AND ("buyerName" IS NULL OR length("buyerName") <= 200) AND ("taxInvoiceRef" IS NULL OR length("taxInvoiceRef") <= 60)
    AND "status" IN ('POSTED', 'CANCELLED') AND "glState" IN ('POSTED', 'SKIPPED') AND (("glState" = 'POSTED') = ("journalEntryId" IS NOT NULL))
    AND (("status" = 'CANCELLED') = ("cancelledAt" IS NOT NULL)) AND ("status" <> 'CANCELLED' OR length(btrim(coalesce("cancelReason", ''))) >= 3))
);
CREATE UNIQUE INDEX "FixedAssetDisposal_number_key" ON "FixedAssetDisposal"("number");
CREATE UNIQUE INDEX "FixedAssetDisposal_asset_live_key" ON "FixedAssetDisposal"("assetId") WHERE "status" = 'POSTED';
CREATE INDEX "FixedAssetDisposal_disposalDate_idx" ON "FixedAssetDisposal"("disposalDate");
ALTER TABLE "FixedAssetDisposal" ADD CONSTRAINT "FixedAssetDisposal_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "FixedAsset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "FixedAssetDisposal" ADD CONSTRAINT "FixedAssetDisposal_proceedsAccountId_fkey" FOREIGN KEY ("proceedsAccountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Guards ───────────────────────────────────────────────────────────────────────────────────────
-- Nothing of the sub-ledger is deleted (a DRAFT asset is: it never reached the books).
CREATE OR REPLACE FUNCTION fixed_asset_no_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'FixedAsset' AND OLD."status" = 'DRAFT' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'FA_KEPT: % rows are part of the books and are never deleted (reverse or cancel them)', TG_TABLE_NAME USING ERRCODE = 'P0001';
END $$;

-- The amounts the books carry never change in place: events are append-only; a run's / line's / addition's /
-- disposal's amounts are frozen (a run POSTED → REVERSED once, a line voided once, a document POSTED → CANCELLED once);
-- an asset's category, acquisition and in-service facts are frozen once it left DRAFT.
CREATE OR REPLACE FUNCTION fixed_asset_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'FixedAssetEvent' THEN
    RAISE EXCEPTION 'FA_FROZEN: the fixed-asset sub-ledger is append-only (a correction is a reversing row)' USING ERRCODE = 'P0001';
  ELSIF TG_TABLE_NAME = 'FixedAsset' THEN
    IF OLD."status" <> 'DRAFT' AND (NEW."categoryId" <> OLD."categoryId" OR NEW."acquisitionKind" <> OLD."acquisitionKind" OR NEW."acquisitionDate" <> OLD."acquisitionDate"
       OR NEW."inServiceDate" IS DISTINCT FROM OLD."inServiceDate" OR NEW."supplierInvoiceLineId" IS DISTINCT FROM OLD."supplierInvoiceLineId"
       OR NEW."supplierInvoiceId" IS DISTINCT FROM OLD."supplierInvoiceId" OR NEW."counterAccountId" IS DISTINCT FROM OLD."counterAccountId"
       OR NEW."openingAccumulated" IS DISTINCT FROM OLD."openingAccumulated" OR NEW."method" <> OLD."method"
       OR NEW."decliningRatePercent" IS DISTINCT FROM OLD."decliningRatePercent" OR NEW."leaseEndDate" IS DISTINCT FROM OLD."leaseEndDate"
       OR NEW."status" = 'DRAFT') THEN
      RAISE EXCEPTION 'FA_FROZEN: an active asset''s category, acquisition, in-service date and method never change' USING ERRCODE = 'P0001';
    END IF;
  ELSIF TG_TABLE_NAME = 'FixedAssetDepreciationRun' THEN
    IF NEW."number" <> OLD."number" OR NEW."year" <> OLD."year" OR NEW."month" <> OLD."month" OR NEW."totalAmount" <> OLD."totalAmount"
       OR NEW."assetCount" <> OLD."assetCount" OR NEW."glState" <> OLD."glState" OR NEW."journalEntryId" IS DISTINCT FROM OLD."journalEntryId"
       OR OLD."status" = 'REVERSED' THEN
      RAISE EXCEPTION 'FA_FROZEN: a depreciation run''s amounts never change; it is only reversed, once' USING ERRCODE = 'P0001';
    END IF;
  ELSIF TG_TABLE_NAME = 'FixedAssetDepreciationLine' THEN
    IF NEW."runId" <> OLD."runId" OR NEW."assetId" <> OLD."assetId" OR NEW."periodKey" <> OLD."periodKey" OR NEW."amount" <> OLD."amount"
       OR NEW."fromDate" <> OLD."fromDate" OR NEW."toDate" <> OLD."toDate" OR NEW."expenseAccountId" IS DISTINCT FROM OLD."expenseAccountId"
       OR NEW."accumAccountId" IS DISTINCT FROM OLD."accumAccountId" OR OLD."voidedAt" IS NOT NULL THEN
      RAISE EXCEPTION 'FA_FROZEN: a depreciation line never changes; it is only voided with its run, once' USING ERRCODE = 'P0001';
    END IF;
  ELSE
    IF NEW."number" <> OLD."number" OR NEW."assetId" <> OLD."assetId" OR NEW."glState" <> OLD."glState"
       OR NEW."journalEntryId" IS DISTINCT FROM OLD."journalEntryId" OR NEW."before" <> OLD."before" OR OLD."status" = 'CANCELLED' THEN
      RAISE EXCEPTION 'FA_FROZEN: a posted addition / disposal never changes; it is only cancelled, once' USING ERRCODE = 'P0001';
    END IF;
    -- (nested IFs: a record's field is resolved when the expression runs, so each table reads only its own columns)
    IF TG_TABLE_NAME = 'FixedAssetAddition' THEN
      IF NEW."amount" <> OLD."amount" OR NEW."additionDate" <> OLD."additionDate" THEN
        RAISE EXCEPTION 'FA_FROZEN: a posted addition never changes; it is only cancelled, once' USING ERRCODE = 'P0001';
      END IF;
    ELSIF NEW."disposalDate" <> OLD."disposalDate" OR NEW."proceedsNet" <> OLD."proceedsNet" OR NEW."vat" <> OLD."vat"
       OR NEW."costRemoved" <> OLD."costRemoved" OR NEW."accumRemoved" <> OLD."accumRemoved" OR NEW."catchUpDepreciation" <> OLD."catchUpDepreciation" THEN
      RAISE EXCEPTION 'FA_FROZEN: a posted disposal never changes; it is only cancelled, once' USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END $$;

-- At commit, every asset that left DRAFT equals its sub-ledger: cost = Σ cost deltas and accumulated = Σ accumulated
-- deltas (a DISPOSED asset: both sums are zero — it was derecognised).
CREATE OR REPLACE FUNCTION fixed_asset_books_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE aid text; a record; c numeric; d numeric;
BEGIN
  IF TG_TABLE_NAME = 'FixedAsset' THEN aid := NEW."id"; ELSE aid := NEW."assetId"; END IF;
  SELECT "status", "cost", "accumulatedDepreciation" INTO a FROM "FixedAsset" WHERE "id" = aid;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT coalesce(sum("costDelta"), 0), coalesce(sum("accumDelta"), 0) INTO c, d FROM "FixedAssetEvent" WHERE "assetId" = aid;
  IF a."status" = 'DRAFT' THEN
    IF c <> 0 OR d <> 0 OR EXISTS (SELECT 1 FROM "FixedAssetEvent" WHERE "assetId" = aid) THEN
      RAISE EXCEPTION 'FA_OUT_OF_BOOKS: a draft asset has no sub-ledger rows' USING ERRCODE = 'P0001';
    END IF;
  ELSIF a."status" = 'DISPOSED' THEN
    IF c <> 0 OR d <> 0 THEN
      RAISE EXCEPTION 'FA_OUT_OF_BOOKS: a disposed asset''s sub-ledger nets to zero (cost %, accumulated %)', c, d USING ERRCODE = 'P0001';
    END IF;
  ELSIF c <> a."cost" OR d <> a."accumulatedDepreciation" THEN
    RAISE EXCEPTION 'FA_OUT_OF_BOOKS: the asset (cost %, accumulated %) differs from its sub-ledger (cost %, accumulated %)', a."cost", a."accumulatedDepreciation", c, d USING ERRCODE = 'P0001';
  END IF;
  RETURN NULL;
END $$;

-- A supplier invoice whose EXPENSE line was capitalised (an asset out of DRAFT, or a posted addition) is not cancelled.
CREATE OR REPLACE FUNCTION fixed_asset_invoice_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."status" = 'CANCELLED' AND OLD."status" IS DISTINCT FROM 'CANCELLED'
     AND (EXISTS (SELECT 1 FROM "FixedAsset" WHERE "supplierInvoiceId" = NEW."id" AND "status" <> 'DRAFT')
          OR EXISTS (SELECT 1 FROM "FixedAssetAddition" WHERE "supplierInvoiceId" = NEW."id" AND "status" = 'POSTED')) THEN
    RAISE EXCEPTION 'FA_CAPITALISED: a line of this supplier invoice was capitalised as a fixed asset; dispose of or cancel that first' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER fixed_asset_no_delete BEFORE DELETE ON "FixedAssetCategory" FOR EACH ROW EXECUTE FUNCTION fixed_asset_no_delete();
CREATE TRIGGER fixed_asset_no_delete BEFORE DELETE ON "FixedAsset" FOR EACH ROW EXECUTE FUNCTION fixed_asset_no_delete();
CREATE TRIGGER fixed_asset_no_delete BEFORE DELETE ON "FixedAssetEvent" FOR EACH ROW EXECUTE FUNCTION fixed_asset_no_delete();
CREATE TRIGGER fixed_asset_no_delete BEFORE DELETE ON "FixedAssetDepreciationRun" FOR EACH ROW EXECUTE FUNCTION fixed_asset_no_delete();
CREATE TRIGGER fixed_asset_no_delete BEFORE DELETE ON "FixedAssetDepreciationLine" FOR EACH ROW EXECUTE FUNCTION fixed_asset_no_delete();
CREATE TRIGGER fixed_asset_no_delete BEFORE DELETE ON "FixedAssetAddition" FOR EACH ROW EXECUTE FUNCTION fixed_asset_no_delete();
CREATE TRIGGER fixed_asset_no_delete BEFORE DELETE ON "FixedAssetDisposal" FOR EACH ROW EXECUTE FUNCTION fixed_asset_no_delete();
CREATE TRIGGER fixed_asset_guard BEFORE UPDATE ON "FixedAsset" FOR EACH ROW EXECUTE FUNCTION fixed_asset_guard();
CREATE TRIGGER fixed_asset_guard BEFORE UPDATE ON "FixedAssetEvent" FOR EACH ROW EXECUTE FUNCTION fixed_asset_guard();
CREATE TRIGGER fixed_asset_guard BEFORE UPDATE ON "FixedAssetDepreciationRun" FOR EACH ROW EXECUTE FUNCTION fixed_asset_guard();
CREATE TRIGGER fixed_asset_guard BEFORE UPDATE ON "FixedAssetDepreciationLine" FOR EACH ROW EXECUTE FUNCTION fixed_asset_guard();
CREATE TRIGGER fixed_asset_guard BEFORE UPDATE ON "FixedAssetAddition" FOR EACH ROW EXECUTE FUNCTION fixed_asset_guard();
CREATE TRIGGER fixed_asset_guard BEFORE UPDATE ON "FixedAssetDisposal" FOR EACH ROW EXECUTE FUNCTION fixed_asset_guard();
CREATE CONSTRAINT TRIGGER fixed_asset_books_check AFTER INSERT OR UPDATE ON "FixedAsset" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fixed_asset_books_check();
CREATE CONSTRAINT TRIGGER fixed_asset_books_check AFTER INSERT ON "FixedAssetEvent" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fixed_asset_books_check();
CREATE TRIGGER fixed_asset_invoice_guard BEFORE UPDATE OF "status" ON "SupplierInvoice" FOR EACH ROW EXECUTE FUNCTION fixed_asset_invoice_guard();
CREATE TRIGGER ledger_no_truncate BEFORE TRUNCATE ON "FixedAssetCategory" FOR EACH STATEMENT EXECUTE FUNCTION ledger_no_truncate();
CREATE TRIGGER ledger_no_truncate BEFORE TRUNCATE ON "FixedAsset" FOR EACH STATEMENT EXECUTE FUNCTION ledger_no_truncate();
CREATE TRIGGER ledger_no_truncate BEFORE TRUNCATE ON "FixedAssetEvent" FOR EACH STATEMENT EXECUTE FUNCTION ledger_no_truncate();
CREATE TRIGGER ledger_no_truncate BEFORE TRUNCATE ON "FixedAssetDepreciationRun" FOR EACH STATEMENT EXECUTE FUNCTION ledger_no_truncate();
CREATE TRIGGER ledger_no_truncate BEFORE TRUNCATE ON "FixedAssetDepreciationLine" FOR EACH STATEMENT EXECUTE FUNCTION ledger_no_truncate();
CREATE TRIGGER ledger_no_truncate BEFORE TRUNCATE ON "FixedAssetAddition" FOR EACH STATEMENT EXECUTE FUNCTION ledger_no_truncate();
CREATE TRIGGER ledger_no_truncate BEFORE TRUNCATE ON "FixedAssetDisposal" FOR EACH STATEMENT EXECUTE FUNCTION ledger_no_truncate();
CREATE TRIGGER ledger_audit_row AFTER INSERT OR UPDATE OR DELETE ON "FixedAssetCategory" FOR EACH ROW EXECUTE FUNCTION ledger_audit_row();
CREATE TRIGGER ledger_audit_row AFTER INSERT OR UPDATE OR DELETE ON "FixedAsset" FOR EACH ROW EXECUTE FUNCTION ledger_audit_row();
CREATE TRIGGER ledger_audit_row AFTER INSERT OR UPDATE OR DELETE ON "FixedAssetEvent" FOR EACH ROW EXECUTE FUNCTION ledger_audit_row();
CREATE TRIGGER ledger_audit_row AFTER INSERT OR UPDATE OR DELETE ON "FixedAssetDepreciationRun" FOR EACH ROW EXECUTE FUNCTION ledger_audit_row();
CREATE TRIGGER ledger_audit_row AFTER INSERT OR UPDATE OR DELETE ON "FixedAssetDepreciationLine" FOR EACH ROW EXECUTE FUNCTION ledger_audit_row();
CREATE TRIGGER ledger_audit_row AFTER INSERT OR UPDATE OR DELETE ON "FixedAssetAddition" FOR EACH ROW EXECUTE FUNCTION ledger_audit_row();
CREATE TRIGGER ledger_audit_row AFTER INSERT OR UPDATE OR DELETE ON "FixedAssetDisposal" FOR EACH ROW EXECUTE FUNCTION ledger_audit_row();

-- 1 (seed) / 7 ──────────────────────────────────────────────────────────────────────────────────
-- The seven default categories (editable; their lives and residual values are the council's defaults — the owner's
-- accountant confirms them per asset). Their cost account only when the default chart is there.
INSERT INTO "FixedAssetCategory" ("id", "code", "nameAr", "nameEn", "usefulLifeMonths", "method", "residualPercent", "isLeasehold", "costAccountId", "sortOrder", "createdBy", "updatedBy")
SELECT 'fac_' || lower(v.code), v.code, v.ar, v.en, v.life, 'STRAIGHT_LINE', v.res, v.code = 'LEASEHOLD',
       (SELECT a."id" FROM "Account" a WHERE a."code" = v.acc AND a."type"::text = 'ASSET' AND a."allowPosting" AND a."isActive"), v.ord, 'migration', 'migration'
  FROM (VALUES ('ROASTERS', 'مكائن التحميص', 'Roasting machines', 120, 10.00, '1210', 1),
               ('GRINDERS', 'المطاحن', 'Grinders', 60, 5.00, '1210', 2),
               ('CAFE_EQUIPMENT', 'معدات المقهى', 'Café equipment', 60, 5.00, '1210', 3),
               ('VEHICLES', 'السيارات', 'Vehicles', 60, 20.00, '1240', 4),
               ('FURNITURE', 'الأثاث والتجهيزات', 'Furniture & fixtures', 60, 0.00, '1230', 5),
               ('IT_EQUIPMENT', 'أجهزة الحاسب وتقنية المعلومات', 'IT equipment', 36, 0.00, '1230', 6),
               ('LEASEHOLD', 'تحسينات المباني المستأجرة', 'Leasehold improvements', 60, 0.00, '1220', 7)) v(code, ar, en, life, res, acc, ord);

DO $$
DECLARE r record; p text; a text;
BEGIN
  -- FA_DISPOSAL_GAIN_LOSS → 7300 under 7000 (other income and expenses: IAS 16.68, a gain is not revenue).
  IF NOT EXISTS (SELECT 1 FROM "Account" WHERE "code" = '7300') THEN
    SELECT "id" INTO p FROM "Account" WHERE "code" = '7000';
    IF p IS NOT NULL THEN
      INSERT INTO "Account" ("id", "code", "nameAr", "nameEn", "parentId", "type", "allowPosting", "isActive", "allowManualJournal", "createdBy", "updatedBy", "updatedAt")
      VALUES ('acc_' || replace(gen_random_uuid()::text, '-', ''), '7300', 'أرباح وخسائر استبعاد الأصول الثابتة', 'Gain / loss on disposal of fixed assets', p, 'EXPENSE', true, true, true, 'migration', 'migration', now());
    END IF;
  END IF;
  FOR r IN SELECT * FROM (VALUES ('FA_COST', '1210', 'ASSET'), ('FA_ACCUMULATED_DEPRECIATION', '1290', 'ASSET'),
                                 ('FA_DEPRECIATION_EXPENSE', '6600', 'EXPENSE'), ('FA_DISPOSAL_GAIN_LOSS', '7300', 'EXPENSE')) v(role, code, ty) LOOP
    IF NOT EXISTS (SELECT 1 FROM "AccountRole" WHERE "tenantId" = 'hiqbah' AND "role" = r.role) THEN
      a := NULL;
      SELECT "id" INTO a FROM "Account" WHERE "code" = r.code AND "type"::text = r.ty AND "allowPosting" AND "isActive";
      IF a IS NOT NULL THEN
        INSERT INTO "AccountRole" ("id", "tenantId", "role", "accountId", "updatedBy", "updatedAt") VALUES ('ar_' || replace(gen_random_uuid()::text, '-', ''), 'hiqbah', r.role, a, 'migration', now());
      END IF;
    END IF;
  END LOOP;
END $$;

-- 8 ─────────────────────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'flowcom_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "FixedAssetCategory", "FixedAsset", "FixedAssetEvent", "FixedAssetDepreciationRun",
      "FixedAssetDepreciationLine", "FixedAssetAddition", "FixedAssetDisposal" TO flowcom_app;
    GRANT EXECUTE ON FUNCTION fixed_asset_no_delete(), fixed_asset_guard(), fixed_asset_books_check(), fixed_asset_invoice_guard() TO flowcom_app;
  END IF;
END $$;

COMMIT;
