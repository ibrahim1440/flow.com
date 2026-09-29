-- Stage 6: exemption / zero-rating reason code and text on tax categories (nullable; additive).
ALTER TABLE "TaxCategory" ADD COLUMN "zatcaExemptionCode" TEXT, ADD COLUMN "zatcaExemptionReason" TEXT;
