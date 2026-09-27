// Runs a tool against the isolated Sales CRM Preview database AS THE RESTRICTED RUNTIME ROLE,
// and refuses everything else.
//
// Three things must all hold on every connection variable, not one of them:
//
//   1. the endpoint is the approved non-production one,
//   2. the database is the isolated one,
//   3. the ROLE is the restricted runtime role.
//
// (3) is the new condition and it is the important one. The previous guard checked where a
// connection pointed but not who it connected as, so it would have happily started the
// application with `neondb_owner` — a role that is a member of neon_superuser and therefore of
// pg_read_all_data and pg_write_all_data, i.e. able to read and write every table in every
// database on the branch. It also means this guard REFUSES the migration credential in the
// application runtime rather than trusting a convention.
//
// An allowlist, not a denylist: an unrecognised endpoint, database or role is refused. The
// three known production identifiers are denied as well, as a second line and never as the
// only one. Never prints a value.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const require_ = createRequire(ROOT + "/package.json");
const ENVFILE = process.env.PREVIEW_ENV;
if (!ENVFILE) { console.error("REFUSE: PREVIEW_ENV is not set"); process.exit(3); }

const env = { ...process.env };
for (const line of readFileSync(ENVFILE, "utf8").split(/\r?\n/)) {
  const t = line.trim();
  if (!t || t.startsWith("#")) continue;
  const i = t.indexOf("=");
  if (i < 0) continue;
  let v = t.slice(i + 1);
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
  env[t.slice(0, i).trim()] = v;
}

const ALLOWED_ENDPOINT = "ep-wandering-leaf-aqjtuin5";
const ALLOWED_DATABASE = "sales_preview";
const ALLOWED_ROLE = "sales_preview_app";
const FORBIDDEN_ROLES = ["neondb_owner", "cloud_admin", "neon_service", "sales_preview_migrator"];
const DENIED_ENDPOINTS = ["ep-dawn-dust-aqn1u1uf", "ep-jolly-feather-aqne6cp1", "ep-icy-field-aq4upc3z"];

const PATHS = ["DATABASE_URL", "DIRECT_URL", "SHADOW_DATABASE_URL", "ERP_TEST_DATABASE_URL", "POSTGRES_URL"];
let checked = 0;
for (const k of PATHS) {
  const raw = env[k];
  if (!raw) continue;
  checked++;

  for (const bad of DENIED_ENDPOINTS) {
    if (raw.includes(bad)) { console.error(`REFUSE: ${k} names a protected endpoint`); process.exit(3); }
  }

  // Parsed rather than pattern-matched, so the role and database checked here are the ones
  // the driver will actually use — a substring test can be fooled by a query parameter.
  let u;
  try { u = new URL(raw); } catch { console.error(`REFUSE: ${k} is not a usable connection string`); process.exit(3); }

  if (!u.hostname.startsWith(ALLOWED_ENDPOINT)) {
    console.error(`REFUSE: ${k} is not the approved preview endpoint`); process.exit(3);
  }
  if (u.pathname.replace(/^\//, "") !== ALLOWED_DATABASE) {
    console.error(`REFUSE: ${k} is not the approved preview database`); process.exit(3);
  }
  if (FORBIDDEN_ROLES.includes(u.username)) {
    console.error(`REFUSE: ${k} uses a privileged or migration role; the runtime must use ${ALLOWED_ROLE}`);
    process.exit(3);
  }
  if (u.username !== ALLOWED_ROLE) {
    console.error(`REFUSE: ${k} is not the approved restricted runtime role`); process.exit(3);
  }
}
if (checked === 0) { console.error("REFUSE: no database URL is configured at all"); process.exit(3); }

// The sandbox collection adapter is a non-production facility, gated on this in addition to
// its own server-side checks.
env.SALES_SANDBOX_COLLECTIONS = "true";

const argv = process.argv.slice(2);
const tool = argv[0];
const rest = argv.slice(1);
let cmd, args;
if (tool === "next") { cmd = process.execPath; args = [require_.resolve("next/dist/bin/next"), ...rest]; }
else if (tool === "node") { cmd = process.execPath; args = [...rest]; }
else if (tool === "playwright") { cmd = process.execPath; args = [ROOT + "/node_modules/@playwright/test/cli.js", ...rest]; }
else if (tool === "prisma") {
  // Deliberately refused. Schema changes belong to the migration identity and its own guard;
  // letting the runtime wrapper run prisma would be the hole this separation exists to close.
  console.error("REFUSE: migrations do not run under the runtime identity — use withmigrate.mjs");
  process.exit(3);
}
else { console.error(`withpreview: unknown tool "${tool}"`); process.exit(2); }

const child = spawn(cmd, args, { stdio: "inherit", env, shell: false, cwd: ROOT });
child.on("exit", (code, sig) => process.exit(code ?? (sig ? 1 : 1)));
