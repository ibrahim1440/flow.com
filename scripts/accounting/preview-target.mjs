// The one hosted database the accounting preview may write to (synthetic data only).
// Neon project "hiqbah-erp-test" (dry-smoke-16360248), branch "preview-accounting-ledger-core"
// (br-withered-art-aw2zp5kr), database accounting_preview, marked 'hiqbah-finance-disposable'.
// Production endpoints are refused by name as a second rail.
//
// Two layers: isPreviewTarget() checks the URL before any connection; assertPreviewIdentity()
// connects and checks what the SERVER reports (Neon's neon.project_id / neon.branch_id /
// neon.endpoint_id settings, current_database() and the database comment). Both must pass before
// any migrate, reset or seed. Names are never trusted — only stable ids.
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
const DENIED = ["ep-dawn-dust-aqn1u1uf", "ep-jolly-feather-aqne6cp1", "ep-icy-field-aq4upc3z", "ep-noisy-night-aq3qczk4", "ep-wandering-leaf-aqjtuin5", "ep-lingering-wave-aqtxp32f", "ep-proud-block-aq9mtqql"];

export function isPreviewTarget(rawUrl) {
  let u;
  try { u = new URL(rawUrl ?? ""); } catch { return false; }
  if (DENIED.some((e) => u.hostname.includes(e))) return false;
  return u.hostname.startsWith(PREVIEW.endpoint) && u.pathname.replace(/^\//, "") === PREVIEW.database && process.env.ACCOUNTING_PREVIEW_DB === PREVIEW.database;
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
