// Stage 3 over HTTP, server running as the restricted runtime role (accounting_app), on the
// synthetic fixture: sales-invoice four-eyes and duties, receipt assignment from a sales
// collection (one bank journal, commissions untouched, the collection never posts), concurrent
// and repeated assignment, and refusal of SQL bypasses by the runtime role.
//
//   BASE_URL=http://localhost:3040 FIN_PASSWORD=... RUNTIME_DATABASE_URL=... \
//     node --test --test-concurrency=1 tests/accounting/http/receivables-workflow.test.mjs
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
const customer = (nameAr) => one(`select id from "Customer" where "nameAr" = $1`, [nameAr]).then((r) => r.id);
const line = (ref) => one(`select id from "BankTransaction" where "bankReference" = $1 and status <> 'VOID'`, [ref]).then((r) => r.id);
const journalsOf = (key) => one(`select count(*)::int n from "JournalEntry" j join "AccountingEvent" e on e.id = j."originEventId" where e."idempotencyKey" = $1`, [key]).then((r) => r.n);

test("sales invoice: duties and four-eyes over HTTP, posting once, retries refused", async () => {
  const prep = await session("acc.preparer");
  const appr = await session("acc.approver");
  const viewer = await session("acc.viewer");
  const vat = (await one(`select id from "TaxCategory" where code = 'VAT15'`)).id;
  const doc = { customerId: await customer("مقاهي نجد المختصة"), issueDate: new Date(Date.now() + 3 * 3600_000).toISOString().slice(0, 10), lines: [{ description: "بن تجريبي — 4 كغ", quantity: "4", unitPrice: "100", discountPercent: "10", taxCategoryId: vat }] };
  assert.equal((await viewer("/api/accounting/receivables/invoices", { method: "POST", json: doc })).status, 403, "viewer cannot create");
  const c = await prep("/api/accounting/receivables/invoices", { method: "POST", json: doc });
  assert.equal(c.status, 201, JSON.stringify(c.body));
  assert.equal(Number(c.body.totalGross), 414, "4 × 100 − 10% = 360, VAT 54");
  const id = c.body.id;
  assert.equal((await appr(`/api/accounting/receivables/invoices/${id}/approve`, { method: "POST", json: {} })).status, 409, "a draft cannot be approved");
  assert.equal((await prep(`/api/accounting/receivables/invoices/${id}/submit`, { method: "POST", json: {} })).status, 200);
  assert.equal((await prep(`/api/accounting/receivables/invoices/${id}/approve`, { method: "POST", json: {} })).status, 403, "the preparer lacks the approval duty");
  assert.equal((await prep(`/api/accounting/receivables/invoices/${id}`, { method: "PATCH", json: doc })).status, 409, "a submitted document is not edited");
  assert.equal((await appr(`/api/accounting/receivables/invoices/${id}/approve`, { method: "POST", json: {} })).status, 200);
  const [p1, p2] = await Promise.all([appr(`/api/accounting/receivables/invoices/${id}/post`, { method: "POST", json: {} }), appr(`/api/accounting/receivables/invoices/${id}/post`, { method: "POST", json: {} })]);
  assert.deepEqual([p1.status, p2.status].sort(), [200, 409], "two concurrent posts: one wins");
  assert.equal(await journalsOf(`receivables:${id}:ar.invoice.posted`), 1, "one journal");
  assert.equal((await prep(`/api/accounting/receivables/invoices/${id}`, { method: "DELETE" })).status, 409, "a posted invoice is not deleted");
});

test("receipt from a sales collection: the collection names the customer; one bank journal; commissions and the collection do not post", async () => {
  const prep = await session("acc.preparer");
  const viewer = await session("acc.viewer");
  const dep = await line("DEP-5530");
  const other = await line("DEP-5521");
  const coll = await one(`select id, "customerId" from "SalesCollection" where "referenceNumber" = 'SC-0931'`);
  const commissionsBefore = (await one(`select count(*)::int n from "JournalEntry" where "sourceModule" = 'commissions'`)).n;
  const q = (await prep("/api/accounting/receivables/receipts")).body.rows.find((r) => r.id === dep);
  assert.equal(q.collection.customerId, coll.customerId, "the queue proposes the collection's customer");
  assert.equal((await viewer(`/api/accounting/receivables/receipts/${dep}`, { method: "PUT", json: {} })).status, 403);
  const wrong = await prep(`/api/accounting/receivables/receipts/${dep}`, { method: "PUT", json: { customerId: await customer("فندق الروضة") } });
  assert.equal(wrong.status, 400); assert.match(wrong.body.error, /differs from the sales collection/);
  // Two lines claim the same collection at once: exactly one succeeds (either may win).
  const inv = await one(`select i.id, i."totalGross"::text g from "SalesInvoice" i where i."customerId" = $1 and i.status = 'POSTED' and i.kind = 'INVOICE' order by i."invoiceNo" limit 1`, [coll.customerId]);
  const claim = { salesCollectionId: coll.id, allocations: [{ invoiceId: inv.id, amount: "1000.00" }] };   // fits either line
  const [a, b] = await Promise.all([
    prep(`/api/accounting/receivables/receipts/${dep}`, { method: "PUT", json: claim }),
    prep(`/api/accounting/receivables/receipts/${other}`, { method: "PUT", json: claim }),
  ]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409], JSON.stringify([a.body, b.body]));
  const [win, winLine] = a.status === 200 ? [a, dep] : [b, other];
  assert.match((a.status === 409 ? a : b).body.error, /already assigned/);
  assert.equal(win.body.receipt.customerId, coll.customerId);
  assert.equal(Number(win.body.receipt.arAmount), 1000);
  assert.equal(win.body.ledger.status, "TRANSLATED", JSON.stringify(win.body.ledger));
  assert.equal(await journalsOf(`bank:${winLine}:confirmed`), 1, "one bank journal");
  const j = await one(`select sum(case when a.code = '1130' then l.credit else 0 end)::text ar, sum(case when a.code = '2410' then l.credit else 0 end)::text adv, bool_and(l."partyId" is null or l."partyId" = $2) party
                         from "JournalEntryLine" l join "Account" a on a.id = l."accountId" join "JournalEntry" e on e.id = l."journalEntryId" join "AccountingEvent" ev on ev.id = e."originEventId" where ev."idempotencyKey" = $1`, [`bank:${winLine}:confirmed`, coll.customerId]);
  assert.equal(Number(j.ar), 1000); assert.equal(Number(j.adv) > 0, true, "the excess is an advance"); assert.equal(j.party, true);
  assert.equal((await one(`select count(*)::int n from "AccountingEvent" where "sourceDocumentId" = $1`, [coll.id])).n, 0, "the sales collection has no posting of its own");
  assert.equal((await one(`select count(*)::int n from "JournalEntry" where "sourceModule" = 'commissions'`)).n, commissionsBefore, "commission journals unchanged");
  // Retry after posting: refused, nothing duplicated.
  const again = await prep(`/api/accounting/receivables/receipts/${winLine}`, { method: "PUT", json: { customerId: coll.customerId, allocations: [] } });
  assert.equal(again.status, 409); assert.match(again.body.error, /has posted/);
  assert.equal(await journalsOf(`bank:${winLine}:confirmed`), 1);
  // Aging ties to the ledger after the receipt.
  const ag = (await prep("/api/accounting/reports/ar-aging")).body;
  assert.equal(ag.reconciled, true, JSON.stringify({ sub: ag.subledger, ledger: ag.ledger }));
});

test("the runtime role cannot bypass the receivables guards in SQL", async () => {
  const posted = await one(`select id from "SalesInvoice" where status = 'POSTED' and kind = 'INVOICE' order by "invoiceNo" limit 1`);
  await assert.rejects(db.query(`update "SalesInvoice" set "totalGross" = "totalGross" + 1 where id = $1`, [posted.id]), /posted sales document cannot be changed/);
  await assert.rejects(db.query(`update "SalesInvoiceLine" set "unitPrice" = 1 where "invoiceId" = $1`, [posted.id]), /cannot change/);
  await assert.rejects(db.query(`delete from "ArAllocation"`), /audit trail/);
  const r = await one(`select r.id from "CustomerReceipt" r join "BankTransaction" t on t.id = r."bankTransactionId" where t."bankReference" = 'DEP-5510'`);
  await assert.rejects(db.query(`update "CustomerReceipt" set "customerId" = (select id from "Customer" where "nameAr" = 'مقاهي نجد المختصة') where id = $1`, [r.id]), /has posted/);
  const submitted = await one(`select id, "submittedBy" from "SalesInvoice" where status = 'SUBMITTED' limit 1`);
  await assert.rejects(db.query(`update "SalesInvoice" set status = 'APPROVED', "approvedBy" = $2, "approvedAt" = now() where id = $1`, [submitted.id, submitted.submittedBy]), /someone other than/);
  await assert.rejects(db.query(`alter table "SalesInvoice" disable trigger "SalesInvoice_accounting_guard"`), /must be owner|permission denied/);
});
