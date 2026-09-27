// The one hosted database the accounting preview may write to (synthetic data only).
// Neon project "hiqbah-erp-test" (dry-smoke-16360248), branch "preview-accounting-ledger-core"
// (br-withered-art-aw2zp5kr), endpoint ep-plain-field-awqkif28, database accounting_preview.
//
// How identity is established, strongest first — ALL must pass before migrate, reset or seed:
//   1. Explicit allowlist (ALLOWLIST below): the URL's host must be exactly one of the endpoint's
//      two hostnames as published by the Neon API, and the database must be accounting_preview.
//      Production endpoints are refused by name as a second rail.
//   2. Authoritative control-plane metadata (neonMetadataProblems): the Neon API, called with a
//      NEON_API_KEY, must report that this endpoint belongs to the allow-listed project and branch,
//      that its hosts equal the URL's host, that the project is not the production project, and that
//      the database exists on that branch. No key, no network, or any mismatch → refuse (fail closed).
//   3. Server-reported settings (identityProblems): neon.project_id / neon.branch_id /
//      neon.endpoint_id and current_database(). Set by Neon's compute configuration; supporting
//      evidence only — not proven to be immune to a session-level override.
//   4. The 'hiqbah-finance-disposable' database comment: a manually placed secondary guard. No script
//      in this repository creates it on a hosted database, and it never substitutes for 1–3.
// Names (branch names, database comments) are never treated as proof of identity.
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PREVIEW = {
  project: "dry-smoke-16360248",
  branch: "br-withered-art-aw2zp5kr",
  endpoint: "ep-plain-field-awqkif28",
  database: "accounting_preview",
  marker: "hiqbah-finance-disposable",
};
export const PRODUCTION_PROJECT = "dark-lab-61530722";

// Hostnames exactly as returned by the Neon API (list endpoints, project dry-smoke-16360248, 2026-09-27).
export const ALLOWLIST = [{
  project: PREVIEW.project, branch: PREVIEW.branch, endpoint: PREVIEW.endpoint, database: PREVIEW.database,
  hosts: ["ep-plain-field-awqkif28.c-12.us-east-1.aws.neon.tech", "ep-plain-field-awqkif28-pooler.c-12.us-east-1.aws.neon.tech"],
}];
const DENIED = ["ep-dawn-dust-aqn1u1uf", "ep-jolly-feather-aqne6cp1", "ep-icy-field-aq4upc3z", "ep-noisy-night-aq3qczk4", "ep-wandering-leaf-aqjtuin5", "ep-lingering-wave-aqtxp32f", "ep-proud-block-aq9mtqql"];

export function isPreviewTarget(rawUrl) {
  let u;
  try { u = new URL(rawUrl ?? ""); } catch { return false; }
  if (DENIED.some((e) => u.hostname.includes(e))) return false;
  const db = u.pathname.replace(/^\//, "");
  const allowed = ALLOWLIST.some((a) => a.hosts.includes(u.hostname) && a.database === db);
  return allowed && process.env.ACCOUNTING_PREVIEW_DB === PREVIEW.database;
}

export const IDENTITY_SQL = `SELECT current_database() AS db,
  current_setting('neon.project_id', true) AS project,
  current_setting('neon.branch_id', true) AS branch,
  current_setting('neon.endpoint_id', true) AS endpoint,
  shobj_description(d.oid, 'pg_database') AS marker
FROM pg_database d WHERE d.datname = current_database()`;

/** Pure check of the row returned by IDENTITY_SQL. Returns a list of problems (empty = ok). */
export function identityProblems(row) {
  if (!row) return ["identity query returned nothing"];
  const p = [];
  if (row.project === PRODUCTION_PROJECT) p.push("server reports the PRODUCTION project");
  if (row.project !== PREVIEW.project) p.push(`server project is not ${PREVIEW.project}`);
  if (row.branch !== PREVIEW.branch) p.push(`server branch is not ${PREVIEW.branch}`);
  if (row.endpoint !== PREVIEW.endpoint) p.push(`server endpoint is not ${PREVIEW.endpoint}`);
  if (row.db !== PREVIEW.database) p.push(`current_database() is not ${PREVIEW.database}`);
  if (row.marker !== PREVIEW.marker) p.push("database is not marked disposable");
  return p;
}

/**
 * Pure check of the Neon API responses against the allowlist and the URL.
 * endpoint = GET /projects/{project}/endpoints/{endpoint} → .endpoint
 * databases = GET /projects/{project}/branches/{branch}/databases → .databases
 */
export function neonMetadataProblems(urlHost, endpoint, databases) {
  const a = ALLOWLIST.find((x) => x.hosts.includes(urlHost));
  if (!a) return ["URL host is not on the allowlist"];
  if (!endpoint) return ["Neon API returned no endpoint"];
  const p = [];
  if (endpoint.project_id === PRODUCTION_PROJECT) p.push("Neon API reports the PRODUCTION project");
  if (endpoint.id !== a.endpoint) p.push("Neon API endpoint id differs from the allowlist");
  if (endpoint.project_id !== a.project) p.push("Neon API project differs from the allowlist");
  if (endpoint.branch_id !== a.branch) p.push("Neon API branch differs from the allowlist");
  const apiHosts = [endpoint.host, endpoint.hosts?.read_write_host, endpoint.hosts?.read_write_pooled_host].filter(Boolean);
  if (!apiHosts.includes(urlHost)) p.push("URL host is not a host Neon reports for this endpoint");
  if (!Array.isArray(databases) || !databases.some((d) => d.name === a.database)) p.push(`database ${a.database} not found on the allow-listed branch`);
  return p;
}

/** Calls the Neon API (HTTPS console.neon.tech). Throws — fail closed — on any problem. */
export async function assertNeonMetadata(rawUrl, label = "database") {
  const key = process.env.NEON_API_KEY;
  if (!key) throw new Error(`Refusing (${label}): NEON_API_KEY is not set, so the endpoint cannot be verified against Neon's metadata.`);
  const u = new URL(rawUrl);
  const a = ALLOWLIST.find((x) => x.hosts.includes(u.hostname));
  if (!a) throw new Error(`Refusing (${label}): URL host is not on the allowlist.`);
  const api = process.env.NEON_API_BASE ?? "https://console.neon.tech/api/v2";
  const get = async (p) => {
    let r;
    try { r = await fetch(`${api}${p}`, { headers: { Accept: "application/json", Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15000) }); }
    catch { throw new Error(`Refusing (${label}): Neon API unreachable; identity cannot be verified.`); }
    if (!r.ok) throw new Error(`Refusing (${label}): Neon API answered ${r.status}; identity cannot be verified.`);
    return r.json();
  };
  const ep = (await get(`/projects/${a.project}/endpoints/${a.endpoint}`)).endpoint;
  const dbs = (await get(`/projects/${a.project}/branches/${a.branch}/databases`)).databases;
  const problems = neonMetadataProblems(u.hostname, ep, dbs);
  if (problems.length) throw new Error(`Refusing (${label}): ${problems.join("; ")}.`);
  return { project: ep.project_id, branch: ep.branch_id, endpoint: ep.id };
}

/** Connects with `url` and throws unless the server identifies as the preview target. */
export async function assertPreviewIdentity(url, label = "database", { skipUrlCheck = false } = {}) {
  if (!skipUrlCheck && !isPreviewTarget(url)) throw new Error(`Refusing: ${label} URL is not the accounting preview target.`);
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const { Client } = createRequire(path.join(root, "package.json"))("pg");
  const c = new Client({ connectionString: url, connectionTimeoutMillis: 20000 });
  try {
    await c.connect();
    const { rows } = await c.query(IDENTITY_SQL);
    const problems = identityProblems(rows[0]);
    if (problems.length) throw new Error(`Refusing (${label}): ${problems.join("; ")}.`);
    return rows[0];
  } finally {
    await c.end().catch(() => {});
  }
}
