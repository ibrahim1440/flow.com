import "dotenv/config";
import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: process.env.DATABASE_URL || "file:./prisma/dev.db",
    // DIRECT_URL: non-pooler Neon connection used by Prisma CLI for migrations.
    // DATABASE_URL must remain the pooler URL for runtime (pg.Pool in db.ts).
    ...(process.env.DIRECT_URL ? { directUrl: process.env.DIRECT_URL } : {}),
  },
});
