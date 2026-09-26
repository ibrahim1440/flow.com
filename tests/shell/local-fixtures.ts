/**
 * The shell suite on an ISOLATED LOCAL database instead of the production-derived preview.
 *
 * The suite reads no pre-existing records: it signs in as three disposable `NAV_` identities
 * and creates (then deletes) one synthetic lead. So the preview database is not needed for
 * what it asserts — only for where it used to run. This provisions the SAME identities, with
 * the same role definitions and PIN hashing, into a local disposable database; the spec file
 * and its assertions are unchanged.
 *
 * Refuses anything but 127.0.0.1:54329/erp_shell_local marked 'hiqbah-shell-disposable'.
 * SHELL_LOCAL_URL (owner URL) and PIN_LOOKUP_SECRET come from the environment; never printed.
 */
import { hashSync } from "bcryptjs";
import { Client } from "pg";
import { pinLookup, pinVerifierInput } from "../../src/lib/pin-lookup";
import { ROLES } from "../e2e/support/roles";
import { NAV_PEOPLE, NAV_PREFIX } from "../../scripts/sales-preview/preview-guard";

const MARKER = "hiqbah-shell-disposable";

async function withLocal<T>(fn: (c: Client, secret: string) => Promise<T>): Promise<T> {
  const url = process.env.SHELL_LOCAL_URL ?? "";
  const u = new URL(url);
  if (u.hostname !== "127.0.0.1" || u.port !== "54329" || u.pathname !== "/erp_shell_local") throw new Error("REFUSE: SHELL_LOCAL_URL must be 127.0.0.1:54329/erp_shell_local");
  const secret = process.env.PIN_LOOKUP_SECRET ?? "";
  if (secret.length < 32) throw new Error("REFUSE: PIN_LOOKUP_SECRET missing");
  const c = new Client({ connectionString: url });
  await c.connect();
  try {
    const m = await c.query(`SELECT shobj_description(oid,'pg_database') d FROM pg_database WHERE datname = current_database()`);
    if (m.rows[0]?.d !== MARKER) throw new Error(`REFUSE: database is not marked ${MARKER}`);
    return await fn(c, secret);
  } finally {
    await c.end();
  }
}

export async function provisionLocal(): Promise<number> {
  return withLocal(async (c, secret) => {
    for (const p of NAV_PEOPLE) {
      const role = ROLES[p.role];
      await c.query(
        `INSERT INTO "Employee" (id, name, pin, "pinLookup", role, permissions, "defaultRoute", active, "preferredLanguage", "createdAt", "updatedAt")
         VALUES ($1,$2,$3,$4,$5,$6,'/dashboard',true,'ar',now(),now())
         ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, pin = EXCLUDED.pin, "pinLookup" = EXCLUDED."pinLookup",
           role = EXCLUDED.role, permissions = EXCLUDED.permissions, active = true, "updatedAt" = now()`,
        [p.id, p.name, hashSync(pinVerifierInput(p.pin, secret), 10), pinLookup(p.pin, secret), role.role, JSON.stringify(role.permissions)],
      );
    }
    return NAV_PEOPLE.length;
  });
}

export async function removeLocal(): Promise<number> {
  return withLocal(async (c) => (await c.query(`DELETE FROM "Employee" WHERE id LIKE '${NAV_PREFIX}\\_%'`)).rowCount ?? 0);
}

export default async function globalSetup() {
  console.log(`[shell-local] provisioned ${await provisionLocal()} disposable navigation fixtures`);
  return async () => { console.log(`[shell-local] removed ${await removeLocal()} navigation fixtures`); };
}
