// Application-runtime verification: the real server, running as the restricted runtime role
// (accounting_app: DML only, like production's erp_app), against the local synthetic fixture.
// Covers the complete journal workflow, reversals, period controls, reports, commission
// integration (including the provisional path) and what the runtime role itself can and cannot do.
//
//   /tmp/claude-0/serve-runtime.sh   (next start with DATABASE_URL = accounting_app URL)
//   BASE_URL=http://localhost:3040 FIN_PASSWORD=... RUNTIME_DATABASE_URL=... \
//     node --test --test-concurrency=1 tests/accounting/http/runtime-workflow.test.mjs
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";

const BASE = process.env.BASE_URL ?? "http://localhost:3040";
if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(BASE)) throw new Error("Refusing to run against a non-local server.");
const DB_URL = process.env.RUNTIME_DATABASE_URL;
if (!DB_URL || !/@(127\.0\.0\.1|localhost):\d+\//.test(DB_URL)) throw new Error("RUNTIME_DATABASE_URL must be a local database.");
const PASSWORD = process.env.FIN_PASSWORD;
const { Client } = createRequire(import.meta.url)("pg");

let db;
before(async () => { db = new Client({ connectionString: DB_URL }); await db.connect(); });
after(async () => { await db?.end(); });

async function session(username) {
  const r = await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ method: "password", username, password: PASSWORD }) });
  assert.equal(r.status, 200, `login ${username}`);
  const cookie = r.headers.get("set-cookie").split(";")[0];
  return async (path, init = {}) => {
    const res = await fetch(`${BASE}${path}`, { ...init, headers: { cookie, "Content-Type": "application/json" }, body: init.json ? JSON.stringify(init.json) : undefined });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
}
const year = new Date().getUTCFullYear();
const iso = (m, d) => `${year}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

test("the server's database sessions are the runtime role, which has no elevated rights", async () => {
  const viewer = await session("acc.viewer");
  assert.equal((await viewer("/api/accounting/overview")).status, 200);
  const who = await db.query("select current_user as u, r.rolsuper, r.rolcreaterole, r.rolcreatedb, r.rolbypassrls from pg_roles r where r.rolname = current_user");
  assert.deepEqual(who.rows[0], { u: "accounting_app", rolsuper: false, rolcreaterole: false, rolcreatedb: false, rolbypassrls: false });
  const sessions = await db.query("select distinct usename from pg_stat_activity where datname = current_database() and backend_type = 'client backend' and usename is not null");
  assert.deepEqual(sessions.rows.map((r) => r.usename).sort(), ["accounting_app"], "only the runtime role is connected (test + server)");
});

test("runtime role cannot bypass ledger controls directly in SQL", async () => {
  const posted = (await db.query(`select l.id from "JournalEntryLine" l join "JournalEntry" e on e.id = l."journalEntryId" where e.status = 'POSTED' limit 1`)).rows[0];
  const refuse = async (sql, re) => { await assert.rejects(db.query(sql), re, sql); };
  await refuse(`update "JournalEntryLine" set debit = debit + 1 where id = '${posted.id}'`, /posted|immutable|cannot/i);
  await refuse(`delete from "JournalEntryLine" where id = '${posted.id}'`, /posted|immutable|cannot/i);
  await refuse(`truncate "JournalEntryLine"`, /permission denied/);
  await refuse(`alter table "JournalEntryLine" disable trigger all`, /must be owner|permission denied/);
  await refuse(`set session_replication_role = replica`, /permission denied/);
  await refuse(`create table rt_probe(x int)`, /permission denied/);
});

test("journal workflow as the runtime role: create → submit → approve (four-eyes) → post, then reversal", async () => {
  const prep = await session("acc.preparer");
  const appr = await session("acc.approver");
  const acc = (await prep("/api/accounting/coa")).body;
  const id = (code) => acc.find((a) => a.code === code).id;
  // Not a cash account: from the bank-posting start date (Stage 2) cash accounts take bank lines
  // only, which stage2-workflow.test.mjs covers.
  const day = iso(9, 15);
  const c = await prep("/api/accounting/journals", { method: "POST", json: { entryDate: day, description: "RT — bank fee accrued", lines: [{ accountId: id("6900"), debit: "33.10", credit: "0" }, { accountId: id("2130"), debit: "0", credit: "33.10" }] } });
  assert.equal(c.status, 201, JSON.stringify(c.body));
  const e = c.body.id;
  assert.equal((await prep(`/api/accounting/journals/${e}/submit`, { method: "POST", json: {} })).status, 200);
  assert.equal((await prep(`/api/accounting/journals/${e}/approve`, { method: "POST", json: {} })).status, 403);
  assert.equal((await appr(`/api/accounting/journals/${e}/approve`, { method: "POST", json: {} })).status, 200);
  const p = await appr(`/api/accounting/journals/${e}/post`, { method: "POST", json: {} });
  assert.equal(p.status, 200, JSON.stringify(p.body));

  const gl = (await appr(`/api/accounting/reports/general-ledger?accountId=${id("6900")}&from=${iso(9, 1)}&to=${iso(9, 30)}`)).body;
  assert.ok(JSON.stringify(gl).includes("RT — bank fee"), "posted entry appears in the general ledger");

  // Reversal: requested by the preparer, approved and posted by the approver.
  const rv = await prep(`/api/accounting/journals/${e}/reverse`, { method: "POST", json: { reason: "RT — wrong account", date: iso(9, 16) } });
  assert.equal(rv.status, 403, "preparer has no journal_reverse");
  const rv2 = await appr(`/api/accounting/journals/${e}/reverse`, { method: "POST", json: { reason: "RT — wrong account", date: iso(9, 16) } });
  assert.equal(rv2.status, 201, JSON.stringify(rv2.body));
  const approveOwn = await appr(`/api/accounting/journals/${rv2.body.id}/approve`, { method: "POST", json: {} });
  assert.equal(approveOwn.status, 403, "the requester of a reversal cannot approve it");
  const appr2 = await session("acc.approver.en");
  assert.equal((await appr2(`/api/accounting/journals/${rv2.body.id}/approve`, { method: "POST", json: {} })).status, 200);
  assert.equal((await appr2(`/api/accounting/journals/${rv2.body.id}/post`, { method: "POST", json: {} })).status, 200);
  assert.equal((await appr(`/api/accounting/journals/${e}`)).body.status, "REVERSED");
  const again = await appr(`/api/accounting/journals/${e}/reverse`, { method: "POST", json: { reason: "RT — twice" } });
  assert.ok(again.status >= 400 && again.status < 500, "a reversed entry cannot be reversed again");
});

test("period controls: no posting into a locked or closed period; unlock needs a reason", async () => {
  const prep = await session("acc.preparer");
  const appr = await session("acc.approver");
  const acc = (await prep("/api/accounting/coa")).body;
  const id = (code) => acc.find((a) => a.code === code).id;
  const periods = (await appr("/api/accounting/fiscal-periods")).body.filter((p) => p.year === year);
  const jul = periods.find((p) => p.periodNo === 7);
  const mar = periods.find((p) => p.periodNo === 3);
  assert.equal(jul.status, "LOCKED");
  assert.equal(mar.status, "CLOSED");
  for (const [m, label] of [[7, "locked"], [3, "closed"]]) {
    const c = await prep("/api/accounting/journals", { method: "POST", json: { entryDate: iso(m, 10), description: `RT — into ${label}`, lines: [{ accountId: id("6900"), debit: "1.00", credit: "0" }, { accountId: id("1120"), debit: "0", credit: "1.00" }] } });
    assert.ok(c.status >= 400 && c.status < 500, `create into ${label} period refused (${c.status})`);
    assert.notEqual(c.status, 500);
  }
  assert.equal((await appr(`/api/accounting/fiscal-periods/${jul.id}/unlock`, { method: "POST", json: {} })).status, 400, "reason required");
  assert.equal((await prep(`/api/accounting/fiscal-periods/${jul.id}/unlock`, { method: "POST", json: { reason: "RT — preparer" } })).status, 403);
  const blockers = await appr(`/api/accounting/fiscal-periods/${periods.find((p) => p.periodNo === 9).id}/close-check`);
  assert.equal(blockers.status, 200);
  assert.ok(Array.isArray(blockers.body.blockers ?? blockers.body), "close-check lists blockers for the open month with pending entries");
});

test("commission integration as the runtime role: accrual → one journal; duplicate processing adds nothing; subledger ties", async () => {
  const appr = await session("acc.approver");
  const v = (await db.query(`select v.id, v.version, v."accountingApproval" as a from "CommissionPlanVersion" v order by v.version`)).rows;
  const approved = v.find((x) => x.a === "APPROVED");
  const rep = (await db.query(`select id from "Employee" where username = 'rep.reem'`)).rows[0].id;
  const entryId = `rt-${randomUUID()}`;
  // The sales module writes the movement; the outbox trigger creates the accounting event.
  await db.query(`insert into "CommissionLedgerEntry"(id, type, "employeeId", "periodStart", amount, "planVersionId", reason) values ($1, 'ACCRUAL', $2, $3, 432.10, $4, 'RT accrual')`, [entryId, rep, `${iso(9, 1)}T00:00:00Z`, approved.id]);
  const ev = (await db.query(`select id, status from "AccountingEvent" where "sourceDocumentId" = $1 or "sourceEventId" = $1`, [entryId])).rows;
  assert.equal(ev.length, 1, "outbox created exactly one event");
  const r1 = await appr("/api/accounting/events/process", { method: "POST", json: {} });
  assert.equal(r1.status, 200, JSON.stringify(r1.body));
  const r2 = await appr(`/api/accounting/events/${ev[0].id}/process`, { method: "POST", json: {} });
  assert.ok(r2.status < 500);
  const js = (await db.query(`select "entryNo", status, "isProvisional", "policyKey", "policyVersion", "totalDebit" from "JournalEntry" where "originEventId" = $1`, [ev[0].id])).rows;
  assert.equal(js.length, 1, "exactly one journal for the event, even after reprocessing");
  assert.equal(js[0].status, "POSTED");
  assert.equal(js[0].isProvisional, false);
  assert.equal(js[0].policyKey, "commissions.recognition");
  assert.ok(js[0].policyVersion >= 1);
  assert.equal(Number(js[0].totalDebit), 432.1);
  const rec = (await appr("/api/accounting/reports/commission-reconciliation")).body;
  assert.equal(rec.reconciled, true, JSON.stringify(rec).slice(0, 400));
});

test("provisional plan version: posts only because this is a marked disposable database with the isolated-test switch, and is labelled", async () => {
  const appr = await session("acc.approver");
  // The fixture's plan-v2 accrual was BLOCKED when seeded without the switch. This server has the
  // isolated-test switch, so processing (here, or the batch run above) translates it provisionally.
  const v2 = (await db.query(`select e.id, e.status from "AccountingEvent" e join "CommissionLedgerEntry" c on c.id = e."sourceDocumentId" join "CommissionPlanVersion" v on v.id = c."planVersionId" where v."accountingApproval" <> 'APPROVED' limit 1`)).rows[0];
  assert.ok(v2, "fixture has an accrual under the unapproved plan v2");
  if (v2.status === "BLOCKED") assert.equal((await appr(`/api/accounting/events/${v2.id}/process`, { method: "POST", json: {} })).status, 200);
  const j = (await db.query(`select "isProvisional", status from "JournalEntry" where "originEventId" = $1`, [v2.id])).rows;
  assert.equal(j.length, 1);
  assert.equal(j[0].isProvisional, true, "journal from an unapproved plan version is labelled provisional");
  const list = (await appr("/api/accounting/journals?provisional=only")).body;
  assert.ok(list.total >= 1);
  const tbAll = (await appr(`/api/accounting/reports/trial-balance?from=${iso(1, 1)}&to=${iso(12, 31)}`)).body;
  const tbFinal = (await appr(`/api/accounting/reports/trial-balance?from=${iso(1, 1)}&to=${iso(12, 31)}&provisional=exclude`)).body;
  assert.equal(tbAll.balanced, true);
  assert.equal(tbFinal.balanced, true);
  assert.notEqual(tbAll.totals.closingDebit, tbFinal.totals.closingDebit, "provisional amounts can be excluded from reports");
  // The database, not only the service, refuses a provisional entry when the marker is absent — proven
  // in tests/accounting/integration (policy gate) and on the Neon rehearsal copy of production.
});

test("reports stay consistent after all of the above", async () => {
  const s = await session("acc.viewer");
  const tb = (await s(`/api/accounting/reports/trial-balance?from=${iso(1, 1)}&to=${iso(12, 31)}`)).body;
  assert.equal(tb.balanced, true);
  const is = await s(`/api/accounting/reports/income-statement?from=${iso(1, 1)}&to=${iso(12, 31)}`);
  assert.equal(is.status, 200);
  const bs = (await s(`/api/accounting/reports/balance-sheet?to=${iso(12, 31)}`)).body;
  assert.equal(bs.balanced, true);
  const audit = await s("/api/accounting/audit");
  assert.equal(audit.status, 200);
  assert.ok((audit.body.rows ?? audit.body).length > 0, "actions are audited");
});
