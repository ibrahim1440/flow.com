/**
 * Three disposable identities for checking the navigation in a browser.
 *
 * `NAV_`-prefixed and nothing else: never the `RVW_` reviewer accounts, whose PINs are
 * issued once and whose sessions somebody may be holding. Permissions come from the same
 * `ROLES` definitions the test suites use, so what the browser shows is what those roles
 * really grant rather than a hand-written approximation.
 *
 * Idempotent. Re-running reissues the same fixed PINs — these are throwaway logins on an
 * isolated preview database, not credentials.
 *
 *   PREVIEW_ENV=<app env file> npx tsx scripts/sales-preview/nav-fixtures.ts [--remove]
 */
import { readFileSync } from "node:fs";
import { hashSync } from "bcryptjs";
import { Client } from "pg";
import { pinLookup, pinVerifierInput } from "../../src/lib/pin-lookup";
import { ROLES, type RoleName } from "../../tests/e2e/support/roles";

const P = "NAV";
const ENVFILE = process.env.PREVIEW_ENV;
if (!ENVFILE) { console.error("REFUSE: PREVIEW_ENV is not set."); process.exit(3); }

const env: Record<string, string> = {};
for (const line of readFileSync(ENVFILE, "utf8").split(/\r?\n/)) {
  const t = line.trim();
  if (!t || t.startsWith("#")) continue;
  const i = t.indexOf("=");
  if (i > 0) env[t.slice(0, i).trim()] = t.slice(i + 1).trim().replace(/^["']|["']$/g, "");
}

const ALLOWED_ENDPOINT = "ep-wandering-leaf-aqjtuin5";
const ALLOWED_DATABASE = "sales_preview";
const ALLOWED_ROLE = "sales_preview_app";

const url = env.DATABASE_URL;
if (!url) { console.error("REFUSE: DATABASE_URL is not in that env file"); process.exit(3); }
let u: URL;
try { u = new URL(url); } catch { console.error("REFUSE: unusable connection string"); process.exit(3); }
if (!u.hostname.startsWith(ALLOWED_ENDPOINT)) { console.error("REFUSE: not the approved preview endpoint"); process.exit(3); }
if (u.pathname.replace(/^\//, "") !== ALLOWED_DATABASE) { console.error("REFUSE: not the approved preview database"); process.exit(3); }
if (u.username !== ALLOWED_ROLE) { console.error(`REFUSE: must run as ${ALLOWED_ROLE}`); process.exit(3); }

const secret = env.PIN_LOOKUP_SECRET;
if (!secret || secret.length < 32) { console.error("REFUSE: PIN_LOOKUP_SECRET missing or too short"); process.exit(3); }

const PEOPLE: { id: string; name: string; pin: string; role: RoleName }[] = [
  { id: `${P}_rep`, name: `${P} Sales Rep`, pin: "940011", role: "crmRep" },
  { id: `${P}_manager`, name: `${P} Sales Manager`, pin: "940022", role: "crmManager" },
  { id: `${P}_finance`, name: `${P} Finance`, pin: "940033", role: "crmFinance" },
];

async function main() {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    if (process.argv.includes("--remove")) {
      const r = await client.query(`DELETE FROM "Employee" WHERE id LIKE '${P}\\_%'`);
      console.log(`removed ${r.rowCount} navigation fixtures`);
      return;
    }
    for (const p of PEOPLE) {
      const role = ROLES[p.role];
      await client.query(
        `INSERT INTO "Employee"
           (id, name, pin, "pinLookup", role, permissions, "defaultRoute", active,
            "preferredLanguage", "createdAt", "updatedAt")
         VALUES ($1,$2,$3,$4,$5,$6,'/dashboard',true,'ar',now(),now())
         ON CONFLICT (id) DO UPDATE SET
           name = EXCLUDED.name, pin = EXCLUDED.pin, "pinLookup" = EXCLUDED."pinLookup",
           role = EXCLUDED.role, permissions = EXCLUDED.permissions,
           active = true, "updatedAt" = now()`,
        [
          p.id, p.name,
          hashSync(pinVerifierInput(p.pin, secret), 10),
          pinLookup(p.pin, secret),
          role.role, JSON.stringify(role.permissions),
        ],
      );
      console.log(`  ${p.id.padEnd(14)} ${p.role.padEnd(12)} pin ${p.pin}`);
    }
    console.log("\nDisposable. Remove with --remove when the checks are done.");
  } finally {
    await client.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
