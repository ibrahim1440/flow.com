import { PrismaClient } from "@/generated/prisma/client";

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient };

function createPrismaClient() {
  const url = process.env.DATABASE_URL ?? "";

  if (url.startsWith("postgresql://") || url.startsWith("postgres://")) {
    const { Pool } = require("pg");
    const { PrismaPg } = require("@prisma/adapter-pg");
    const pool = new Pool({
      connectionString: url,
      max: 10,
      idleTimeoutMillis: 10000,
      connectionTimeoutMillis: 5000,
    });
    const adapter = new PrismaPg(pool);
    return new PrismaClient({ adapter });
  }

  // Local SQLite via libSQL
  const path = require("path");
  const { PrismaLibSql } = require("@prisma/adapter-libsql");
  const resolvedUrl = url.startsWith("file:./") || url.startsWith("file:../")
    ? `file:${path.resolve(url.slice(5))}`
    : url || `file:${path.resolve("prisma/dev.db")}`;
  const adapter = new PrismaLibSql({ url: resolvedUrl });
  return new PrismaClient({ adapter });
}

export const prisma = globalForPrisma.prisma ?? createPrismaClient();

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;

/**
 * Transaction budget for the multi-step operational writes.
 *
 * Prisma's default interactive-transaction timeout is 5 000 ms, which assumes a database
 * on the same machine. This deployment talks to Neon over the public internet: a measured
 * round-trip is ~167 ms, so a transaction that walks a variable number of rows — a
 * preparation review reserving across several finished-goods lots, a delivery consuming
 * several allocations, packaging exploding a bill of materials — spends almost all of its
 * budget waiting on the wire. A review of 95 units spread over 10 lots measured 5 560 ms
 * and died with Prisma P2028 ("query cannot be executed on an expired transaction"),
 * returning HTTP 500 on a perfectly ordinary order.
 *
 * The work itself is legitimate and must stay in one transaction, so the fix is to give
 * these transactions a budget that matches the deployment rather than to split them and
 * lose atomicity. 30 s is far above the worst case measured and still bounded, so a
 * genuinely stuck transaction still fails rather than pinning a connection forever.
 *
 * `maxWait` is how long to wait for a connection from the pool before starting.
 */
export const TX_OPTS = { timeout: 30_000, maxWait: 10_000 } as const;
