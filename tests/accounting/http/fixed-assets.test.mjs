// Stage 5 over HTTP, server running as the restricted runtime role (accounting_app), on the
// synthetic fixture (classes, lives and rates are SYNTHETIC TEST ASSUMPTIONS): duties on every
// fixed-asset and year-end route, four-eyes, one run per period under concurrent requests,
// exactly one journal per run, and database guards the runtime role cannot bypass.
//
//   BASE_URL=http://localhost:3040 FIN_PASSWORD=... RUNTIME_DATABASE_URL=... \
//     node --test --test-concurrency=1 tests/accounting/http/fixed-assets.test.mjs
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const BASE = process.env.BASE_URL ?? "http://localhost:3040";
if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(BASE)) throw new Error("Refusing to run against a non-local server.");
const DB_URL = process.env.RUNTIME_DATABASE_URL;
if (!DB_URL || !/@(127\.0\.0\.1|localhost):\d+\//.test(DB_URL)) throw new Error("RUNTIME_DATABASE_URL must be a local database.");
const { Client } = createRequire(import.meta.url)("pg");
let db;
before(async () => { db = new Client({ connectionString: DB_URL }); await db.connect(); });
after(async () => { await db?.end(); });

async function session(username) {
  const r = await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ method: "password", username, password: process.env.FIN_PASSWORD }) });
  assert.equal(r.status, 200, `login ${username}`);
  const cookie = r.headers.get("set-cookie").split(";")[0];
  return async (path, init = {}) => {
    const res = await fetch(`${BASE}${path}`, { ...init, headers: { cookie, "Content-Type": "application/json" }, body: init.json ? JSON.stringify(init.json) : undefined });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
}
const one = async (sql, args = []) => (await db.query(sql, args)).rows[0];
const now = new Date(Date.now() + 3 * 3600_000);
const YEAR = now.getUTCFullYear(), MONTH = now.getUTCMonth() + 1;

test("duties: a viewer and an operations user can read but not act; the preparer cannot approve and the approver cannot prepare", async () => {
  const viewer = await session("acc.viewer");
  const none = await session("no.accounting");
  const prep = await session("acc.preparer");
  const appr = await session("acc.approver");
  assert.equal((await viewer("/api/accounting/fixed-assets")).status, 200);
  assert.equal((await none("/api/accounting/fixed-assets")).status, 403);
  const asset = await one(`select id from "FaAsset" where status = 'SUBMITTED' limit 1`);
  const period = await one(`select id from "FiscalPeriod" where year = $1 and "periodNo" = $2`, [YEAR, MONTH]);
  for (const [who, path, json] of [
    [viewer, "/api/accounting/fixed-assets", { name: "x" }], [viewer, `/api/accounting/fixed-assets/${asset.id}/capitalise`], [viewer, "/api/accounting/fixed-assets/runs", { periodId: period.id }],
    [viewer, "/api/accounting/year-end", { year: YEAR - 1 }], [viewer, "/api/accounting/fixed-assets/classes", { code: "X" }],
    [prep, `/api/accounting/fixed-assets/${asset.id}/capitalise`], [appr, "/api/accounting/fixed-assets/runs", { periodId: period.id }], [appr, "/api/accounting/fixed-assets/classes", { code: "X" }],
    [prep, "/api/accounting/year-end/x/approve"], [appr, "/api/accounting/year-end", { year: YEAR - 1 }],
  ]) {
    const r = await who(path, { method: "POST", json: json ?? {} });
    assert.equal(r.status, 403, `${path} → ${r.status} ${JSON.stringify(r.body)}`);
  }
});

test("a run for this month: concurrent requests make one; the preparer cannot approve it; the approver posts it once; a second approval is refused", async () => {
  const prep = await session("acc.preparer");
  const prep2 = await session("acc.preparer");
  const appr = await session("acc.approver");
  const period = await one(`select id from "FiscalPeriod" where year = $1 and "periodNo" = $2`, [YEAR, MONTH]);
  const [a, b] = await Promise.all([prep("/api/accounting/fixed-assets/runs", { method: "POST", json: { periodId: period.id } }), prep2("/api/accounting/fixed-assets/runs", { method: "POST", json: { periodId: period.id } })]);
  assert.deepEqual([a.status, b.status].sort(), [201, 409], `${a.status} ${b.status}`);
  const run = (a.status === 201 ? a : b).body;
  assert.equal((await prep(`/api/accounting/fixed-assets/runs/${run.id}/approve`, { method: "POST" })).status, 403, "the preparer holds no approval duty");
  const [x, y] = await Promise.all([appr(`/api/accounting/fixed-assets/runs/${run.id}/approve`, { method: "POST" }), appr(`/api/accounting/fixed-assets/runs/${run.id}/approve`, { method: "POST" })]);
  assert.deepEqual([x.status, y.status].sort(), [200, 409]);
  const ok = x.status === 200 ? x.body : y.body;
  assert.equal(ok.ledger.status, "TRANSLATED", ok.ledger.message);
  const n = await one(`select count(*)::int n from "JournalEntry" j join "AccountingEvent" e on e.id = j."originEventId" where e."idempotencyKey" = $1`, [`fixed_assets:${run.id}:fa.depreciation.posted:1`]);
  assert.equal(n.n, 1);
  const detail = await appr(`/api/accounting/fixed-assets/runs/${run.id}`);
  assert.equal(detail.body.status, "POSTED");
  assert.equal(detail.body.journal.reduce((s, j) => s + Number(j.debit), 0).toFixed(2), run.total);
});

test("database guards hold for the runtime role: a posted run and a capitalised asset cannot be edited, policies cannot be self-approved", async () => {
  const run = await one(`select id from "FaDepRun" where status = 'POSTED' limit 1`);
  await assert.rejects(db.query(`update "FaDepRun" set total = 1 where id = $1`, [run.id]), /cannot be changed; reverse it/);
  await assert.rejects(db.query(`update "FaDepLine" set amount = 1 where "runId" = $1`, [run.id]), /cannot change/);
  const a = await one(`select id from "FaAsset" where status = 'CAPITALISED' limit 1`);
  await assert.rejects(db.query(`update "FaAsset" set "usefulLifeMonths" = 999 where id = $1`, [a.id]), /capitalised asset cannot be edited/);
  const p = await one(`select id, "preparedBy" from "FaClassPolicy" where status = 'DRAFT' limit 1`);
  await assert.rejects(db.query(`update "FaClassPolicy" set status = 'APPROVED', "approvedBy" = $2 where id = $1`, [p.id, p.preparedBy]), /someone other than its preparer/);
  await assert.rejects(db.query(`delete from "FaAsset" where id = $1`, [a.id]), /Only a draft asset/);
  await assert.rejects(db.query(`alter table "FaAsset" disable trigger "FaAsset_guard"`), /must be owner/);
});
