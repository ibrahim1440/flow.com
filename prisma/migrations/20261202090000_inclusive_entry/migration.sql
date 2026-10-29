-- «شامل؟» — VAT-inclusive price entry, converted ON THE SERVER (batch 22 WP-K, BATCH22-DESIGN §1 ruling and §2 WP-K).
-- ADDITIVE ONLY, one transaction (PostgreSQL 16 / 17): two columns and two CHECKs on each of two existing tables; every
-- existing row reads as "not inclusive" (the defaults), so no row is rewritten beyond the defaulted column and no
-- existing CHECK or trigger changes.
--
--   1. "SalesInvoiceLine"."priceIncludesVat" (false) and "enteredGrossUnitPrice" (numeric(18,2), NULL): the unit price the
--      user typed VAT-inclusive, kept for audit. The line still stores the NET unit price (2 dp) the E-10 arithmetic and
--      sinv_invoice_guard use: unitPrice = round_half_up(gross ÷ (1 + rate), 2) — a line out of step with its typed
--      gross is refused (SalesInvoiceLine_inclusive_check). For a 0 % line (Z / E / O) the gross IS the net. VAT stays
--      rounded once per (category, rate) on the document total: no plug line.
--   2. "SupplierInvoiceLine"."priceIncludesVat" (false) and "grossEntered" (numeric(18,2), NULL): the supplier's gross G
--      typed from the paper invoice. Net = round(G ÷ (1 + r), 2) and VAT = G − net, the VAT adjustable by ±0.01 to match the
--      paper (net then G − VAT); the line's gross is G and |VAT − round(net × r)| ≤ 0.01 (SupplierInvoiceLine_inclusive_check).
-- The two flags come with their figure (…_inclusive_pair_check). Verifier check 70.
-- Rollback: docs/hr/migration-review/rollback-20261202090000_inclusive_entry.sql.
BEGIN;

ALTER TABLE "SalesInvoiceLine" ADD COLUMN "priceIncludesVat" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "SalesInvoiceLine" ADD COLUMN "enteredGrossUnitPrice" DECIMAL(18,2);
ALTER TABLE "SalesInvoiceLine" ADD CONSTRAINT "SalesInvoiceLine_inclusive_pair_check" CHECK ("priceIncludesVat" = ("enteredGrossUnitPrice" IS NOT NULL));
ALTER TABLE "SalesInvoiceLine" ADD CONSTRAINT "SalesInvoiceLine_inclusive_check" CHECK (NOT "priceIncludesVat"
  OR ("enteredGrossUnitPrice" >= 0 AND "unitPrice" = round("enteredGrossUnitPrice" * 100 / (100 + "taxRatePercent"), 2)));

ALTER TABLE "SupplierInvoiceLine" ADD COLUMN "priceIncludesVat" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "SupplierInvoiceLine" ADD COLUMN "grossEntered" DECIMAL(18,2);
ALTER TABLE "SupplierInvoiceLine" ADD CONSTRAINT "SupplierInvoiceLine_inclusive_pair_check" CHECK ("priceIncludesVat" = ("grossEntered" IS NOT NULL));
ALTER TABLE "SupplierInvoiceLine" ADD CONSTRAINT "SupplierInvoiceLine_inclusive_check" CHECK (NOT "priceIncludesVat"
  OR ("grossEntered" = "gross" AND abs("vat" - round("net" * "vatRate" / 100, 2)) <= 0.01));

COMMIT;
