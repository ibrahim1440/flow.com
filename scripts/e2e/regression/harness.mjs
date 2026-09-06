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
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

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

export const db = new Client({ connectionString: DB_URL });

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

export async function api(path, { method = "GET", body, raw = false } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
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

export async function ensureUser(id, name, role, perms, pin) {
  await db.query(
    `INSERT INTO "Employee" (id,name,pin,"pinHash",role,permissions,"defaultRoute",active,"preferredLanguage","createdAt","updatedAt")
     VALUES ($1,$2,$3,$4,$5,$6,'/dashboard',true,'en',now(),now())
     ON CONFLICT (id) DO UPDATE SET permissions=EXCLUDED.permissions, role=EXCLUDED.role, active=true`,
    [id, name, bcrypt.hashSync(pin, 10), createHash("sha256").update(pin).digest("hex"), role, JSON.stringify(perms)]
  );
}

export async function loginAs(pin) {
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
  const available = num(r.available), reserved = num(r.reserved);
  return { produced: num(r.produced), available, reserved, free: available - reserved };
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
