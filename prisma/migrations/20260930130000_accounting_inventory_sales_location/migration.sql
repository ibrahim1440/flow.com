-- The location cost of sales is taken from when a sales invoice posts (at most one location).
ALTER TABLE "InvLocation" ADD COLUMN "isSalesDefault" BOOLEAN NOT NULL DEFAULT false;
CREATE UNIQUE INDEX "InvLocation_one_sales_default" ON "InvLocation" ("isSalesDefault") WHERE "isSalesDefault";
