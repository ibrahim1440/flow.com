// The approver's identity comes from the authenticated server-side session — never from
// anything the caller sends. Over real HTTP against the local fixture server.
//
//   BASE_URL=http://localhost:3040 FIN_PASSWORD=... node --test tests/finance/http/approver-identity.test.mjs
//
// fin.dual holds BOTH budget_prepare and budget_approve, so the duty check does not stop them:
// only the requester ≠ decider rule, applied to the SESSION identity, does. Every route to
// that rule — body fields, query parameters, identity-looking headers, a forged cookie — is
// tried, and the request must stay undecided.
import { test } from "node:test";
import assert from "node:assert/strict";

const BASE = process.env.BASE_URL ?? "http://localhost:3040";
if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(BASE)) throw new Error("Refusing to run against a non-local server.");
const PASSWORD = process.env.FIN_PASSWORD;

async function session(username) {
  const r = await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ method: "password", username, password: PASSWORD }) });
  assert.equal(r.status, 200, `login ${username}`);
  const cookie = r.headers.get("set-cookie").split(";")[0];
  const call = async (path, init = {}) => {
    const res = await fetch(`${BASE}${path}`, { ...init, headers: { cookie, "Content-Type": "application/json", ...(init.headers ?? {}) }, body: init.json ? JSON.stringify(init.json) : init.body });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  call.cookie = cookie;
  return call;
}

test("a requester cannot approve their own request by supplying another approver's identity", async () => {
  const dual = await session("fin.dual");
  const appr = await session("fin.approver");
  const staff = (await (await session("legacy.admin"))("/api/employees")).body;
  const idOf = (u) => staff.find((e) => e.username === u).id;
  const dualId = idOf("fin.dual"), apprId = idOf("fin.approver");

  // fin.dual prepares and submits a budget → a pending request they raised.
  const setup = (await dual("/api/finance/setup")).body;
  const rent = setup.finCategories.find((c) => c.kind === "PAYMENT" && c.active);
  const b = await dual("/api/finance/budgets", { method: "POST", json: { month: "2027-05" } });
  assert.equal(b.status, 201, JSON.stringify(b.body));
  const budgetId = b.body.id ?? b.body.budget?.id;
  assert.equal((await dual(`/api/finance/budgets/${budgetId}/lines`, { method: "PUT", json: { lines: [{ kind: "PAYMENT", finCategoryId: rent.id, plannedAmount: "900.00" }] } })).status, 200);
  const sub = await dual(`/api/finance/budgets/${budgetId}/submit`, { method: "POST", json: {} });
  assert.equal(sub.status, 201, JSON.stringify(sub.body));
  const reqId = sub.body.id;
  const decide = `/api/finance/approvals/${reqId}/decide`;

  // Identity claims the server must ignore.
  const claims = { decidedBy: apprId, actorId: apprId, userId: apprId, approverId: apprId, employeeId: apprId, requestedBy: apprId, assignedToId: apprId, id: apprId };
  const attempts = [
    ["body identity fields", { json: { decision: "APPROVE", ...claims } }],
    ["query parameters", { path: `${decide}?decidedBy=${apprId}&actorId=${apprId}&userId=${apprId}&approverId=${apprId}`, json: { decision: "APPROVE" } }],
    ["identity-looking headers", { json: { decision: "APPROVE" }, headers: { "x-user-id": apprId, "x-actor-id": apprId, "x-employee-id": apprId, "x-approver-id": apprId, "x-forwarded-user": "fin.approver", "x-remote-user": "fin.approver", "x-authenticated-user": apprId } }],
    ["all at once", { path: `${decide}?decidedBy=${apprId}`, json: { decision: "APPROVE", ...claims }, headers: { "x-user-id": apprId, "x-forwarded-user": "fin.approver" } }],
  ];
  for (const [label, a] of attempts) {
    const r = await dual(a.path ?? decide, { method: "POST", json: a.json, headers: a.headers });
    assert.equal(r.status, 403, `${label}: expected 403, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.match(r.body.error, /cannot decide a request you raised/, label);
  }

  // A forged or tampered session is not a session.
  const tampered = dual.cookie.replace(/.$/, (c) => (c === "A" ? "B" : "A"));
  for (const cookie of [tampered, "token=not-a-jwt", `token=${Buffer.from(JSON.stringify({ id: apprId })).toString("base64")}`]) {
    const r = await fetch(`${BASE}${decide}`, { method: "POST", headers: { cookie, "Content-Type": "application/json" }, body: JSON.stringify({ decision: "APPROVE" }) });
    assert.equal(r.status, 401, `forged cookie → ${r.status}`);
  }

  // Nothing was decided.
  const mine = (await dual("/api/finance/approvals")).body.raisedByMe.find((r) => r.id === reqId);
  assert.equal(mine.status, "PENDING");
  assert.equal(mine.decidedBy, null);

  // The real approver decides; the recorded decider is the session's employee, whatever the
  // body claims.
  const ok = await appr(decide, { method: "POST", json: { decision: "APPROVE", decidedBy: dualId, actorId: dualId, userId: dualId }, headers: { "x-user-id": dualId } });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.decidedBy, apprId, "decidedBy comes from the session, not from the body or headers");
  assert.equal(ok.body.requestedBy, dualId);
});
