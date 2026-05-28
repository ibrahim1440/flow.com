-- CreateTable
CREATE TABLE "CuppingSession" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" TEXT NOT NULL DEFAULT 'Open',
    "batchId" TEXT,
    "greenBeanId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CuppingSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CuppingScore" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "employeeId" TEXT,
    "externalName" TEXT,
    "fragranceAroma" DOUBLE PRECISION NOT NULL DEFAULT 7,
    "flavor" DOUBLE PRECISION NOT NULL DEFAULT 7,
    "aftertaste" DOUBLE PRECISION NOT NULL DEFAULT 7,
    "acidity" DOUBLE PRECISION NOT NULL DEFAULT 7,
    "body" DOUBLE PRECISION NOT NULL DEFAULT 7,
    "balance" DOUBLE PRECISION NOT NULL DEFAULT 7,
    "uniformity" DOUBLE PRECISION NOT NULL DEFAULT 10,
    "cleanCup" DOUBLE PRECISION NOT NULL DEFAULT 10,
    "sweetness" DOUBLE PRECISION NOT NULL DEFAULT 10,
    "overall" DOUBLE PRECISION NOT NULL DEFAULT 7,
    "defectCups" INTEGER NOT NULL DEFAULT 0,
    "defectType" TEXT NOT NULL DEFAULT 'none',
    "finalScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "notes" TEXT,
    "flavorDescriptors" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CuppingScore_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "CuppingSession" ADD CONSTRAINT "CuppingSession_batchId_fkey"
    FOREIGN KEY ("batchId") REFERENCES "RoastingBatch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CuppingSession" ADD CONSTRAINT "CuppingSession_greenBeanId_fkey"
    FOREIGN KEY ("greenBeanId") REFERENCES "GreenBean"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CuppingScore" ADD CONSTRAINT "CuppingScore_sessionId_fkey"
    FOREIGN KEY ("sessionId") REFERENCES "CuppingSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CuppingScore" ADD CONSTRAINT "CuppingScore_employeeId_fkey"
    FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE SET NULL ON UPDATE CASCADE;
