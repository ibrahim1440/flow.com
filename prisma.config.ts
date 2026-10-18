import "dotenv/config";
import { defineConfig } from "prisma/config";
import { requireDatabaseUrl } from "./src/lib/db-config";

// The CLI carried the same silent SQLite fallback the runtime did:
//   url: process.env.DATABASE_URL || "file:./prisma/dev.db"
// which meant a Prisma command run without an environment — a stray `migrate status`,
// a `generate` in a misconfigured shell — addressed a different database engine
// entirely and reported confidently about it. The schema and migration lock are both
// pinned to postgresql, so that answer was never meaningful; it was only quiet.
//
// DIRECT_URL is validated by the explicit migration command (scripts/migrate-deploy.mjs)
// rather than here, so that `prisma generate` still runs in a build environment which
// holds no migration credential and has no business holding one.
export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: requireDatabaseUrl(process.env),
    // NOTE (P-4 retest P1-1): Prisma 7.8 ignores directUrl — the CLI uses `url` (DATABASE_URL).
    // Migrations therefore run through scripts/migrate-deploy.mjs, which passes DIRECT_URL as the
    // CLI's DATABASE_URL, and every other CLI command is run as DATABASE_URL="$DIRECT_URL" npx prisma …
    // (RUNBOOK §6 / §10). DATABASE_URL stays the pooler URL for the runtime (pg.Pool in db.ts).
    ...(process.env.DIRECT_URL ? { directUrl: process.env.DIRECT_URL } : {}),
  },
});
