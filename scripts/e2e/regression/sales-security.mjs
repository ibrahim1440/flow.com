// SALES CRM & COMMISSIONS — SECURITY NEGATIVE TESTS, through the real HTTP API.
//
// Every case here tries to do something it must not be allowed to do. A passing assertion
// means the server REFUSED. Checking that a button is hidden proves nothing: the button is
// not the control, the handler is.
//
// Requires a running app pointed at the verified preview database.
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../../..");
const require_ = createRequire(path.join(ROOT, "package.json"));
const pg = require_("pg");
const bcrypt = require_("bcryptjs");
const crypto = await import("node:crypto");

const BASE = process.env.SALES_TEST_BASE_URL ?? "http://127.0.0.1:3020";
const URL_ = process.env.DATABASE_URL ?? "";
const dbName = (URL_.match(/\/([a-z0-9_]+)(\?|$)/) || [])[1];
// The isolated Preview database. Not `sales_crm_preview`, which this suite used to name:
// that database is reached with `neondb_owner`, a role that is a member of neon_superuser and
// therefore of pg_read_all_data and pg_write_all_data — able to read and write every table in
// every database on the branch. `sales_preview` is reached with `sales_preview_app`, which
// owns nothing, holds SELECT/INSERT/UPDATE/DELETE and no DDL, and is a member of no role.
if (dbName !== "sales_preview") {
  console.log(`FATAL: refusing to run against database "${dbName ?? "(none)"}".`);
  process.exit(3);
}
const SECRET = (process.env.PIN_LOOKUP_SECRET ?? "").trim();
if (!SECRET) { console.log("FATAL: PIN_LOOKUP_SECRET is not set"); process.exit(3); }

const c = new pg.Client({ connectionString: URL_ });
const results = { pass: 0, fail: 0, failures: [] };
function check(name, ok, detail = "") {
  if (ok) { results.pass++; console.log(`  [PASS] ${name}`); }
  else { results.fail++; results.failures.push(name); console.log(`  [FAIL] ${name}  << ${detail}`); }
}
const section = (t) => console.log(`\n${"=".repeat(78)}\n  ${t}\n${"=".repeat(78)}`);
const sub = (t) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 58 - t.length))}`);
const S = (v) => { try { return JSON.stringify(v) ?? String(v); } catch { return String(v); } };
const P = "SEC";

// Version B PIN shape, matching what the application writes.
const pinLookup = (pin) =>
  crypto.createHmac("sha256", SECRET).update("pin:lookup:v1:" + pin).digest("base64");
const pinVerifier = (pin) =>
  crypto.createHmac("sha384", SECRET).update("pin:verify:v1:" + pin).digest("base64");

let cookies = {};
async function api(pathname, opts = {}) {
  const jar = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join("; ");
  const res = await fetch(BASE + pathname, {
    method: opts.method ?? "GET",
    headers: {
      "Content-Type": "application/json",
      ...(jar ? { Cookie: jar } : {}),
      ...(opts.headers ?? {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    redirect: "manual",
  });
  const setCookie = res.headers.getSetCookie?.() ?? [];
  for (const sc of setCookie) {
    const [pair] = sc.split(";");
    const i = pair.indexOf("=");
    if (i > 0) cookies[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
  }
  let json = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, json };
}
const logout = () => { cookies = {}; };
async function loginAs(pin) {
  logout();
  const r = await api("/api/auth/login", { method: "POST", body: { method: "pin", pin } });
  if (r.status !== 200) throw new Error(`login failed ${r.status} ${S(r.json).slice(0, 120)}`);
}

async function mkEmployee(id, name, pin, permissions) {
  await c.query(`DELETE FROM "Employee" WHERE id=$1`, [id]);
  await c.query(
    `INSERT INTO "Employee" (id,name,pin,"pinLookup",role,permissions,"defaultRoute",active,"preferredLanguage","createdAt","updatedAt")
     VALUES ($1,$2,$3,$4,'custom',$5,'/dashboard',true,'ar',now(),now())`,
    [id, name, bcrypt.hashSync(pinVerifier(pin), 10), pinLookup(pin), JSON.stringify(permissions)]);
}

async function cleanup() {
  // Keyed on CONTENT, not on id.
  //
  // Rows this suite creates through the API get cuid ids, so an `id LIKE 'SEC%'` filter
  // matched only the rows inserted directly by the fixture and silently left every
  // API-created lead behind. The next run then tried to delete the employee those leads
  // pointed at and hit the foreign key. Child-first, and matched on the prefix the suite
  // actually puts in the data.
  const prefix = `${P}%`;
  for (const sql of [
    `DELETE FROM "CommissionLedgerCorrection" WHERE "entryId" IN (SELECT id FROM "CommissionLedgerEntry" WHERE "employeeId" LIKE '${P}%') OR "correctsEntryId" IN (SELECT id FROM "CommissionLedgerEntry" WHERE "employeeId" LIKE '${P}%')`,
    `DELETE FROM "CommissionLedgerEntry" WHERE "employeeId" LIKE '${P}%'`,
    `DELETE FROM "CommissionAccrual" WHERE "employeeId" LIKE '${P}%'`,
    `DELETE FROM "CollectionEvent" WHERE "externalRef" LIKE '${P}%'`,
    `DELETE FROM "CommissionAssignment" WHERE "employeeId" LIKE '${P}%'`,
    `DELETE FROM "Activity" WHERE "leadId" IN (SELECT id FROM "Lead" WHERE "companyName" LIKE '${P}%')`,
    `DELETE FROM "LeadConversion" WHERE "leadId" IN (SELECT id FROM "Lead" WHERE "companyName" LIKE '${P}%')`,
    `DELETE FROM "OpportunityStageEvent" WHERE "opportunityId" IN (SELECT id FROM "Opportunity" WHERE title LIKE '${P}%')`,
    `DELETE FROM "OpportunityOwner" WHERE "opportunityId" IN (SELECT id FROM "Opportunity" WHERE title LIKE '${P}%')`,
    `DELETE FROM "Opportunity" WHERE title LIKE '${P}%'`,
    `DELETE FROM "Lead" WHERE "companyName" LIKE '${P}%'`,
    `DELETE FROM "PipelineStage" WHERE code LIKE '${P}%'`,
    `DELETE FROM "Customer" WHERE name LIKE '${P}%'`,
    `DELETE FROM "Employee" WHERE id LIKE '${P}%'`,
  ]) await c.query(sql).catch((e) => { if (e.code === "23503") throw e; });
  void prefix;
}

async function main() {
  await c.connect();
  console.log(`database: ${dbName}   app: ${BASE}`);
  await cleanup();

  const PIN_REP_A = "910011", PIN_REP_B = "910022", PIN_MGR = "910033", PIN_NONE = "910044";
  const repPerms = {
    dashboard: { access: "edit" },
    sales: { access: "edit", sub: { lead_write: true, lead_convert: true } },
    commissions: { access: "view", sub: { view_own: true } },
  };
  const mgrPerms = {
    dashboard: { access: "edit" },
    sales: { access: "edit", sub: { lead_write: true, lead_assign: true, lead_convert: true, deal_close: true, deal_reopen: true } },
    commissions: { access: "edit", sub: { view_own: true, view_team: true, manage_plans: true, approve: true, sandbox_collections: true } },
  };
  await mkEmployee(`${P}_rep_a`, `${P} Rep A`, PIN_REP_A, repPerms);
  await mkEmployee(`${P}_rep_b`, `${P} Rep B`, PIN_REP_B, repPerms);
  await mkEmployee(`${P}_mgr`, `${P} Manager`, PIN_MGR, mgrPerms);
  await mkEmployee(`${P}_none`, `${P} NoSales`, PIN_NONE, { dashboard: { access: "edit" } });

  const stageId = `${P}_stage`;
  await c.query(`DELETE FROM "PipelineStage" WHERE id=$1`, [stageId]);
  await c.query(
    `INSERT INTO "PipelineStage" (id,code,"nameEn","nameAr",position,probability,"isActive","createdAt","updatedAt")
     VALUES ($1,$2,'New','جديد',1,10,true,now(),now())`, [stageId, `${P}_NEW`]);

  // ═══════════════════════════════════════════════════════════════════════
  section("A — NO SESSION, NO ACCESS");

  sub("A1. every sales endpoint refuses an unauthenticated caller");
  logout();
  for (const [m, p] of [["GET", "/api/sales/leads"], ["POST", "/api/sales/leads"],
                        ["GET", "/api/commissions/me"], ["GET", "/api/commissions/sandbox-collections"]]) {
    const r = await api(p, { method: m, body: m === "POST" ? { companyName: "X", contactName: "Y" } : undefined });
    check(`${m} ${p} refuses without a session`, r.status === 401 || r.status === 403,
      `status=${r.status} ${S(r.json).slice(0, 90)}`);
  }

  // ═══════════════════════════════════════════════════════════════════════
  section("B — A ROLE WITHOUT THE MODULE IS REFUSED");

  sub("B1. an employee with no sales module cannot read or write leads");
  await loginAs(PIN_NONE);
  const noRead = await api("/api/sales/leads");
  check("reading leads is refused", noRead.status === 403, `status=${noRead.status}`);
  const noWrite = await api("/api/sales/leads", { method: "POST", body: { companyName: `${P} Nope`, contactName: "Fahad" } });
  check("creating a lead is refused", noWrite.status === 403, `status=${noWrite.status}`);
  const noComm = await api("/api/commissions/me");
  check("reading own commission is refused without the module", noComm.status === 403, `status=${noComm.status}`);

  // ═══════════════════════════════════════════════════════════════════════
  section("C — OWNERSHIP CANNOT BE FORGED (MASS ASSIGNMENT)");

  sub("C1. a rep cannot plant a lead on a colleague");
  await loginAs(PIN_REP_A);
  const planted = await api("/api/sales/leads", {
    method: "POST",
    body: { companyName: `${P} Planted Cafe`, contactName: "Fahad", ownerId: `${P}_rep_b` },
  });
  check("the request is accepted", planted.status === 201, `status=${planted.status} ${S(planted.json).slice(0, 110)}`);
  check("but the owner is the CALLER, not the id they supplied",
    planted.json?.lead?.ownerId === `${P}_rep_a`,
    `ownerId=${planted.json?.lead?.ownerId} — a rep could hand a lead, and its commission, to someone else`);

  sub("C2. a rep without lead_assign sees only their own leads");
  const repList = await api("/api/sales/leads");
  check("the list is scoped", repList.json?.scope === "own", S(repList.json?.scope));
  const foreign = (repList.json?.rows ?? []).filter((r) => r.owner?.id !== `${P}_rep_a`);
  check("and contains no other rep's lead", foreign.length === 0,
    `${foreign.length} foreign rows were returned to the client`);

  // ═══════════════════════════════════════════════════════════════════════
  section("D — ID MANIPULATION DOES NOT REACH ANOTHER REP'S RECORD");

  sub("D1. rep B's lead cannot be converted by rep A through the URL");
  await loginAs(PIN_REP_B);
  const bLead = await api("/api/sales/leads", {
    method: "POST", body: { companyName: `${P} B Cafe`, contactName: "Bandar" },
  });
  check("rep B's own lead is created", bLead.status === 201, `status=${bLead.status}`);
  const bLeadId = bLead.json?.lead?.id;
  await c.query(`UPDATE "Lead" SET status='QUALIFIED' WHERE id=$1`, [bLeadId]);

  await loginAs(PIN_REP_A);
  const stolen = await api(`/api/sales/leads/${bLeadId}/convert`, { method: "POST", body: { stageId } });
  check("rep A cannot convert it", stolen.status === 404 || stolen.status === 403,
    `status=${stolen.status} ${S(stolen.json).slice(0, 110)}`);
  check("and the refusal does not confirm the lead exists",
    !/forbidden|not allowed|permission/i.test(S(stolen.json)) || stolen.status === 404,
    S(stolen.json).slice(0, 110));
  const convCount = Number((await c.query(`SELECT COUNT(*)::int n FROM "LeadConversion" WHERE "leadId"=$1`, [bLeadId])).rows[0].n);
  check("no conversion was created by the attempt", convCount === 0, `${convCount}`);

  // ═══════════════════════════════════════════════════════════════════════
  section("E — A REP CANNOT MANUFACTURE THE MONEY THEY ARE PAID ON");

  sub("E1. recording a sandbox collection needs its own privilege");
  await loginAs(PIN_REP_A);
  const fakeMoney = await api("/api/commissions/sandbox-collections", {
    method: "POST",
    body: { externalRef: `${P}-rep-forged`, amountGross: "11500", amountTax: "1500" },
  });
  check("a rep is refused", fakeMoney.status === 403, `status=${fakeMoney.status} ${S(fakeMoney.json).slice(0, 110)}`);
  const forged = Number((await c.query(`SELECT COUNT(*)::int n FROM "CollectionEvent" WHERE "externalRef"=$1`, [`${P}-rep-forged`])).rows[0].n);
  check("and nothing was recorded", forged === 0, `${forged}`);

  sub("E2. a rep cannot read the sandbox collection list either");
  const peek = await api("/api/commissions/sandbox-collections");
  check("refused", peek.status === 403, `status=${peek.status}`);

  sub("E3. a manager with the privilege CAN record one, and it is stamped SANDBOX");
  await loginAs(PIN_MGR);
  const real = await api("/api/commissions/sandbox-collections", {
    method: "POST",
    body: { externalRef: `${P}-mgr-1`, amountGross: "11500", amountTax: "1500" },
  });
  check("accepted for the privileged role", real.status === 201, `status=${real.status} ${S(real.json).slice(0, 130)}`);
  check("the response says it is sandbox, not a real payment",
    real.json?.sourceSystem === "SANDBOX" && /No real payment/i.test(String(real.json?.notice ?? "")),
    S(real.json).slice(0, 150));
  const stamped = (await c.query(`SELECT "sourceSystem" s FROM "CollectionEvent" WHERE "externalRef"=$1`, [`${P}-mgr-1`])).rows[0];
  check("and the stored row carries the SANDBOX stamp", stamped?.s === "SANDBOX", S(stamped));

  sub("E4. re-delivering the same collection reference does not record a second one");
  const again = await api("/api/commissions/sandbox-collections", {
    method: "POST",
    body: { externalRef: `${P}-mgr-1`, amountGross: "11500", amountTax: "1500" },
  });
  check("the retry is answered as a replay", again.status === 200 && again.json?.replayed === true,
    `status=${again.status} replayed=${again.json?.replayed}`);
  const evCount = Number((await c.query(`SELECT COUNT(*)::int n FROM "CollectionEvent" WHERE "externalRef"=$1`, [`${P}-mgr-1`])).rows[0].n);
  check("exactly one collection event exists", evCount === 1, `${evCount}`);

  // ═══════════════════════════════════════════════════════════════════════
  section("F — VALIDATION REFUSES NONSENSE RATHER THAN STORING IT");

  sub("F1. tax cannot exceed the amount collected");
  const backwards = await api("/api/commissions/sandbox-collections", {
    method: "POST", body: { externalRef: `${P}-bad-1`, amountGross: "100", amountTax: "500" },
  });
  check("refused with 400", backwards.status === 400, `status=${backwards.status} ${S(backwards.json).slice(0, 110)}`);

  sub("F2. a non-SAR collection is refused, not converted at an invented rate");
  const fx = await api("/api/commissions/sandbox-collections", {
    method: "POST", body: { externalRef: `${P}-bad-2`, amountGross: "1000", currency: "USD" },
  });
  check("refused with 409", fx.status === 409, `status=${fx.status}`);
  check("and it says why", /exchange-rate/i.test(S(fx.json)), S(fx.json).slice(0, 130));

  sub("F3. a collection with no external reference is refused");
  const noRef = await api("/api/commissions/sandbox-collections", {
    method: "POST", body: { amountGross: "1000" },
  });
  check("refused with 400", noRef.status === 400, `status=${noRef.status}`);

  sub("F4. a lead needs a company and a contact");
  await loginAs(PIN_REP_A);
  const thin = await api("/api/sales/leads", { method: "POST", body: { companyName: "X" } });
  check("refused with 400", thin.status === 400, `status=${thin.status} ${S(thin.json).slice(0, 100)}`);

  // ═══════════════════════════════════════════════════════════════════════
  section("G — STORED TEXT IS NOT INTERPRETED");

  sub("G1. a script tag in a lead name is stored as text, not neutralised into something else");
  const xss = await api("/api/sales/leads", {
    method: "POST",
    body: { companyName: `${P} <script>alert(1)</script>`, contactName: `"><img src=x onerror=alert(1)>` },
  });
  check("the lead is accepted", xss.status === 201, `status=${xss.status}`);
  const stored = (await c.query(`SELECT "companyName" cn FROM "Lead" WHERE id=$1`, [xss.json?.lead?.id])).rows[0];
  check("the payload is stored verbatim, so nothing was silently rewritten",
    String(stored?.cn).includes("<script>"), S(stored?.cn));
  // React escapes on render; the point asserted here is that the server neither executes nor
  // mangles it. A rendering assertion belongs in the browser suite, not here.

  sub("G2. a CSV formula in a name is stored, and is the export's problem to neutralise");
  const csv = await api("/api/sales/leads", {
    method: "POST", body: { companyName: `${P} =cmd|' /C calc'!A0`, contactName: "Fahad" },
  });
  check("accepted and stored", csv.status === 201, `status=${csv.status}`);

  // ═══════════════════════════════════════════════════════════════════════
  section("H — ERRORS DO NOT LEAK THE DATABASE");

  sub("H1. a bad foreign key surfaces as a domain message, not a Prisma error");
  await loginAs(PIN_REP_A);
  const badStage = await api("/api/sales/leads", { method: "POST", body: { companyName: `${P} FK`, contactName: "Fahad" } });
  const fkLeadId = badStage.json?.lead?.id;
  await c.query(`UPDATE "Lead" SET status='QUALIFIED' WHERE id=$1`, [fkLeadId]);
  const bad = await api(`/api/sales/leads/${fkLeadId}/convert`, {
    method: "POST", body: { stageId: "no-such-stage", linkToCustomerId: "no-such-customer" },
  });
  check("refused", bad.status >= 400, `status=${bad.status}`);
  const text = S(bad.json);
  check("no Prisma internals in the response", !/PrismaClient|P2003|P2002|invocation|prisma\./i.test(text), text.slice(0, 140));
  check("no SQL or stack trace in the response", !/SELECT |INSERT |at Object\.|\.ts:\d+/i.test(text), text.slice(0, 140));

  await cleanup();
  console.log(`\n${"=".repeat(78)}\n  SALES SECURITY RESULT\n${"=".repeat(78)}`);
  console.log(`${results.pass} passed, ${results.fail} failed`);
  if (results.failures.length) console.log("FAILURES:\n  - " + results.failures.join("\n  - "));
  await c.end();
  process.exit(results.fail === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.log("FATAL:", e?.stack || e);
  try { await cleanup(); } catch {}
  try { await c.end(); } catch {}
  process.exit(1);
});
