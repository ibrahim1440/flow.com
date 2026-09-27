// Accounting API authorisation over real HTTP, against the local fixture server only
// (scripts/accounting/seed-local-fixture.ts). Permissions are enforced by the server; the
// screens hiding a button is not what these tests rely on.
//
//   BASE_URL=http://localhost:3040 FIN_PASSWORD=... node --test tests/accounting/http/authz.test.mjs
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
const anon = async (path, init = {}) => {
  const res = await fetch(`${BASE}${path}`, { ...init, headers: { "Content-Type": "application/json" }, body: init.json ? JSON.stringify(init.json) : undefined });
  return res.status;
};

const READS = ["/api/accounting/overview", "/api/accounting/journals", "/api/accounting/coa", "/api/accounting/fiscal-periods", "/api/accounting/events",
  "/api/accounting/reports/trial-balance", "/api/accounting/reports/income-statement", "/api/accounting/reports/balance-sheet",
  "/api/accounting/reports/commission-reconciliation", "/api/accounting/policies", "/api/accounting/mappings", "/api/accounting/audit"];

test("no session: every accounting endpoint answers 401", async () => {
  for (const p of READS) assert.equal(await anon(p), 401, p);
  assert.equal(await anon("/api/accounting/journals", { method: "POST", json: {} }), 401);
  assert.equal(await anon("/api/accounting/events/process", { method: "POST", json: {} }), 401);
});

test("no accounting module: 403 on reads and writes", async () => {
  const s = await session("no.accounting");
  for (const p of READS) assert.equal((await s(p)).status, 403, p);
  assert.equal((await s("/api/accounting/journals", { method: "POST", json: {} })).status, 403);
});

test("view-only: reads succeed, every write is refused", async () => {
  const s = await session("acc.viewer");
  for (const p of READS) assert.equal((await s(p)).status, 200, p);
  const j = (await s("/api/accounting/journals?status=SUBMITTED")).body.rows[0];
  const writes = [
    ["POST", "/api/accounting/journals", { entryDate: "2026-09-01", lines: [] }],
    ["POST", `/api/accounting/journals/${j.id}/approve`, {}],
    ["POST", `/api/accounting/journals/${j.id}/post`, {}],
    ["POST", `/api/accounting/journals/${j.id}/reject`, { reason: "Viewer tries" }],
    ["POST", `/api/accounting/journals/${j.id}/reverse`, { reason: "Viewer tries" }],
    ["POST", "/api/accounting/events/process", {}],
    ["POST", "/api/accounting/policies", { key: "commissions.recognition" }],
    ["PUT", "/api/accounting/mappings", { role: "COMMISSION_EXPENSE", accountId: "x" }],
    ["PATCH", "/api/accounting/settings", { setupComplete: false }],
    ["POST", "/api/accounting/coa", { code: "9999", nameEn: "x", type: "EXPENSE" }],
    ["POST", "/api/accounting/setup/template", {}],
  ];
  for (const [method, path, json] of writes) assert.equal((await s(path, { method, json })).status, 403, `${method} ${path}`);
});

test("separation of duties over HTTP: the preparer cannot approve; the approver cannot create; identity comes from the session", async () => {
  const prep = await session("acc.preparer");
  const appr = await session("acc.approver");
  const accounts = (await prep("/api/accounting/coa")).body;
  const id = (code) => accounts.find((a) => a.code === code).id;
  const day = new Date(Date.now() + 3 * 3600_000).toISOString().slice(0, 10);
  const created = await prep("/api/accounting/journals", { method: "POST", json: { entryDate: day, description: "HTTP test — employee custody", lines: [{ accountId: id("6900"), debit: "12.50", credit: "0" }, { accountId: id("1140"), debit: "0", credit: "12.50" }] } });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const e = created.body.id;
  assert.equal((await appr("/api/accounting/journals", { method: "POST", json: { entryDate: day, lines: [] } })).status, 403, "approver has no journal_create");
  assert.equal((await prep(`/api/accounting/journals/${e}/submit`, { method: "POST", json: {} })).status, 200);
  assert.equal((await prep(`/api/accounting/journals/${e}/approve`, { method: "POST", json: { approvedBy: "someone-else" } })).status, 403, "preparer has no journal_approve, whatever the body says");
  const ok = await appr(`/api/accounting/journals/${e}/approve`, { method: "POST", json: {} });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  const again = await appr(`/api/accounting/journals/${e}/approve`, { method: "POST", json: {} });
  assert.equal(again.status, 409, "double approval is a conflict, not a second approval");
  const posted = await appr(`/api/accounting/journals/${e}/post`, { method: "POST", json: {} });
  assert.equal(posted.status, 200, JSON.stringify(posted.body));
  const detail = (await appr(`/api/accounting/journals/${e}`)).body;
  assert.equal(detail.status, "POSTED");
  assert.notEqual(detail.createdBy, detail.approvedBy);
  // Unbalanced and malformed bodies are 400 with a message, never 500.
  const bad = await prep("/api/accounting/journals", { method: "POST", json: { entryDate: day, lines: [{ accountId: id("6900"), debit: "10", credit: "0" }, { accountId: id("1140"), debit: "0", credit: "9" }] } });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /must equal credits/);
  assert.equal((await prep("/api/accounting/journals", { method: "POST", body: "{not json" })).status, 400);
  assert.equal((await prep("/api/accounting/journals", { method: "POST", json: { entryDate: "31/12/2026", lines: [] } })).status, 400);
});

test("reports balance on the fixture", async () => {
  const s = await session("acc.viewer");
  const tb = (await s("/api/accounting/reports/trial-balance?from=2026-01-01&to=2026-12-31")).body;
  assert.equal(tb.balanced, true);
  assert.equal(tb.totals.closingDebit, tb.totals.closingCredit);
  const bs = (await s("/api/accounting/reports/balance-sheet?to=2026-12-31")).body;
  assert.equal(bs.balanced, true);
  const rec = (await s("/api/accounting/reports/commission-reconciliation")).body;
  assert.equal(rec.reconciled, true);
});
