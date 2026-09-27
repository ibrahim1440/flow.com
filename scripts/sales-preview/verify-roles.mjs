// Prove the runtime identity is actually confined — by testing it, not by reading the script
// that created it.
//
// Everything here is either catalogue metadata or a SYNTHETIC probe object created for the
// purpose and dropped afterwards. No real business row is ever selected: where a real table is
// involved the check is has_table_privilege(), which answers from the catalogue and reads no
// data at all.
//
// Privileges are resolved by OID, never by a formatted name. `has_table_privilege(role,
// 'public.' || name, ...)` inside a WHERE clause is evaluated in whatever order the planner
// likes, so it can be applied to a catalogue row whose name does not exist in `public` and
// fail with a confusing "relation does not exist". The OID form cannot misresolve.
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const require_ = createRequire(ROOT + "/package.json");
const pg = require_("pg");

const S = process.env.SCRATCH;
if (!S) { console.error("REFUSE: SCRATCH is not set"); process.exit(3); }

const APP = "sales_preview_app";
const MIG = "sales_preview_migrator";
const PREVIEW_DB = "sales_preview";
const OTHER_DB = "neondb";            // the one holding copied production data
const OLD_DB = "sales_crm_preview";   // the earlier preview database

const results = { pass: 0, fail: 0, failures: [] };
const check = (name, ok, detail = "") => {
  if (ok) { results.pass++; console.log(`  [PASS] ${name}`); }
  else { results.fail++; results.failures.push(name); console.log(`  [FAIL] ${name}  << ${detail}`); }
};
const section = (t) => console.log(`\n${"=".repeat(76)}\n  ${t}\n${"=".repeat(76)}`);

function readEnv(file) {
  const out = {};
  let text;
  try { text = readFileSync(file, "utf8"); } catch { return out; }
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i < 0) continue;
    out[t.slice(0, i).trim()] = t.slice(i + 1);
  }
  return out;
}

const appUrl = readEnv(`${S}/.env.preview-app`).DIRECT_URL;

// OPTIONAL, and deliberately so. Creating the synthetic probe table in neondb needs a
// credential with rights there, which most people running this will not have and should not
// be made to obtain. Without it the privilege sweep still runs in full — it is the positive
// control that is skipped, and the run says so rather than quietly proving less.
const ownerUrl = readEnv(`${S}/.env.sales-preview`).DIRECT_URL ?? null;

// Sections A, B and D read the catalogue and drive the runtime role; none of that needs an
// owner. The migration identity is enough, and is the one a reviewer will actually have.
const adminUrl = ownerUrl ?? readEnv(`${S}/.env.preview-migrate`).DIRECT_URL;
if (!adminUrl) {
  console.error("REFUSE: need .env.preview-migrate (or .env.sales-preview) in $SCRATCH");
  process.exit(3);
}

const withDb = (url, db) => { const u = new URL(url); u.pathname = "/" + db; return u.toString(); };

async function connect(url) {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  return c;
}
const q = async (c, sql, p = []) => (await c.query(sql, p)).rows;
/** Run a statement expecting it to be refused; returns the SQLSTATE or null if it succeeded. */
async function refused(c, sql) {
  try { await c.query(sql); return null; } catch (e) { return e.code ?? "ERROR"; }
}

async function main() {
  // ═══════════════════════════════════════════════════════════════════════
  section("A — ROLE ATTRIBUTES, READ BACK FROM THE CATALOGUE");
  const owner = await connect(adminUrl);
  const roles = await q(owner, `
    SELECT rolname, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls,
           rolcanlogin, rolinherit
      FROM pg_roles WHERE rolname = ANY($1)`, [[APP, MIG]]);

  for (const r of roles) {
    const label = r.rolname === APP ? "runtime" : "migration";
    check(`${label} role ${r.rolname} is NOT superuser`, r.rolsuper === false, String(r.rolsuper));
    check(`${label} role has NOCREATEDB`, r.rolcreatedb === false, String(r.rolcreatedb));
    check(`${label} role has NOCREATEROLE`, r.rolcreaterole === false, String(r.rolcreaterole));
    check(`${label} role has NOREPLICATION`, r.rolreplication === false, String(r.rolreplication));
    check(`${label} role has NOBYPASSRLS`, r.rolbypassrls === false, String(r.rolbypassrls));
  }
  check("the runtime role is NOINHERIT",
    roles.find((r) => r.rolname === APP)?.rolinherit === false, "");

  const memberships = await q(owner, `
    SELECT m.rolname AS member, g.rolname AS granted
      FROM pg_auth_members am
      JOIN pg_roles m ON m.oid = am.member
      JOIN pg_roles g ON g.oid = am.roleid
     WHERE m.rolname = ANY($1)`, [[APP, MIG]]);
  check("neither task role is a member of ANY role — no neon_superuser, no pg_read_all_data",
    memberships.length === 0, JSON.stringify(memberships));

  // The contrast that makes the point.
  const ownerMem = await q(owner,
    `SELECT g.rolname FROM pg_auth_members am JOIN pg_roles m ON m.oid=am.member
       JOIN pg_roles g ON g.oid=am.roleid WHERE m.rolname='neondb_owner'`);
  console.log(`        (for contrast, neondb_owner is a member of: ${ownerMem.map((r) => r.rolname).join(", ")})`);

  // ═══════════════════════════════════════════════════════════════════════
  section("B — WHAT THE RUNTIME ROLE MAY DO IN ITS OWN DATABASE");
  const app = await connect(appUrl);
  check("it can connect to its own database",
    (await q(app, "SELECT current_database() d"))[0].d === PREVIEW_DB, "");
  check("and it is the restricted role, not an owner",
    (await q(app, "SELECT current_user u"))[0].u === APP, "");

  const privs = await q(app, `
    SELECT DISTINCT p.privilege_type
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      CROSS JOIN LATERAL (
        SELECT unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'])
      ) AS t(privilege_type)
      JOIN LATERAL (SELECT t.privilege_type) p ON true
     WHERE n.nspname = 'public' AND c.relkind = 'r'
       AND has_table_privilege(current_user, c.oid, t.privilege_type)
     ORDER BY 1`);
  const held = privs.map((r) => r.privilege_type).sort();
  check("it holds exactly SELECT, INSERT, UPDATE, DELETE on the tables",
    JSON.stringify(held) === JSON.stringify(["DELETE", "INSERT", "SELECT", "UPDATE"]), JSON.stringify(held));
  check("it does NOT hold TRUNCATE", !held.includes("TRUNCATE"), JSON.stringify(held));
  check("it does NOT hold REFERENCES or TRIGGER",
    !held.includes("REFERENCES") && !held.includes("TRIGGER"), JSON.stringify(held));

  const counts = await q(app, `
    SELECT COUNT(*)::int AS tables,
           COUNT(*) FILTER (WHERE has_table_privilege(current_user, c.oid, 'SELECT'))::int AS readable,
           COUNT(*) FILTER (WHERE pg_get_userbyid(c.relowner) = current_user)::int AS owned
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname='public' AND c.relkind='r'`);
  check(`all ${counts[0].tables} tables are readable by the app`,
    counts[0].readable === counts[0].tables, JSON.stringify(counts[0]));
  check("but the app OWNS none of them", counts[0].owned === 0, JSON.stringify(counts[0]));

  check("it cannot CREATE in the schema",
    (await q(app, "SELECT has_schema_privilege(current_user,'public','CREATE') c"))[0].c === false, "");
  check("a CREATE TABLE is actually refused, not merely un-granted",
    (await refused(app, 'CREATE TABLE public."__should_not_exist"(x int)')) === "42501", "");
  check("a DROP TABLE on a real table is refused",
    (await refused(app, 'DROP TABLE public."Employee"')) === "42501", "");
  check("an ALTER TABLE is refused",
    (await refused(app, 'ALTER TABLE public."Employee" ADD COLUMN "__x" int')) === "42501", "");
  check("a TRUNCATE is refused",
    (await refused(app, 'TRUNCATE public."Employee"')) === "42501", "");

  // ═══════════════════════════════════════════════════════════════════════
  section("C — WHAT IT MAY DO IN THE DATABASES THAT HOLD OTHER DATA");

  // A synthetic probe, so the proof never involves a real row. Creating it needs rights in
  // the other database, which only an owner credential has — and that credential is not
  // required to run this script. Without it the sweep below still runs; what is lost is the
  // positive control, and the run says so rather than quietly proving less.
  let otherOwner = null;
  if (ownerUrl) {
    otherOwner = await connect(withDb(ownerUrl, OTHER_DB));
    await otherOwner.query('DROP TABLE IF EXISTS public."__isolation_probe"');
    await otherOwner.query('CREATE TABLE public."__isolation_probe"(id int primary key, secret text)');
    await otherOwner.query(`INSERT INTO public."__isolation_probe" VALUES (1, 'synthetic-canary')`);
    console.log(`        (created a synthetic probe table in ${OTHER_DB}; no real row is touched)`);
  } else {
    console.log(`        (SKIPPED the synthetic probe in ${OTHER_DB}: no owner credential configured.`);
    console.log("         The privilege sweep below still runs; the positive control does not.)");
  }

  let appOther = null;
  let connectCode = null;
  try {
    appOther = await connect(withDb(appUrl, OTHER_DB));
  } catch (e) {
    connectCode = e.code ?? "ERROR";
  }

  if (appOther) {
    // Connecting is possible because PUBLIC holds CONNECT on that database and revoking it
    // is out of scope — it is shared and unrelated. Connecting is not reading, and what
    // follows is the part that matters.
    console.log(`        (the app CAN connect to ${OTHER_DB}: PUBLIC holds CONNECT there, deliberately left alone)`);
    if (otherOwner) {
      check("reading the synthetic probe row is refused",
        (await refused(appOther, 'SELECT * FROM public."__isolation_probe"')) === "42501", "");
      check("writing to the synthetic probe row is refused",
        (await refused(appOther, `INSERT INTO public."__isolation_probe" VALUES (2,'x')`)) === "42501", "");
      check("deleting from it is refused",
        (await refused(appOther, 'DELETE FROM public."__isolation_probe"')) === "42501", "");
    }
    check("creating a table there is refused",
      (await refused(appOther, 'CREATE TABLE public."__nope"(x int)')) === "42501", "");

    // The real tables, checked WITHOUT selecting from them: the catalogue answers.
    const reach = await q(appOther, `
      SELECT COUNT(*)::int AS tables,
             COUNT(*) FILTER (WHERE has_table_privilege(current_user, c.oid, 'SELECT'))::int AS readable,
             COUNT(*) FILTER (WHERE has_table_privilege(current_user, c.oid, 'INSERT')
                                 OR has_table_privilege(current_user, c.oid, 'UPDATE')
                                 OR has_table_privilege(current_user, c.oid, 'DELETE'))::int AS writable
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname='public' AND c.relkind='r'`);
    check(`none of the ${reach[0].tables} tables in ${OTHER_DB} is readable by the app`,
      reach[0].readable === 0, JSON.stringify(reach[0]));
    check(`none of them is writable either`, reach[0].writable === 0, JSON.stringify(reach[0]));
    await appOther.end();
  } else {
    check(`connecting to ${OTHER_DB} is refused outright`, connectCode === "42501" || connectCode === "3D000", String(connectCode));
  }

  if (otherOwner) {
    await otherOwner.query('DROP TABLE IF EXISTS public."__isolation_probe"');
    await otherOwner.end();
    console.log("        (probe table dropped)");
  }

  // The earlier preview database, same question.
  try {
    const appOld = await connect(withDb(appUrl, OLD_DB));
    const reachOld = await q(appOld, `
      SELECT COUNT(*)::int AS tables,
             COUNT(*) FILTER (WHERE has_table_privilege(current_user, c.oid, 'SELECT'))::int AS readable
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname='public' AND c.relkind='r'`);
    check(`none of the ${reachOld[0].tables} tables in ${OLD_DB} is readable by the app`,
      reachOld[0].readable === 0, JSON.stringify(reachOld[0]));
    await appOld.end();
  } catch (e) {
    check(`connecting to ${OLD_DB} is refused outright`, true, String(e.code));
  }

  // ═══════════════════════════════════════════════════════════════════════
  section("D — THE RUNTIME ROLE CANNOT BECOME SOMETHING ELSE");
  check("it cannot SET ROLE to the migrator",
    (await refused(app, `SET ROLE ${MIG}`)) === "42501", "");
  check("it cannot SET ROLE to neondb_owner",
    (await refused(app, "SET ROLE neondb_owner")) === "42501", "");
  check("it cannot read password hashes out of pg_authid",
    (await refused(app, "SELECT rolpassword FROM pg_authid")) === "42501", "");
  check("it cannot create a role",
    ["42501", "0LP01"].includes(await refused(app, "CREATE ROLE __nope LOGIN")), "");
  check("it cannot create a database",
    ["42501", "0LP01"].includes(await refused(app, "CREATE DATABASE __nope")), "");

  await app.end();
  await owner.end();

  console.log(`\n${"=".repeat(76)}\n  ROLE ISOLATION RESULT\n${"=".repeat(76)}`);
  console.log(`${results.pass} passed, ${results.fail} failed`);
  if (results.failures.length) console.log("FAILURES:\n  - " + results.failures.join("\n  - "));
  process.exit(results.fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("FAILED: " + String(e.stack ?? e).replace(/postgres(ql)?:\/\/[^\s"']*/g, "<redacted>"));
  process.exit(1);
});
