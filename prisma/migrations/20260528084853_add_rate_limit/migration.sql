-- CreateTable
CREATE TABLE "RateLimit" (
    "id" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "keyHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RateLimit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RateLimit_scope_keyHash_createdAt_idx" ON "RateLimit"("scope", "keyHash", "createdAt");

-- CreateIndex
CREATE INDEX "RateLimit_createdAt_idx" ON "RateLimit"("createdAt");
