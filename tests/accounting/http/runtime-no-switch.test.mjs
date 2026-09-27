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
    const res = await fetch(`${BASE}/api/accounting/events/process`, { method: "POST", headers: { cookie, "Content-Type": "application/json" }, body: "{}" });
    assert.equal(res.status, 200);
    const one = await fetch(`${BASE}/api/accounting/events/${ev.id}/process`, { method: "POST", headers: { cookie, "Content-Type": "application/json" }, body: "{}" });
    assert.ok(one.status < 500);
    const st = (await db.query(`select status from "AccountingEvent" where id = $1`, [ev.id])).rows[0].status;
    assert.equal(st, "BLOCKED");
    assert.equal((await db.query(`select count(*)::int as n from "JournalEntry" where "originEventId" = $1`, [ev.id])).rows[0].n, 0);
    assert.equal((await db.query(`select count(*)::int as n from "JournalEntry" where "isProvisional"`)).rows[0].n, 0, "no provisional journal anywhere");
  } finally { await db.end(); }
});
