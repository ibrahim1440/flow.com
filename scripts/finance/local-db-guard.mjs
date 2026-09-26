/**
 * Refuse to write unless the target is explicitly THIS disposable finance database.
 *
 * Every condition must hold — any one alone (a local-looking URL, NODE_ENV, a database name)
 * is not proof enough:
 *   1. the URL is PostgreSQL on 127.0.0.1/localhost, port 54329 (the portable server);
 *   2. the URL mentions no known shared endpoint and no hosted provider domain;
 *   3. the database name is one of the two disposable names AND equals the one the caller
 *      expects;
 *   4. the operator declared it: FIN_DISPOSABLE_DB must equal that database name;
 *   5. the server itself says so: the database carries the comment
 *      'hiqbah-finance-disposable' (set only by scripts/finance/local-postgres.mjs), and
 *      current_database() matches.
 * Nothing is printed except the problem; no URL, user or password is ever echoed.
 */
export const MARKER = "hiqbah-finance-disposable";
export const DISPOSABLE_DATABASES = ["erp_finance_dev", "erp_finance_test"];
/** Shared Neon endpoints named in project documents. ep-dawn-dust is treated as production. */
export const SHARED_ENDPOINTS = ["ep-dawn-dust-aqn1u1uf", "ep-icy-field-aq4upc3z", "ep-wandering-leaf-aqjtuin5", "ep-jolly-feather-aqne6cp1"];

export function checkUrl(rawUrl, expectedDb, env = process.env) {
  const problems = [];
  let u;
  try { u = new URL(rawUrl ?? ""); } catch { return ["DATABASE_URL is not a valid URL."]; }
  if (!["postgres:", "postgresql:"].includes(u.protocol)) problems.push("not a PostgreSQL URL");
  if (!["127.0.0.1", "localhost"].includes(u.hostname)) problems.push("host is not the local loopback server");
  if (u.port !== "54329") problems.push("port is not the portable server's 54329");
  const lower = String(rawUrl).toLowerCase();
  if (SHARED_ENDPOINTS.some((ep) => lower.includes(ep)) || /neon\.tech|supabase|amazonaws|vercel/.test(lower)) problems.push("URL names a shared/hosted database");
  const db = u.pathname.replace(/^\//, "");
  if (!DISPOSABLE_DATABASES.includes(db)) problems.push("database is not one of the disposable finance databases");
  if (db !== expectedDb) problems.push(`database is not the expected ${expectedDb}`);
  if (env.FIN_DISPOSABLE_DB !== expectedDb) problems.push(`FIN_DISPOSABLE_DB is not set to ${expectedDb}`);
  return problems;
}

/** `query(sql)` must run SQL on the same connection the caller will write with. */
export async function assertDisposableFinanceDb({ url, expectedDb, query, env = process.env }) {
  const problems = checkUrl(url, expectedDb, env);
  if (problems.length === 0) {
    const rows = await query("SELECT current_database() AS db, shobj_description(oid, 'pg_database') AS marker FROM pg_database WHERE datname = current_database()");
    const r = rows?.[0];
    if (!r || r.db !== expectedDb) problems.push("connected database does not match");
    if (!r || r.marker !== MARKER) problems.push("database is not marked as disposable by scripts/finance/local-postgres.mjs");
  }
  if (problems.length) {
    throw new Error(`Refusing to write: ${problems.join("; ")}. This command only runs against the local disposable ${expectedDb}.`);
  }
}
