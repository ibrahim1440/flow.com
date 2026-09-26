// The resolved decisions over real HTTP, against the LOCAL fixture server of the candidate.
// Nothing here changes the fixture: every write below is expected to be refused.
//
//   BASE_URL=http://localhost:3080 FIN_PASSWORD=... node --test tests/finance/http/uat-decisions.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";

const BASE = process.env.BASE_URL ?? "http://localhost:3080";
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

test("D6: branch access changes are refused to a finance-settings holder who is not an administrator, and to anyone for themselves", async () => {
  const m = await session("fin.manager");
  const a = await session("fin.admin");
  const setup = (await a("/api/finance/setup")).body;
  const cafe = setup.branches[0].id;
  const viewer = setup.people.find((p) => /عرض فقط/.test(p.name)).id;
  const before = setup.branchAccess.length;
  assert.equal((await m("/api/finance/setup/branch-access", { method: "POST", json: { employeeId: viewer, branchId: cafe, grant: true } })).status, 403);
  const adminId = setup.people.find((p) => /مسؤول النظام — المالية/.test(p.name)).id;
  const self = await a("/api/finance/setup/branch-access", { method: "POST", json: { employeeId: adminId, branchId: cafe, grant: true } });
  assert.equal(self.status, 403);
  assert.match(self.body.error, /own branch access/);
  assert.equal((await a("/api/finance/setup")).body.branchAccess.length, before, "no access changed");
});

test("D3a: creating an allocation category needs the prepare duty", async () => {
  const v = await session("fin.viewer");
  assert.equal((await v("/api/finance/categories", { method: "POST", json: { code: "X-VIEW", nameEn: "Viewer's category" } })).status, 403);
});

test("D5: cancelling needs a reason; the effects are readable first", async () => {
  const m = await session("fin.manager");
  const obs = (await m("/api/finance/obligations?take=50")).body.rows;
  const rent = obs.find((o) => o.type === "RENT");
  const fx = await m(`/api/finance/obligations/${rent.id}/cancel`);
  assert.equal(fx.status, 200);
  assert.equal(fx.body.remaining, rent.remaining);
  const r = await m(`/api/finance/obligations/${rent.id}/cancel`, { method: "POST", json: { reason: "no" } });
  assert.equal(r.status, 400);
  assert.equal((await m("/api/finance/obligations?take=50")).body.rows.find((o) => o.id === rent.id).status, "OPEN");
  const v = await session("fin.viewer");
  assert.equal((await v(`/api/finance/obligations/${rent.id}/cancel`, { method: "POST", json: { reason: "Viewer tries to cancel" } })).status, 403);
});

test("Sales collection: the Al Qasr receipt is offered its approved collection by reference; a viewer cannot link it", async () => {
  const m = await session("fin.manager");
  const lines = (await m("/api/finance/transactions?q=IN-2301")).body.rows;
  assert.equal(lines.length, 1);
  const s = await m(`/api/finance/transactions/${lines[0].id}/collection`);
  assert.equal(s.status, 200);
  if (s.body.linked) return; // already linked during a walkthrough run
  assert.equal(s.body.decision.kind, "MATCH");
  assert.equal(s.body.decision.basis, "REFERENCE");
  assert.deepEqual([s.body.candidates[0].amountGross, s.body.candidates[0].amountTax], [575000, 75000]);
  const v = await session("fin.viewer");
  assert.equal((await v(`/api/finance/transactions/${lines[0].id}/collection`, { method: "POST", json: { collectionId: s.body.candidates[0].id } })).status, 403);
});
