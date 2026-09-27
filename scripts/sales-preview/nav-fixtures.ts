/**
 * Three disposable identities for checking the navigation in a browser.
 *
 * `NAV_`-prefixed and nothing else: never the `RVW_` reviewer accounts, whose PINs are
 * issued once and whose sessions somebody may be holding. Permissions come from the same
 * `ROLES` definitions the test suites use, so what the browser shows is what those roles
 * really grant rather than a hand-written approximation.
 *
 * Idempotent, and it prints no PINs — the shell suite imports them from `preview-guard.ts`
 * rather than reading them off a terminal. `playwright.shell.config.ts` calls the two
 * functions below as its global setup and teardown, so a normal run leaves nothing behind;
 * the CLI is for driving the browser by hand.
 *
 *   PREVIEW_ENV=<app env file> npx tsx scripts/sales-preview/nav-fixtures.ts [--remove]
 */
import { hashSync } from "bcryptjs";
import { Client } from "pg";
import { pinLookup, pinVerifierInput } from "../../src/lib/pin-lookup";
import { ROLES } from "../../tests/e2e/support/roles";
import { NAV_PEOPLE, NAV_PREFIX, PreviewRefusal, loadPreviewEnv } from "./preview-guard";

async function withPreview<T>(fn: (c: Client, secret: string) => Promise<T>): Promise<T> {
  const { url, secret } = loadPreviewEnv();
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    return await fn(client, secret);
  } finally {
    await client.end();
  }
}

/** Create or refresh the three fixtures. Returns their ids — never their PINs. */
export async function provisionNavFixtures(): Promise<string[]> {
  return withPreview(async (client, secret) => {
    for (const p of NAV_PEOPLE) {
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
    }
    return NAV_PEOPLE.map((p) => p.id);
  });
}

/**
 * Delete every `NAV_` account, whether this run created it or an earlier one abandoned it.
 * Unconditional on purpose: teardown must not depend on setup having got that far.
 */
export async function removeNavFixtures(): Promise<number> {
  return withPreview(async (client) => {
    const r = await client.query(`DELETE FROM "Employee" WHERE id LIKE '${NAV_PREFIX}\\_%'`);
    return r.rowCount ?? 0;
  });
}

async function main() {
  if (process.argv.includes("--remove")) {
    console.log(`removed ${await removeNavFixtures()} navigation fixtures`);
    return;
  }
  const ids = await provisionNavFixtures();
  for (const id of ids) console.log(`  ${id}`);
  console.log("\nDisposable. Remove with --remove when the checks are done.");
}

// Only when run as a script. Playwright imports this file for its global setup, and an
// import must not also execute the CLI.
if (typeof require !== "undefined" && require.main === module) {
  main().catch((e) => {
    if (e instanceof PreviewRefusal) {
      console.error(e.message);
      process.exit(3);
    }
    console.error(e);
    process.exit(1);
  });
}
