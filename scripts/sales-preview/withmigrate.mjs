// Runs a SCHEMA CHANGE against the isolated Sales CRM Preview database as the migration
// identity, and refuses everything else.
//
// The mirror image of withpreview.mjs: the same endpoint and database, but the migration role
// instead of the runtime one — and it will only launch `prisma`. It cannot start the
// application, so the migration credential has no path into the running app even by mistake.
//
// Never prints a value.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const require_ = createRequire(ROOT + "/package.json");
const ENVFILE = process.env.MIGRATE_ENV;
if (!ENVFILE) { console.error("REFUSE: MIGRATE_ENV is not set"); process.exit(3); }

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
const ALLOWED_ROLE = "sales_preview_migrator";
const DENIED_ENDPOINTS = ["ep-dawn-dust-aqn1u1uf", "ep-jolly-feather-aqne6cp1", "ep-icy-field-aq4upc3z"];

const PATHS = ["DATABASE_URL", "DIRECT_URL", "SHADOW_DATABASE_URL", "POSTGRES_URL"];
let checked = 0;
for (const k of PATHS) {
  const raw = env[k];
  if (!raw) continue;
  checked++;
  for (const bad of DENIED_ENDPOINTS) {
    if (raw.includes(bad)) { console.error(`REFUSE: ${k} names a protected endpoint`); process.exit(3); }
  }
  let u;
  try { u = new URL(raw); } catch { console.error(`REFUSE: ${k} is not a usable connection string`); process.exit(3); }
  if (!u.hostname.startsWith(ALLOWED_ENDPOINT)) { console.error(`REFUSE: ${k} is not the approved endpoint`); process.exit(3); }
  if (u.pathname.replace(/^\//, "") !== ALLOWED_DATABASE) { console.error(`REFUSE: ${k} is not the approved database`); process.exit(3); }
  if (u.username !== ALLOWED_ROLE) { console.error(`REFUSE: ${k} is not the migration role`); process.exit(3); }
}
if (checked === 0) { console.error("REFUSE: no database URL is configured at all"); process.exit(3); }

const argv = process.argv.slice(2);
const tool = argv[0];
if (tool !== "prisma") {
  console.error("REFUSE: the migration identity runs prisma and nothing else");
  process.exit(3);
}

const child = spawn(process.execPath, [require_.resolve("prisma/build/index.js"), ...argv.slice(1)], {
  stdio: "inherit", env, shell: false, cwd: ROOT,
});
child.on("exit", (code, sig) => process.exit(code ?? (sig ? 1 : 1)));
