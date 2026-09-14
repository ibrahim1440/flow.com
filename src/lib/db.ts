import { PrismaClient } from "@/generated/prisma/client";
import { requireDatabaseUrl } from "./db-config";

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient };

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
 *
 * ── Why this is also the CLIENT-LEVEL default ──────────────────────────────
 * Passing it per call reached only the transactions that remembered to pass it. The
 * ARRAY form of $transaction cannot be given options at all — it accepts an isolation
 * level and nothing else — so every array-form transaction in this application was
 * still running on Prisma's 5 000 ms LAN-shaped default no matter what this constant
 * said. The destructive resets are exactly that shape: twenty sequential deleteMany
 * calls, which cost about 3.3 s in round trips before the database deletes a single
 * row, and they duly failed with P2028 at 5 679 ms once the dataset grew — a factory
 * reset that dies half way and returns a 500.
 *
 * Setting it on the client makes the budget a property of the deployment rather than
 * something each call site has to remember, which is what it always should have been.
 * It raises a ceiling; it changes no semantics, and a genuinely stuck transaction still
 * fails rather than pinning a connection forever.
 */
export const TX_OPTS = { timeout: 30_000, maxWait: 10_000 } as const;

function createPrismaClient() {
  // Throws if DATABASE_URL is absent, malformed, or not PostgreSQL. This module is
  // imported by every route, so the failure surfaces at startup rather than as a
  // silent redirection to a scratch database — see db-config.ts for why the old
  // SQLite fallback is gone rather than gated.
  const url = requireDatabaseUrl(process.env);

  const { Pool } = require("pg");
  const { PrismaPg } = require("@prisma/adapter-pg");
  const pool = new Pool({
    connectionString: url,
    max: 10,
    // Opening a connection to this database costs about a second — measured at
    // 992-1067 ms across repeated trials, almost all of it TLS and session setup, while
    // a query on an already-open connection costs about 167 ms. At a 10-second idle
    // timeout every pause longer than a coffee-machine glance threw the connection away,
    // so the operator's next click paid that second again before any work started.
    //
    // Five minutes spans normal think-time between actions while still returning
    // connections during a genuinely quiet period. The ceiling of 10 bounds what is
    // held open regardless.
    idleTimeoutMillis: 300_000,
    connectionTimeoutMillis: 5000,
  });
  const adapter = new PrismaPg(pool);
  // Opt-in query tracing, off unless ERP_QUERY_LOG is set. Performance work on this
  // deployment is about the NUMBER of sequential round trips rather than the cost of
  // any single query, and that is not something you can reason about from the outside:
  // pg_stat_statements is database-wide, so it cannot attribute queries to one request.
  // This prints each statement with its duration so a single request can be profiled
  // for what it actually does.
  if (process.env.ERP_QUERY_LOG) {
    const client = new PrismaClient({
      adapter,
      transactionOptions: TX_OPTS,
      log: [{ emit: "event", level: "query" }],
    });
    (client as unknown as { $on: (e: "query", cb: (q: { query: string; duration: number }) => void) => void })
      .$on("query", (q) => {
        console.log(`[q] ${String(q.duration).padStart(5)}ms  ${q.query.replace(/\s+/g, " ").slice(0, 110)}`);
      });
    return client;
  }
  return new PrismaClient({ adapter, transactionOptions: TX_OPTS });
}

export const prisma = globalForPrisma.prisma ?? createPrismaClient();

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
