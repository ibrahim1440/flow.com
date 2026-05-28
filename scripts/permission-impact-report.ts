/**
 * Dry-run permission impact report.
 *
 * Identifies every employee/module/subKey that currently receives access via
 * hasSubPrivilege's auto-grant fallback (missing subKey + module access = "edit").
 * These employees would lose that sub-privilege if hasSubPrivilege is changed to deny-by-default.
 *
 * SAFE: read-only. Does not write to the database. Does not change runtime behavior.
 *
 * Run: npx tsx scripts/permission-impact-report.ts
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

// MODULE_SUB_PRIVILEGES inlined to avoid importing server-only code.
// Keep in sync with src/lib/auth-shared.ts MODULE_SUB_PRIVILEGES manually when sub-privileges are added.
const MODULE_SUB_PRIVILEGES: Record<string, { key: string; label: string }[]> = {
  inventory: [
    { key: "receive",  label: "Receive new beans" },
    { key: "adjust",   label: "Edit / adjust stock" },
    { key: "override", label: "Override inventory (force restock cancelled batches)" },
  ],
  orders: [
    { key: "create", label: "Create new orders" },
    { key: "edit",   label: "Edit existing orders" },
    { key: "delete", label: "Delete orders" },
  ],
  production: [
    { key: "start_batch",  label: "Start / continue roasting" },
    { key: "blend",        label: "Blend batches" },
    { key: "view_history", label: "View completed batches" },
    { key: "cancel_batch", label: "Cancel / delete batches" },
    { key: "edit_date",    label: "Edit batch date (retroactive)" },
  ],
  qc: [
    { key: "create_record", label: "Submit QC records" },
    { key: "edit_record",   label: "Edit QC records" },
    { key: "view_records",  label: "View QC history" },
    { key: "manage",        label: "Finalize QC panel / generate guest links" },
  ],
  dispatch: [
    { key: "mark_delivered", label: "Mark as delivered" },
  ],
  labels: [
    { key: "print", label: "Generate / print labels" },
  ],
  employees: [
    { key: "create", label: "Add employees" },
    { key: "edit",   label: "Edit employee permissions" },
  ],
  settings: [
    { key: "reset", label: "Factory reset (wipe all data)" },
  ],
  customers: [
    { key: "manage", label: "Manage customer roast preferences" },
  ],
};

type AccessLevel = "none" | "view" | "edit";
type ModulePermission = { access: AccessLevel; sub?: Record<string, boolean> };
type Permissions = Record<string, ModulePermission>;

function parsePermissions(raw: string): Permissions {
  if (!raw || raw.trim() === "") return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

type ImpactRow = {
  employeeId:   string;
  employeeName: string;
  role:         string;
  module:       string;
  subKey:       string;
  subLabel:     string;
  reason:       string;
};

async function main() {
  const prisma = createPrismaClient();

  try {
    const employees = await prisma.employee.findMany({
      select: { id: true, name: true, role: true, permissions: true },
      orderBy: { name: "asc" },
    });

    const impacted: ImpactRow[] = [];
    let emptyPermCount = 0;

    for (const emp of employees) {
      const raw = (emp.permissions as string | null) ?? "{}";
      const perms = parsePermissions(raw);

      // If permissions are empty/invalid, the login fallback applies buildDefaultPermissions(role)
      // which writes all sub-keys explicitly. These employees are NOT impacted by the flip.
      if (Object.keys(perms).length === 0) {
        emptyPermCount++;
        continue;
      }

      for (const [module, subs] of Object.entries(MODULE_SUB_PRIVILEGES)) {
        const perm = perms[module];
        if (!perm || perm.access !== "edit") continue; // not edit — not affected by auto-grant

        for (const sub of subs) {
          const subObject = perm.sub;
          const keyMissing = !subObject || !(sub.key in subObject);

          if (keyMissing) {
            let reason: string;
            if (!subObject) {
              reason = "perm.sub is undefined";
            } else {
              reason = `key "${sub.key}" absent from perm.sub`;
            }
            impacted.push({
              employeeId:   emp.id,
              employeeName: emp.name,
              role:         emp.role,
              module,
              subKey:       sub.key,
              subLabel:     sub.label,
              reason,
            });
          }
        }
      }
    }

    // ── Output ──────────────────────────────────────────────────────────────

    console.log("\n╔══════════════════════════════════════════════════════════════╗");
    console.log("║        PERMISSION AUTO-GRANT IMPACT REPORT (DRY RUN)        ║");
    console.log("╚══════════════════════════════════════════════════════════════╝\n");
    console.log(`Total employees scanned  : ${employees.length}`);
    console.log(`Empty permissions (safe) : ${emptyPermCount}`);
    console.log(`Employees with explicit JSON: ${employees.length - emptyPermCount}`);
    console.log(`Auto-grant rows found    : ${impacted.length}\n`);

    if (impacted.length === 0) {
      console.log("✓ No employees rely on the auto-grant fallback.");
      console.log("  Safe to flip hasSubPrivilege to deny-by-default.\n");
      return;
    }

    console.log("⚠  The following employees CURRENTLY receive access by auto-grant fallback.");
    console.log("   They would LOSE this sub-privilege after switching to deny-by-default.\n");

    // Group by employee for readability
    const byEmployee = new Map<string, ImpactRow[]>();
    for (const row of impacted) {
      if (!byEmployee.has(row.employeeId)) byEmployee.set(row.employeeId, []);
      byEmployee.get(row.employeeId)!.push(row);
    }

    for (const [, rows] of byEmployee) {
      const first = rows[0];
      console.log(`  Employee : ${first.employeeName}`);
      console.log(`  ID       : ${first.employeeId}`);
      console.log(`  Role     : ${first.role}`);
      console.log(`  Affected sub-privileges:`);
      for (const row of rows) {
        console.log(`    • ${row.module}.${row.subKey}  (${row.subLabel})`);
        console.log(`      Reason: ${row.reason}`);
      }
      console.log();
    }

    // Summary table
    const moduleCounts = new Map<string, number>();
    for (const row of impacted) {
      moduleCounts.set(row.module, (moduleCounts.get(row.module) ?? 0) + 1);
    }
    console.log("── Module impact counts ───────────────────────────────────────");
    for (const [mod, count] of [...moduleCounts.entries()].sort()) {
      console.log(`  ${mod.padEnd(14)} ${count} affected row(s)`);
    }
    console.log();
    console.log("Action: run the backfill (scripts/permission-backfill.ts) before");
    console.log("        flipping hasSubPrivilege to deny-by-default, OR accept");
    console.log("        that impacted employees will lose the listed sub-privileges.\n");

  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error("Script failed:", err);
  process.exit(1);
});
