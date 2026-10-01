#!/usr/bin/env node
/**
 * Classify every database URL in one or more env files WITHOUT connecting and WITHOUT printing
 * any credential. Intended for the output of `vercel env pull --environment=<target>
 * [--git-branch=<branch>] <tmpfile>` on the owner's machine, and for local .env files.
 *
 *   node scripts/accounting/classify-db-urls.mjs /tmp/vercel-preview.env [.env ...]
 *
 * Prints, per variable holding a postgres URL: role, endpoint id, Neon project/branch identity
 * (from the stable identifiers below, never from branch names), database, whether a password is
 * present, and a verdict. Exit code 2 when any Preview-side file carries a production credential.
 */
import { existsSync, readFileSync } from "node:fs";

// Stable identifiers verified through the Neon API on 2026-09-27 (docs/accounting/CREDENTIAL_INCIDENT.md).
export const ENDPOINTS = {
  "ep-dawn-dust-aqn1u1uf": { project: "dark-lab-61530722", branch: "br-weathered-bread-aqais7hp", cls: "PRODUCTION-LIVE" },
  "ep-jolly-feather-aqne6cp1": { project: "dark-lab-61530722", branch: "br-fragrant-poetry-aqd0ndyx", cls: "PRODUCTION-PROJECT (branch named 'production', not live)" },
  "ep-wandering-leaf-aqjtuin5": { project: "dark-lab-61530722", branch: "br-bold-forest-aq3z2qjq", cls: "PRODUCTION-PROJECT (copy: erp-regression-r1)" },
  "ep-proud-block-aq9mtqql": { project: "dark-lab-61530722", branch: "br-wild-credit-aqn8vqh6", cls: "PRODUCTION-PROJECT (archived copy)" },
  "ep-noisy-night-aq3qczk4": { project: "dark-lab-61530722", branch: "br-billowing-fire-aq5eyiku", cls: "PRODUCTION-PROJECT (copy: accounting rehearsal)" },
  "ep-lingering-wave-aqtxp32f": { project: "dark-lab-61530722", branch: "br-rough-violet-aq9nwnom", cls: "PRODUCTION-PROJECT (copy: finance/sales rehearsal)" },
  "ep-plain-field-awqkif28": { project: "dry-smoke-16360248", branch: "br-withered-art-aw2zp5kr", cls: "TEST-PROJECT (accounting preview)" },
};

const parse = (f) => {
  const out = {};
  for (const line of readFileSync(f, "utf8").split(/\r?\n/)) {
    const m = /^(?:export\s+)?([A-Za-z0-9_]+)=["']?(.*?)["']?$/.exec(line.trim());
    if (m) out[m[1]] = m[2];
  }
  return out;
};

export function classifyUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { return null; }
  if (!/^postgres(ql)?:$/.test(u.protocol)) return null;
  const endpoint = /neon\.tech$/.test(u.hostname) ? u.hostname.split(".")[0].replace(/-pooler$/, "") : u.hostname;
  const known = ENDPOINTS[endpoint];
  const role = decodeURIComponent(u.username);
  let cls = known?.cls;
  if (!cls) cls = /neon\.tech$/.test(u.hostname) ? "UNKNOWN NEON ENDPOINT — review" : ["127.0.0.1", "localhost"].includes(u.hostname) ? "LOCAL" : "OTHER HOST — review";
  const production = known?.project === "dark-lab-61530722";
  return {
    role, endpoint, pooled: /-pooler\./.test(u.hostname), project: known?.project ?? "?", branch: known?.branch ?? "?",
    database: u.pathname.slice(1), password: u.password ? "present" : "absent", cls,
    ownerCredential: production && role === "neondb_owner",
    production,
  };
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const files = process.argv.slice(2);
  if (!files.length) { console.error("usage: classify-db-urls.mjs <env file> [...]"); process.exit(64); }
  let bad = false;
  for (const f of files) {
    if (!existsSync(f)) { console.log(`${f}: missing`); continue; }
    const env = parse(f);
    const preview = /preview|development/i.test(f) || env.VERCEL_ENV === "preview";
    const rows = [];
    for (const [k, v] of Object.entries(env)) {
      const c = classifyUrl(v);
      if (!c) continue;
      let verdict = "ok";
      if (c.ownerCredential) verdict = "EXPOSED OWNER CREDENTIAL (production project) — rotate/replace";
      if (preview && c.production) { verdict = "PRODUCTION DATABASE IN PREVIEW — remove"; bad = true; }
      rows.push({ var: k, role: c.role, endpoint: c.endpoint, pooled: c.pooled, project: c.project, branch: c.branch, database: c.database, password: c.password, class: c.cls, verdict });
    }
    console.log(`\n${f}${preview ? " (treated as Preview)" : ""}`);
    if (rows.length) console.table(rows); else console.log("  no postgres URLs");
  }
  process.exit(bad ? 2 : 0);
}
