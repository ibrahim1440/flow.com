// Shared harness for the backend regression suites.
//
// These suites write freely: they create orders, consume stock, force concurrency and
// deliberately attempt invalid operations. That is only acceptable against a throwaway
// test or demo database, so this module refuses to start anywhere it cannot positively
// identify as approved test infrastructure.
//
// ── Why a dedicated variable, and not DATABASE_URL ────────────────────────────
// The application reads DATABASE_URL, and on any machine where the app has been run that
// variable points at real data. If these suites read it too, a shell that happens to have
// it exported would run destructive tests against production. They read
// ERP_TEST_DATABASE_URL instead and never look at DATABASE_URL at all, so there is no
// fall-back path to production — the tests simply cannot reach it.
import { createRequire } from "node:module";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { guardClient } from "../identity-guard.mjs";
// Pure arithmetic, no imports of its own — safe to load before the safety rails below.
// The `free` figure every suite reads is computed by this module so that
// harness-selftest.mjs proves the SHIPPED path rather than a copy of it.
import { freeUnits } from "./oversell.mjs";

// Resolved from this file's own location so the suites run from any checkout — a clean
// clone, a CI workspace, a git worktree — rather than from one developer's directory.
const require_ = createRequire(import.meta.url);
export const { Client } = require_("pg");
const bcrypt = require_("bcryptjs");

export const HERE = path.dirname(fileURLToPath(import.meta.url));

// ── Safety rails ─────────────────────────────────────────────────────────────

export const DB_URL = process.env.ERP_TEST_DATABASE_URL;
export const BASE = process.env.ERP_TEST_BASE_URL;

/**
 * Database names these suites are allowed to touch.
 *
 * Fail-closed by construction: the name must MATCH one of these, so a database this list
 * has never heard of is refused rather than allowed. Override for your own throwaway
 * database with ERP_TEST_DB_ALLOWLIST as a comma-separated list of exact names.
 */
const DEFAULT_ALLOWLIST = ["erp_mvp_test", "erp_test", "erp_e2e", "erp_demo"];
const ALLOWLIST = (process.env.ERP_TEST_DB_ALLOWLIST ?? DEFAULT_ALLOWLIST.join(","))
  .split(",").map((s) => s.trim()).filter(Boolean);

function refuse(reason) {
  console.error(`\nREFUSING TO RUN: ${reason}\n`);
  console.error("These suites create, mutate and delete data. They require an explicitly");
  console.error("nominated throwaway database. Set:");
  console.error("  ERP_TEST_DATABASE_URL   a connection string whose database name is one of:");
  console.error(`                          ${ALLOWLIST.join(", ")}`);
  console.error("  ERP_TEST_BASE_URL       the running test server, e.g. http://localhost:3010");
  console.error("  ERP_TEST_ADMIN_PIN      the seeded administrator PIN for that database");
  console.error("  PIN_LOOKUP_SECRET       the same value the test server is running with");
  console.error("");
  process.exit(2);
}

if (!DB_URL) refuse("ERP_TEST_DATABASE_URL is not set.");
if (!BASE) refuse("ERP_TEST_BASE_URL is not set.");

let dbName;
try {
  dbName = new URL(DB_URL).pathname.replace(/^\//, "").split("?")[0];
} catch {
  refuse("ERP_TEST_DATABASE_URL is not a valid connection URL.");
}
if (!dbName) refuse("ERP_TEST_DATABASE_URL names no database.");
if (!ALLOWLIST.includes(dbName)) {
  refuse(
    `database "${dbName}" is not on the approved test allowlist (${ALLOWLIST.join(", ")}).\n` +
    "  If this really is a throwaway database, add its name to ERP_TEST_DB_ALLOWLIST."
  );
}

// The PIN is a credential, even for a seeded demo account, so it is supplied by the
// environment rather than written into the repository.
export const ADMIN_PIN = process.env.ERP_TEST_ADMIN_PIN;
if (!ADMIN_PIN) refuse("ERP_TEST_ADMIN_PIN is not set.");

// ── The PIN lookup secret ──────────────────────────────────────────
//
// PIN login finds its row by HMAC-SHA256 over the candidate, keyed by a secret the
// database does not contain. These suites both seed employees and log in as them, so they
// have to produce the same selector the server will search for — which means running with
// the server’s own secret. A different value here is not a failing test, it is a
// suite that cannot log in at all, so it is refused up front with the other rails rather
// than discovered as twenty red suites.
//
// Deliberately NOT defaulted. A fixture secret invented here would authenticate against a
// server that has a real one only by accident.
export const PIN_LOOKUP_SECRET = process.env.PIN_LOOKUP_SECRET;
if (!PIN_LOOKUP_SECRET) refuse("PIN_LOOKUP_SECRET is not set.");
if (PIN_LOOKUP_SECRET.trim().length < 32) {
  refuse("PIN_LOOKUP_SECRET is shorter than the 32 characters the application requires.");
}

/**
 * The selector and the verifier input for a PIN — Secure Version B.
 *
 * These mirror pinLookup() and pinVerifierInput() in src/lib/pin-lookup.ts — same domains,
 * same digests, same encoding — because these suites are plain .mjs and cannot import the
 * TypeScript module. harness-selftest.mjs reads that file and fails if either side drifts, so
 * the duplication cannot silently stop matching.
 *
 * pinLookupValue is the keyed selector login searches on. pinVerifierInput is what bcrypt
 * hashes: the fixtures store bcrypt(pinVerifierInput(pin)) in Employee.pin, exactly as the
 * application's own credential paths do, so a fixture never stores a state the server cannot
 * produce and the raw PIN never verifies directly.
 */
export function pinLookupValue(pin, secret = PIN_LOOKUP_SECRET.trim()) {
  return createHmac("sha256", secret).update("pin:lookup:v1:" + pin).digest("base64");
}

export function pinVerifierInput(pin, secret = PIN_LOOKUP_SECRET.trim()) {
  return createHmac("sha384", secret).update("pin:verify:v1:" + pin).digest("base64");
}

const rawDb = new Client({ connectionString: DB_URL });

// The same pre-execution identity guard the Playwright layer uses. One rule, one file.
export const db = guardClient(rawDb, "the regression harness");

// ── Reporting ────────────────────────────────────────────────────────────────
export const results = { pass: 0, fail: 0, failures: [], issues: [] };

export function check(name, ok, detail = "") {
  if (ok) { results.pass++; console.log("  [PASS] " + name); }
  else { results.fail++; results.failures.push(name); console.log("  [FAIL] " + name + (detail ? "  << " + detail : "")); }
  return ok;
}

export function issue(severity, title, detail) {
  results.issues.push({ severity, title, detail });
  console.log(`  [${severity}] ${title} — ${detail}`);
}

export const section = (t) => console.log("\n" + "=".repeat(78) + "\n  " + t + "\n" + "=".repeat(78));
export const sub = (t) => console.log("\n── " + t + " " + "─".repeat(Math.max(0, 60 - t.length)));

export const one = async (sql, p) => (await db.query(sql, p)).rows[0];
export const all = async (sql, p) => (await db.query(sql, p)).rows;
export const num = (v) => (v === null || v === undefined ? NaN : Number(v));
export const near = (a, b, tol = 0.0005) => Math.abs(Number(a) - Number(b)) < tol;

// ── HTTP ─────────────────────────────────────────────────────────────────────
let cookie = "";

// ── Idempotency keys for dispatch ─────────────────────────────────────
//
// POST /api/deliveries now refuses a request that carries no Idempotency-Key, because a
// dispatch the server cannot recognise on a retry is a dispatch it may perform twice.
// Every existing call site here is a separate intended shipment, so each gets its own
// fresh key — which is exactly what a correct client does and leaves what those suites
// assert untouched: a second POST is still a second dispatch, judged by the quantity
// guards as before.
//
// It is a default, not a rule. A caller that passes headers["Idempotency-Key"] keeps its
// own value (that is how a replay is expressed), and one that passes noIdempotencyKey
// sends none at all (that is how the refusal itself is tested). Auto-minting therefore
// cannot hide either behaviour from the suite that exists to prove them.
let keySeq = 0;
export function freshIdempotencyKey(tag = "e2e") {
  return `${tag}-${process.pid}-${Date.now().toString(36)}-${++keySeq}`;
}

export async function api(
  path,
  { method = "GET", body, raw = false, headers = {}, noIdempotencyKey = false } = {}
) {
  const needsKey =
    method === "POST" &&
    path.split("?")[0] === "/api/deliveries" &&
    !noIdempotencyKey &&
    !Object.keys(headers).some((h) => h.toLowerCase() === "idempotency-key");

  const res = await fetch(BASE + path, {
    method,
    headers: {
      "content-type": "application/json",
      ...(cookie ? { cookie } : {}),
      ...(needsKey ? { "Idempotency-Key": freshIdempotencyKey() } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "manual",
  });
  for (const c of res.headers.getSetCookie?.() ?? []) if (c.startsWith("token=")) cookie = c.split(";")[0];
  const text = await res.text();
  if (raw) return { status: res.status, text };
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, json };
}

export function setCookie(c) { cookie = c; }
export function getCookie() { return cookie; }

export async function concurrently(n, fn) {
  return Promise.all(Array.from({ length: n }, (_, i) => fn(i)));
}

/**
 * A fixture employee who can actually log in — Secure Version B shape.
 *
 * The two live credential columns are written together, exactly as the application’s own
 * credential-setting paths now do: pin = bcrypt(pinVerifierInput(pin)), the proof over the
 * keyed derivation and never the raw PIN, and pinLookup, the keyed selector login searches
 * on. The legacy pinHash is deliberately left NULL — the application writes it on no path
 * under Version B, so a fixture that set it would be testing a state the server cannot
 * produce.
 *
 * The conflict branch refreshes the verifier and the lookup together. Leaving a stale
 * lookup beside a fresh verifier is precisely the desynchronisation that makes an account
 * unreachable, and a suite re-run on a dirty database would inherit it.
 */
export async function ensureUser(id, name, role, perms, pin) {
  await db.query(
    `INSERT INTO "Employee" (id,name,pin,"pinLookup",role,permissions,"defaultRoute",active,"preferredLanguage","createdAt","updatedAt")
     VALUES ($1,$2,$3,$4,$5,$6,'/dashboard',true,'en',now(),now())
     ON CONFLICT (id) DO UPDATE SET permissions=EXCLUDED.permissions, role=EXCLUDED.role, active=true,
       pin=EXCLUDED.pin, "pinLookup"=EXCLUDED."pinLookup"`,
    [id, name, bcrypt.hashSync(pinVerifierInput(pin), 10),
     pinLookupValue(pin), role, JSON.stringify(perms)]
  );
}

// The seeded administrator predates the cutover, so its row carries a bcrypt(raw-PIN)
// verifier and no selector — a state that cannot authenticate under Version B, whose login
// searches by keyed lookup and proves by bcrypt(pinVerifierInput(pin)). The environment
// supplies this one PIN in plaintext, so the suites reissue the account they own into the
// Version B shape instead of depending on a hand-run step. Both live columns are written —
// pin = bcrypt(pinVerifierInput(ADMIN_PIN)) and the matching lookup — and pinHash is left
// exactly as it was, inert. Idempotent, and only ever for the administrator.
let adminLookupSettled = false;
export async function ensureAdminPinLookup() {
  if (adminLookupSettled) return;
  adminLookupSettled = true;
  const lookup = pinLookupValue(ADMIN_PIN);
  const verifier = bcrypt.hashSync(pinVerifierInput(ADMIN_PIN), 10);
  // If a prior run already reissued this account, its verifier accepts the Version B input
  // and its lookup is set — nothing to do.
  const already = await one(`SELECT id FROM "Employee" WHERE "pinLookup"=$1 AND active=true`, [lookup]);
  if (already) return;
  // Otherwise force the canonical administrator into the Version B shape. Prefer the seeded
  // "admin" account; fall back to any active admin. pinHash is untouched.
  const target =
    (await one(`SELECT id FROM "Employee" WHERE active=true AND role='admin' AND username='admin' LIMIT 1`)) ||
    (await one(`SELECT id FROM "Employee" WHERE active=true AND role='admin' ORDER BY "createdAt" LIMIT 1`));
  if (!target) throw new Error("ensureAdminPinLookup: no active admin employee to reissue");
  await db.query(`UPDATE "Employee" SET pin=$1, "pinLookup"=$2 WHERE id=$3`, [verifier, lookup, target.id]);
}

export async function loginAs(pin) {
  if (pin === ADMIN_PIN) await ensureAdminPinLookup();
  const r = await api("/api/auth/login", { method: "POST", body: { method: "pin", pin } });
  if (r.status !== 200) throw new Error("login failed: " + r.status + " " + JSON.stringify(r.json));
  return r;
}

// ── Stock readers ────────────────────────────────────────────────────────────
export async function greenStock(beanId) {
  return num((await one('SELECT "quantityKg" q FROM "GreenBean" WHERE id=$1', [beanId])).q);
}
export async function materialStock(id) {
  return num((await one('SELECT "quantityOnHand" q FROM "MaterialItem" WHERE id=$1', [id])).q);
}
export async function skuUnits(skuId) {
  const r = await one(
    `SELECT COALESCE(SUM("unitsProduced"),0)::int produced,
            COALESCE(SUM("unitsAvailable"),0)::int available,
            COALESCE(SUM("unitsReserved"),0)::int reserved
       FROM "FinishedGoodsLot" WHERE "productSkuId"=$1`, [skuId]);
  // Free-to-promise, defined exactly as the application defines it:
  // FinishedGoodsLot.availableQty - reservedQty (see prisma/schema.prisma). Deliberately
  // not clamped at zero — a negative value means reserved exceeded available, which is
  // precisely the over-reservation these suites exist to catch.
  //
  // Four committed assertions read `.free` while this function returned only
  // produced/available/reserved, so every one of them compared against `undefined` and
  // answered false in both directions. The arithmetic lives in oversell.mjs so that it is
  // provable without a database; see harness-selftest.mjs.
  const available = num(r.available), reserved = num(r.reserved);
  return { produced: num(r.produced), available, reserved, free: freeUnits(available, reserved) };
}
export async function roastedStock(coffeeProductId) {
  return num((await one(
    `SELECT COALESCE(SUM(rb."roastedAvailableKg"),0) q FROM "RoastingBatch" rb
      WHERE rb."productId"=$1 OR rb."orderItemId" IN
        (SELECT oi.id FROM "OrderItem" oi WHERE oi."productId"=$1)`, [coffeeProductId])).q);
}

// ── Global invariants ────────────────────────────────────────────────────────
export async function invariants(label) {
  const problems = [];
  const q = async (name, sql) => {
    const rows = await all(sql);
    if (rows.length > 0) problems.push(`${name} (${rows.length})`);
  };
  await q("negative green bean", 'SELECT id FROM "GreenBean" WHERE "quantityKg" < 0');
  await q("negative material", 'SELECT id FROM "MaterialItem" WHERE "quantityOnHand" < 0');
  await q("negative roasted stock", 'SELECT id FROM "RoastingBatch" WHERE "roastedAvailableKg" < 0');
  await q("unit balances out of order", 'SELECT id FROM "FinishedGoodsLot" WHERE "unitsReserved" > "unitsAvailable" OR "unitsAvailable" > "unitsProduced" OR "unitsReserved" < 0');
  await q("kg balances out of order", 'SELECT id FROM "FinishedGoodsLot" WHERE "reservedQty" > "availableQty" OR "reservedQty" < 0');
  await q("unit lot without SKU", 'SELECT id FROM "FinishedGoodsLot" WHERE "isUnitTracked" AND "productSkuId" IS NULL');
  await q("lot with both batch links", 'SELECT id FROM "FinishedGoodsLot" WHERE "roastingBatchId" IS NOT NULL AND "packedFromBatchId" IS NOT NULL');
  await q("unitsReserved vs RESERVED allocations",
    `SELECT f.id FROM "FinishedGoodsLot" f
      LEFT JOIN "StockAllocation" sa ON sa."finishedGoodsLotId"=f.id AND sa.status='RESERVED' AND sa."quantityUnits" IS NOT NULL
      WHERE f."isUnitTracked"
      GROUP BY f.id, f."unitsReserved"
      HAVING f."unitsReserved" IS DISTINCT FROM COALESCE(SUM(sa."quantityUnits"),0)`);
  await q("reservedQty vs RESERVED kg allocations",
    `SELECT f.id FROM "FinishedGoodsLot" f
      LEFT JOIN "StockAllocation" sa ON sa."finishedGoodsLotId"=f.id AND sa.status='RESERVED' AND sa."quantityUnits" IS NULL
      GROUP BY f.id, f."reservedQty"
      HAVING f."reservedQty" IS DISTINCT FROM COALESCE(SUM(sa."quantityKg"),0)`);
  await q("delivered beyond ordered (units)", 'SELECT id FROM "OrderItem" WHERE "quantityUnits" IS NOT NULL AND "deliveredUnits" > "quantityUnits"');
  return check(`INVARIANTS — ${label}`, problems.length === 0, problems.join(" | "));
}

/** Read a fixture that ships with these suites. */
export function fixture(name) {
  return JSON.parse(readFileSync(path.join(HERE, "fixtures", name), "utf8"));
}

/** Exit with the conventional status so CI fails on a red suite. */
export async function finish(label) {
  section(label);
  console.log(`${results.pass} passed, ${results.fail} failed`);
  if (results.failures.length) console.log("FAILURES:\n  - " + results.failures.join("\n  - "));
  try { await db.end(); } catch { /* already closed */ }
  process.exit(results.fail === 0 ? 0 : 1);
}
