-- One sales collection <-> one bank line (active links only; removed links stay as history).
CREATE UNIQUE INDEX "BankTransactionMatch_collection_once"
  ON "BankTransactionMatch" ("targetId") WHERE "active" AND "targetType" = 'SALES_COLLECTION';
CREATE UNIQUE INDEX "BankTransactionMatch_line_one_collection"
  ON "BankTransactionMatch" ("transactionId") WHERE "active" AND "targetType" = 'SALES_COLLECTION';
