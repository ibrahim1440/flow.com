// NAVIGATION — against the roles that actually exist in the preview database.
//
// `navigation.ts` checks the tree against the ROLES definitions the test suites are built
// from. Those are what a role is SUPPOSED to be. This one reads the `permissions` column of
// every active employee, which is what the running application actually serves — and the
// two can differ, because a row provisioned before a privilege existed simply lacks the key
// and its definition will not say so.
//
// Read-only. It connects, reads employees, and asserts properties of the menu each one is
// served. It writes nothing.
import { readFileSync } from "node:fs";
import { Client } from "pg";
import {
  visibleNav, routeAllowed, type NavNode, type Viewer,
} from "@/lib/nav/registry";
import { hasModuleAccess, type Permissions } from "@/lib/auth-shared";

const ENVFILE = process.env.PREVIEW_ENV ?? "C:/Users/mtmbk/.beanflow/sales-preview/.env.preview-app";
let env: Record<string, string> = {};
try {
  for (const line of readFileSync(ENVFILE, "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i > 0) env[t.slice(0, i).trim()] = t.slice(i + 1).trim().replace(/^["']|["']$/g, "");
  }
} catch {
  env = {};
}
const url = env.DATABASE_URL ?? process.env.DATABASE_URL ?? "";
const dbName = (url.match(/\/([a-z0-9_]+)(\?|$)/) || [])[1];
if (dbName !== "sales_preview") {
  console.log(`FATAL: refusing to run against database "${dbName ?? "(none)"}".`);
  process.exit(3);
}

const results = { pass: 0, fail: 0, failures: [] as string[] };
function check(name: string, ok: boolean, detail = "") {
  if (ok) { results.pass++; console.log(`  [PASS] ${name}`); }
  else { results.fail++; results.failures.push(name); console.log(`  [FAIL] ${name}  << ${detail}`); }
}
const section = (t: string) => console.log(`\n${"=".repeat(78)}\n  ${t}\n${"=".repeat(78)}`);
const sub = (t: string) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 58 - t.length))}`);
const S = (v: unknown) => { try { return JSON.stringify(v) ?? String(v); } catch { return String(v); } };

function destinations(tree: NavNode[], trail: NavNode[] = []): { node: NavNode; trail: NavNode[] }[] {
  const out: { node: NavNode; trail: NavNode[] }[] = [];
  for (const n of tree) {
    if (n.href) out.push({ node: n, trail });
    if (n.children) out.push(...destinations(n.children, [...trail, n]));
  }
  return out;
}

/** The flat sidebar this replaced, with the gate each entry carried. */
const BEFORE: [string, string | null, string | null, string?][] = [
  ["/dashboard", null, null],
  ["/dashboard/inventory", "inventory", null], ["/dashboard/purchases", "inventory", null],
  ["/dashboard/products", "inventory", null], ["/dashboard/sales/leads", "sales", null],
  ["/dashboard/sales/pipeline", "sales", null], ["/dashboard/sales/activities", "sales", null],
  ["/dashboard/sales/quotes", "sales", null],
  ["/dashboard/sales/collections", "sales", null, "FINANCE_TOO"],
  ["/dashboard/sales/targets", "sales", null], ["/dashboard/sales/reports", "sales", null],
  ["/dashboard/sales/settings", "sales", "stage_manage"],
  ["/dashboard/sales/my-commissions", "commissions", null],
  ["/dashboard/commissions/review", "commissions", "view_team"],
  ["/dashboard/commissions/plans", "commissions", "manage_plans"],
  ["/dashboard/orders", "orders", null], ["/dashboard/workstation/preparation", "orders", null],
  ["/dashboard/production", "production", null], ["/dashboard/production-orders", "production", null],
  ["/dashboard/qc", "qc", null], ["/dashboard/packaging", "packaging", null],
  ["/dashboard/dispatch", "dispatch", null], ["/dashboard/history", "history", null],
  ["/dashboard/analytics", "analytics", null], ["/dashboard/labels", "labels", null],
  ["/dashboard/employees", "employees", null], ["/dashboard/cupping", "cupping", null],
  ["/dashboard/customers", "customers", null], ["/dashboard/accounting", "accounting", null],
  ["/dashboard/settings", "settings", null],
];

function couldSeeBefore(v: Viewer, [, module, subKey, extra]: [string, string | null, string | null, string?]) {
  if (extra === "FINANCE_TOO") {
    const cs = v.permissions.commissions;
    if (cs && cs.access !== "none" &&
      (cs.sub?.collection_verify === true || cs.sub?.collection_reject === true || cs.sub?.collection_reverse === true)) return true;
  }
  if (!module) return true;
  const perm = v.permissions[module];
  if (!perm || perm.access === "none") return false;
  if (module === "settings" && v.role !== "admin") return false;
  if (subKey) return perm.sub?.[subKey] === true;
  return true;
}

async function main() {
  const c = new Client({ connectionString: url });
  await c.connect();
  try {
    const rows = (await c.query<{ id: string; name: string; role: string; permissions: unknown }>(
      `SELECT id, name, role, permissions FROM "Employee" WHERE active = true ORDER BY id`,
    )).rows;

    section(`A — EVERY ACTIVE ACCOUNT IN ${dbName} (${rows.length})`);
    console.log(`  ${rows.map((r) => r.id).join(", ")}\n`);

    for (const r of rows) {
      const permissions = (typeof r.permissions === "string"
        ? JSON.parse(r.permissions) : r.permissions) as Permissions;
      const v: Viewer = { permissions, role: r.role };
      const tree = visibleNav(v);
      const dests = destinations(tree);
      const hrefs = dests.map((d) => d.node.href!);

      sub(`${r.id} — ${r.name}`);

      // No heading that opens onto nothing.
      const empty: string[] = [];
      const w = (ns: NavNode[]) => ns.forEach((n) => {
        if (n.children && n.children.length === 0) empty.push(n.id);
        if (n.children) w(n.children);
      });
      w(tree);
      check("no empty group", empty.length === 0, S(empty));

      // Nothing offered that the guard would refuse.
      const refused = dests.filter((d) => !routeAllowed(v, d.node.href!)).map((d) => d.node.id);
      check("every offered link opens", refused.length === 0, S(refused));

      // No destination twice. Administrators legitimately meet both framings.
      const dupes = hrefs.filter((h, i) => hrefs.indexOf(h) !== i);
      const SHARED = ["/dashboard/sales/collections", "/dashboard/commissions/review", "/dashboard/sales/my-commissions"];
      if (r.role === "admin" || hasModuleAccess(permissions, "settings")) {
        check("duplicates are only the deliberate Sales/Finance pairs",
          dupes.every((h) => SHARED.includes(h)), S(dupes));
      } else {
        check("no duplicated destination", dupes.length === 0, S(dupes));
      }

      // Orders: once, and framed by whether this person has the Sales CRM.
      const orders = dests.filter((d) => d.node.href === "/dashboard/orders");
      if (hasModuleAccess(permissions, "orders")) {
        check("orders appears exactly once", orders.length === 1, `${orders.length}`);
        const expected = hasModuleAccess(permissions, "sales") ? "sales" : "operations";
        check(`orders sits under ${expected}`, orders[0]?.trail[0]?.id === expected,
          S(orders[0]?.trail.map((t) => t.id)));
      } else {
        check("orders is absent for somebody without the ability", orders.length === 0, `${orders.length}`);
      }

      // No Sales heading for somebody who has no Sales CRM.
      if (!hasModuleAccess(permissions, "sales")) {
        check("no Sales group without the sales module",
          !tree.some((n) => n.id === "sales"), S(tree.map((n) => n.id)));
      }

      // Nothing lost against the flat sidebar.
      const lost = BEFORE.filter((row) => couldSeeBefore(v, row) && !hrefs.includes(row[0])).map((row) => row[0]);
      check("nothing reachable before is gone", lost.length === 0, S(lost));

      // And nothing gained.
      const before = new Set(BEFORE.filter((row) => couldSeeBefore(v, row)).map((row) => row[0]));
      const gained = [...new Set(hrefs)].filter((h) => !before.has(h));
      check("nothing appeared that they could not already open", gained.length === 0, S(gained));
    }
  } finally {
    await c.end();
  }

  console.log(`\n${"=".repeat(78)}`);
  console.log(`  ${results.pass} passed, ${results.fail} failed`);
  if (results.fail) {
    console.log("\n  Failures:");
    for (const f of results.failures) console.log(`    - ${f}`);
  }
  console.log("=".repeat(78));
  process.exit(results.fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
