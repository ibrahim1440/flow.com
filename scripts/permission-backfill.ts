/**
 * One-time permission backfill.
 *
 * For every employee whose permissions JSON is missing sub-keys that now exist in
 * MODULE_SUB_PRIVILEGES, writes the missing keys explicitly:
 *   - access === "edit"  → missing key written as true  (preserves current effective access)
 *   - access === "view"  → missing key written as false (deny; view has no sub-privilege meaning)
 *   - access === "none"  → skipped entirely
 *   - perm.sub missing entirely → creates sub object with all keys set per above rule
 *
 * This makes all permissions explicit before hasSubPrivilege is flipped to deny-by-default,
 * so existing users do not lose access they currently rely on.
 *
 * Run permission-impact-report.ts first to confirm what this will change.
 *
 * IDEMPOTENT: safe to re-run. Already-explicit sub-keys are never overwritten.
 * Only writes to the DB when at least one key was genuinely missing.
 *
 * Run: npx tsx scripts/permission-backfill.ts
 */

import "dotenv/config";
import path from "path";
import { PrismaClient } from "../src/generated/prisma/client";

// Mirror the adapter detection in src/lib/db.ts so this script works against
// both the Neon PostgreSQL production DB and the local SQLite dev DB.
function createPrismaClient(): PrismaClient {
  const url = process.env.DATABASE_URL ?? "";
  if (url.startsWith("postgresql://") || url.startsWith("postgres://")) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Pool } = require("pg");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { PrismaPg } = require("@prisma/adapter-pg");
    const pool = new Pool({ connectionString: url });
    const adapter = new PrismaPg(pool);
    return new PrismaClient({ adapter });
  }
  // Local SQLite via libSQL
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { PrismaLibSql } = require("@prisma/adapter-libsql");
  const resolvedUrl =
    url.startsWith("file:./") || url.startsWith("file:../")
      ? `file:${path.resolve(url.slice(5))}`
      : url || `file:${path.resolve("prisma/dev.db")}`;
  const adapter = new PrismaLibSql({ url: resolvedUrl });
  return new PrismaClient({ adapter });
}

// Keep in sync with src/lib/auth-shared.ts MODULE_SUB_PRIVILEGES manually when sub-privileges are added.
const MODULE_SUB_PRIVILEGES: Record<string, { key: string }[]> = {
  inventory: [
    { key: "receive" },
    { key: "adjust" },
    { key: "override" },
  ],
  orders: [
    { key: "create" },
    { key: "edit" },
    { key: "delete" },
  ],
  production: [
    { key: "start_batch" },
    { key: "blend" },
    { key: "view_history" },
    { key: "cancel_batch" },
    { key: "edit_date" },
  ],
  qc: [
    { key: "create_record" },
    { key: "edit_record" },
    { key: "view_records" },
    { key: "manage" },
  ],
  dispatch: [
    { key: "mark_delivered" },
  ],
  labels: [
    { key: "print" },
  ],
  employees: [
    { key: "create" },
    { key: "edit" },
  ],
  settings: [
    { key: "reset" },
  ],
  customers: [
    { key: "manage" },
  ],
};

type AccessLevel = "none" | "view" | "edit";
type ModulePermission = { access: AccessLevel; sub?: Record<string, boolean> };
type Permissions = Record<string, ModulePermission>;

/**
 * Merges missing sub-keys into a single ModulePermission entry.
 * Returns the updated permission and whether any key was actually added.
 * Never overwrites a key that already exists.
 */
function mergeSubKeys(
  perm: ModulePermission,
  subs: { key: string }[],
): { changed: boolean; perm: ModulePermission } {
  if (perm.access === "none") return { changed: false, perm };

  const grantValue = perm.access === "edit"; // true for edit, false for view
  const existing = perm.sub ?? {};
  const merged: Record<string, boolean> = { ...existing };
  let changed = false;

  for (const sub of subs) {
    if (!(sub.key in merged)) {
      merged[sub.key] = grantValue;
      changed = true;
    }
    // Already present — never overwrite, even if the value differs from grantValue.
  }

  if (!changed) return { changed: false, perm };
  return { changed: true, perm: { ...perm, sub: merged } };
}

async function main() {
  const prisma = createPrismaClient();
  let updatedCount = 0;
  let skippedCount = 0;
  let errorCount = 0;

  try {
    const employees = await prisma.employee.findMany({
      select: { id: true, name: true, role: true, permissions: true },
      orderBy: { name: "asc" },
    });

    console.log("\n╔══════════════════════════════════════════════════════════════╗");
    console.log("║             PERMISSION BACKFILL (EXPLICIT SUB-KEYS)         ║");
    console.log("╚══════════════════════════════════════════════════════════════╝\n");
    console.log(`Employees to process: ${employees.length}\n`);

    for (const emp of employees) {
      const raw = (emp.permissions as string | null) ?? "{}";

      // Skip empty permissions — the login fallback (buildDefaultPermissions) handles these
      // and will write full explicit sub-keys on next login. No backfill needed.
      if (!raw || raw.trim() === "" || raw.trim() === "{}") {
        console.log(`  SKIP  ${emp.name} (${emp.role}): empty permissions — login fallback handles this`);
        skippedCount++;
        continue;
      }

      let perms: Permissions;
      try {
        perms = JSON.parse(raw);
      } catch {
        console.log(`  SKIP  ${emp.name} (${emp.role}): malformed JSON — will remain unchanged`);
        errorCount++;
        continue;
      }

      if (Object.keys(perms).length === 0) {
        console.log(`  SKIP  ${emp.name} (${emp.role}): empty permissions object — login fallback handles this`);
        skippedCount++;
        continue;
      }

      let anyChange = false;
      const nextPerms: Permissions = { ...perms };

      for (const [module, subs] of Object.entries(MODULE_SUB_PRIVILEGES)) {
        const perm = nextPerms[module];
        if (!perm) continue; // module not present in this employee's permissions — skip
        const { changed, perm: merged } = mergeSubKeys(perm, subs);
        if (changed) {
          nextPerms[module] = merged;
          anyChange = true;
        }
      }

      if (!anyChange) {
        console.log(`  OK    ${emp.name} (${emp.role}): all sub-keys already explicit`);
        skippedCount++;
        continue;
      }

      await prisma.employee.update({
        where: { id: emp.id },
        data: { permissions: JSON.stringify(nextPerms) },
      });

      // Log which keys were added for this employee
      const addedKeys: string[] = [];
      for (const [module, subs] of Object.entries(MODULE_SUB_PRIVILEGES)) {
        const before = perms[module];
        const after  = nextPerms[module];
        // Skip missing modules and "none"-access modules — no keys are added for those.
        if (!before || !after || before.access === "none") continue;
        for (const sub of subs) {
          const wasAbsent = !before.sub || !(sub.key in before.sub);
          if (wasAbsent && after.sub) {
            addedKeys.push(`${module}.${sub.key}=${after.sub[sub.key]}`);
          }
        }
      }
      console.log(`  FIXED ${emp.name} (${emp.role}): added ${addedKeys.join(", ")}`);
      updatedCount++;
    }

    console.log("\n──────────────────────────────────────────────────────────────");
    console.log(`Updated : ${updatedCount}`);
    console.log(`Skipped : ${skippedCount}`);
    if (errorCount > 0) {
      console.log(`Errors  : ${errorCount} (malformed JSON — manual review required)`);
    }
    console.log();

    if (updatedCount > 0) {
      console.log("Next step: re-run permission-impact-report.ts to confirm 0 auto-grant rows remain,");
      console.log("           then apply the hasSubPrivilege deny-by-default patch.\n");
    } else {
      console.log("No changes made. All permissions were already explicit.\n");
    }

  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error("Backfill failed:", err);
  process.exit(1);
});
