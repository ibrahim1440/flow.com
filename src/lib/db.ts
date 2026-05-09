import path from "path";
import { PrismaClient } from "@/generated/prisma/client";
import { PrismaLibSql } from "@prisma/adapter-libsql";

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient };

function createPrismaClient() {
  const raw = process.env.DATABASE_URL ?? "";
  // Resolve relative file: URLs to absolute so libSQL can find the file
  const url = raw.startsWith("file:./") || raw.startsWith("file:../")
    ? `file:${path.resolve(raw.slice(5))}`
    : raw || `file:${path.resolve("prisma/dev.db")}`;

  // PrismaLibSql is a factory — pass the config object, not a pre-created client
  const adapter = new PrismaLibSql({ url });
  return new PrismaClient({ adapter });
}

export const prisma = globalForPrisma.prisma ?? createPrismaClient();

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
