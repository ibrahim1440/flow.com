/**
 * What the ACTUAL reviewer accounts can do, read from the preview database.
 *
 * Not the `NAV_`/`COL_` synthetic fixtures and not the `ROLES` definitions those are built
 * from — the stored `permissions` on the real `RVW_` rows, which is the only thing the
 * running application reads. A role provisioned before a privilege existed simply lacks the
 * key, and the definition it was built from will not say so.
 *
 * Read-only. Prints the effective ability set, the navigation each account is served, and
 * the collection decision verdict for a given collection.
 *
 *   PREVIEW_ENV=<app env file> npx tsx scripts/sales-preview/reviewer-audit.ts [collectionId]
 */
import { readFileSync } from "node:fs";
import { Client } from "pg";
import { visibleNav, routeAllowed, type NavNode, type Viewer } from "@/lib/nav/registry";
import { collectionDecisionAbility } from "@/lib/services/sales/collections";
import { collectionScope } from "@/lib/services/sales/scope";
import { hasModuleAccess, hasSubPrivilege, type Permissions } from "@/lib/auth-shared";

const ENVFILE = process.env.PREVIEW_ENV;
if (!ENVFILE) { console.error("REFUSE: PREVIEW_ENV is not set."); process.exit(3); }
const env: Record<string, string> = {};
for (const line of readFileSync(ENVFILE, "utf8").split(/\r?\n/)) {
  const t = line.trim();
  if (!t || t.startsWith("#")) continue;
  const i = t.indexOf("=");
  if (i > 0) env[t.slice(0, i).trim()] = t.slice(i + 1).trim().replace(/^["']|["']$/g, "");
}
const url = env.DATABASE_URL;
if (!url) { console.error("REFUSE: DATABASE_URL missing"); process.exit(3); }
const u = new URL(url);
if (!u.hostname.startsWith("ep-wandering-leaf-aqjtuin5") || u.pathname.replace(/^\//, "") !== "sales_preview") {
  console.error("REFUSE: not the approved preview database"); process.exit(3);
}

/** The abilities that actually decide anything in this module. */
const WATCHED: [string, string | null][] = [
  ["sales", null], ["commissions", null], ["orders", null], ["customers", null],
  ["sales", "collection_submit"], ["sales", "collection_view_team"], ["sales", "stage_manage"],
  ["commissions", "view_own"], ["commissions", "view_team"], ["commissions", "manage_plans"],
  ["commissions", "approve"], ["commissions", "record_payout"],
  ["commissions", "collection_verify"], ["commissions", "collection_reject"],
  ["commissions", "collection_reverse"],
];

function flatten(tree: NavNode[], trail: string[] = []): string[] {
  const out: string[] = [];
  for (const n of tree) {
    if (n.href) out.push(`${[...trail, n.ar].join(" › ")}  →  ${n.href}`);
    if (n.children) out.push(...flatten(n.children, [...trail, n.ar]));
  }
  return out;
}

async function main() {
  const c = new Client({ connectionString: url });
  await c.connect();
  try {
    const rows = (await c.query<{ id: string; name: string; role: string; active: boolean; permissions: unknown }>(
      `SELECT id, name, role, active, permissions FROM "Employee" WHERE id LIKE 'RVW\\_%' ORDER BY id`,
    )).rows;
    if (rows.length === 0) { console.log("No RVW_ reviewer accounts found."); return; }

    const target = process.argv[2];
    let collection: { id: string; status: string; submittedById: string; gross: string } | null = null;
    if (target) {
      collection = (await c.query(
        `SELECT id, status::text AS status, "submittedById", "amountGross"::text AS gross
           FROM "SalesCollection" WHERE id = $1`, [target],
      )).rows[0] ?? null;
    }

    for (const r of rows) {
      const permissions = (typeof r.permissions === "string"
        ? JSON.parse(r.permissions) : r.permissions) as Permissions;
      const v: Viewer = { permissions, role: r.role };

      console.log("\n" + "═".repeat(78));
      console.log(`${r.name}   (${r.id})   role=${r.role}   active=${r.active}`);
      console.log("═".repeat(78));

      console.log("\nEffective abilities");
      for (const [mod, sub] of WATCHED) {
        const held = sub ? hasSubPrivilege(permissions, mod, sub) : hasModuleAccess(permissions, mod);
        const label = sub ? `${mod}/${sub}` : `${mod} (module)`;
        console.log(`  ${held ? "YES" : " . "}  ${label}`);
      }

      const scope = collectionScope(permissions, r.id);
      console.log(`\nCollection scope: ${scope.all ? "ALL (the whole queue)" : "own submissions only"}`);

      console.log("\nNavigation served");
      for (const line of flatten(visibleNav(v))) console.log(`  ${line}`);

      console.log("\nRoute guard");
      for (const p of [
        "/dashboard/sales/collections", "/dashboard/sales/pipeline", "/dashboard/sales/leads",
        "/dashboard/commissions/review", "/dashboard/orders", "/dashboard/workstation/preparation",
      ]) console.log(`  ${routeAllowed(v, p) ? "open  " : "REFUSE"}  ${p}`);

      if (collection) {
        const d = collectionDecisionAbility({
          status: collection.status as never,
          submittedById: collection.submittedById,
          actorId: r.id,
          canVerify: hasSubPrivilege(permissions, "commissions", "collection_verify"),
          canReject: hasSubPrivilege(permissions, "commissions", "collection_reject"),
          canReverse: hasSubPrivilege(permissions, "commissions", "collection_reverse"),
        });
        console.log(`\nOn collection ${collection.id} (${collection.status}, ${collection.gross}, by ${collection.submittedById})`);
        console.log(`  approve: ${d.approve.allowed}  [${d.approve.reason}]`);
        console.log(`  reject : ${d.reject.allowed}  [${d.reject.reason}]`);
        console.log(`  reverse: ${d.reverse.allowed}  [${d.reverse.reason}]`);
      }
    }
  } finally {
    await c.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
