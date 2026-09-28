// Stage 4 over HTTP, server running as the restricted runtime role (accounting_app), on the
// synthetic fixture (decision D-1 undecided; the server runs with the isolated-test switch, so
// documents post provisionally): inventory duties and four-eyes, idempotent creation, double
// posting under concurrency, a production from an operational roasting batch, reports that tie
// to the ledger, and refusal of SQL bypasses by the runtime role.
//
//   BASE_URL=http://localhost:3040 FIN_PASSWORD=... RUNTIME_DATABASE_URL=... \
//     node --test --test-concurrency=1 tests/accounting/http/inventory-workflow.test.mjs
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
const id = (sql, args) => one(sql, args).then((r) => r.id);
const today = () => new Date(Date.now() + 3 * 3600_000).toISOString().slice(0, 10);
const journalsOf = (docId) => one(`select count(*)::int n from "JournalEntry" j join "AccountingEvent" e on e.id = j."originEventId" where e."idempotencyKey" = $1`, [`inventory:${docId}:inv.document.posted`]).then((r) => r.n);

test("goods receipt: duties, idempotent creation, four-eyes, one posting under concurrency", async () => {
  const prep = await session("acc.preparer");
  const appr = await session("acc.approver");
  const viewer = await session("acc.viewer");
  const doc = {
    type: "RECEIPT", docDate: today(), requestKey: `http-inv-${Date.now()}`, description: "استلام تجريبي عبر HTTP",
    locationId: await id(`select id from "InvLocation" where code = 'RST'`), supplierId: await id(`select id from "Supplier" where name = 'محمصة الوادي للتوريد'`),
    // Labels, not green coffee: the fixture's roasting production (dated yesterday) must still be able
    // to post in the test below, and a green-coffee receipt dated today would (rightly) block it.
    lines: [{ itemId: await id(`select id from "InvItem" where code = 'LBL-ETH'`), quantity: "1000", unitCost: "0.15" }],
  };
  assert.equal((await viewer("/api/accounting/inventory/documents", { method: "POST", json: doc })).status, 403, "a viewer cannot prepare");
  assert.equal((await appr("/api/accounting/inventory/documents", { method: "POST", json: doc })).status, 403, "an approver without the preparer duty cannot prepare");
  const created = await prep("/api/accounting/inventory/documents", { method: "POST", json: doc });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const again = await prep("/api/accounting/inventory/documents", { method: "POST", json: doc });
  assert.equal(again.body.id, created.body.id, "the same request key returns the same draft");
  assert.equal((await one(`select count(*)::int n from "InvDocument" where "requestKey" = $1`, [doc.requestKey])).n, 1);
  const d = created.body.id;
  assert.equal((await prep(`/api/accounting/inventory/documents/${d}/submit`, { method: "POST", json: {} })).status, 200);
  const own = await prep(`/api/accounting/inventory/documents/${d}/approve`, { method: "POST", json: {} });
  assert.equal(own.status, 403, "the preparer lacks the approval duty");
  assert.equal((await appr(`/api/accounting/inventory/documents/${d}/post`, { method: "POST", json: {} })).status, 409, "not approved yet");
  assert.equal((await appr(`/api/accounting/inventory/documents/${d}/approve`, { method: "POST", json: {} })).status, 200);
  assert.equal((await prep(`/api/accounting/inventory/documents/${d}/post`, { method: "POST", json: {} })).status, 403, "the preparer lacks the posting duty");
  const both = await Promise.all([1, 2].map(() => appr(`/api/accounting/inventory/documents/${d}/post`, { method: "POST", json: {} })));
  assert.deepEqual(both.map((r) => r.status).sort(), [200, 409], JSON.stringify(both.map((r) => r.body)));
  assert.equal(await journalsOf(d), 1, "one journal");
  assert.equal((await one(`select count(*)::int n from "InvMove" where "documentId" = $1`, [d])).n, 1, "one cost move");
  const retry = await appr(`/api/accounting/inventory/documents/${d}/post`, { method: "POST", json: {} });
  assert.equal(retry.status, 409); assert.match(retry.body.error, /already posted/);
  assert.equal(await journalsOf(d), 1, "a retry adds nothing");
  const detail = (await viewer(`/api/accounting/inventory/documents/${d}`)).body;
  assert.equal(detail.ledger.provisional, true, "D-1 is undecided: the journal is provisional");
  assert.deepEqual(detail.ledger.lines.map((l) => [l.account.slice(0, 4), l.debit, l.credit]).sort(), [["1172", "150.00", "0.00"], ["2120", "0.00", "150.00"]]);
});

test("cost of sales is not entered by hand; a draft is edited or deleted only by its preparer's duty", async () => {
  const prep = await session("acc.preparer");
  const appr = await session("acc.approver");
  const loc = await id(`select id from "InvLocation" where code = 'RST'`);
  const sku = await id(`select id from "InvItem" where code = 'SKU-ETH-250'`);
  const sale = await prep("/api/accounting/inventory/documents", { method: "POST", json: { type: "SALE_ISSUE", docDate: today(), locationId: loc, lines: [{ itemId: sku, quantity: "1" }] } });
  assert.equal(sale.status, 400, JSON.stringify(sale.body));
  const draft = await prep("/api/accounting/inventory/documents", { method: "POST", json: { type: "ISSUE", issueReason: "QC", docDate: today(), locationId: loc, lines: [{ itemId: sku, quantity: "1" }] } });
  assert.equal(draft.status, 201);
  assert.equal((await appr(`/api/accounting/inventory/documents/${draft.body.id}`, { method: "DELETE" })).status, 403);
  assert.equal((await prep(`/api/accounting/inventory/documents/${draft.body.id}`, { method: "DELETE" })).status, 200);
  assert.equal((await one(`select count(*)::int n from "InvDocument" where id = $1`, [draft.body.id])).n, 0);
});

test("a roasting batch becomes a production; the loss is within the approved band; reports tie to the ledger", async () => {
  const appr = await session("acc.approver");
  // SUBMITTED on a fresh fixture; APPROVED if the production-configuration suite ran first (it
  // approves the document and shows that posting is refused there while D-1 is undecided).
  const pending = await one(`select id, status from "InvDocument" where "sourceType" = 'ROASTING_BATCH' and status in ('SUBMITTED', 'APPROVED')`);
  assert.ok(pending, "the fixture leaves a production waiting for approval");
  if (pending.status === "SUBMITTED") assert.equal((await appr(`/api/accounting/inventory/documents/${pending.id}/approve`, { method: "POST", json: {} })).status, 200);
  const posted = await appr(`/api/accounting/inventory/documents/${pending.id}/post`, { method: "POST", json: {} });
  assert.equal(posted.status, 200, JSON.stringify(posted.body));
  const d = (await appr(`/api/accounting/inventory/documents/${pending.id}`)).body;
  assert.deepEqual([d.production.yieldIn, d.production.yieldOut, d.production.expectedYield, d.production.abnormalQty], ["12.0000", "10.2000", "9.8400", "0.0000"], "12 kg × (100% − 18%) = 9.84 ≤ 10.2: no abnormal loss");
  const lines = d.ledger.lines.map((l) => [l.account.slice(0, 4), l.debit, l.credit]);
  assert.ok(lines.some(([a, dr]) => a === "1173" && Number(dr) > 0) && lines.some(([a, , cr]) => a === "1171" && Number(cr) > 0) && !lines.some(([a]) => a === "5300"), JSON.stringify(lines));
  const v = (await appr(`/api/accounting/inventory/reports/valuation?asOf=${today()}`)).body;
  assert.equal(v.reconciled, true, JSON.stringify(v.accounts));
  const g = (await appr(`/api/accounting/inventory/reports/grni?asOf=${today()}`)).body;
  const explained = Number(g.receiptsTotal) - Number(g.billsTotal) + Number(g.landedTotal) - Number(g.returnsTotal);
  assert.equal(explained.toFixed(2), g.ledger, "GRNI explained line by line equals account 2120");
  const again = await appr(`/api/accounting/inventory/from-roasting/${d.sourceId}`, { method: "POST", json: { locationId: d.locationId } });
  assert.equal(again.status, 403, "the approver lacks the preparer duty");
});

test("back-dating over a posted movement is refused over HTTP", async () => {
  const prep = await session("acc.preparer");
  const appr = await session("acc.approver");
  const loc = await id(`select id from "InvLocation" where code = 'RST'`);
  const lbl = await id(`select id from "InvItem" where code = 'LBL-ETH'`);
  const d = await prep("/api/accounting/inventory/documents", { method: "POST", json: { type: "ISSUE", issueReason: "QC", docDate: `${today().slice(0, 4)}-09-01`, locationId: loc, lines: [{ itemId: lbl, quantity: "1" }] } });
  assert.equal(d.status, 201);
  await prep(`/api/accounting/inventory/documents/${d.body.id}/submit`, { method: "POST", json: {} });
  await appr(`/api/accounting/inventory/documents/${d.body.id}/approve`, { method: "POST", json: {} });
  const r = await appr(`/api/accounting/inventory/documents/${d.body.id}/post`, { method: "POST", json: {} });
  assert.equal(r.status, 409); assert.match(r.body.error, /already has a posted movement/);
  assert.equal((await one(`select status from "InvDocument" where id = $1`, [d.body.id])).status, "APPROVED", "nothing half-posted");
});

test("the runtime role cannot bypass the inventory guards in SQL", async () => {
  const posted = await one(`select id from "InvDocument" where status = 'POSTED' and type = 'RECEIPT' order by "docNo" limit 1`);
  await assert.rejects(db.query(`update "InvDocument" set "docDate" = "docDate" + 1 where id = $1`, [posted.id]), /posted inventory document cannot be changed/);
  await assert.rejects(db.query(`update "InvDocLine" set "unitCost" = 1 where "documentId" = $1`, [posted.id]), /cannot change/);
  await assert.rejects(db.query(`delete from "InvMove" where "documentId" = $1`, [posted.id]), /cannot be changed or deleted/);
  await assert.rejects(db.query(`update "InvLayer" set "valueLeft" = "valueLeft" + 1 where "itemId" = (select "itemId" from "InvDocLine" where "documentId" = $1 limit 1)`, [posted.id]), /does not equal its moves|cannot/);
  await assert.rejects(db.query(`update "InvLossBand" set "maxLossPercent" = 30 where status = 'APPROVED'`), /cannot change/);
  const draftBand = await one(`select id, "createdBy" from "InvLossBand" where status = 'DRAFT' limit 1`);
  await assert.rejects(db.query(`update "InvLossBand" set status = 'APPROVED', "approvedBy" = $2, "approvedAt" = now() where id = $1`, [draftBand.id, draftBand.createdBy]), /someone other than its author/);
  await assert.rejects(db.query(`truncate "InvMove"`), /permission denied/);
});
