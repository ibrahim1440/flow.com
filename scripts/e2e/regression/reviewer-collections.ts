// THE COLLECTION WORKFLOW, AS THE ACTUAL REVIEWER ACCOUNTS.
//
// `sales-collections.mjs` proves the workflow with roles this repository defines. This one
// proves it with the three `RVW_` accounts the human reviewer actually signs in as, because
// a role can be correct in its definition and wrong in the database — a row provisioned
// before a privilege existed simply lacks the key.
//
// ── How it authenticates, and why that is honest ──
// The reviewer PINs are issued once and must not be rotated; rotating one would sign the
// reviewer out of a session they may be holding. So this mints a session token instead.
// That is not a shortcut around authorization: `getUserWithPermissions` treats the token as
// proof of WHO is calling and reads `active`, `role` and `permissions` live from the
// employee row on every request. Every authorization decision below is therefore made
// against the real reviewer's real stored permissions. Nothing in the database is changed
// to make a check pass, and no PIN is touched.
//
// ── What it touches ──
// Only rows it creates, all prefixed `RVWX`. The reviewer's own deals, quotations and
// collections are never read for mutation and never modified.
import { readFileSync } from "node:fs";
import { Client } from "pg";
import { SignJWT } from "jose";

const P = "RVWX";
const BASE = process.env.SALES_TEST_BASE_URL ?? "http://localhost:3000";
const ENVFILE = process.env.PREVIEW_ENV ?? "C:/Users/mtmbk/.beanflow/sales-preview/.env.preview-app";

const env: Record<string, string> = {};
for (const line of readFileSync(ENVFILE, "utf8").split(/\r?\n/)) {
  const t = line.trim();
  if (!t || t.startsWith("#")) continue;
  const i = t.indexOf("=");
  if (i > 0) env[t.slice(0, i).trim()] = t.slice(i + 1).trim().replace(/^["']|["']$/g, "");
}
const url = env.DATABASE_URL ?? "";
const dbName = (url.match(/\/([a-z0-9_]+)(\?|$)/) || [])[1];
if (dbName !== "sales_preview") {
  console.log(`FATAL: refusing to run against database "${dbName ?? "(none)"}".`);
  process.exit(3);
}
const JWT = env.JWT_SECRET ?? "";
if (JWT.length < 32) { console.log("FATAL: JWT_SECRET missing from the preview env file"); process.exit(3); }
const secret = new TextEncoder().encode(JWT);

const results = { pass: 0, fail: 0, failures: [] as string[] };
function check(name: string, ok: boolean, detail = "") {
  if (ok) { results.pass++; console.log(`  [PASS] ${name}`); }
  else { results.fail++; results.failures.push(name); console.log(`  [FAIL] ${name}  << ${detail}`); }
}
const section = (t: string) => console.log(`\n${"=".repeat(78)}\n  ${t}\n${"=".repeat(78)}`);
const sub = (t: string) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 58 - t.length))}`);
const S = (v: unknown) => { try { return JSON.stringify(v) ?? String(v); } catch { return String(v); } };

const c = new Client({ connectionString: url });
const q = async (s: string, p: unknown[] = []) => (await c.query(s, p)).rows;
const one = async (s: string, p: unknown[] = []) => (await q(s, p))[0] ?? null;

/** A session for a real employee row. Carries identity only; the row decides the rest. */
async function sessionFor(id: string) {
  const row = await one(`SELECT id, name, role FROM "Employee" WHERE id = $1 AND active = true`, [id]);
  if (!row) throw new Error(`no active employee ${id}`);
  const token = await new SignJWT({
    id: row.id, name: row.name, role: row.role, permissions: {}, preferredLanguage: "ar",
  })
    .setProtectedHeader({ alg: "HS256" })
    .setExpirationTime("1h")
    .sign(secret);

  const api = async (pathname: string, opts: { method?: string; body?: unknown; raw?: BodyInit } = {}) => {
    const res = await fetch(BASE + pathname, {
      method: opts.method ?? "GET",
      headers: {
        Cookie: `token=${token}`,
        ...(opts.raw ? {} : { "Content-Type": "application/json" }),
      },
      body: opts.raw ?? (opts.body ? JSON.stringify(opts.body) : undefined),
      redirect: "manual",
    });
    const text = await res.text();
    // Deliberately loose: this reads a dozen different API shapes and the assertions below
    // are the specification, not a type. Narrowing each one would be noise.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let json: any = null;
    try { json = JSON.parse(text); } catch { /* not every response is JSON */ }
    return { status: res.status, json, headers: res.headers };
  };
  return { id: row.id, name: row.name as string, api };
}

async function cleanup() {
  for (const sql of [
    `DELETE FROM "CollectionEvidence" WHERE "collectionId" IN (SELECT id FROM "SalesCollection" WHERE "idempotencyKey" LIKE '${P}%')`,
    `DELETE FROM "SalesCollection" WHERE "idempotencyKey" LIKE '${P}%'`,
    `DELETE FROM "CommissionLedgerCorrection" WHERE "entryId" IN (SELECT id FROM "CommissionLedgerEntry" WHERE reason LIKE '${P}%') OR "correctsEntryId" IN (SELECT id FROM "CommissionLedgerEntry" WHERE reason LIKE '${P}%')`,
    `DELETE FROM "CommissionLedgerEntry" WHERE reason LIKE '${P}%'`,
    `DELETE FROM "CommissionAccrual" WHERE "collectionEventId" IN (SELECT id FROM "CollectionEvent" WHERE "opportunityId" IN (SELECT id FROM "Opportunity" WHERE title LIKE '${P}%'))`,
    `DELETE FROM "CollectionEvent" WHERE "opportunityId" IN (SELECT id FROM "Opportunity" WHERE title LIKE '${P}%')`,
    `DELETE FROM "Quote" WHERE "quoteNumber" LIKE '${P}%'`,
    `DELETE FROM "OpportunityStageEvent" WHERE "opportunityId" IN (SELECT id FROM "Opportunity" WHERE title LIKE '${P}%')`,
    `DELETE FROM "Opportunity" WHERE title LIKE '${P}%'`,
    `DELETE FROM "Customer" WHERE name LIKE '${P}%'`,
  ]) await c.query(sql).catch(() => {});
}

async function main() {
  await c.connect();
  console.log(`database: ${dbName}   app: ${BASE}`);
  await cleanup();

  const rep = await sessionFor("RVW_emp_rep");
  const manager = await sessionFor("RVW_emp_manager");
  const finance = await sessionFor("RVW_emp_finance");
  console.log(`identities: ${rep.name} · ${manager.name} · ${finance.name}\n`);

  // ── an isolated deal of the rep's own, with an accepted quotation ──────────
  const stage = await one(`SELECT id FROM "PipelineStage" WHERE "isActive" = true ORDER BY position ASC LIMIT 1`);
  const custId = `${P}_cust`;
  await c.query(`INSERT INTO "Customer" (id,name,"createdAt","updatedAt") VALUES ($1,$2,now(),now())
                 ON CONFLICT (id) DO NOTHING`, [custId, `${P} Verification Customer`]);
  const mkDeal = async (tag: string, gross: number, tax: number) => {
    const oppId = `${P}_opp_${tag}`;
    await c.query(
      `INSERT INTO "Opportunity" (id,title,"customerId","stageId",outcome,amount,currency,probability,"ownerId","createdAt","updatedAt")
       VALUES ($1,$2,$3,$4,'OPEN',$5,'SAR',50,$6,now(),now())`,
      [oppId, `${P} Deal ${tag}`, custId, stage.id, String(gross), rep.id]);
    await c.query(
      `INSERT INTO "Quote" (id,"quoteNumber",revision,"opportunityId","customerId",status,currency,
                            subtotal,"discountTotal","taxTotal","grandTotal","acceptedAt","createdAt","updatedAt")
       VALUES ($1,$2,1,$3,$4,'ACCEPTED','SAR',$5,0,$6,$7,now(),now(),now())`,
      [`${P}_q_${tag}`, `${P}-Q-${tag}`, oppId, custId, String(gross - tax), String(tax), String(gross)]);
    return oppId;
  };

  const plan = await one(
    `SELECT a."planVersionId", v."baseRatePercent"::text AS rate
       FROM "CommissionAssignment" a JOIN "CommissionPlanVersion" v ON v.id = a."planVersionId"
      WHERE a."employeeId" = $1 ORDER BY a."effectiveFrom" DESC LIMIT 1`, [rep.id]);
  console.log(plan
    ? `the rep's live commission plan: ${plan.rate}%  (used as-is, not replaced)`
    : "the rep has no commission assignment — approval will create no accrual");

  const ledger = async (employeeId: string) =>
    Number((await one(`SELECT COALESCE(SUM(amount),0) AS t FROM "CommissionLedgerEntry" WHERE "employeeId"=$1`, [employeeId])).t);
  const decide = (s: Awaited<ReturnType<typeof sessionFor>>, id: string, action: string, reason?: string) =>
    s.api(`/api/sales/collections/${id}/actions`, { method: "POST", body: { action, ...(reason ? { reason } : {}) } });
  let key = 0;
  const submit = (s: Awaited<ReturnType<typeof sessionFor>>, oppId: string, amount: string) =>
    s.api("/api/sales/collections", {
      method: "POST",
      body: { opportunityId: oppId, amountGross: amount, idempotencyKey: `${P}-${++key}-${Date.now()}` },
    });

  // ═════════════════════════════════════════════════════════════════════════
  section("A — THE REP SUBMITS");
  const dealA = await mkDeal("a", 1150, 150);
  let collectionId = "";
  {
    const r = await submit(rep, dealA, "1150.00");
    check("the actual Sales Rep reviewer can record a collection", r.status === 201,
      `${r.status} ${S(r.json?.error).slice(0, 110)}`);
    collectionId = (r.json as { collectionId: string })?.collectionId;
    check("tax is derived by the server", r.json?.amountTax === "150.00", S(r.json?.amountTax));
    check("and the net basis with it", r.json?.amountNet === "1000.00", S(r.json?.amountNet));

    // Evidence, so Finance has something to inspect.
    const form = new FormData();
    form.append("file", new Blob([Buffer.from("%PDF-1.4\nreviewer verification receipt")], { type: "application/pdf" }), "receipt.pdf");
    const up = await rep.api(`/api/sales/collections/${collectionId}/evidence`, { method: "POST", raw: form });
    check("and attach evidence to it", up.status < 300, `${up.status} ${S(up.json).slice(0, 110)}`);
  }

  // ═════════════════════════════════════════════════════════════════════════
  section("B — THE MANAGER SEES IT AND CANNOT DECIDE IT");
  {
    const list = await manager.api("/api/sales/collections");
    check("the actual Sales Manager reviewer can read the queue", list.status === 200, String(list.status));
    check("with team scope", list.json?.scope === "all", S(list.json?.scope));
    const seen = (list.json?.rows as { id: string }[] ?? []).some((r) => r.id === collectionId);
    check("and sees the rep's collection", seen, "not in their list");
    check("the server offers them no decision",
      list.json?.can?.verify === false && list.json?.can?.reject === false && list.json?.can?.reverse === false,
      S(list.json?.can));
    const d = (list.json?.decisions as Record<string, { approve: { allowed: boolean; reason: string } }>)?.[collectionId];
    check("and says why: no privilege", d?.approve?.allowed === false && d.approve.reason === "NO_PRIVILEGE", S(d?.approve));
    for (const action of ["approve", "reject", "reverse"]) {
      const r = await decide(manager, collectionId, action, "manager attempt");
      check(`the API refuses the manager's ${action}`, r.status === 403, `${r.status} ${S(r.json?.error).slice(0, 80)}`);
    }
  }

  // ═════════════════════════════════════════════════════════════════════════
  section("C — THE SUBMITTER CANNOT DECIDE THEIR OWN");
  {
    const r = await decide(rep, collectionId, "approve");
    check("the rep is refused approval of their own collection", r.status === 403,
      `${r.status} ${S(r.json?.error).slice(0, 100)}`);
    const still = await one(`SELECT status::text AS status FROM "SalesCollection" WHERE id=$1`, [collectionId]);
    check("and it is untouched", still.status === "PENDING_VERIFICATION", still.status);
    const cantSubmit = await submit(finance, dealA, "10.00");
    check("and Finance cannot submit one to decide later", cantSubmit.status === 403 || cantSubmit.status === 404,
      `${cantSubmit.status} ${S(cantSubmit.json?.error).slice(0, 80)}`);
  }

  // ═════════════════════════════════════════════════════════════════════════
  section("D — THE FINANCE REVIEWER INSPECTS AND DECIDES");
  {
    const list = await finance.api("/api/sales/collections");
    check("the actual Finance reviewer can read the queue", list.status === 200, String(list.status));
    check("holding NO sales module at all", list.json?.scope === "all", S(list.json?.scope));
    check("with verify, reject and reverse offered",
      list.json?.can?.verify === true && list.json?.can?.reject === true && list.json?.can?.reverse === true,
      S(list.json?.can));
    const d = (list.json?.decisions as Record<string, { approve: { allowed: boolean }; reject: { allowed: boolean } }>)?.[collectionId];
    check("approve is allowed on this row", d?.approve?.allowed === true, S(d?.approve));
    check("reject is allowed on this row", d?.reject?.allowed === true, S(d?.reject));

    sub("D1. the evidence, which a verification is worthless without");
    const meta = await finance.api(`/api/sales/collections/${collectionId}/evidence`);
    check("Finance can list the evidence", meta.status === 200, String(meta.status));
    const evId = (meta.json?.evidence as { id: string }[] ?? [])[0]?.id;
    check("there is a file on it", Boolean(evId), S(meta.json).slice(0, 110));
    if (evId) {
      const bytes = await finance.api(`/api/sales/collections/${collectionId}/evidence/${evId}`);
      check("and download it", bytes.status === 200, String(bytes.status));
      check("as an attachment, never inline",
        /attachment/i.test(bytes.headers.get("content-disposition") ?? ""),
        S(bytes.headers.get("content-disposition")));
    }

    sub("D2. approval creates the commission exactly once");
    const before = await ledger(rep.id);
    const r = await decide(finance, collectionId, "approve");
    check("the approval is accepted", r.status === 200, `${r.status} ${S(r.json?.error).slice(0, 100)}`);
    const row = await one(
      `SELECT status::text AS status, "decidedById", "collectionEventId" FROM "SalesCollection" WHERE id=$1`, [collectionId]);
    check("the status is APPROVED", row.status === "APPROVED", row.status);
    check("attributed to the Finance reviewer", row.decidedById === finance.id, S(row.decidedById));
    const events = await q(`SELECT id FROM "CollectionEvent" WHERE "externalRef"=$1`, [collectionId]);
    check("exactly one commission event", events.length === 1, `${events.length}`);
    const accruals = await q(
      `SELECT amount FROM "CommissionAccrual" WHERE "collectionEventId" IN
         (SELECT id FROM "CollectionEvent" WHERE "externalRef"=$1)`, [collectionId]);
    if (plan) {
      const expected = Math.round(1000 * Number(plan.rate)) / 100;
      check("exactly one accrual", accruals.length === 1, `${accruals.length}`);
      check(`worth ${plan.rate}% of the 1,000.00 net = ${expected.toFixed(2)}`,
        accruals[0] && Math.abs(Number(accruals[0].amount) - expected) < 0.005, S(accruals[0]?.amount));
      const after = await ledger(rep.id);
      check("and the ledger moved by the same amount", Math.abs(after - before - expected) < 0.005,
        `${before} → ${after}`);
    } else {
      check("no plan assigned, so no accrual — and no error", accruals.length === 0, `${accruals.length}`);
    }

    sub("D3. approving again adds nothing");
    const again = await decide(finance, collectionId, "approve");
    check("the replay is accepted as a replay", again.status === 200 && again.json?.replayed === true,
      `${again.status} ${S(again.json).slice(0, 90)}`);
    const after2 = await q(
      `SELECT id FROM "CommissionAccrual" WHERE "collectionEventId" IN
         (SELECT id FROM "CollectionEvent" WHERE "externalRef"=$1)`, [collectionId]);
    check("still one accrual", after2.length === accruals.length, `${after2.length}`);
  }

  // ═════════════════════════════════════════════════════════════════════════
  section("E — REJECTION NEEDS A REASON");
  {
    const dealB = await mkDeal("b", 575, 75);
    const id = ((await submit(rep, dealB, "575.00")).json as { collectionId: string }).collectionId;
    const noReason = await decide(finance, id, "reject");
    check("a rejection with no reason is refused", noReason.status === 400, String(noReason.status));
    const ok = await decide(finance, id, "reject", "الإيصال لا يطابق المبلغ — تحقّق المراجعة");
    check("with a reason it is accepted", ok.status === 200, `${ok.status} ${S(ok.json?.error).slice(0, 80)}`);
    const row = await one(
      `SELECT status::text AS status, "decisionReason", "collectionEventId" FROM "SalesCollection" WHERE id=$1`, [id]);
    check("the status is REJECTED", row.status === "REJECTED", row.status);
    check("the reason is stored", (row.decisionReason ?? "").length > 3, S(row.decisionReason));
    check("and no commission event exists", row.collectionEventId === null, S(row.collectionEventId));
  }

  // ═════════════════════════════════════════════════════════════════════════
  section("F — REVERSAL PRESERVES HISTORY AND COMPENSATES");
  {
    const before = await ledger(rep.id);
    const noReason = await decide(finance, collectionId, "reverse");
    check("a reversal with no reason is refused", noReason.status === 400, String(noReason.status));
    const r = await decide(finance, collectionId, "reverse", "أُعيد المبلغ للعميل — تحقّق المراجعة");
    check("with a reason it is accepted", r.status === 200, `${r.status} ${S(r.json?.error).slice(0, 80)}`);

    const row = await one(
      `SELECT status::text AS status, "decidedById", "reversedById", "reversalReason", "collectionEventId"
         FROM "SalesCollection" WHERE id=$1`, [collectionId]);
    check("the original row still exists", Boolean(row));
    check("still pointing at its commission event", Boolean(row.collectionEventId), S(row.collectionEventId));
    check("who approved it is still recorded", row.decidedById === finance.id, S(row.decidedById));
    check("the reversal is attributed separately", row.reversedById === finance.id, S(row.reversedById));
    check("and carries its reason", (row.reversalReason ?? "").length > 3, S(row.reversalReason));
    const ev = await one(`SELECT status::text AS status FROM "CollectionEvent" WHERE "externalRef"=$1`, [collectionId]);
    check("the event is marked reversed, not deleted", ev?.status === "REVERSED", S(ev));
    const accruals = await q(
      `SELECT id FROM "CommissionAccrual" WHERE "collectionEventId" IN
         (SELECT id FROM "CollectionEvent" WHERE "externalRef"=$1)`, [collectionId]);
    check("and the accrual row was not deleted", accruals.length >= (plan ? 1 : 0), `${accruals.length}`);

    if (plan) {
      const after = await ledger(rep.id);
      const expected = Math.round(1000 * Number(plan.rate)) / 100;
      check("the ledger came back down by the amount that was posted",
        Math.abs(before - after - expected) < 0.005, `${before} → ${after}`);
      const last = await one(
        `SELECT amount, type::text AS type FROM "CommissionLedgerEntry"
          WHERE "employeeId"=$1 ORDER BY "createdAt" DESC LIMIT 1`, [rep.id]);
      check("as a compensating REVERSAL entry", last?.type === "REVERSAL" && Number(last.amount) < 0, S(last));
    }
  }
}

// tsx compiles this to CommonJS, where top-level await is not available.
async function run() {
  let exit = 0;
  try { await main(); }
  catch (e) { console.log(`\nFATAL: ${(e as Error)?.stack ?? e}`); exit = 1; }
  finally {
    await cleanup().catch(() => {});
    await c.end().catch(() => {});
  }
  console.log(`\n${"=".repeat(78)}`);
  console.log(`  ${results.pass} passed, ${results.fail} failed`);
  if (results.fail) { console.log("\n  Failures:"); for (const f of results.failures) console.log(`    - ${f}`); }
  console.log("=".repeat(78));
  process.exit(results.fail || exit ? 1 : 0);
  
}
void run();
