// Posted bank lines over HTTP, server running as the restricted runtime role (accounting_app):
// Finance can no longer change a posted line (clear 409 from every path), the correction workflow
// is four-eyes, and the runtime role cannot bypass the guards in SQL.
//
//   BASE_URL=http://localhost:3040 FIN_PASSWORD=... RUNTIME_DATABASE_URL=... \
//     node --test --test-concurrency=1 tests/accounting/http/bank-corrections.test.mjs
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
const posted = async () => (await db.query(`select t.id, t.amount::text, t."txnDate" from "BankTransaction" t join "AccountingEvent" e on e."idempotencyKey" = 'bank:' || t.id || ':confirmed' join "JournalEntry" j on j."originEventId" = e.id join "CashAccount" c on c.id = t."cashAccountId" where t.status <> 'VOID' and t.classification <> 'INTERNAL_TRANSFER' and t.amount < 0 and c.code = 'ACC-BANK' and not exists (select 1 from "BankCorrection" b where b."transactionId" = t.id) order by t."txnDate" desc limit 1`)).rows[0];

test("Finance cannot change a posted line: review, void and match are refused with 409 and a pointer to Accounting", async () => {
  await (await session("acc.approver"))("/api/accounting/events/process", { method: "POST", json: {} });
  const t = await posted();
  assert.ok(t, "the fixture has a posted bank line");
  const fin = await session("acc.finclerk");
  const cats = (await db.query(`select id from "FinCategory" where code = 'ACC-MARKETING'`)).rows[0].id;
  const review = await fin(`/api/finance/transactions/${t.id}/review`, { method: "POST", json: { classification: "OTHER_OPERATING_PAYMENT", splits: [{ finCategoryId: cats, amount: t.amount }], markReviewed: true } });
  assert.equal(review.status, 409, JSON.stringify(review.body)); assert.match(review.body.error, /posted to the ledger/);
  const v = await fin(`/api/finance/transactions/${t.id}/void`, { method: "POST", json: { reason: "duplicate entry" } });
  assert.equal(v.status, 409); assert.match(v.body.error, /Request a correction/);
  const ob = (await db.query(`select id from "FinObligation" where "sourceType" = 'SUPPLIER_BILL' limit 1`)).rows[0];
  if (ob) {
    const m = await fin(`/api/finance/transactions/${t.id}/matches`, { method: "POST", json: { targetType: "OBLIGATION", targetId: ob.id, amount: "1.00" } });
    assert.equal(m.status, 409, JSON.stringify(m.body));
  }
});

test("correction over HTTP: permissions, four-eyes, void + replacement post, the original is VOID", async () => {
  const t = await posted();
  // a payment category mapped to an ordinary expense account
  const cat = (await db.query(`select c.id from "FinCategory" c join "Account" a on a.id = c."glAccountId" where c.kind = 'PAYMENT' and a."controlKind" = 'NONE' and a.type = 'EXPENSE' order by c.code limit 1`)).rows[0].id;
  const viewer = await session("acc.viewer");
  const prep = await session("acc.preparer");
  const appr = await session("acc.approver");
  const replacement = { txnDate: String(t.txnDate.toISOString?.() ?? t.txnDate).slice(0, 10), amount: t.amount, classification: "OTHER_OPERATING_PAYMENT", splits: [{ finCategoryId: cat, amount: t.amount }] };
  assert.equal((await viewer(`/api/accounting/bank/lines/${t.id}/corrections`, { method: "POST", json: { kind: "REPLACE", reason: "wrong category", replacement } })).status, 403);
  const bad = await prep(`/api/accounting/bank/lines/${t.id}/corrections`, { method: "POST", json: { kind: "REPLACE", reason: "wrong category", replacement: { ...replacement, amount: "-1.00" } } });
  assert.equal(bad.status, 400, "splits must add up");
  const c = await prep(`/api/accounting/bank/lines/${t.id}/corrections`, { method: "POST", json: { kind: "REPLACE", reason: "wrong category", replacement } });
  assert.equal(c.status, 201, JSON.stringify(c.body));
  assert.equal((await prep(`/api/accounting/bank/corrections/${c.body.id}/approve`, { method: "POST", json: {} })).status, 403, "the requester lacks the approval duty");
  const a = await appr(`/api/accounting/bank/corrections/${c.body.id}/approve`, { method: "POST", json: {} });
  assert.equal(a.status, 200, JSON.stringify(a.body));
  assert.deepEqual(a.body.ledger.map((x) => x.status), ["TRANSLATED", "TRANSLATED"]);
  assert.equal((await appr(`/api/accounting/bank/corrections/${c.body.id}/approve`, { method: "POST", json: {} })).status, 409, "retry refused");
  assert.equal((await db.query(`select status from "BankTransaction" where id = $1`, [t.id])).rows[0].status, "VOID");
  const list = (await appr("/api/accounting/bank/corrections")).body;
  assert.equal(list.find((x) => x.id === c.body.id).status, "APPLIED");
});

test("the runtime role cannot bypass the guards in SQL", async () => {
  const t = await posted();
  await assert.rejects(db.query(`update "BankTransaction" set amount = amount - 1 where id = $1`, [t.id]), /posted to the ledger/);
  await assert.rejects(db.query(`update "BankTransaction" set status = 'VOID', "voidedAt" = now(), "voidedBy" = 'x' where id = $1`, [t.id]), /approved correction/);
  await assert.rejects(db.query(`delete from "BankTransactionSplit" where "transactionId" = $1`, [t.id]), /budget splits cannot change/);
  await assert.rejects(db.query(`delete from "BankCorrection"`), /cannot be deleted/);
  await assert.rejects(db.query(`alter table "BankTransaction" disable trigger "BankTransaction_posted_guard"`), /must be owner|permission denied/);
});
