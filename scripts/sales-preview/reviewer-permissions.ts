/**
 * Bring the reviewer accounts' PERMISSIONS up to date, and touch nothing else.
 *
 * ── Why this exists beside `reviewer-accounts.ts` ───────────────────────────
 * That script rotates the PIN on every run and prints it once. That is right when issuing
 * accounts and wrong when a privilege has been added: a reviewer who is mid-review would be
 * signed out of the account they are holding, and the new PIN would exist only in whatever
 * terminal happened to run it.
 *
 * The missing "تسجيل تحصيل" button was exactly this case. `RVW_emp_rep` was provisioned
 * before `sales/collection_submit` existed, so its stored permissions had no such key,
 * `hasSubPrivilege` correctly returned false, and the server correctly reported that the
 * action was unavailable. Nothing was broken; the role was simply older than the feature.
 *
 * So this updates `permissions` (and reactivates the row) from the same `ROLES` definition
 * the test fixtures use, and leaves `pin`, `pinLookup` and `name` untouched. Idempotent, and
 * safe to run while somebody is signed in.
 *
 * Runs as the RESTRICTED runtime role against the Preview database, and refuses any other
 * identity. This is ordinary DML on rows that role may write.
 *
 * Usage:
 *   PREVIEW_ENV=<the app env file> npx tsx scripts/sales-preview/reviewer-permissions.ts
 */
import { readFileSync } from "node:fs";
import { Client } from "pg";
import { ROLES } from "../../tests/e2e/support/roles";

const P = "RVW";

const ENVFILE = process.env.PREVIEW_ENV;
if (!ENVFILE) {
  console.error("REFUSE: PREVIEW_ENV is not set. It must point at the app env file.");
  process.exit(3);
}

const env: Record<string, string> = {};
for (const line of readFileSync(ENVFILE, "utf8").split(/\r?\n/)) {
  const t = line.trim();
  if (!t || t.startsWith("#")) continue;
  const i = t.indexOf("=");
  if (i < 0) continue;
  env[t.slice(0, i).trim()] = t.slice(i + 1).trim().replace(/^["']|["']$/g, "");
}

const ALLOWED_ENDPOINT = "ep-wandering-leaf-aqjtuin5";
const ALLOWED_DATABASE = "sales_preview";
const ALLOWED_ROLE = "sales_preview_app";

const url = env.DATABASE_URL;
if (!url) { console.error("REFUSE: DATABASE_URL is not in that env file"); process.exit(3); }
let u: URL;
try { u = new URL(url); } catch { console.error("REFUSE: DATABASE_URL is not a usable connection string"); process.exit(3); }
if (!u.hostname.startsWith(ALLOWED_ENDPOINT)) { console.error("REFUSE: not the approved preview endpoint"); process.exit(3); }
if (u.pathname.replace(/^\//, "") !== ALLOWED_DATABASE) { console.error("REFUSE: not the approved preview database"); process.exit(3); }
if (u.username !== ALLOWED_ROLE) {
  console.error(`REFUSE: this must run as ${ALLOWED_ROLE}; it is a data change, not an admin task`);
  process.exit(3);
}

const REVIEWERS = [
  { id: `${P}_emp_rep`, label: "Sales rep", role: ROLES.crmRep },
  { id: `${P}_emp_manager`, label: "Sales manager", role: ROLES.crmManager },
  { id: `${P}_emp_finance`, label: "Finance", role: ROLES.crmFinance },
];

/** Every sub-privilege the role grants, flattened for a readable before/after. */
function granted(permissions: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const [mod, v] of Object.entries(permissions ?? {})) {
    const m = v as { access?: string; sub?: Record<string, boolean> };
    if (!m || m.access === "none" || !m.access) continue;
    for (const [k, on] of Object.entries(m.sub ?? {})) if (on) out.push(`${mod}/${k}`);
  }
  return out.sort();
}

async function main() {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    console.log(`database: ${ALLOWED_DATABASE}  role: ${ALLOWED_ROLE}\n`);
    for (const r of REVIEWERS) {
      const existing = await client.query<{ permissions: unknown; active: boolean }>(
        `SELECT permissions, active FROM "Employee" WHERE id = $1`, [r.id],
      );
      if (existing.rowCount === 0) {
        console.log(`  ${r.id}: MISSING — run reviewer-accounts.ts to issue it first.`);
        continue;
      }

      const wasRaw = existing.rows[0].permissions;
      const was = granted(typeof wasRaw === "string" ? JSON.parse(wasRaw) : (wasRaw as Record<string, unknown>));
      const now = granted(r.role.permissions as unknown as Record<string, unknown>);
      const added = now.filter((k) => !was.includes(k));
      const removed = was.filter((k) => !now.includes(k));

      // PIN, pinLookup and name are deliberately absent from this UPDATE.
      await client.query(
        `UPDATE "Employee"
            SET permissions = $2, role = $3, active = true, "updatedAt" = now()
          WHERE id = $1`,
        [r.id, JSON.stringify(r.role.permissions), r.role.role],
      );

      console.log(`  ${r.id}  (${r.label})`);
      console.log(`    + ${added.length ? added.join(", ") : "nothing new"}`);
      if (removed.length) console.log(`    - ${removed.join(", ")}`);
      if (!existing.rows[0].active) console.log("    reactivated");
    }
    console.log("\nPINs were not touched. Anyone signed in stays signed in.");
  } finally {
    await client.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
