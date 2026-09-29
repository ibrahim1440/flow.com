// Stage 6 over HTTP, server running as the restricted runtime role (accounting_app), on the
// synthetic fixture (LOCAL e-invoice validation only; nothing is sent to ZATCA): duties on the tax
// routes, the XML download, a LOCAL_ONLY submission recorded as not sent, and database guards the
// runtime role cannot bypass.
//
//   BASE_URL=http://localhost:3040 FIN_PASSWORD=... RUNTIME_DATABASE_URL=... \
//     node --test --test-concurrency=1 tests/accounting/http/tax.test.mjs
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
  const call = async (path, init = {}) => {
    const res = await fetch(`${BASE}${path}`, { ...init, headers: { cookie, "Content-Type": "application/json" }, body: init.json ? JSON.stringify(init.json) : undefined });
    const text = await res.text();
    let body = null; try { body = JSON.parse(text); } catch { body = text; }
    return { status: res.status, body, type: res.headers.get("content-type") };
  };
  return call;
}
const one = async (sql, args = []) => (await db.query(sql, args)).rows[0];

test("duties on the tax routes", async () => {
  const viewer = await session("acc.viewer");
  const none = await session("no.accounting");
  const prep = await session("acc.preparer");
  const appr = await session("acc.approver");
  assert.equal((await viewer("/api/accounting/tax/einvoices")).status, 200);
  assert.equal((await none("/api/accounting/tax/einvoices")).status, 403);
  const e = await one(`select id from "EInvoice" limit 1`);
  const job = await one(`select "salesInvoiceId" id from "EInvoiceJob" limit 1`);
  const draft = await prep("/api/accounting/tax/profile", { method: "POST", json: { sellerName: "شركة تجريبية", vatNumber: "399999999900003", crNumber: "1010000000", street: "s", buildingNo: "1234", district: "d", city: "c", postalCode: "12345", egsSerial: "EGS-LOCAL-01" } });
  assert.equal(draft.status, 201, JSON.stringify(draft.body));
  for (const [who, path, json] of [
    [viewer, "/api/accounting/tax/einvoices/generate", { salesInvoiceId: job.id }], [viewer, `/api/accounting/tax/einvoices/${e.id}/submit`], [viewer, `/api/accounting/tax/einvoices/${e.id}/revalidate`],
    [viewer, "/api/accounting/tax/profile", {}], [appr, "/api/accounting/tax/profile", {}], [prep, `/api/accounting/tax/profile/${draft.body.id}/approve`],
    [viewer, `/api/accounting/tax/customers/x`, {}],
  ]) {
    const r = await who(path, { method: path.includes("/customers/") ? "PUT" : "POST", json: json ?? {} });
    assert.equal(r.status, 403, `${path} → ${r.status}`);
  }
  assert.equal((await prep(`/api/accounting/tax/profile/${draft.body.id}/discard`, { method: "POST", json: {} })).status, 200);
});

test("XML download, a LOCAL_ONLY submission recorded as not sent, and guards the runtime role cannot bypass", async () => {
  const prep = await session("acc.preparer");
  const e = await one(`select id, xml from "EInvoice" order by icv limit 1`);
  const x = await prep(`/api/accounting/tax/einvoices/${e.id}/xml`);
  assert.equal(x.status, 200);
  assert.match(x.type, /application\/xml/);
  assert.equal(x.body, e.xml);
  const s = await prep(`/api/accounting/tax/einvoices/${e.id}/submit`, { method: "POST", json: {} });
  assert.equal(s.status, 200);
  assert.deepEqual([s.body.outcome, s.body.environment], ["NOT_SENT", "LOCAL_ONLY"]);
  await assert.rejects(db.query(`update "EInvoice" set xml = '<x/>' where id = $1`, [e.id]), /cannot be changed or deleted/);
  await assert.rejects(db.query(`delete from "EInvoice" where id = $1`, [e.id]), /cannot be changed or deleted/);
  await assert.rejects(db.query(`update "EInvoiceSubmission" set outcome = 'ACCEPTED' where "eInvoiceId" = $1`, [e.id]), /append-only/);
  await assert.rejects(db.query(`update "EInvoiceProfile" set environment = 'PRODUCTION' where status = 'APPROVED'`), /not allowed|cannot change/);
  await assert.rejects(db.query(`alter table "EInvoice" disable trigger "EInvoice_guard"`), /must be owner/);
});
