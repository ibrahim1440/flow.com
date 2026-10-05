// Stage 2 over real HTTP, server running as the restricted runtime role (accounting_app),
// against the local synthetic fixture: supplier bill workflow and permissions, posting,
// payment from a bank line, aging/statement tie-out, bank mappings, manual-journal refusal.
//
//   BASE_URL=http://localhost:3040 FIN_PASSWORD=... RUNTIME_DATABASE_URL=... \
//     node --test --test-concurrency=1 tests/accounting/http/stage2-workflow.test.mjs
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
const year = new Date().getUTCFullYear();
const iso = (m, d) => `${year}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

test("permissions: no module → 403; viewer reads but cannot write; preparer cannot approve, post or map", async () => {
  const none = await session("no.accounting");
  for (const p of ["/api/accounting/bills", "/api/accounting/bank", "/api/accounting/reports/ap-aging", "/api/accounting/reports/bank-reconciliation"]) assert.equal((await none(p)).status, 403, p);
  const viewer = await session("acc.viewer");
  assert.equal((await viewer("/api/accounting/bills")).status, 200);
  assert.equal((await viewer("/api/accounting/bills", { method: "POST", json: {} })).status, 403);
  const prep = await session("acc.preparer");
  const any = (await prep("/api/accounting/bills?status=PENDING")).body.rows[0];
  assert.equal((await prep(`/api/accounting/bills/${any.id}/approve`, { method: "POST", json: {} })).status, 403);
  assert.equal((await prep(`/api/accounting/bills/${any.id}/post`, { method: "POST", json: {} })).status, 403);
  const cats = (await prep("/api/accounting/bank")).body.categories;
  assert.equal((await prep(`/api/accounting/bank/categories/${cats[0].id}`, { method: "PUT", json: { accountId: null } })).status, 403);
  assert.equal((await prep("/api/accounting/settings", { method: "PATCH", json: { bankPostingFrom: iso(9, 1) } })).status, 403);
});

test("bill lifecycle over HTTP: create → submit → four-eyes approve → post → payment from the bank → settled and tied out", async () => {
  const prep = await session("acc.preparer");
  const appr = await session("acc.approver");
  const suppliers = (await prep("/api/accounting/suppliers")).body;
  const sup = suppliers.find((s) => s.vatNumber);
  const taxes = await (await fetch(`${BASE}/api/accounting/tax-categories`, { headers: { cookie: "" } })).status;
  assert.equal(taxes, 401, "tax categories need a session");
  const coa = (await prep("/api/accounting/coa")).body;
  const acc = (code) => coa.find((a) => a.code === code).id;
  const vat = (await (await fetch(`${BASE}/api/accounting/tax-categories`, { headers: { cookie: (await login("acc.preparer")) } })).json()).find((t) => t.code === "VAT15").id;
  const inv = `HTTP-${Date.now()}`;
  const bad = await prep("/api/accounting/bills", { method: "POST", json: { supplierId: sup.id, supplierInvoiceNo: inv, billDate: iso(9, 26), lines: [{ kind: "EXPENSE", accountId: acc("2110"), quantity: "1", unitPrice: "10" }] } });
  assert.equal(bad.status, 400, "a bill line cannot debit the payables control account");
  const c = await prep("/api/accounting/bills", { method: "POST", json: { supplierId: sup.id, supplierInvoiceNo: inv, billDate: iso(9, 26), lines: [{ kind: "EXPENSE", accountId: acc("6700"), description: "صيانة", quantity: "2", unitPrice: "150.25", taxCategoryId: vat }] } });
  assert.equal(c.status, 201, JSON.stringify(c.body));
  assert.equal(c.body.totalGross, "345.58", "2 × 150.25 = 300.50 net, VAT 45.08 (half-up), gross 345.58");
  const dup = await prep("/api/accounting/bills", { method: "POST", json: { supplierId: sup.id, supplierInvoiceNo: inv, billDate: iso(9, 26), lines: [{ kind: "EXPENSE", accountId: acc("6700"), quantity: "1", unitPrice: "1" }] } });
  assert.equal(dup.status, 409, "same supplier invoice number twice");
  const id = c.body.id;
  assert.equal((await prep(`/api/accounting/bills/${id}/submit`, { method: "POST", json: {} })).status, 200);
  assert.equal((await appr(`/api/accounting/bills/${id}/reject`, { method: "POST", json: { reason: "abc" } })).status, 400, "reason too short");
  assert.equal((await appr(`/api/accounting/bills/${id}/approve`, { method: "POST", json: {} })).status, 200);
  const posted = await appr(`/api/accounting/bills/${id}/post`, { method: "POST", json: {} });
  assert.equal(posted.status, 200, JSON.stringify(posted.body));
  assert.equal(posted.body.ledger.status, "TRANSLATED");
  const detail = (await appr(`/api/accounting/bills/${id}`)).body;
  assert.equal(detail.status, "POSTED"); assert.equal(detail.obligation.remaining, "345.58");
  assert.notEqual(detail.createdBy, detail.approvedBy);

  // Finance records and reviews the payment; the outbox and the processor post it.
  const bank = (await db.query(`select id from "CashAccount" where code = 'ACC-BANK'`)).rows[0].id;
  const cat = (await db.query(`select id from "FinCategory" where code = 'ACC-SUPPLIERS'`)).rows[0].id;
  const t = (await db.query(`insert into "BankTransaction"(id, "cashAccountId", "branchKey", "txnDate", amount, status, classification, "reviewStatus", "bankReference", "updatedAt") values ('rt-' || gen_random_uuid(), $1, 'COMPANY', $2, -345.58, 'CONFIRMED', 'SUPPLIER_PAYMENT', 'NEEDS_REVIEW', 'HTTP-PAY', now()) returning id`, [bank, iso(9, 27)])).rows[0].id;
  await db.query(`insert into "BankTransactionSplit"(id, "transactionId", "finCategoryId", amount) values ('rt-' || gen_random_uuid(), $1, $2, -345.58)`, [t, cat]);
  await db.query(`insert into "BankTransactionMatch"(id, "transactionId", "targetType", "targetId", amount) values ('rt-' || gen_random_uuid(), $1, 'OBLIGATION', $2, 345.58)`, [t, detail.obligation.id]);
  await db.query(`update "BankTransaction" set "reviewStatus" = 'REVIEWED' where id = $1`, [t]);
  assert.equal((await appr("/api/accounting/events/process", { method: "POST", json: {} })).status, 200);
  const ev = (await db.query(`select status, "errorMessage" from "AccountingEvent" where "idempotencyKey" = $1`, [`bank:${t}:confirmed`])).rows[0];
  assert.equal(ev.status, "TRANSLATED", ev.errorMessage ?? "");
  const after = (await appr(`/api/accounting/bills/${id}`)).body;
  assert.equal(after.obligation.remaining, "0.00");
  const aging = (await appr("/api/accounting/reports/ap-aging")).body;
  assert.equal(aging.reconciled, true, JSON.stringify({ sub: aging.subledger, ledger: aging.ledger, expl: aging.explanation }));
  const st = (await appr(`/api/accounting/reports/supplier-statement?supplierId=${sup.id}&from=${iso(1, 1)}&to=${iso(12, 31)}`)).body;
  assert.equal(st.closing, st.ledgerBalance, "the supplier statement ties to the supplier's balance on the payables account");
  const posting = await appr(`/api/accounting/bills/${id}/reverse`, { method: "POST", json: { reason: "خطأ في الفاتورة" } });
  assert.equal(posting.status, 409, "a paid bill cannot be reversed");
});

async function login(username) {
  const r = await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ method: "password", username, password: process.env.FIN_PASSWORD }) });
  return r.headers.get("set-cookie").split(";")[0];
}

test("runtime role cannot bypass the bill rules directly in SQL", async () => {
  const posted = (await db.query(`select id from "SupplierBill" where status = 'POSTED' limit 1`)).rows[0].id;
  await assert.rejects(db.query(`update "SupplierBill" set "totalGross" = 1 where id = $1`, [posted]), /cannot be changed|reverse it/);
  await assert.rejects(db.query(`delete from "SupplierBill" where id = $1`, [posted]), /Only a draft/);
  await assert.rejects(db.query(`alter table "SupplierBill" disable trigger all`), /must be owner|permission denied/);
});

test("bank mapping and reconciliation over HTTP; manual journals on the mapped bank account are refused after the start date", async () => {
  const appr = await session("acc.approver");
  const prep = await session("acc.preparer");
  const m = (await appr("/api/accounting/bank")).body;
  assert.ok(m.settings.bankPostingFrom);
  const mkt = m.categories.find((c) => c.code === "ACC-MARKETING");
  const coa = (await appr("/api/accounting/coa")).body;
  const r = await appr(`/api/accounting/bank/categories/${mkt.id}`, { method: "PUT", json: { accountId: coa.find((a) => a.code === "6400").id } });
  assert.equal(r.status, 200);
  const bad = await appr(`/api/accounting/bank/categories/${mkt.id}`, { method: "PUT", json: { accountId: coa.find((a) => a.code === "1130").id } });
  assert.equal(bad.status, 400, "a receivables control account cannot be a category's account");
  await appr("/api/accounting/events/process", { method: "POST", json: {} });
  const rec = (await appr("/api/accounting/reports/bank-reconciliation")).body;
  const main = rec.accounts.find((a) => a.cashAccount.code === "ACC-BANK");
  const sum = main.items.notPosted.reduce((s, x) => s + Number(x.amount), 0) - main.items.manualJournalsAfterStart.reduce((s, x) => s + Number(x.amount), 0);
  assert.ok(Math.abs(sum - Number(main.difference)) < 0.005, `difference ${main.difference} is fully itemised (${sum.toFixed(2)})`);
  const till = rec.accounts.find((a) => a.cashAccount.code === "ACC-TILL");
  assert.equal(till.difference, "0.00", "the transfer's receiving leg is in the ledger through the paying leg");
  const j = await prep("/api/accounting/journals", { method: "POST", json: { entryDate: iso(9, 26), description: "cash fee", lines: [{ accountId: coa.find((a) => a.code === "6900").id, debit: "5", credit: "0" }, { accountId: coa.find((a) => a.code === "1120").id, debit: "0", credit: "5" }] } });
  assert.equal(j.status, 409); assert.match(j.body.error, /posted from bank lines only/);
});
