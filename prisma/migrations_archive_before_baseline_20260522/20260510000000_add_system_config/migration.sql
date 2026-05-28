-- CreateTable
CREATE TABLE "SystemConfig" (
    "id" TEXT NOT NULL,
    "logoBase64" TEXT,
    CONSTRAINT "SystemConfig_pkey" PRIMARY KEY ("id")
);

-- Seed singleton row
INSERT INTO "SystemConfig" ("id") VALUES ('singleton');
