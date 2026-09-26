// ACCEPTANCE 16/17 over real HTTP: the API refuses financial actions to users without the
// duty, and enforces branch scope on reads and writes — independent of any hidden button.
//
//   BASE_URL=http://localhost:3040 FIN_PASSWORD=... node --test tests/finance/http/authz.test.mjs
//
// Runs against the LOCAL fixture server only (scripts/finance/seed-local-fixture.ts).
import { test } from "node:test";
import assert from "node:assert/strict";

const BASE = process.env.BASE_URL ?? "http://localhost:3040";
if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(BASE)) throw new Error("Refusing to run against a non-local server.");
const PASSWORD = process.env.FIN_PASSWORD;

async function session(username) {
  const r = await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ method: "password", username, password: PASSWORD }) });
  assert.equal(r.status, 200, `login ${username}`);
  const cookie = r.headers.get("set-cookie").split(";")[0];
  return async (path, init = {}) => {
    const res = await fetch(`${BASE}${path}`, { ...init, headers: { cookie, "Content-Type": "application/json", ...(init.headers ?? {}) }, body: init.json ? JSON.stringify(init.json) : init.body });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
}

test("no session → 401 on every finance endpoint", async () => {
  for (const p of ["/api/finance/overview", "/api/finance/transactions", "/api/finance/budgets"]) {
    assert.equal((await fetch(`${BASE}${p}`)).status, 401, p);
  }
});

test("no finance module → 403 on reads and writes", async () => {
  const s = await session("no.finance");
  assert.equal((await s("/api/finance/overview")).status, 403);
  assert.equal((await s("/api/finance/transactions", { method: "POST", json: { amount: "1" } })).status, 403);
});

test("finance viewer (no duties) can read but every financial write is refused", async () => {
  const s = await session("fin.viewer");
  const m = await session("fin.manager");
  assert.equal((await s("/api/finance/overview")).status, 200);
  // The viewer has no branch access at all, so it reads an empty scope; real ids come from the manager.
  assert.equal((await s("/api/finance/accounts")).body.length, 0, "no branch access → sees no accounts");
  const accounts = (await m("/api/finance/accounts")).body;
  const cats = (await m("/api/finance/categories")).body;
  const budgets = (await m("/api/finance/budgets")).body;
  const approvals = await s("/api/finance/approvals");
  const writes = [
    ["/api/finance/transactions", { cashAccountId: accounts[0].id, amount: "1", txnDate: "2026-09-01" }],
    ["/api/finance/imports", { cashAccountId: accounts[0].id, csv: "Date,Amount\n2026-09-01,1\n", mapping: { date: "Date", amount: "Amount" } }],
    ["/api/finance/allocations/manual", { categoryId: cats[0].id, amount: "1", sourceCashAccountId: accounts[0].id, reason: "x" }],
    ["/api/finance/allocations/transfer", { fromCategoryId: cats[0].id, toCategoryId: cats[1].id, amount: "1", reason: "x" }],
    ["/api/finance/reservations", { categoryId: cats[0].id, amount: "1", payee: "x", purpose: "x" }],
    ["/api/finance/budgets", { month: "2027-03" }],
    ["/api/finance/reconciliations", { cashAccountId: accounts[0].id, statementDate: "2026-09-01", statementBalance: "0" }],
    ["/api/finance/obligations", { type: "RENT", description: "x", amount: "1", dueDate: "2026-12-01" }],
    [`/api/finance/budgets/${budgets[0].id}/close`, {}],
  ];
  for (const [path, json] of writes) assert.equal((await s(path, { method: "POST", json })).status, 403, path);
  assert.equal((await s("/api/finance/setup/settings", { method: "PATCH", json: { allowSelfApproval: true } })).status, 403);
  assert.equal(approvals.body.toDecide.length, 0, "a viewer has nothing to decide");
});

test("a preparer cannot decide approvals; the named approver can see them", async () => {
  const prep = await session("fin.manager");
  const appr = await session("fin.approver");
  const q = (await appr("/api/finance/approvals")).body;
  assert.ok(q.toDecide.length >= 1);
  const r = await prep(`/api/finance/approvals/${q.toDecide[0].id}/decide`, { method: "POST", json: { decision: "APPROVE" } });
  assert.equal(r.status, 403);
});

test("branch scope: the café user sees only café data and cannot touch company accounts", async () => {
  const cafe = await session("fin.cafe");
  const manager = await session("fin.manager");
  const all = (await manager("/api/finance/accounts")).body;
  const company = all.find((a) => a.branchKey === "COMPANY");
  const mine = (await cafe("/api/finance/accounts")).body;
  assert.ok(mine.length >= 1 && mine.every((a) => a.branchKey !== "COMPANY"));
  const lines = (await cafe("/api/finance/transactions?take=200")).body.rows;
  assert.ok(lines.every((t) => t.branchKey !== "COMPANY"));
  const companyLine = (await manager("/api/finance/transactions?take=1&accountId=" + company.id)).body.rows[0];
  assert.equal((await cafe(`/api/finance/transactions/${companyLine.id}`)).status, 404);
  assert.equal((await cafe("/api/finance/transactions", { method: "POST", json: { cashAccountId: company.id, amount: "1", txnDate: "2026-09-01" } })).status, 404);
  assert.equal((await cafe("/api/finance/overview?branch=COMPANY")).status, 404, "cannot widen scope with a query parameter");
});
