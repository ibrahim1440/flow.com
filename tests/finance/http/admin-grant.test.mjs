// First grant of Finance duties, over real HTTP (local fixture server only).
//
// An administrator whose stored permissions predate the Finance module has no finance access
// and needs none to grant it: duties are assigned in Employees (employees.edit), which does
// not depend on Finance. Permissions are read from the database on every request, so a grant
// applies on the grantee's next request, with no re-login.
//
//   BASE_URL=http://localhost:3040 FIN_PASSWORD=... node --test tests/finance/http/admin-grant.test.mjs
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

const FIN_SUBS = ["txn_enter", "reconcile", "budget_prepare", "budget_approve", "allocate", "transfer_approve", "spend_override_approve", "period_close", "all_branches", "settings_manage"];
const finance = (granted) => ({ access: "edit", sub: Object.fromEntries(FIN_SUBS.map((k) => [k, granted.includes(k)])) });

test("administrator grants the first Finance preparer and approver without holding Finance", async () => {
  const admin = await session("legacy.admin");
  const prepS = await session("new.preparer");
  const apprS = await session("new.approver");

  // Before: nobody involved has Finance, including the administrator.
  assert.equal((await admin("/api/finance/overview")).status, 403, "a pre-Finance admin record gets no finance access implicitly");
  assert.equal((await prepS("/api/finance/overview")).status, 403);
  assert.equal((await apprS("/api/finance/overview")).status, 403);

  const staff = (await admin("/api/employees")).body;
  const find = (u) => staff.find((e) => e.username === u);
  const prep = find("new.preparer"), appr = find("new.approver");
  assert.ok(prep && appr, "admin sees the employees");
  const withFinance = (e, granted) => ({ ...(typeof e.permissions === "string" ? JSON.parse(e.permissions) : e.permissions), finance: finance(granted) });

  // Grant — Employees API only (employees.edit); no Finance permission involved.
  let r = await admin(`/api/employees/${prep.id}`, { method: "PUT", json: { name: prep.name, role: prep.role, permissions: withFinance(prep, ["txn_enter", "budget_prepare", "allocate", "all_branches"]) } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  r = await admin(`/api/employees/${appr.id}`, { method: "PUT", json: { name: appr.name, role: appr.role, permissions: withFinance(appr, ["budget_approve", "spend_override_approve", "transfer_approve", "all_branches"]) } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await admin("/api/finance/overview")).status, 403, "granting others did not grant the admin");

  // Effective on the next request (no re-login).
  assert.equal((await prepS("/api/finance/overview")).status, 200);
  assert.equal((await apprS("/api/finance/overview")).status, 200);

  // Separation holds: preparer prepares, cannot approve; approver approves, cannot prepare.
  const setup = (await prepS("/api/finance/setup")).body;
  const rent = setup.finCategories.find((c) => c.kind === "PAYMENT" && c.active);
  const b = await prepS("/api/finance/budgets", { method: "POST", json: { month: "2027-01" } });
  assert.equal(b.status, 201, JSON.stringify(b.body));
  const budgetId = b.body.id ?? b.body.budget?.id;
  assert.equal((await apprS("/api/finance/budgets", { method: "POST", json: { month: "2027-02" } })).status, 403, "approver cannot prepare");
  r = await prepS(`/api/finance/budgets/${budgetId}/lines`, { method: "PUT", json: { lines: [{ kind: "PAYMENT", finCategoryId: rent.id, plannedAmount: "500.00" }] } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const sub = await prepS(`/api/finance/budgets/${budgetId}/submit`, { method: "POST", json: {} });
  assert.equal(sub.status, 201, JSON.stringify(sub.body));
  const reqId = sub.body.id;
  assert.equal((await prepS(`/api/finance/approvals/${reqId}/decide`, { method: "POST", json: { decision: "APPROVE" } })).status, 403, "preparer cannot approve (no budget_approve)");
  r = await apprS(`/api/finance/approvals/${reqId}/decide`, { method: "POST", json: { decision: "APPROVE" } });
  assert.equal(r.status, 200, JSON.stringify(r.body));

  // Revocation is also immediate.
  r = await admin(`/api/employees/${appr.id}`, { method: "PUT", json: { name: appr.name, role: appr.role, permissions: { ...withFinance(appr, []), finance: { access: "none" } } } });
  assert.equal(r.status, 200);
  assert.equal((await apprS("/api/finance/overview")).status, 403, "revoked on the next request");
});
