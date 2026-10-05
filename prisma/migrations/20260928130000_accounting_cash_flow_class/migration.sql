-- CreateEnum
CREATE TYPE "CashFlowClass" AS ENUM ('CASH', 'OPERATING', 'INVESTING', 'FINANCING', 'EXCLUDED');

-- AlterTable
ALTER TABLE "Account" ADD COLUMN     "cashFlowClass" "CashFlowClass";

