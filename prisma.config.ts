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
    // DIRECT_URL: non-pooler Neon connection used by Prisma CLI for migrations.
    // DATABASE_URL must remain the pooler URL for runtime (pg.Pool in db.ts).
    ...(process.env.DIRECT_URL ? { directUrl: process.env.DIRECT_URL } : {}),
  },
});
