-- CreateEnum
CREATE TYPE "PipelineStagePurpose" AS ENUM ('QUALIFICATION', 'QUOTATION');

-- AlterTable
ALTER TABLE "PipelineStage" ADD COLUMN     "purpose" "PipelineStagePurpose";

-- CreateIndex
CREATE UNIQUE INDEX "PipelineStage_purpose_key" ON "PipelineStage"("purpose");
