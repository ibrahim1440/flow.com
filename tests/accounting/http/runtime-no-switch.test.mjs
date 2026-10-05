// Runtime role, server started WITHOUT ACCOUNTING_PROVISIONAL_POSTING (production configuration):
// an accrual under an unapproved plan version stays BLOCKED and produces no journal.
//
//   Run on a freshly seeded fixture, before any server with the switch has processed events.
//   ACCOUNTING_PROVISIONAL_POSTING unset → /tmp/claude-0/serve-runtime.sh --no-switch
//   BASE_URL=... FIN_PASSWORD=... RUNTIME_DATABASE_URL=... node --test tests/accounting/http/runtime-no-switch.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const BASE = process.env.BASE_URL ?? "http://localhost:3040";
if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(BASE)) throw new Error("Refusing to run against a non-local server.");
const DB_URL = process.env.RUNTIME_DATABASE_URL;
if (!DB_URL || !/@(127\.0\.0\.1|localhost):\d+\//.test(DB_URL)) throw new Error("RUNTIME_DATABASE_URL must be a local database.");
const { Client } = createRequire(import.meta.url)("pg");

test("without the isolated-test switch an unapproved plan version cannot post", async () => {
  const r = await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ method: "password", username: "acc.approver", password: process.env.FIN_PASSWORD }) });
  const cookie = r.headers.get("set-cookie").split(";")[0];
  const db = new Client({ connectionString: DB_URL });
  await db.connect();
  try {
    const ev = (await db.query(`select e.id from "AccountingEvent" e join "CommissionLedgerEntry" c on c.id = e."sourceDocumentId" join "CommissionPlanVersion" v on v.id = c."planVersionId" where v."accountingApproval" <> 'APPROVED' and e.status in ('PENDING', 'BLOCKED') limit 1`)).rows[0];
    // Needs a fresh fixture: a server running WITH the switch would already have posted these.
    assert.ok(ev, "no unprocessed event under an unapproved plan version — reseed the fixture and run this suite first");
    // The fixture itself posts its stage 4 inventory documents provisionally while seeding (D-1 is
    // undecided in it). Those are the only provisional journals allowed; this server must add none.
    const provisional = async () => (await db.query(`select count(*)::int as n, count(*) filter (where "sourceModule" <> 'inventory')::int as other from "JournalEntry" where "isProvisional"`)).rows[0];
    const before = await provisional();
    assert.equal(before.other, 0, "no provisional journal outside the fixture's inventory documents");
    const res = await fetch(`${BASE}/api/accounting/events/process`, { method: "POST", headers: { cookie, "Content-Type": "application/json" }, body: "{}" });
    assert.equal(res.status, 200);
    const one = await fetch(`${BASE}/api/accounting/events/${ev.id}/process`, { method: "POST", headers: { cookie, "Content-Type": "application/json" }, body: "{}" });
    assert.ok(one.status < 500);
    const st = (await db.query(`select status from "AccountingEvent" where id = $1`, [ev.id])).rows[0].status;
    assert.equal(st, "BLOCKED");
    assert.equal((await db.query(`select count(*)::int as n from "JournalEntry" where "originEventId" = $1`, [ev.id])).rows[0].n, 0);
    assert.deepEqual(await provisional(), before, "the server without the switch created no provisional journal");
  } finally { await db.end(); }
});

test("without the isolated-test switch an inventory document cannot post while decision D-1 is undecided", async () => {
  const login = async (username) => (await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ method: "password", username, password: process.env.FIN_PASSWORD }) })).headers.get("set-cookie").split(";")[0];
  const cookie = await login("acc.approver");
  const call = (path) => fetch(`${BASE}${path}`, { method: "POST", headers: { cookie, "Content-Type": "application/json" }, body: "{}" });
  const db = new Client({ connectionString: DB_URL });
  await db.connect();
  try {
    const doc = (await db.query(`select id, status from "InvDocument" where "sourceType" = 'ROASTING_BATCH' and status in ('SUBMITTED', 'APPROVED') limit 1`)).rows[0];
    assert.ok(doc, "the fixture leaves a roasting production awaiting approval");
    if (doc.status === "SUBMITTED") assert.equal((await call(`/api/accounting/inventory/documents/${doc.id}/approve`)).status, 200);
    const res = await call(`/api/accounting/inventory/documents/${doc.id}/post`);
    assert.equal(res.status, 409);
    assert.match((await res.json()).error, /Waiting for decision D-1/);
    const after = (await db.query(`select status, (select count(*)::int from "InvMove" where "documentId" = $1) as moves from "InvDocument" where id = $1`, [doc.id])).rows[0];
    assert.deepEqual(after, { status: "APPROVED", moves: 0 }, "nothing half-posted");
  } finally { await db.end(); }
});
