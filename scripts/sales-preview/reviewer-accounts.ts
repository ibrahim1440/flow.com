/**
 * Provision the human reviewer's accounts on the Preview database, and print their PINs ONCE.
 *
 * ── Why these are their own accounts ────────────────────────────────────────
 * The first version of this script rotated the PINs of the browser suite's `UAT_emp_*`
 * fixtures. That was wrong twice over. The suite's `globalSetup` DELETES every `UAT_emp_%` row
 * and reseeds it with the committed fixture PIN, so a test run silently takes the reviewer's
 * access away; and `sales-crm.spec.ts` deactivates `UAT_emp_crmRep` mid-test and flips its
 * language to Arabic, so a reviewer signing in during a run would meet a deactivated account.
 *
 * So the reviewer gets `RVW_`-prefixed accounts of their own. Every teardown in this
 * repository is prefix-scoped — `UAT_emp_%`, `<suite>_%`, or an explicit id list — and none of
 * them matches `RVW_`. `globalSetup` also asserts that, so the guarantee is enforced rather
 * than remembered.
 *
 * ── What it does ───────────────────────────────────────────────────────────
 * Creates or updates three employees, a 1% and a 2% commission plan, and the assignments that
 * make the commission screens show something — all idempotent, all `RVW_`-prefixed — then
 * issues a fresh random six-digit PIN for each and prints it to this terminal and nowhere
 * else. Nothing is written to a file. The PINs are not recoverable afterwards: run it again to
 * get new ones.
 *
 * Runs as the RESTRICTED runtime role, and refuses any other identity. Everything here is
 * ordinary DML on rows this role may write.
 *
 * Usage:
 *   PREVIEW_ENV=<the app env file> npx tsx scripts/sales-preview/reviewer-accounts.ts
 */
import { randomInt } from "node:crypto";
import { readFileSync } from "node:fs";
import { hashSync } from "bcryptjs";
import { Client } from "pg";
import { pinLookup, pinVerifierInput } from "../../src/lib/pin-lookup";
import { ROLES } from "../../tests/e2e/support/roles";

/** The reviewer's own prefix. Deliberately not `UAT_`. */
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
if (!url) { console.error("REFUSE: no DATABASE_URL in that env file"); process.exit(3); }
let u: URL;
try { u = new URL(url); } catch { console.error("REFUSE: DATABASE_URL is not a usable connection string"); process.exit(3); }
if (!u.hostname.startsWith(ALLOWED_ENDPOINT)) { console.error("REFUSE: not the approved preview endpoint"); process.exit(3); }
if (u.pathname.replace(/^\//, "") !== ALLOWED_DATABASE) { console.error("REFUSE: not the approved preview database"); process.exit(3); }
if (u.username !== ALLOWED_ROLE) {
  console.error(`REFUSE: this must run as ${ALLOWED_ROLE}; it is a data change, not an admin task`);
  process.exit(3);
}
const secret = env.PIN_LOOKUP_SECRET;
if (!secret || secret.length < 32) { console.error("REFUSE: PIN_LOOKUP_SECRET is missing or too short"); process.exit(3); }

/**
 * The three accounts, with permissions taken from the application's own privilege list via
 * `ROLES` — so a reviewer can never be granted a privilege key that does not exist, and can
 * never silently drift from what the tests assert about these roles.
 */
const REVIEWERS = [
  {
    id: `${P}_emp_rep`, label: "Sales rep", role: ROLES.crmRep,
    name: "Reviewer — Sales Rep",
    can: "owns leads and deals, raises quotations, places the order an accepted quotation entitles",
  },
  {
    id: `${P}_emp_manager`, label: "Sales manager", role: ROLES.crmManager,
    name: "Reviewer — Sales Manager",
    can: "whole pipeline, approves discounts, closes and reopens deals, records sandbox collections",
  },
  {
    id: `${P}_emp_finance`, label: "Finance", role: ROLES.crmFinance,
    name: "Reviewer — Finance",
    can: "approves, adjusts and records payouts on commission — and no access to the pipeline at all",
  },
];

const newPin = () => String(randomInt(100_000, 1_000_000));

async function main() {
  const client = new Client({ connectionString: url });
  await client.connect();
  const issued: { label: string; id: string; can: string; pin: string }[] = [];

  try {
    // ── the accounts ────────────────────────────────────────────────────────
    for (const r of REVIEWERS) {
      let pin = newPin();
      for (let attempt = 0; attempt < 20; attempt++) {
        const clash = await client.query(
          `SELECT 1 FROM "Employee" WHERE "pinLookup" = $1 AND id <> $2 LIMIT 1`,
          [pinLookup(pin, secret), r.id],
        );
        if (clash.rowCount === 0) break;
        pin = newPin();
      }

      // Upsert: create on a fresh database, repair on an existing one. Reactivates the row
      // and rewrites the permissions, so a reviewer locked out by an earlier state recovers
      // by running this again.
      await client.query(
        `INSERT INTO "Employee"
           (id, name, pin, "pinLookup", role, permissions, "defaultRoute", active,
            "preferredLanguage", "createdAt", "updatedAt")
         VALUES ($1,$2,$3,$4,$5,$6,'/dashboard',true,'en',now(),now())
         ON CONFLICT (id) DO UPDATE SET
           name = EXCLUDED.name,
           pin = EXCLUDED.pin,
           "pinLookup" = EXCLUDED."pinLookup",
           role = EXCLUDED.role,
           permissions = EXCLUDED.permissions,
           active = true,
           "updatedAt" = now()`,
        [
          r.id, r.name,
          hashSync(pinVerifierInput(pin, secret), 10),
          pinLookup(pin, secret),
          r.role.role, JSON.stringify(r.role.permissions),
        ],
      );
      issued.push({ label: r.label, id: r.id, can: r.can, pin });
    }

    // ── commission plans, so the commission screens have something to show ──
    // Codes must not begin `UAT`: globalSetup deletes plans by `code LIKE 'UAT%'`.
    const plans: [string, string, string, string][] = [
      [`${P}_plan_standard`, `${P}_STD`, "Reviewer Standard 1%", "1.000000"],
      [`${P}_plan_senior`, `${P}_SNR`, "Reviewer Senior 2%", "2.000000"],
    ];
    for (const [planId, code, name, rate] of plans) {
      await client.query(
        `INSERT INTO "CommissionPlan" (id, code, name, "isActive", "createdAt", "updatedAt")
         VALUES ($1,$2,$3,true,now(),now())
         ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, "isActive" = true, "updatedAt" = now()`,
        [planId, code, name],
      );
      await client.query(
        `INSERT INTO "CommissionPlanVersion"
           (id, "planId", version, basis, "tierMode", "baseRatePercent", currency, "effectiveFrom", "createdAt")
         VALUES ($1,$2,1,'NET_COLLECTION','INCREMENTAL',$3,'SAR','2020-01-01',now())
         ON CONFLICT (id) DO UPDATE SET "baseRatePercent" = EXCLUDED."baseRatePercent"`,
        [`${planId.replace("_plan_", "_ver_")}`, planId, rate],
      );
    }

    const assignments: [string, string, string][] = [
      [`${P}_asg_rep`, `${P}_emp_rep`, `${P}_plan_standard`],
      [`${P}_asg_mgr`, `${P}_emp_manager`, `${P}_plan_senior`],
    ];
    for (const [asgId, employeeId, planId] of assignments) {
      await client.query(
        `INSERT INTO "CommissionAssignment"
           (id, "employeeId", "planId", "planVersionId", "effectiveFrom", "createdAt")
         VALUES ($1,$2,$3,$4,'2020-01-01',now())
         ON CONFLICT (id) DO NOTHING`,
        [asgId, employeeId, planId, planId.replace("_plan_", "_ver_")],
      );
    }
  } finally {
    await client.end();
  }

  const line = "-".repeat(76);
  console.log(`\n${line}`);
  console.log("  PREVIEW REVIEWER ACCOUNTS — printed once, to this terminal only");
  console.log(line);
  console.log("  Synthetic accounts in a disposable database. Not staff accounts, no real");
  console.log("  data. Do not paste them into chat, a ticket, or a commit.\n");
  for (const r of issued) {
    console.log(`  ${r.label.padEnd(15)} PIN ${r.pin}`);
    console.log(`  ${" ".repeat(15)} ${r.id}`);
    console.log(`  ${" ".repeat(15)} ${r.can}\n`);
  }
  console.log(line);
  console.log("  These accounts are RVW_-prefixed and no test fixture touches them: every");
  console.log("  teardown in this repository is scoped to UAT_ or to a named suite prefix,");
  console.log("  and globalSetup asserts that none of the RVW_ rows disappeared. Running the");
  console.log("  test suites will NOT reset these PINs.");
  console.log(`${line}\n`);
}

main().catch((e) => {
  console.error("FAILED: " + String(e?.message ?? e));
  process.exit(1);
});
