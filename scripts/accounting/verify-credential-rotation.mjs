#!/usr/bin/env node
/**
 * Post-rotation verification for the exposed neondb_owner credential (docs/accounting/CREDENTIAL_INCIDENT.md).
 *
 * Secrets are read ONLY from files named by environment variables. The script refuses to start
 * if any command-line argument or those variables look like a connection string, and it never
 * prints a URL, user name, password or server error text: only endpoint ids, verdicts and
 * SQLSTATE / error classes.
 *
 *   OLD_OWNER_URL_FILE=~/secure/old.url \
 *   NEW_OWNER_URL_FILE=~/secure/new-live.url \          (optional)
 *   ROTATION_TARGETS_FILE=scripts/accounting/rotation-targets.json \   (optional; default below)
 *     node scripts/accounting/verify-credential-rotation.mjs
 *
 * Verdict per target endpoint:
 *   PASS          the endpoint was reachable (TCP connect to host:port succeeded) AND the old
 *                 credential was rejected with an authentication error (SQLSTATE 28P01).
 *   FAIL          the old credential still logs in.
 *   INCONCLUSIVE  anything else: DNS failure, timeout, refused/unreachable port, TLS failure,
 *                 an error other than 28P01 (for example an unknown endpoint). A network failure
 *                 is never counted as revocation.
 * New credential (live branch): PASS only if it connects AND the server itself reports the
 * expected neon.endpoint_id, current_user and current_database().
 *
 * Exit: 0 all PASS · 1 any FAIL · 2 otherwise inconclusive · 64 usage/safety refusal.
 * Needs raw PostgreSQL egress (TCP 5432); run it where that exists (owner machine or an
 * authorised runner), not in a sandbox without it — there every target is INCONCLUSIVE.
 */
import { readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const { Client } = createRequire(path.join(ROOT, "package.json"))("pg");
const looksLikeUrl = (s) => typeof s === "string" && /[a-z]+:\/\//i.test(s);

// ---- safety: no secrets on the command line or directly in the environment ----
if (process.argv.slice(2).some(looksLikeUrl)) { console.error("Refusing: pass credentials only through *_FILE variables, never as arguments."); process.exit(64); }
for (const v of ["OLD_OWNER_URL", "NEW_OWNER_URL"]) if (process.env[v]) { console.error(`Refusing: ${v} is set directly; use ${v}_FILE.`); process.exit(64); }
for (const v of ["OLD_OWNER_URL_FILE", "NEW_OWNER_URL_FILE", "ROTATION_TARGETS_FILE"]) if (looksLikeUrl(process.env[v])) { console.error(`Refusing: ${v} must be a file path, not a URL.`); process.exit(64); }

const readUrl = (v) => {
  const f = process.env[v];
  if (!f) return null;
  if (!existsSync(f)) { console.error(`${v}: file not found.`); process.exit(64); }
  const s = readFileSync(f, "utf8").trim();
  try { return new URL(s); } catch { console.error(`${v}: file does not contain a valid URL.`); process.exit(64); }
};

// Default targets: every compute endpoint of production project dark-lab-61530722, from the
// Neon API (list_postgres_endpoints, 2026-09-27). Stable ids, not branch names.
const DEFAULT_TARGETS = [
  { endpoint: "ep-dawn-dust-aqn1u1uf", branch: "br-weathered-bread-aqais7hp", host: "ep-dawn-dust-aqn1u1uf.c-8.us-east-1.aws.neon.tech", port: 5432, live: true },
  { endpoint: "ep-jolly-feather-aqne6cp1", branch: "br-fragrant-poetry-aqd0ndyx", host: "ep-jolly-feather-aqne6cp1.c-8.us-east-1.aws.neon.tech", port: 5432 },
  { endpoint: "ep-wandering-leaf-aqjtuin5", branch: "br-bold-forest-aq3z2qjq", host: "ep-wandering-leaf-aqjtuin5.c-8.us-east-1.aws.neon.tech", port: 5432 },
  { endpoint: "ep-noisy-night-aq3qczk4", branch: "br-billowing-fire-aq5eyiku", host: "ep-noisy-night-aq3qczk4.c-8.us-east-1.aws.neon.tech", port: 5432 },
  { endpoint: "ep-lingering-wave-aqtxp32f", branch: "br-rough-violet-aq9nwnom", host: "ep-lingering-wave-aqtxp32f.c-8.us-east-1.aws.neon.tech", port: 5432 },
  { endpoint: "ep-proud-block-aq9mtqql", branch: "br-wild-credit-aqn8vqh6", host: "ep-proud-block-aq9mtqql.c-8.us-east-1.aws.neon.tech", port: 5432 },
];
const targets = process.env.ROTATION_TARGETS_FILE ? JSON.parse(readFileSync(process.env.ROTATION_TARGETS_FILE, "utf8")) : DEFAULT_TARGETS;

const oldUrl = readUrl("OLD_OWNER_URL_FILE");
const newUrl = readUrl("NEW_OWNER_URL_FILE");
if (!oldUrl) { console.error("OLD_OWNER_URL_FILE is required."); process.exit(64); }

const TIMEOUT = Number(process.env.ROTATION_TIMEOUT_MS ?? 15000);

/** Plain TCP reachability of host:port — proves the intended endpoint answered at all. */
function tcpReachable(host, port) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    const done = (ok, why) => { s.destroy(); resolve({ ok, why }); };
    s.setTimeout(TIMEOUT, () => done(false, "timeout"));
    s.once("connect", () => done(true));
    s.once("error", (e) => done(false, e.code ?? "network"));
  });
}

async function attempt(url, host, port) {
  const u = new URL(url.toString());
  u.hostname = host; u.port = String(port);
  const c = new Client({ connectionString: u.toString(), connectionTimeoutMillis: TIMEOUT, ssl: u.hostname === "127.0.0.1" || u.hostname === "localhost" ? undefined : { rejectUnauthorized: true } });
  try {
    await c.connect();
    const r = await c.query("select current_user as u, current_database() as d, current_setting('neon.endpoint_id', true) as ep");
    return { connected: true, ...r.rows[0] };
  } catch (e) {
    return { connected: false, code: e.code ?? null, cls: e.code ? "sqlstate" : (e.message?.includes("timeout") ? "timeout" : "network") };
  } finally {
    await c.end().catch(() => {});
  }
}

export function classifyOld(reach, res) {
  if (!reach.ok) return { verdict: "INCONCLUSIVE", detail: `endpoint not reachable (${reach.why})` };
  if (res.connected) return { verdict: "FAIL", detail: "old credential still logs in" };
  if (res.code === "28P01") return { verdict: "PASS", detail: "authentication rejected (28P01)" };
  return { verdict: "INCONCLUSIVE", detail: res.code ? `sqlstate ${res.code} (not an authentication rejection)` : res.cls };
}

const rows = [];
for (const t of targets) {
  const reach = await tcpReachable(t.host, t.port);
  const res = reach.ok ? await attempt(oldUrl, t.host, t.port) : { connected: false, cls: "skipped" };
  rows.push({ check: "old credential revoked", endpoint: t.endpoint, branch: t.branch, ...classifyOld(reach, res) });
}
if (newUrl) {
  const live = targets.find((t) => t.live) ?? targets[0];
  const reach = await tcpReachable(live.host, live.port);
  const res = reach.ok ? await attempt(newUrl, live.host, live.port) : { connected: false, cls: "skipped" };
  const expectedEp = process.env.EXPECT_ENDPOINT_ID ?? live.endpoint;
  let verdict, detail;
  if (!reach.ok) { verdict = "INCONCLUSIVE"; detail = `endpoint not reachable (${reach.why})`; }
  else if (!res.connected) { verdict = "FAIL"; detail = res.code ? `sqlstate ${res.code}` : res.cls; }
  else if (res.ep !== expectedEp && !(process.env.EXPECT_ENDPOINT_ID === "" && res.ep === null)) { verdict = "FAIL"; detail = "server reports a different endpoint id"; }
  else if (res.u !== (process.env.EXPECT_USER ?? "neondb_owner") || res.d !== (process.env.EXPECT_DB ?? "neondb")) { verdict = "FAIL"; detail = "unexpected user or database"; }
  else { verdict = "PASS"; detail = "connected; server identity matches"; }
  rows.push({ check: "new credential works", endpoint: live.endpoint, branch: live.branch, verdict, detail });
}
console.table(rows);
console.log("Branches without a compute endpoint (br-cold-wave, br-fancy-unit, br-quiet-sky, br-crimson-glitter) cannot be probed; verify them by role metadata after the reset and treat them as exposed until then.");
process.exit(rows.some((r) => r.verdict === "FAIL") ? 1 : rows.every((r) => r.verdict === "PASS") ? 0 : 2);
