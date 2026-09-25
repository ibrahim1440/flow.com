// SALES COLLECTIONS — what the database refuses, and what survives a race.
//
// Three kinds of proof, and they are not interchangeable:
//
//   A. CONSTRAINTS. Raw SQL against the real schema. A CHECK constraint that exists only in
//      a migration file nobody applied is not a constraint, and the only way to tell the
//      difference is to attempt the write and be refused.
//
//   B. CONCURRENCY. Real parallel HTTP requests against a running app. Two `fetch` calls in
//      one `Promise.all` genuinely overlap: they arrive on different connections, contend
//      for the same row lock, and one of them has to lose. Calling the service twice in
//      sequence proves nothing about that.
//
//   C. AUTHORISATION. Also real HTTP, and every assertion passes when the server REFUSES.
//      A hidden button is not an authorisation control.
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
// The isolated Preview database, reached with `sales_preview_app` — a role that owns
// nothing, holds no DDL and is a member of no role. This suite writes freely, so it refuses
// to start anywhere else.
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
const q = async (s, p = []) => (await c.query(s, p)).rows;
const one = async (s, p = []) => (await q(s, p))[0] ?? null;
const P = "COL";

const pinLookup = (pin) => crypto.createHmac("sha256", SECRET).update("pin:lookup:v1:" + pin).digest("base64");
const pinVerifier = (pin) => crypto.createHmac("sha384", SECRET).update("pin:verify:v1:" + pin).digest("base64");

/**
 * One cookie jar per identity, so a race can run as two different people at the same time.
 * The single shared jar the other suites use would have the second login evict the first.
 */
function session() {
  const jar = {};
  const api = async (pathname, opts = {}) => {
    const cookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; ");
    const res = await fetch(BASE + pathname, {
      method: opts.method ?? "GET",
      headers: {
        ...(opts.raw ? {} : { "Content-Type": "application/json" }),
        ...(cookie ? { Cookie: cookie } : {}),
        ...(opts.headers ?? {}),
      },
      body: opts.raw ? opts.raw : opts.body ? JSON.stringify(opts.body) : undefined,
      redirect: "manual",
    });
    for (const sc of res.headers.getSetCookie?.() ?? []) {
      const [pair] = sc.split(";");
      const i = pair.indexOf("=");
      if (i > 0) jar[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
    }
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not every response is JSON */ }
    return { status: res.status, json, headers: res.headers };
  };
  return {
    api,
    async login(pin) {
      const r = await api("/api/auth/login", { method: "POST", body: { method: "pin", pin } });
      if (r.status !== 200) throw new Error(`login failed ${r.status} ${S(r.json).slice(0, 120)}`);
      return this;
    },
  };
}

async function mkEmployee(id, name, pin, permissions) {
  await c.query(
    `INSERT INTO "Employee" (id,name,pin,"pinLookup",role,permissions,"defaultRoute",active,"preferredLanguage","createdAt","updatedAt")
     VALUES ($1,$2,$3,$4,'custom',$5,'/dashboard',true,'ar',now(),now())`,
    [id, name, bcrypt.hashSync(pinVerifier(pin), 10), pinLookup(pin), JSON.stringify(permissions)]);
}

/**
 * Stage purposes are unique per deployment, so a fixture has to borrow rather than add a
 * second one. Whatever is borrowed is handed back in cleanup.
 */
const borrowedPurposes = [];
async function stageFor(purpose, fallbackId) {
  const existing = await one(`SELECT id FROM "PipelineStage" WHERE purpose=$1::"PipelineStagePurpose"`, [purpose]);
  if (existing) return existing.id;
  await c.query(`UPDATE "PipelineStage" SET purpose=$1::"PipelineStagePurpose" WHERE id=$2`, [purpose, fallbackId]);
  borrowedPurposes.push(fallbackId);
  return fallbackId;
}

async function cleanup() {
  for (const id of borrowedPurposes) {
    await c.query(`UPDATE "PipelineStage" SET purpose=NULL WHERE id=$1`, [id]).catch(() => {});
  }
  borrowedPurposes.length = 0;
  for (const sql of [
    `DELETE FROM "CollectionEvidence" WHERE "uploadedById" LIKE '${P}%'`,
    `DELETE FROM "SalesCollection" WHERE "submittedById" LIKE '${P}%'`,
    `DELETE FROM "CommissionLedgerEntry" WHERE "employeeId" LIKE '${P}%'`,
    `DELETE FROM "CommissionAccrual" WHERE "employeeId" LIKE '${P}%'`,
    `DELETE FROM "CollectionEvent" WHERE "opportunityId" IN (SELECT id FROM "Opportunity" WHERE title LIKE '${P}%')`,
    `DELETE FROM "CommissionAssignment" WHERE "employeeId" LIKE '${P}%'`,
    `DELETE FROM "CommissionTier" WHERE "planVersionId" IN (SELECT id FROM "CommissionPlanVersion" WHERE "planId" LIKE '${P}%')`,
    `DELETE FROM "CommissionPlanVersion" WHERE "planId" LIKE '${P}%'`,
    `DELETE FROM "CommissionPlan" WHERE id LIKE '${P}%'`,
    `DELETE FROM "QuoteLine" WHERE "quoteId" IN (SELECT id FROM "Quote" WHERE "quoteNumber" LIKE '${P}%')`,
    `DELETE FROM "Quote" WHERE "quoteNumber" LIKE '${P}%'`,
    `DELETE FROM "Activity" WHERE "leadId" IN (SELECT id FROM "Lead" WHERE "companyName" LIKE '${P}%')`,
    `DELETE FROM "Activity" WHERE "opportunityId" IN (SELECT id FROM "Opportunity" WHERE title LIKE '${P}%')`,
    `DELETE FROM "LeadConversion" WHERE "leadId" IN (SELECT id FROM "Lead" WHERE "companyName" LIKE '${P}%')`,
    `DELETE FROM "OpportunityStageEvent" WHERE "opportunityId" IN (SELECT id FROM "Opportunity" WHERE title LIKE '${P}%')`,
    `DELETE FROM "OpportunityOwner" WHERE "opportunityId" IN (SELECT id FROM "Opportunity" WHERE title LIKE '${P}%')`,
    `DELETE FROM "Opportunity" WHERE title LIKE '${P}%'`,
    `DELETE FROM "Lead" WHERE "companyName" LIKE '${P}%'`,
    `DELETE FROM "PipelineStage" WHERE code LIKE '${P}%'`,
    `DELETE FROM "Customer" WHERE name LIKE '${P}%'`,
    `DELETE FROM "Employee" WHERE id LIKE '${P}%'`,
  ]) await c.query(sql).catch((e) => { if (e.code === "23503") throw e; });
}

/** Insert a collection row straight into the table, bypassing every service check. */
async function rawCollection(id, over = {}) {
  const f = {
    opportunityId: null, quoteId: null, customerId: null,
    idempotencyKey: `${P}-raw-${id}`, amountGross: "1150.00", amountTax: "150.00", amountNet: "1000.00",
    currency: "SAR", paymentMethod: "BANK_TRANSFER", status: "PENDING_VERIFICATION",
    submittedById: null, decisionReason: null, reversalReason: null, collectionEventId: null,
    reversedById: null, reversedAt: null,
    ...over,
  };
  return c.query(
    `INSERT INTO "SalesCollection"
       (id,"opportunityId","quoteId","customerId","idempotencyKey","amountGross","amountTax","amountNet",
        currency,"paymentMethod","collectedAt",status,"submittedById","submittedAt","decisionReason",
        "reversalReason","collectionEventId","reversedById","reversedAt","createdAt","updatedAt")
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::"SalesCollectionMethod",now(),$11::"SalesCollectionStatus",
             $12,now(),$13,$14,$15,$16,$17,now(),now())`,
    [id, f.opportunityId, f.quoteId, f.customerId, f.idempotencyKey, f.amountGross, f.amountTax,
      f.amountNet, f.currency, f.paymentMethod, f.status, f.submittedById, f.decisionReason,
      f.reversalReason, f.collectionEventId, f.reversedById, f.reversedAt]);
}

/** Run a write that must fail, and report whether it failed for the reason claimed. */
const refused = async (fn, code) => {
  try { await fn(); return { ok: false, code: null }; }
  catch (e) { return { ok: code ? e.code === code : true, code: e.code, message: e.message }; }
};

async function main() {
  await c.connect();
  console.log(`database: ${dbName}   app: ${BASE}`);
  await cleanup();

  // ── identities ────────────────────────────────────────────────────────────
  const PIN = { repA: "920011", repB: "920022", fin: "920033", fin2: "920044", dual: "920055", none: "920066", stale: "920077", mgr: "920088" };
  const repPerms = {
    dashboard: { access: "edit" },
    sales: { access: "edit", sub: { lead_write: true, lead_convert: true, quote_write: true, collection_submit: true } },
    commissions: { access: "view", sub: { view_own: true } },
  };
  const finPerms = {
    dashboard: { access: "edit" },
    // No sales module, exactly like the deployed Finance role: they verify collections,
    // they do not read the pipeline. The queue and the evidence are reached through
    // `commissions` — if that ever regresses, C3 and D9 below stop passing.
    sales: { access: "none" },
    commissions: {
      access: "edit",
      sub: { view_own: true, view_team: true, collection_verify: true, collection_reject: true, collection_reverse: true },
    },
  };
  // Deliberately holds BOTH halves. The separation of duties has to hold anyway.
  const dualPerms = {
    dashboard: { access: "edit" },
    sales: { access: "edit", sub: { quote_write: true, collection_submit: true, collection_view_team: true } },
    commissions: {
      access: "edit",
      sub: { view_own: true, collection_verify: true, collection_reject: true, collection_reverse: true },
    },
  };
  const ids = {
    repA: `${P}_rep_a`, repB: `${P}_rep_b`, fin: `${P}_fin`, fin2: `${P}_fin2`,
    dual: `${P}_dual`, none: `${P}_none`, stale: `${P}_stale`, mgr: `${P}_mgr`,
  };
  // A salesperson whose role predates the privilege — the exact shape of the reported
  // defect. They can open the deal and see every figure; they just cannot record.
  const stalePerms = {
    dashboard: { access: "edit" },
    sales: { access: "edit", sub: { lead_write: true, lead_convert: true, quote_write: true } },
    commissions: { access: "view", sub: { view_own: true } },
  };
  await mkEmployee(ids.repA, `${P} Rep A`, PIN.repA, repPerms);
  await mkEmployee(ids.repB, `${P} Rep B`, PIN.repB, repPerms);
  await mkEmployee(ids.fin, `${P} Finance`, PIN.fin, finPerms);
  await mkEmployee(ids.fin2, `${P} Finance Two`, PIN.fin2, finPerms);
  await mkEmployee(ids.dual, `${P} Both Hats`, PIN.dual, dualPerms);
  await mkEmployee(ids.none, `${P} No Access`, PIN.none, { dashboard: { access: "edit" } });
  await mkEmployee(ids.stale, `${P} Stale Role`, PIN.stale, stalePerms);
  // A sales manager: sees the team's collections, and holds NO financial decision. The
  // separation the whole design rests on — seeing is not deciding.
  await mkEmployee(ids.mgr, `${P} Manager`, PIN.mgr, {
    dashboard: { access: "edit" },
    sales: { access: "edit", sub: { lead_write: true, quote_write: true, collection_submit: true, collection_view_team: true } },
    commissions: { access: "edit", sub: { view_own: true, view_team: true, manage_plans: true } },
  });

  // ── stages, plan, deals ───────────────────────────────────────────────────
  const mkStage = (id, code, name, pos) =>
    c.query(`INSERT INTO "PipelineStage" (id,code,"nameEn","nameAr",position,probability,"isActive","createdAt","updatedAt")
             VALUES ($1,$2,$3,$4,$5,10,true,now(),now())`, [id, code, name, name, pos]);
  await mkStage(`${P}_stage_new`, `${P}_NEW`, "New", 1);
  await mkStage(`${P}_stage_qual`, `${P}_QUAL`, "Qualification", 2);
  await mkStage(`${P}_stage_quote`, `${P}_QUOTE`, "Quotation", 3);
  const qualStage = await stageFor("QUALIFICATION", `${P}_stage_qual`);
  const quoteStage = await stageFor("QUOTATION", `${P}_stage_quote`);
  console.log(`stages: qualification=${qualStage} quotation=${quoteStage}`);

  const planId = `${P}_plan`, pvId = `${P}_pv`;
  await c.query(`INSERT INTO "CommissionPlan" (id,code,name,"isActive","createdAt","updatedAt")
                 VALUES ($1,$2,'Collections Plan',true,now(),now())`, [planId, `${P}_PLAN`]);
  await c.query(
    `INSERT INTO "CommissionPlanVersion" (id,"planId",version,basis,"tierMode","baseRatePercent",currency,"effectiveFrom","createdAt")
     VALUES ($1,$2,1,'NET_COLLECTION','INCREMENTAL',1,'SAR',$3,now())`,
    [pvId, planId, new Date("2026-01-01T00:00:00Z")]);
  for (const emp of [ids.repA, ids.repB, ids.dual]) {
    await c.query(
      `INSERT INTO "CommissionAssignment" (id,"employeeId","planId","planVersionId","effectiveFrom","createdAt")
       VALUES ($1,$2,$3,$4,$5,now())`,
      [`${P}_asg_${emp}`, emp, planId, pvId, new Date("2026-01-01T00:00:00Z")]);
  }

  const custId = `${P}_cust`;
  await c.query(`INSERT INTO "Customer" (id,name,"createdAt","updatedAt") VALUES ($1,$2,now(),now())`,
    [custId, `${P} Elite Roastery`]);

  /** A deal with an accepted quotation of `gross` carrying `tax`, owned by `ownerId`. */
  async function mkDeal(tag, ownerId, gross, tax) {
    const oppId = `${P}_opp_${tag}`, quoteId = `${P}_q_${tag}`;
    await c.query(
      `INSERT INTO "Opportunity" (id,title,"customerId","stageId",outcome,amount,currency,probability,"ownerId","createdAt","updatedAt")
       VALUES ($1,$2,$3,$4,'OPEN',$5,'SAR',50,$6,now(),now())`,
      [oppId, `${P} Deal ${tag}`, custId, `${P}_stage_new`, String(gross), ownerId]);
    await c.query(
      `INSERT INTO "Quote" (id,"quoteNumber",revision,"opportunityId","customerId",status,currency,
                            subtotal,"discountTotal","taxTotal","grandTotal","acceptedAt","createdAt","updatedAt")
       VALUES ($1,$2,1,$3,$4,'ACCEPTED','SAR',$5,0,$6,$7,now(),now(),now())`,
      [quoteId, `${P}-Q-${tag}`, oppId, custId, String(gross - tax), String(tax), String(gross)]);
    return { oppId, quoteId };
  }

  const repA = await session().login(PIN.repA);
  const repB = await session().login(PIN.repB);
  const fin = await session().login(PIN.fin);
  const fin2 = await session().login(PIN.fin2);
  const dual = await session().login(PIN.dual);
  const none = await session().login(PIN.none);
  const stale = await session().login(PIN.stale);
  const mgr = await session().login(PIN.mgr);

  const decide = (s, id, action, reason) =>
    s.api(`/api/sales/collections/${id}/actions`, {
      method: "POST",
      body: { action, ...(reason ? { reason } : {}) },
    });
  let keySeq = 0;
  const submit = (s, oppId, amount, extra = {}) =>
    s.api("/api/sales/collections", {
      method: "POST",
      body: {
        opportunityId: oppId,
        amountGross: String(amount),
        idempotencyKey: `${P}-k-${++keySeq}-${Date.now()}`,
        ...extra,
      },
    });
  const ledger = async (employeeId) =>
    Number((await one(`SELECT COALESCE(SUM(amount),0) AS t FROM "CommissionLedgerEntry" WHERE "employeeId"=$1`, [employeeId])).t);

  // ═══════════════════════════════════════════════════════════════════════════
  section("A — THE DATABASE REFUSES WHAT THE SERVICE MUST NEVER WRITE");
  const { oppId: dealA } = await mkDeal("a", ids.repA, 23000, 3000);
  const raw = (id, over) => rawCollection(id, { opportunityId: dealA, submittedById: ids.repA, ...over });

  sub("A1. an amount that is not money");
  {
    const neg = await refused(() => raw(`${P}_c_neg`, { amountGross: "-100.00", amountTax: "0.00", amountNet: "-100.00" }), "23514");
    check("a negative collection is refused by a CHECK constraint", neg.ok, neg.code ?? "the insert succeeded");
    const zero = await refused(() => raw(`${P}_c_zero`, { amountGross: "0.00", amountTax: "0.00", amountNet: "0.00" }), "23514");
    check("a zero collection is refused too", zero.ok, zero.code ?? "the insert succeeded");
  }

  sub("A2. net must reconcile with gross and tax");
  {
    const r = await refused(() => raw(`${P}_c_bad`, { amountNet: "999.00" }), "23514");
    check("net that is not gross minus tax is refused", r.ok, r.code ?? "the insert succeeded");
  }

  sub("A3. a decision carries its reason");
  {
    const rej = await refused(() => raw(`${P}_c_nr`, { status: "REJECTED" }), "23514");
    check("a rejected collection with no reason is refused", rej.ok, rej.code ?? "the insert succeeded");
    const rev = await refused(() => raw(`${P}_c_nv`, { status: "REVERSED", decisionReason: "approved" }), "23514");
    check("a reversed collection with no reason is refused", rev.ok, rev.code ?? "the insert succeeded");
  }

  sub("A4. an approved collection is exactly the one that points at a commission event");
  {
    const noEvent = await refused(() => raw(`${P}_c_noev`, { status: "APPROVED" }), "23514");
    check("an approved collection with no commission event is refused", noEvent.ok, noEvent.code ?? "the insert succeeded");
    await c.query(
      `INSERT INTO "CollectionEvent" (id,"sourceSystem","externalRef",status,"customerId","opportunityId","amountGross","amountTax","amountNonQualifying",currency,"collectedAt","createdAt")
       VALUES ($1,'MANUAL_FINANCE_VERIFICATION',$2,'RECORDED',$3,$4,1150,150,0,'SAR',now(),now())`,
      [`${P}_ev_probe`, `${P}-probe`, custId, dealA]);
    const early = await refused(() => raw(`${P}_c_pend_ev`, { collectionEventId: `${P}_ev_probe` }), "23514");
    check("a pending collection that already points at an event is refused", early.ok, early.code ?? "the insert succeeded");
  }

  sub("A5. the idempotency key and the commission event are each unique");
  {
    await raw(`${P}_c_k1`, { idempotencyKey: `${P}-shared-key` });
    const dupe = await refused(() => raw(`${P}_c_k2`, { idempotencyKey: `${P}-shared-key` }), "23505");
    check("one submitter cannot reuse one idempotency key", dupe.ok, dupe.code ?? "the insert succeeded");

    await rawCollection(`${P}_c_k3`, { opportunityId: dealA, submittedById: ids.repB, idempotencyKey: `${P}-shared-key` });
    check("but a different submitter may, because the key is scoped to them",
      Boolean(await one(`SELECT id FROM "SalesCollection" WHERE id=$1`, [`${P}_c_k3`])));

    await c.query(`UPDATE "SalesCollection" SET status='APPROVED', "collectionEventId"=$1 WHERE id=$2`,
      [`${P}_ev_probe`, `${P}_c_k1`]);
    const shared = await refused(
      () => c.query(`UPDATE "SalesCollection" SET status='APPROVED', "collectionEventId"=$1 WHERE id=$2`,
        [`${P}_ev_probe`, `${P}_c_k3`]), "23505");
    check("two collections cannot share one commission event", shared.ok, shared.code ?? "the update succeeded");
  }

  sub("A6. evidence is bounded, and belongs to a collection");
  {
    const big = await refused(() => c.query(
      `INSERT INTO "CollectionEvidence" (id,"collectionId",filename,"mimeType","byteSize",checksum,content,"uploadedById","uploadedAt")
       VALUES ($1,$2,'huge.pdf','application/pdf',$3,'x',$4,$5,now())`,
      [`${P}_ev_big`, `${P}_c_k1`, 5242881, Buffer.from("x"), ids.repA]), "23514");
    check("evidence larger than the cap is refused", big.ok, big.code ?? "the insert succeeded");
    const orphan = await refused(() => c.query(
      `INSERT INTO "CollectionEvidence" (id,"collectionId",filename,"mimeType","byteSize",checksum,content,"uploadedById","uploadedAt")
       VALUES ($1,'no-such-collection','a.pdf','application/pdf',10,'x',$2,$3,now())`,
      [`${P}_ev_orphan`, Buffer.from("x"), ids.repA]), "23503");
    check("evidence cannot hang off a collection that does not exist", orphan.ok, orphan.code ?? "the insert succeeded");
  }

  // Clear the probes so the ceiling arithmetic below starts from an untouched deal.
  await c.query(`DELETE FROM "SalesCollection" WHERE id LIKE '${P}_c_%'`);
  await c.query(`DELETE FROM "CollectionEvent" WHERE id=$1`, [`${P}_ev_probe`]);

  // ═══════════════════════════════════════════════════════════════════════════
  section("B — TWO CALLERS AT ONCE PRODUCE ONE OUTCOME");

  sub("B1. the same idempotency key submitted twice at once lands once");
  {
    const key = `${P}-race-key-${Date.now()}`;
    const body = { opportunityId: dealA, amountGross: "1000.00", idempotencyKey: key };
    const [x, y] = await Promise.all([
      repA.api("/api/sales/collections", { method: "POST", body }),
      repA.api("/api/sales/collections", { method: "POST", body }),
    ]);
    const rows = await q(`SELECT id FROM "SalesCollection" WHERE "idempotencyKey"=$1`, [key]);
    check("exactly one collection exists", rows.length === 1, `${rows.length} rows`);
    check("neither caller got a server error", x.status < 500 && y.status < 500, `${x.status}/${y.status}`);
    check("at least one was told it was created", [x.status, y.status].includes(201), `${x.status}/${y.status}`);
    await c.query(`DELETE FROM "SalesCollection" WHERE "idempotencyKey"=$1`, [key]);
  }

  sub("B2. two submissions that together overflow the deal: one wins, one is refused");
  {
    const { oppId } = await mkDeal("b", ids.repA, 10000, 1500);
    const mk = (n) => ({ opportunityId: oppId, amountGross: "8000.00", idempotencyKey: `${P}-ovf-${n}-${Date.now()}` });
    const [x, y] = await Promise.all([
      repA.api("/api/sales/collections", { method: "POST", body: mk("a") }),
      repA.api("/api/sales/collections", { method: "POST", body: mk("b") }),
    ]);
    const codes = [x.status, y.status].sort().join("/");
    check("one was created and the other refused", codes === "201/409",
      `${codes} ${S(x.json?.error ?? y.json?.error).slice(0, 90)}`);
    const rows = await q(`SELECT "amountGross" FROM "SalesCollection" WHERE "opportunityId"=$1`, [oppId]);
    check("only one collection was stored", rows.length === 1, `${rows.length} rows`);
    check("so the deal's ceiling was never exceeded",
      rows.reduce((t, r) => t + Number(r.amountGross), 0) <= 10000);
  }

  sub("B3. two approvals of one collection create one commission, not two");
  {
    const { oppId } = await mkDeal("c", ids.repA, 5750, 750);
    const s = await submit(repA, oppId, "5750.00");
    check("the rep recorded it", s.status === 201, `${s.status} ${S(s.json?.error).slice(0, 90)}`);
    const id = s.json.collectionId;
    const [x, y] = await Promise.all([decide(fin, id, "approve"), decide(fin2, id, "approve")]);
    check("both callers were answered without a server error", x.status < 500 && y.status < 500, `${x.status}/${y.status}`);
    const events = await q(`SELECT id FROM "CollectionEvent" WHERE "externalRef"=$1`, [id]);
    check("exactly one commission event exists", events.length === 1, `${events.length} events`);
    const accruals = await q(
      `SELECT amount FROM "CommissionAccrual"
        WHERE "collectionEventId" IN (SELECT id FROM "CollectionEvent" WHERE "externalRef"=$1)`, [id]);
    check("exactly one accrual exists", accruals.length === 1, `${accruals.length} accruals`);
    check("and it is 1% of the 5,000.00 net — 50.00, not 100.00",
      accruals[0] && Number(accruals[0].amount) === 50, S(accruals[0]?.amount));

    sub("B4. a third, sequential approval adds nothing");
    const again = await decide(fin, id, "approve");
    check("the replay is accepted rather than erroring", again.status === 200, String(again.status));
    check("and reports itself as a replay", again.json?.replayed === true, S(again.json).slice(0, 90));
    const after = await q(
      `SELECT amount FROM "CommissionAccrual"
        WHERE "collectionEventId" IN (SELECT id FROM "CollectionEvent" WHERE "externalRef"=$1)`, [id]);
    check("still exactly one accrual, still 50.00",
      after.length === 1 && Number(after[0].amount) === 50, S(after));
  }

  sub("B5. approve racing reject resolves to one terminal status");
  {
    const { oppId } = await mkDeal("d", ids.repA, 2300, 300);
    const s = await submit(repA, oppId, "2300.00");
    const id = s.json.collectionId;
    const [x, y] = await Promise.all([
      decide(fin, id, "approve"),
      decide(fin2, id, "reject", "the receipt does not match the amount"),
    ]);
    const row = await one(`SELECT status::text AS status FROM "SalesCollection" WHERE id=$1`, [id]);
    check("the collection ended in exactly one of the two states",
      ["APPROVED", "REJECTED"].includes(row.status), row.status);
    check("the loser was refused rather than silently ignored",
      [x.status, y.status].some((n) => n === 409), `${x.status}/${y.status}`);
    const events = await q(`SELECT id FROM "CollectionEvent" WHERE "externalRef"=$1`, [id]);
    check("a rejected collection has no commission event, an approved one has exactly one",
      row.status === "REJECTED" ? events.length === 0 : events.length === 1, `${row.status} / ${events.length}`);
  }

  sub("B6. two reversals of one approved collection post one negative adjustment");
  {
    const { oppId } = await mkDeal("e", ids.repA, 4600, 600);
    const s = await submit(repA, oppId, "4600.00");
    const id = s.json.collectionId;
    await decide(fin, id, "approve");
    const before = await ledger(ids.repA);
    const [x, y] = await Promise.all([
      decide(fin, id, "reverse", "the customer was refunded"),
      decide(fin2, id, "reverse", "a second reversal of the same receipt"),
    ]);
    check("both callers were answered", x.status < 500 && y.status < 500, `${x.status}/${y.status}`);
    const row = await one(`SELECT status::text AS status, "reversalReason" FROM "SalesCollection" WHERE id=$1`, [id]);
    check("the collection is reversed", row.status === "REVERSED", row.status);
    check("with exactly one reason recorded", typeof row.reversalReason === "string" && row.reversalReason.length > 3,
      S(row.reversalReason));
    const ev = await one(`SELECT status::text AS status FROM "CollectionEvent" WHERE "externalRef"=$1`, [id]);
    check("the commission event is marked reversed, not deleted", ev?.status === "REVERSED", S(ev));
    const after = await ledger(ids.repA);
    // 1% of the NET, which is 4,000.00 of the 4,600.00 receipt — 40.00, not 46.00.
    check("the ledger came down by exactly the 40.00 that was posted", before - after === 40, `${before} → ${after}`);

    sub("B7. an approved-then-reversed collection cannot be approved again");
    const re = await decide(fin, id, "approve");
    check("re-approval is refused with a conflict", re.status === 409, `${re.status} ${S(re.json?.error).slice(0, 80)}`);
  }

  sub("B8. two qualifying interactions logged at once put the lead in the pipeline once");
  {
    const leadId = `${P}_lead_race`;
    await c.query(
      `INSERT INTO "Lead" (id,"companyName","contactName","ownerId",source,status,"createdAt","updatedAt")
       VALUES ($1,$2,'Contact',$3,'PHONE','NEW',now(),now())`,
      [leadId, `${P} Race Cafe`, ids.repA]);
    const body = (subject) => ({ type: "CALL", subject, leadId, outcome: "INTERESTED" });
    const [x, y] = await Promise.all([
      repA.api("/api/sales/activities", { method: "POST", body: body(`${P} first call`) }),
      repA.api("/api/sales/activities", { method: "POST", body: body(`${P} second call`) }),
    ]);
    check("both activities were accepted", x.status < 400 && y.status < 400,
      `${x.status}/${y.status} ${S(x.json?.error ?? y.json?.error).slice(0, 90)}`);
    const conv = await q(`SELECT "opportunityId" FROM "LeadConversion" WHERE "leadId"=$1`, [leadId]);
    check("the lead was converted exactly once", conv.length === 1, `${conv.length} conversions`);
    const lead = await one(`SELECT status::text AS status FROM "Lead" WHERE id=$1`, [leadId]);
    check("and the lead now reads CONVERTED", lead.status === "CONVERTED", lead.status);
    if (conv.length === 1) {
      const opp = await one(`SELECT "stageId" FROM "Opportunity" WHERE id=$1`, [conv[0].opportunityId]);
      check("the new deal sits in the configured qualification stage", opp.stageId === qualStage,
        `${opp.stageId} (expected ${qualStage})`);
    }

    sub("B9. a third qualifying interaction does not create a second deal");
    const third = await repA.api("/api/sales/activities", { method: "POST", body: body(`${P} third call`) });
    check("it is accepted", third.status < 400, String(third.status));
    check("and reports the deal the lead is already in",
      Boolean(third.json?.qualification?.opportunityId), S(third.json?.qualification).slice(0, 110));
    check("still one conversion",
      (await q(`SELECT id FROM "LeadConversion" WHERE "leadId"=$1`, [leadId])).length === 1);
  }

  sub("B10. accepting a quotation twice at once wins the deal once");
  {
    const { oppId, quoteId } = await mkDeal("f", ids.repA, 8000, 1000);
    await c.query(`UPDATE "Quote" SET status='ISSUED', "acceptedAt"=NULL, "issuedAt"=now() WHERE id=$1`, [quoteId]);
    await c.query(`UPDATE "Opportunity" SET "stageId"=$1 WHERE id=$2`, [quoteStage, oppId]);
    const accept = () => repA.api(`/api/sales/quotes/${quoteId}/transition`, { method: "POST", body: { to: "ACCEPTED" } });
    const [x, y] = await Promise.all([accept(), accept()]);
    check("both callers were answered without a server error", x.status < 500 && y.status < 500, `${x.status}/${y.status}`);
    const opp = await one(`SELECT outcome::text AS outcome FROM "Opportunity" WHERE id=$1`, [oppId]);
    check("the deal is won", opp.outcome === "WON", opp.outcome);
    const wins = await q(
      `SELECT id FROM "OpportunityStageEvent" WHERE "opportunityId"=$1 AND "toOutcome"::text='WON'`, [oppId]);
    check("and the win was recorded once, not twice", wins.length <= 1, `${wins.length} win events`);

    sub("B11. rejecting a quotation does not lose the deal");
    const { oppId: lostOpp, quoteId: lostQuote } = await mkDeal("g", ids.repA, 3000, 0);
    await c.query(`UPDATE "Quote" SET status='ISSUED', "acceptedAt"=NULL, "issuedAt"=now() WHERE id=$1`, [lostQuote]);
    const noReason = await repA.api(`/api/sales/quotes/${lostQuote}/transition`, { method: "POST", body: { to: "REJECTED" } });
    check("a rejection with no reason is refused", noReason.status === 400, String(noReason.status));
    const rej = await repA.api(`/api/sales/quotes/${lostQuote}/transition`, {
      method: "POST", body: { to: "REJECTED", note: "the customer went with a cheaper supplier" },
    });
    check("a rejection with a reason is accepted", rej.status < 400, `${rej.status} ${S(rej.json?.error).slice(0, 80)}`);
    const stillOpen = await one(`SELECT outcome::text AS outcome FROM "Opportunity" WHERE id=$1`, [lostOpp]);
    check("the deal is still open — a rejected quotation is not a lost deal",
      stillOpen.outcome === "OPEN", stillOpen.outcome);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  section("C — WHO MAY DO WHAT, ENFORCED BY THE SERVER");

  sub("C1. the person who recorded a collection cannot verify it");
  {
    const { oppId } = await mkDeal("h", ids.dual, 1150, 150);
    const s = await submit(dual, oppId, "1150.00");
    check("the dual-hatted user could record it", s.status === 201, `${s.status} ${S(s.json?.error).slice(0, 90)}`);
    const id = s.json.collectionId;
    const self = await decide(dual, id, "approve");
    check("but verifying their own is refused, despite holding the privilege", self.status === 403,
      `${self.status} ${S(self.json?.error).slice(0, 110)}`);
    check("and it is still awaiting verification",
      (await one(`SELECT status::text AS status FROM "SalesCollection" WHERE id=$1`, [id])).status === "PENDING_VERIFICATION");
    const selfReject = await decide(dual, id, "reject", "changed my mind about my own receipt");
    check("they cannot reject their own either", selfReject.status === 403, String(selfReject.status));
    const other = await decide(fin, id, "approve");
    check("somebody else in Finance can", other.status === 200, `${other.status} ${S(other.json?.error).slice(0, 90)}`);
  }

  sub("C2. verification needs its own privilege, not merely a sales login");
  {
    const { oppId } = await mkDeal("i", ids.repA, 1150, 150);
    const id = (await submit(repA, oppId, "1150.00")).json.collectionId;
    for (const [who, s] of [["a rep", repB], ["a user with no sales module", none]]) {
      const r = await decide(s, id, "approve");
      check(`${who} cannot approve`, r.status === 403, `${r.status} ${S(r.json?.error).slice(0, 80)}`);
      const rev = await decide(s, id, "reverse", "trying the other door");
      check(`${who} cannot reverse either`, rev.status === 403, String(rev.status));
    }
    check("the collection is untouched",
      (await one(`SELECT status::text AS status FROM "SalesCollection" WHERE id=$1`, [id])).status === "PENDING_VERIFICATION");
  }

  sub("C3. a rep sees their own collections and not a colleague's");
  {
    const mine = await repA.api("/api/sales/collections");
    check("the list is readable", mine.status === 200, String(mine.status));
    check("and is scoped to the caller", mine.json?.scope === "own", S(mine.json?.scope));
    const foreign = (mine.json?.rows ?? []).filter((r) => r.submittedBy?.id && r.submittedBy.id !== ids.repA);
    check("no other person's collection appears in it", foreign.length === 0, `${foreign.length} foreign rows`);
    const theirs = await repB.api("/api/sales/collections");
    check("rep B cannot see rep A's either",
      (theirs.json?.rows ?? []).filter((r) => r.submittedBy?.id === ids.repA).length === 0);
    const finance = await fin.api("/api/sales/collections");
    check("Finance sees the whole queue", finance.json?.scope === "all", S(finance.json?.scope));
    check("and the server tells the client what it may do, rather than the client deciding",
      finance.json?.can?.verify === true && mine.json?.can?.verify === false,
      `${S(finance.json?.can)} / ${S(mine.json?.can)}`);
  }

  sub("C4. a rep cannot record against somebody else's deal");
  {
    const { oppId } = await mkDeal("j", ids.repB, 1150, 150);
    const r = await submit(repA, oppId, "1000.00");
    check("the attempt is refused as not found, which does not confirm the deal exists",
      r.status === 404, `${r.status} ${S(r.json?.error).slice(0, 80)}`);
    check("nothing was stored",
      (await q(`SELECT id FROM "SalesCollection" WHERE "opportunityId"=$1`, [oppId])).length === 0);
  }

  sub("C5. a deal with no accepted quotation has nothing to collect against");
  {
    const oppId = `${P}_opp_bare`;
    await c.query(
      `INSERT INTO "Opportunity" (id,title,"customerId","stageId",outcome,amount,currency,probability,"ownerId","createdAt","updatedAt")
       VALUES ($1,$2,$3,$4,'OPEN',1000,'SAR',50,$5,now(),now())`,
      [oppId, `${P} Deal Bare`, custId, `${P}_stage_new`, ids.repA]);
    const r = await submit(repA, oppId, "500.00");
    check("recording against it is refused with a conflict", r.status === 409, `${r.status} ${S(r.json?.error).slice(0, 80)}`);
  }

  sub("C6. the amount, the currency and the date are checked on the way in");
  {
    const { oppId } = await mkDeal("k", ids.repA, 1150, 150);
    const over = await submit(repA, oppId, "2000.00");
    check("more than the outstanding balance is refused", over.status === 409, `${over.status} ${S(over.json?.error).slice(0, 80)}`);
    check("a negative amount is refused before it reaches the database", (await submit(repA, oppId, "-100.00")).status === 400);
    check("zero is refused", [400, 409].includes((await submit(repA, oppId, "0")).status));
    const cur = await submit(repA, oppId, "100.00", { currency: "USD" });
    check("a currency the quotation is not in is refused, not converted at an invented rate",
      cur.status === 409, `${cur.status} ${S(cur.json?.error).slice(0, 80)}`);
    const future = await submit(repA, oppId, "100.00", { collectedAt: new Date(Date.now() + 40 * 86400_000).toISOString() });
    check("a receipt dated next month is refused", future.status === 400, String(future.status));
    const shortKey = await repA.api("/api/sales/collections", {
      method: "POST", body: { opportunityId: oppId, amountGross: "100.00", idempotencyKey: "abc" },
    });
    check("a too-short idempotency key is refused", shortKey.status === 400, String(shortKey.status));
  }

  sub("C7. evidence is private, and its type is read from the file rather than its name");
  {
    const { oppId } = await mkDeal("m", ids.repA, 1150, 150);
    const id = (await submit(repA, oppId, "1150.00")).json.collectionId;

    // PNG bytes under a .pdf name. The filename is a claim; the signature is the fact.
    const lying = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)]);
    const badForm = new FormData();
    badForm.append("file", new Blob([lying], { type: "application/pdf" }), "receipt.pdf");
    const bad = await repA.api(`/api/sales/collections/${id}/evidence`, { method: "POST", raw: badForm });
    // PNG is an accepted type, so this is stored — but as what it IS, not as what it claimed.
    check("the stored type follows the bytes, not the extension or the browser's header",
      bad.json?.evidence?.mimeType === "image/png", `${bad.status} ${S(bad.json).slice(0, 130)}`);

    const exe = new FormData();
    exe.append("file", new Blob([Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03])], { type: "application/pdf" }), "receipt.pdf");
    const refusedExe = await repA.api(`/api/sales/collections/${id}/evidence`, { method: "POST", raw: exe });
    check("a file that is none of the three accepted types is refused",
      [400, 415].includes(refusedExe.status), `${refusedExe.status} ${S(refusedExe.json).slice(0, 100)}`);

    const goodForm = new FormData();
    goodForm.append("file", new Blob([Buffer.from("%PDF-1.4\nreceipt body")], { type: "application/pdf" }), "receipt.pdf");
    const okUp = await repA.api(`/api/sales/collections/${id}/evidence`, { method: "POST", raw: goodForm });
    check("a real PDF is accepted", okUp.status < 300, `${okUp.status} ${S(okUp.json).slice(0, 120)}`);

    const listed = await repA.api(`/api/sales/collections/${id}/evidence`);
    const evId = listed.json?.evidence?.[0]?.id;
    check("the submitter can list what they attached", Boolean(evId), S(listed.json).slice(0, 120));

    if (evId) {
      const mine = await repA.api(`/api/sales/collections/${id}/evidence/${evId}`);
      check("and download it", mine.status === 200, String(mine.status));
      check("it is served as a download, never rendered inline",
        /attachment/i.test(mine.headers.get("content-disposition") ?? ""), S(mine.headers.get("content-disposition")));
      check("and it is not cached anywhere shared",
        /no-store/i.test(mine.headers.get("cache-control") ?? ""), S(mine.headers.get("cache-control")));
      const theirs = await repB.api(`/api/sales/collections/${id}/evidence/${evId}`);
      check("another rep cannot download it", [403, 404].includes(theirs.status), String(theirs.status));
      const anon = await fetch(`${BASE}/api/sales/collections/${id}/evidence/${evId}`, { redirect: "manual" });
      check("and there is no URL that serves it without a session", anon.status !== 200, String(anon.status));
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  section("D — THE MONEY, READ BACK OUT OF THE LEDGER");

  sub("D1. the worked example: 5,750 gross, 750 tax, 5,000 net, 1% — 50.00 once approved");
  {
    const { oppId } = await mkDeal("n", ids.repB, 5750, 750);
    const s = await submit(repB, oppId, "5750.00");
    check("tax was derived by the server, not supplied by the salesperson",
      s.json?.amountTax === "750.00", S(s.json?.amountTax));
    check("and so was net", s.json?.amountNet === "5000.00", S(s.json?.amountNet));
    check("while it is pending it is worth nothing", (await ledger(ids.repB)) === 0, S(await ledger(ids.repB)));
    await decide(fin, s.json.collectionId, "approve");
    check("approval is worth exactly 50.00", (await ledger(ids.repB)) === 50, S(await ledger(ids.repB)));
  }

  sub("D2. a partial collection earns on the part, and the remainder adds only the difference");
  {
    const { oppId } = await mkDeal("p", ids.repB, 5750, 750);
    const before = await ledger(ids.repB);

    const first = await submit(repB, oppId, "2300.00");
    await decide(fin, first.json.collectionId, "approve");
    const afterFirst = await ledger(ids.repB);
    check("40% of the deal earns 1% of 2,000.00, which is 20.00", afterFirst - before === 20, `${before} → ${afterFirst}`);

    const rest = await submit(repB, oppId, "3450.00");
    check("the settling payment takes the remaining tax exactly", rest.json?.amountTax === "450.00", S(rest.json?.amountTax));
    await decide(fin, rest.json.collectionId, "approve");
    const afterRest = await ledger(ids.repB);
    check("the remainder adds 30.00, not another 50.00", afterRest - afterFirst === 30, `${afterFirst} → ${afterRest}`);

    const rows = await q(
      `SELECT "amountTax","amountNet" FROM "SalesCollection" WHERE "opportunityId"=$1 AND status='APPROVED'`, [oppId]);
    const tax = rows.reduce((t, r) => t + Number(r.amountTax), 0);
    const net = rows.reduce((t, r) => t + Number(r.amountNet), 0);
    check("the two payments reconcile to the quotation to the cent", tax === 750 && net === 5000, `tax ${tax} net ${net}`);

    const nothingLeft = await submit(repB, oppId, "1.00");
    check("and nothing more can be collected against it", nothingLeft.status === 409, String(nothingLeft.status));
  }

  sub("D3. a reversal is an adjustment, not an erasure");
  {
    const { oppId } = await mkDeal("r", ids.repB, 2300, 300);
    const id = (await submit(repB, oppId, "2300.00")).json.collectionId;
    await decide(fin, id, "approve");
    const approved = await one(`SELECT "decidedById","decidedAt" FROM "SalesCollection" WHERE id=$1`, [id]);
    await decide(fin, id, "reverse", "the customer was refunded after a partial cancellation");

    const row = await one(
      `SELECT status::text AS status, "decidedById","decidedAt","reversedById","reversalReason"
         FROM "SalesCollection" WHERE id=$1`, [id]);
    check("the row still exists", Boolean(row));
    check("who approved it is still recorded", row.decidedById === approved.decidedById, S(row.decidedById));
    check("the approval timestamp was not overwritten by the reversal",
      new Date(row.decidedAt).getTime() === new Date(approved.decidedAt).getTime(), S(row.decidedAt));
    check("the reversal is attributed separately", row.reversedById === ids.fin, S(row.reversedById));
    check("and carries its reason", (row.reversalReason ?? "").length > 3, S(row.reversalReason));

    const last = await one(
      `SELECT amount FROM "CommissionLedgerEntry" WHERE "employeeId"=$1 ORDER BY "createdAt" DESC LIMIT 1`, [ids.repB]);
    check("the last ledger movement is negative", last && Number(last.amount) < 0, S(last?.amount));

    const summary = await fin.api(`/api/sales/collections?opportunityId=${oppId}`);
    const reversedRow = (summary.json?.rows ?? []).find((r) => r.id === id);
    check("and the reversed collection is still listed, not hidden",
      reversedRow?.status === "REVERSED", S(reversedRow?.status));
  }

  sub("D4. a pending estimate is never part of a total");
  {
    const { oppId } = await mkDeal("s", ids.repB, 1150, 150);
    const before = await ledger(ids.repB);
    await submit(repB, oppId, "1150.00");
    check("recording it changed no commission total", (await ledger(ids.repB)) === before, `${before}`);
    const accruals = await q(
      `SELECT id FROM "CommissionAccrual"
        WHERE "collectionEventId" IN (SELECT id FROM "CollectionEvent" WHERE "opportunityId"=$1)`, [oppId]);
    check("and produced no accrual", accruals.length === 0, `${accruals.length}`);
  }

  sub("D5. a reversal does not make the period look unreconciled");
  {
    // The regression this pins down: the review screen compared the ledger's NET accrued
    // figure against the sum of the per-collection accrual rows. A reversal moves the first
    // and deliberately never touches the second — an approved accrual is a fact about what
    // was approved — so every period that had ever seen a refund reported a difference and
    // told the reviewer not to approve. On the preview data that read "off by -200.00" with
    // nothing wrong: 250.00 accrued, 200.00 reversed, 50.00 owed, and five untouched rows.
    const review = await fin.api("/api/commissions/review");
    check("Finance can read the review", review.status === 200, String(review.status));
    const mine = (review.json?.employees ?? []).filter((e) => e.employeeId.startsWith(P));
    check("this suite's people are in it", mine.length > 0, `${mine.length}`);

    const withReversals = mine.filter((e) => Number(e.reversals) !== 0);
    check("at least one of them has had a reversal", withReversals.length > 0,
      S(mine.map((e) => [e.employeeId, e.reversals])));

    for (const e of mine) {
      check(`${e.employeeId} reconciles`, e.reconciled === true,
        `difference ${e.reconciliationDifference} — accrued ${e.accrued} vs expected ${e.expectedFromRows}`);
      check(`${e.employeeId}: the ledger equals the rows less anything frozen and reversed`,
        Math.abs(Number(e.accrued) - (Number(e.accrualRowsTotal) - Number(e.frozenReversedTotal))) < 0.005,
        `${e.accrued} vs ${e.accrualRowsTotal} - ${e.frozenReversedTotal}`);
      check(`${e.employeeId}: and the net owed is the entries less the reversals`,
        Math.abs(Number(e.accrued) - (Number(e.accrualEntries) + Number(e.reversals))) < 0.005,
        `${e.accrued} vs ${e.accrualEntries} + ${e.reversals}`);
    }
    const reversed = withReversals[0];
    if (reversed) {
      check("the reversal is reported as its own negative figure, not folded into the total",
        Number(reversed.reversals) < 0, S(reversed.reversals));
    }
  }

  sub("D6. the server's own verdict on whether the action may be offered");
  {
    // The reported defect: a reviewer on their own Won deal, accepted quotation, 1,150.00
    // outstanding, and no button — because their role predated `collection_submit`. The
    // server was right; the screen just would not say so. These pin the verdict at each
    // state, since every surface now renders whatever this returns.
    const { oppId } = await mkDeal("t", ids.repA, 1150, 150);
    const verdict = async (s, id = oppId) =>
      (await s.api(`/api/sales/opportunities/${id}`)).json?.collectionAction;

    const eligible = await verdict(repA);
    check("the owner of an eligible deal is told the action is available",
      eligible?.available === true && eligible?.reason === "OK", S(eligible));

    const notMine = await verdict(repB);
    check("another rep cannot even see the deal, so there is no verdict to give",
      notMine === undefined, S(notMine));

    // Finance holds no sales module at all, so the deal page is not theirs to open —
    // there is no verdict because there is no screen. Deliberate: they verify collections,
    // they do not read the pipeline.
    const financeOnDeal = await fin.api(`/api/sales/opportunities/${oppId}`);
    check("Finance cannot open a deal page at all, holding no sales module",
      financeOnDeal.status === 403, String(financeOnDeal.status));

    // The reported case, reproduced exactly: a salesperson looking at their OWN deal, with
    // an accepted quotation and a balance outstanding, whose role predates the privilege.
    const { oppId: staleDeal } = await mkDeal("v", ids.stale, 1150, 150);
    const noPriv = await verdict(stale, staleDeal);
    check("they can open their own deal and are given a verdict, not a blank",
      noPriv !== undefined, S(noPriv));
    check("the reason names the privilege, not the deal", noPriv?.reason === "NO_PRIVILEGE", S(noPriv));
    const staleTry = await submit(stale, staleDeal, "100.00");
    check("and the API refuses them too, so the screen was not the control",
      staleTry.status === 403, `${staleTry.status} ${S(staleTry.json?.error).slice(0, 80)}`);

    // 7. The button must go once there is nothing left to collect.
    const whole = await submit(repA, oppId, "1150.00");
    check("the owner can record the whole outstanding amount", whole.status === 201,
      `${whole.status} ${S(whole.json?.error).slice(0, 90)}`);
    const settled = await verdict(repA);
    check("with the full amount pending, the action is withdrawn",
      settled?.available === false && settled?.reason === "NOTHING_OUTSTANDING", S(settled));

    await decide(fin, whole.json.collectionId, "approve");
    const afterApproval = await verdict(repA);
    check("and it stays withdrawn once approved",
      afterApproval?.available === false && afterApproval?.reason === "NOTHING_OUTSTANDING",
      S(afterApproval));

    // 6. The API refuses regardless of what any screen decided to render.
    const anyway = await submit(repA, oppId, "1.00");
    check("and the API refuses a submission the screen would not have offered",
      anyway.status === 409, `${anyway.status} ${S(anyway.json?.error).slice(0, 80)}`);

    sub("D7. a deal with no accepted quotation reports that, not a privilege problem");
    const bare = `${P}_opp_noquote`;
    await c.query(
      `INSERT INTO "Opportunity" (id,title,"customerId","stageId",outcome,amount,currency,probability,"ownerId","createdAt","updatedAt")
       VALUES ($1,$2,$3,$4,'OPEN',900,'SAR',50,$5,now(),now())`,
      [bare, `${P} Deal NoQuote`, custId, `${P}_stage_new`, ids.repA]);
    const noDoc = await verdict(repA, bare);
    check("the reason is the missing document", noDoc?.reason === "NO_ACCEPTED_DOCUMENT", S(noDoc));

    sub("D8. partial then remainder, both offered and both accepted");
    const { oppId: part } = await mkDeal("u", ids.repA, 1150, 150);
    const first = await submit(repA, part, "400.00");
    check("a partial amount is accepted", first.status === 201, String(first.status));
    await decide(fin, first.json.collectionId, "approve");
    const midway = await verdict(repA, part);
    check("the action is still offered while a balance remains",
      midway?.available === true, S(midway));
    const rest = await submit(repA, part, "750.00");
    check("and the remainder is accepted", rest.status === 201,
      `${rest.status} ${S(rest.json?.error).slice(0, 80)}`);
    const done = await verdict(repA, part);
    check("after which it is withdrawn", done?.reason === "NOTHING_OUTSTANDING", S(done));

    sub("D9. the empty state's eligible-deal list is scoped, and needs the privilege");
    const mine = await repA.api("/api/sales/collections");
    const theirs = await repB.api("/api/sales/collections");
    const financeList = await fin.api("/api/sales/collections");
    const ids_ = (r) => (r.json?.eligibleDeals ?? []).map((d) => d.id);
    check("a rep is offered only their own eligible deals",
      ids_(mine).every((id) => id.startsWith(P)) &&
      !ids_(mine).some((id) => id === `${P}_opp_j`), S(ids_(mine)).slice(0, 120));
    check("rep B is not offered rep A's deals",
      !ids_(theirs).some((id) => ids_(mine).includes(id)), S(ids_(theirs)).slice(0, 120));
    check("Finance holds no submit privilege, so it is offered none at all",
      ids_(financeList).length === 0, S(ids_(financeList)).slice(0, 120));
    check("and Finance can still read the queue despite holding no sales module",
      financeList.status === 200 && financeList.json?.scope === "all",
      `${financeList.status} ${S(financeList.json?.scope)}`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  section("E — THE APPROVAL WORKFLOW, THROUGH THREE SEPARATE IDENTITIES");
  //
  // Reported: Finance could not approve. Two causes, and only one of them was a privilege.
  // The Finance role holds no sales module by design, so the queue — which lives under
  // Sales — had no nav entry for them and no way in but typing the URL; and every
  // unavailable action rendered as an empty cell, so "no privilege", "not your job" and
  // "you recorded this one" were indistinguishable. This walks the whole story with a rep,
  // a manager and a finance user who are three different people.

  sub("E1. the rep submits");
  let storyId = null;
  {
    const { oppId } = await mkDeal("w", ids.repA, 575, 75);
    const r = await submit(repA, oppId, "575.00");
    check("the rep records 575.00", r.status === 201, `${r.status} ${S(r.json?.error).slice(0, 90)}`);
    storyId = r.json.collectionId;
    check("the server derives the 75.00 tax", r.json?.amountTax === "75.00", S(r.json?.amountTax));
    check("and the 500.00 net basis", r.json?.amountNet === "500.00", S(r.json?.amountNet));
    const row = await one(`SELECT status::text AS status FROM "SalesCollection" WHERE id=$1`, [storyId]);
    check("it is awaiting verification", row.status === "PENDING_VERIFICATION", row.status);
  }

  const decisionOf = async (s, id) =>
    (await s.api("/api/sales/collections")).json?.decisions?.[id];

  sub("E2. the manager sees it and cannot decide it");
  {
    const list = await mgr.api("/api/sales/collections");
    const seen = (list.json?.rows ?? []).find((r) => r.id === storyId);
    check("the manager can see the collection", Boolean(seen), "not in their list");
    check("their scope is the whole team", list.json?.scope === "all", S(list.json?.scope));
    check("and the server offers them no decision",
      list.json?.can?.verify === false && list.json?.can?.reject === false, S(list.json?.can));
    const d = list.json?.decisions?.[storyId];
    check("the per-row verdict says why: no privilege",
      d?.approve?.allowed === false && d.approve.reason === "NO_PRIVILEGE", S(d?.approve));
    const tried = await decide(mgr, storyId, "approve");
    check("and the API refuses them", tried.status === 403, `${tried.status} ${S(tried.json?.error).slice(0, 80)}`);
  }

  sub("E3. Finance sees it, with approve and reject offered");
  {
    const list = await fin.api("/api/sales/collections");
    check("Finance can read the queue while holding NO sales module", list.status === 200, String(list.status));
    check("and sees the whole queue", list.json?.scope === "all", S(list.json?.scope));
    check("with the decision abilities the server grants",
      list.json?.can?.verify === true && list.json?.can?.reject === true && list.json?.can?.reverse === true,
      S(list.json?.can));
    const d = list.json?.decisions?.[storyId];
    check("approve is offered on this row", d?.approve?.allowed === true, S(d?.approve));
    check("reject is offered on this row", d?.reject?.allowed === true, S(d?.reject));
    check("reverse is not, because it is not approved yet",
      d?.reverse?.allowed === false && d.reverse.reason === "NOT_APPROVED", S(d?.reverse));

    const seen = (list.json?.rows ?? []).find((r) => r.id === storyId);
    check("the row carries the gross", Number(seen?.amountGross) === 575, S(seen?.amountGross));
    check("the derived tax", Number(seen?.amountTax) === 75, S(seen?.amountTax));
    check("and the net basis the commission is computed on", Number(seen?.amountNet) === 500, S(seen?.amountNet));
    check("the expected commission effect is quoted BEFORE deciding",
      list.json?.projectedCommission?.[storyId] === "5.00",
      S(list.json?.projectedCommission?.[storyId]));
  }

  sub("E5. the submitter cannot approve their own, before anyone else has decided it");
  {
    const d = await decisionOf(repA, storyId);
    check("the submitter is not offered approve",
      d === undefined || d.approve.allowed === false, S(d?.approve));
    if (d) {
      check("and the reason is the separation of duties, not a missing privilege",
        d.approve.reason === "SELF_SUBMITTED" || d.approve.reason === "NO_PRIVILEGE", S(d.approve));
    }
    const tried = await decide(repA, storyId, "approve");
    check("the API refuses them", tried.status === 403, `${tried.status} ${S(tried.json?.error).slice(0, 80)}`);
    const still = await one(`SELECT status::text AS status FROM "SalesCollection" WHERE id=$1`, [storyId]);
    check("the collection is untouched", still.status === "PENDING_VERIFICATION", still.status);
  }

  sub("E4. Finance approves: the status moves and the commission is created exactly once");
  {
    const before = await ledger(ids.repA);
    const r = await decide(fin, storyId, "approve");
    check("the approval is accepted", r.status === 200, `${r.status} ${S(r.json?.error).slice(0, 80)}`);
    const row = await one(
      `SELECT status::text AS status, "decidedById", "collectionEventId" FROM "SalesCollection" WHERE id=$1`,
      [storyId]);
    check("the status is APPROVED", row.status === "APPROVED", row.status);
    check("attributed to the finance user", row.decidedById === ids.fin, S(row.decidedById));
    check("and it now points at one commission event", Boolean(row.collectionEventId), S(row.collectionEventId));

    const events = await q(`SELECT id FROM "CollectionEvent" WHERE "externalRef"=$1`, [storyId]);
    check("exactly one event", events.length === 1, `${events.length}`);
    const accruals = await q(
      `SELECT amount FROM "CommissionAccrual" WHERE "collectionEventId" IN
         (SELECT id FROM "CollectionEvent" WHERE "externalRef"=$1)`, [storyId]);
    check("exactly one accrual", accruals.length === 1, `${accruals.length}`);
    check("worth 1% of the 500.00 net — 5.00", accruals[0] && Number(accruals[0].amount) === 5,
      S(accruals[0]?.amount));
    const after = await ledger(ids.repA);
    check("which is exactly what the estimate promised", Math.abs(after - before - 5) < 0.005, `${before} -> ${after}`);

    const d = await decisionOf(fin, storyId);
    check("approve is no longer offered",
      d?.approve?.allowed === false && d.approve.reason === "NOT_PENDING", S(d?.approve));
    check("and reverse now is", d?.reverse?.allowed === true, S(d?.reverse));
  }

  sub("E6. Finance rejects a different one, and the reason is mandatory");
  {
    const { oppId } = await mkDeal("x", ids.repA, 230, 30);
    const id = (await submit(repA, oppId, "230.00")).json.collectionId;

    const noReason = await decide(fin, id, "reject");
    check("a rejection with no reason is refused", noReason.status === 400,
      `${noReason.status} ${S(noReason.json?.error).slice(0, 80)}`);
    const blank = await decide(fin, id, "reject", "  ");
    check("whitespace is not a reason", blank.status === 400, String(blank.status));

    const ok = await decide(fin, id, "reject", "صورة الإيصال لا تطابق المبلغ");
    check("with a reason it is accepted", ok.status === 200, `${ok.status} ${S(ok.json?.error).slice(0, 80)}`);
    const row = await one(
      `SELECT status::text AS status, "decisionReason", "collectionEventId" FROM "SalesCollection" WHERE id=$1`,
      [id]);
    check("the status is REJECTED", row.status === "REJECTED", row.status);
    check("the reason is stored", (row.decisionReason ?? "").length > 3, S(row.decisionReason));
    check("and no commission event was created", row.collectionEventId === null, S(row.collectionEventId));
    const accruals = await q(
      `SELECT id FROM "CommissionAccrual" WHERE "collectionEventId" IN
         (SELECT id FROM "CollectionEvent" WHERE "externalRef"=$1)`, [id]);
    check("so no accrual either", accruals.length === 0, `${accruals.length}`);
  }

  sub("E7. an authorised reversal compensates without deleting");
  {
    const before = await ledger(ids.repA);
    const noReason = await decide(fin, storyId, "reverse");
    check("a reversal with no reason is refused", noReason.status === 400, String(noReason.status));

    const r = await decide(fin, storyId, "reverse", "أُعيد المبلغ للعميل");
    check("with a reason it is accepted", r.status === 200, `${r.status} ${S(r.json?.error).slice(0, 80)}`);

    const row = await one(
      `SELECT status::text AS status, "decidedById", "reversedById", "reversalReason", "collectionEventId"
         FROM "SalesCollection" WHERE id=$1`, [storyId]);
    check("the row still exists", Boolean(row));
    check("still pointing at its original event", Boolean(row.collectionEventId), S(row.collectionEventId));
    check("who approved it is still recorded", row.decidedById === ids.fin, S(row.decidedById));
    check("the reversal is attributed separately", row.reversedById === ids.fin, S(row.reversedById));
    check("and carries its reason", (row.reversalReason ?? "").length > 3, S(row.reversalReason));

    const ev = await one(`SELECT status::text AS status FROM "CollectionEvent" WHERE "externalRef"=$1`, [storyId]);
    check("the event is marked reversed, not deleted", ev?.status === "REVERSED", S(ev));

    const after = await ledger(ids.repA);
    check("the ledger came down by the 5.00 that was posted", Math.abs(before - after - 5) < 0.005, `${before} -> ${after}`);
    const last = await one(
      `SELECT amount, type::text AS type FROM "CommissionLedgerEntry"
        WHERE "employeeId"=$1 ORDER BY "createdAt" DESC LIMIT 1`, [ids.repA]);
    check("as a compensating REVERSAL entry", last?.type === "REVERSAL" && Number(last.amount) === -5, S(last));

    const accruals = await q(
      `SELECT id FROM "CommissionAccrual" WHERE "collectionEventId" IN
         (SELECT id FROM "CollectionEvent" WHERE "externalRef"=$1)`, [storyId]);
    check("and the original accrual row was not deleted", accruals.length === 1, `${accruals.length}`);
  }

  sub("D10. every approved collection is stamped as a manual finance verification");
  {
    const rows = await q(
      `SELECT DISTINCT "sourceSystem" FROM "CollectionEvent"
        WHERE "opportunityId" IN (SELECT id FROM "Opportunity" WHERE title LIKE '${P}%')`);
    check("there is exactly one source, and it is not SANDBOX",
      rows.length === 1 && rows[0].sourceSystem === "MANUAL_FINANCE_VERIFICATION", S(rows));
  }
}

let exitCode = 0;
try {
  await main();
} catch (e) {
  console.log(`\nFATAL: ${e?.stack ?? e}`);
  exitCode = 1;
} finally {
  await cleanup().catch((e) => console.log(`cleanup warning: ${e.message}`));
  await c.end().catch(() => {});
}

console.log(`\n${"=".repeat(78)}`);
console.log(`  ${results.pass} passed, ${results.fail} failed`);
if (results.fail) {
  console.log("\n  Failures:");
  for (const f of results.failures) console.log(`    - ${f}`);
}
console.log("=".repeat(78));
process.exit(results.fail || exitCode ? 1 : 0);
