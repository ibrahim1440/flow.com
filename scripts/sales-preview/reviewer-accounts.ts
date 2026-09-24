/**
 * Issue fresh PINs for the three synthetic reviewer accounts, and print them ONCE, locally.
 *
 * Why this exists. The browser suite's fixture PINs live in `tests/e2e/support/roles.ts`,
 * which is committed — acceptable for a disposable test database, and not acceptable as the
 * way a person is handed credentials for a review environment. Telling a reviewer "read the
 * PINs out of the repository" hands them a credential that anybody with the repository
 * already has.
 *
 * So this rotates them. It generates three random six-digit PINs, writes the keyed selector
 * and the bcrypt verifier for each — using the SAME `pinLookup` / `pinVerifierInput` the login
 * route uses, under the preview `PIN_LOOKUP_SECRET` — and prints the PINs to this terminal and
 * nowhere else. Nothing is written to a file, and the values are not recoverable afterwards:
 * run it again to get new ones.
 *
 * Runs as the RESTRICTED runtime role. It is an UPDATE on three rows of `Employee`, which is
 * inside what that role may do; it needs no elevated credential and is refused if handed one.
 *
 * Usage:
 *   PREVIEW_ENV=<the app env file> npx tsx scripts/sales-preview/reviewer-accounts.ts
 */
import { randomInt } from "node:crypto";
import { readFileSync } from "node:fs";
import { hashSync } from "bcryptjs";
import { Client } from "pg";
import { pinLookup, pinVerifierInput } from "../../src/lib/pin-lookup";

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

/** The three accounts a reviewer needs, and what each one is for. */
const REVIEWERS = [
  { id: "UAT_emp_crmRep", role: "Sales rep", can: "own leads and deals, raise quotations, place the order an accepted quotation entitles" },
  { id: "UAT_emp_crmManager", role: "Sales manager", can: "the whole pipeline, approve discounts, close and reopen deals, record sandbox collections" },
  { id: "UAT_emp_crmFinance", role: "Finance", can: "approve, adjust and record payouts on commission — and no access to the pipeline at all" },
];

/** Six digits, uniformly drawn, never starting 0 so it reads as a PIN on screen. */
const newPin = () => String(randomInt(100_000, 1_000_000));

async function main() {
  const client = new Client({ connectionString: url });
  await client.connect();

  const issued: { id: string; role: string; can: string; pin: string }[] = [];
  try {
    for (const r of REVIEWERS) {
      // Collision would make two accounts share a selector, and the login route takes the first
      // row it finds — so draw again rather than risk it.
      let pin = newPin();
      for (let attempt = 0; attempt < 20; attempt++) {
        const clash = await client.query(
          `SELECT 1 FROM "Employee" WHERE "pinLookup" = $1 AND id <> $2 LIMIT 1`,
          [pinLookup(pin, secret), r.id],
        );
        if (clash.rowCount === 0) break;
        pin = newPin();
      }

      const res = await client.query(
        `UPDATE "Employee"
            SET "pinLookup" = $1, pin = $2, "updatedAt" = now()
          WHERE id = $3 AND active = true`,
        [pinLookup(pin, secret), hashSync(pinVerifierInput(pin, secret), 10), r.id],
      );
      if (res.rowCount !== 1) {
        console.error(`\nREFUSE: ${r.id} is not present and active in this database.`);
        console.error("Seed the fixtures first — run the browser suite once — then try again.");
        process.exit(4);
      }
      issued.push({ ...r, pin });
    }
  } finally {
    await client.end();
  }

  const line = "─".repeat(74);
  console.log(`\n${line}`);
  console.log("  REVIEWER ACCOUNTS — printed once, to this terminal only");
  console.log(line);
  console.log("  Synthetic accounts in a disposable database. They are not staff accounts and");
  console.log("  they hold no real data. Do not paste them into chat, a ticket, or a commit.\n");
  for (const r of issued) {
    console.log(`  ${r.role.padEnd(15)} PIN ${r.pin}`);
    console.log(`  ${" ".repeat(15)} ${r.id}`);
    console.log(`  ${" ".repeat(15)} ${r.can}\n`);
  }
  console.log(line);
  console.log("  These replace whatever PINs the accounts had, including the fixture values in");
  console.log("  tests/e2e/support/roles.ts — so the committed PINs no longer open this");
  console.log("  database. Re-running the browser suite re-seeds the fixture PINs and undoes");
  console.log("  that; run this again afterwards.");
  console.log(`${line}\n`);

}

main().catch((e) => {
  console.error("FAILED: " + String(e?.message ?? e));
  process.exit(1);
});
