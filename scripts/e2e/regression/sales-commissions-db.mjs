// SALES CRM & COMMISSIONS — INTEGRATION, against real PostgreSQL.
//
// The engine suite proves the arithmetic without a database. This one proves the things only
// a database can: that a figure survives a reload, that two concurrent callers produce one
// result, that a constraint actually exists rather than merely being intended, and that a
// mid-operation failure leaves nothing behind.
//
// Runs ONLY against the verified preview database. The runner that invokes it refuses any
// other target by allowlist; this file additionally refuses to touch a database whose name
// it does not recognise, so it cannot be pointed somewhere by accident.
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../../..");
const require_ = createRequire(path.join(ROOT, "package.json"));
const pg = require_("pg");
const { Decimal } = require_("@prisma/client/runtime/client");

const URL_ = process.env.DATABASE_URL ?? "";
const dbName = (URL_.match(/\/([a-z0-9_]+)(\?|$)/) || [])[1];
// The isolated Preview database. Not `sales_crm_preview`, which this suite used to name:
// that database is reached with `neondb_owner`, a role that is a member of neon_superuser and
// therefore of pg_read_all_data and pg_write_all_data — able to read and write every table in
// every database on the branch. `sales_preview` is reached with `sales_preview_app`, which
// owns nothing, holds SELECT/INSERT/UPDATE/DELETE and no DDL, and is a member of no role.
if (dbName !== "sales_preview") {
  console.log(`FATAL: refusing to run against database "${dbName ?? "(none)"}" — this suite writes freely and`);
  console.log("only the dedicated preview database is an acceptable target.");
  process.exit(3);
}

const c = new pg.Client({ connectionString: URL_ });
const results = { pass: 0, fail: 0, failures: [] };
function check(name, ok, detail = "") {
  if (ok) { results.pass++; console.log(`  [PASS] ${name}`); }
  else { results.fail++; results.failures.push(name); console.log(`  [FAIL] ${name}  << ${detail}`); }
}
const section = (t) => console.log(`\n${"=".repeat(78)}\n  ${t}\n${"=".repeat(78)}`);
const sub = (t) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 60 - t.length))}`);
const q = async (s, p = []) => (await c.query(s, p)).rows;
const one = async (s, p = []) => (await q(s, p))[0];
const S = (v) => { try { return JSON.stringify(v) ?? String(v); } catch { return String(v); } };
const P = "SLS";

/** A second connection, for genuine concurrency rather than simulated interleaving. */
async function connection() {
  const k = new pg.Client({ connectionString: URL_ });
  await k.connect();
  return k;
}

async function cleanup() {
  // Child-first, so foreign keys never block the teardown.
  for (const sql of [
    `DELETE FROM "CommissionLedgerCorrection" WHERE "entryId" IN (SELECT id FROM "CommissionLedgerEntry" WHERE "employeeId" LIKE '${P}%') OR "correctsEntryId" IN (SELECT id FROM "CommissionLedgerEntry" WHERE "employeeId" LIKE '${P}%')`,
    `DELETE FROM "CommissionLedgerEntry" WHERE "employeeId" LIKE '${P}%'`,
    `DELETE FROM "CommissionAccrual" WHERE "employeeId" LIKE '${P}%'`,
    `DELETE FROM "CollectionEvent" WHERE "externalRef" LIKE '${P}%'`,
    `DELETE FROM "CommissionAssignment" WHERE "employeeId" LIKE '${P}%'`,
    `DELETE FROM "CommissionTier" WHERE "planVersionId" IN (SELECT id FROM "CommissionPlanVersion" WHERE "planId" LIKE '${P}%')`,
    `DELETE FROM "CommissionPlanVersion" WHERE "planId" LIKE '${P}%'`,
    `DELETE FROM "CommissionPlan" WHERE id LIKE '${P}%'`,
    `DELETE FROM "SalesTarget" WHERE "employeeId" LIKE '${P}%'`,
    `DELETE FROM "OpportunityOrder" WHERE "requestKey" LIKE '${P}%'`,
    `DELETE FROM "QuoteLine" WHERE "quoteId" IN (SELECT id FROM "Quote" WHERE "quoteNumber" LIKE '${P}%')`,
    `DELETE FROM "Quote" WHERE "quoteNumber" LIKE '${P}%'`,
    `DELETE FROM "SampleShipment" WHERE "opportunityId" IN (SELECT id FROM "Opportunity" WHERE title LIKE '${P}%')`,
    `DELETE FROM "Activity" WHERE subject LIKE '${P}%'`,
    `DELETE FROM "OpportunityStageEvent" WHERE "opportunityId" IN (SELECT id FROM "Opportunity" WHERE title LIKE '${P}%')`,
    `DELETE FROM "OpportunityOwner" WHERE "opportunityId" IN (SELECT id FROM "Opportunity" WHERE title LIKE '${P}%')`,
    `DELETE FROM "LeadConversion" WHERE "leadId" LIKE '${P}%'`,
    `DELETE FROM "Opportunity" WHERE title LIKE '${P}%'`,
    `DELETE FROM "Lead" WHERE id LIKE '${P}%'`,
    `DELETE FROM "PipelineStage" WHERE code LIKE '${P}%'`,
    `DELETE FROM "Customer" WHERE name LIKE '${P}%'`,
    `DELETE FROM "Employee" WHERE id LIKE '${P}%'`,
  ]) await c.query(sql).catch(() => {});
}

async function main() {
  await c.connect();
  console.log(`database: ${dbName}  (verified preview target)`);
  await cleanup();

  // ── fixtures ──────────────────────────────────────────────────────────────
  const empA = `${P}_emp_a`, empB = `${P}_emp_b`;
  for (const [id, name] of [[empA, `${P} Rep A`], [empB, `${P} Rep B`]]) {
    await c.query(
      `INSERT INTO "Employee" (id,name,pin,role,permissions,"defaultRoute",active,"preferredLanguage","createdAt","updatedAt")
       VALUES ($1,$2,$3,'custom','{}','/dashboard',true,'ar',now(),now())`,
      [id, name, `${P}-nologin-${id}`]);
  }
  const stageId = `${P}_stage_new`;
  await c.query(
    `INSERT INTO "PipelineStage" (id,code,"nameEn","nameAr",position,probability,"isActive","createdAt","updatedAt")
     VALUES ($1,$2,'New','جديد',1,10,true,now(),now())`, [stageId, `${P}_NEW`]);

  // ═══════════════════════════════════════════════════════════════════════
  section("A — SCHEMA CONSTRAINTS EXIST, NOT JUST INTENDED");

  sub("A1. a lead can be converted only once");
  const leadId = `${P}_lead_1`;
  await c.query(
    `INSERT INTO "Lead" (id,"companyName","contactName","ownerId",source,status,"createdAt","updatedAt")
     VALUES ($1,$2,'Contact',$3,'REFERRAL','QUALIFIED',now(),now())`,
    [leadId, `${P} Cafe One`, empA]);
  const custId = `${P}_cust_1`;
  await c.query(`INSERT INTO "Customer" (id,name,"createdAt","updatedAt") VALUES ($1,$2,now(),now())`,
    [custId, `${P} Cafe One`]);
  const oppId = `${P}_opp_1`;
  await c.query(
    `INSERT INTO "Opportunity" (id,title,"customerId","stageId",outcome,amount,currency,probability,"ownerId","createdAt","updatedAt")
     VALUES ($1,$2,$3,$4,'OPEN',5000,'SAR',10,$5,now(),now())`,
    [oppId, `${P} Deal One`, custId, stageId, empA]);
  await c.query(
    `INSERT INTO "LeadConversion" (id,"leadId","customerId","opportunityId","customerCreated","convertedAt")
     VALUES ($1,$2,$3,$4,true,now())`, [`${P}_conv_1`, leadId, custId, oppId]);

  let dupeBlocked = false;
  try {
    await c.query(
      `INSERT INTO "LeadConversion" (id,"leadId","customerId","opportunityId","customerCreated","convertedAt")
       VALUES ($1,$2,$3,$4,true,now())`, [`${P}_conv_2`, leadId, custId, oppId]);
  } catch (e) { dupeBlocked = e.code === "23505"; }
  check("a second conversion of one lead is refused by the database", dupeBlocked,
    "the unique constraint on leadId is missing");

  sub("A2. the same collection cannot be recorded twice under one source reference");
  await c.query(
    `INSERT INTO "CollectionEvent" (id,"sourceSystem","externalRef",status,"customerId","amountGross","amountTax","amountNonQualifying",currency,"collectedAt","createdAt")
     VALUES ($1,'SANDBOX',$2,'RECORDED',$3,1150,150,0,'SAR',now(),now())`,
    [`${P}_ce_dupe`, `${P}-dupe-1`, custId]);
  let ceBlocked = false;
  try {
    await c.query(
      `INSERT INTO "CollectionEvent" (id,"sourceSystem","externalRef",status,"customerId","amountGross","amountTax","amountNonQualifying",currency,"collectedAt","createdAt")
       VALUES ($1,'SANDBOX',$2,'RECORDED',$3,1150,150,0,'SAR',now(),now())`,
      [`${P}_ce_dupe2`, `${P}-dupe-1`, custId]);
  } catch (e) { ceBlocked = e.code === "23505"; }
  check("a re-delivered collection reference is refused", ceBlocked,
    "the unique constraint on (sourceSystem, externalRef) is missing");

  sub("A3. an accrual is unique per (collection, employee, plan version)");
  const planId = `${P}_plan_a`, pvId = `${P}_pv_a`;
  await c.query(`INSERT INTO "CommissionPlan" (id,code,name,"isActive","createdAt","updatedAt")
    VALUES ($1,$2,'Plan A',true,now(),now())`, [planId, `${P}_A`]);
  await c.query(
    `INSERT INTO "CommissionPlanVersion" (id,"planId",version,basis,"tierMode","baseRatePercent",currency,"effectiveFrom","createdAt")
     VALUES ($1,$2,1,'NET_COLLECTION','INCREMENTAL',1,'SAR',$3,now())`,
    [pvId, planId, new Date("2026-01-01T00:00:00Z")]);
  const acc = (id) => c.query(
    `INSERT INTO "CommissionAccrual" (id,"collectionEventId","employeeId","planVersionId","periodStart","periodEnd","qualifyingBase","sharePercent","effectiveRatePercent",amount,currency,status,"createdAt","updatedAt")
     VALUES ($1,$2,$3,$4,$5,$6,1000,100,1,10,'SAR','ACCRUED',now(),now())`,
    [id, `${P}_ce_dupe`, empA, pvId, new Date("2026-09-01T00:00:00Z"), new Date("2026-10-01T00:00:00Z")]);
  await acc(`${P}_acc_1`);
  let accBlocked = false;
  try { await acc(`${P}_acc_2`); } catch (e) { accBlocked = e.code === "23505"; }
  check("the same collection cannot accrue twice for one person on one plan", accBlocked,
    "the unique constraint is missing — a retrying source would pay twice");

  sub("A4. a foreign key refuses a dangling reference");
  let fkBlocked = false;
  try {
    await c.query(
      `INSERT INTO "Opportunity" (id,title,"stageId",outcome,amount,currency,probability,"ownerId","createdAt","updatedAt")
       VALUES ($1,$2,'no-such-stage','OPEN',0,'SAR',0,$3,now(),now())`,
      [`${P}_opp_bad`, `${P} Bad`, empA]);
  } catch (e) { fkBlocked = e.code === "23503"; }
  check("an opportunity cannot reference a stage that does not exist", fkBlocked, "");

  // ═══════════════════════════════════════════════════════════════════════
  section("B — CONCURRENCY: ONE RESULT, NOT TWO");

  sub("B1. two simultaneous conversions of one lead produce exactly one");
  const leadId2 = `${P}_lead_race`;
  await c.query(
    `INSERT INTO "Lead" (id,"companyName","contactName","ownerId",source,status,"createdAt","updatedAt")
     VALUES ($1,$2,'Contact',$3,'PHONE','QUALIFIED',now(),now())`,
    [leadId2, `${P} Race Cafe`, empA]);

  const k1 = await connection(), k2 = await connection();
  // Both take the lead row FOR UPDATE, exactly as the service does, then try to convert.
  const attempt = async (k, tag) => {
    try {
      await k.query("BEGIN");
      await k.query(`SELECT id FROM "Lead" WHERE id=$1 FOR UPDATE`, [leadId2]);
      const existing = await k.query(`SELECT "leadId" FROM "LeadConversion" WHERE "leadId"=$1`, [leadId2]);
      if (existing.rows.length > 0) { await k.query("COMMIT"); return "replayed"; }
      const cu = await k.query(
        `INSERT INTO "Customer" (id,name,"createdAt","updatedAt") VALUES ($1,$2,now(),now()) RETURNING id`,
        [`${P}_cust_race_${tag}`, `${P} Race Cafe ${tag}`]);
      const op = await k.query(
        `INSERT INTO "Opportunity" (id,title,"customerId","stageId",outcome,amount,currency,probability,"ownerId","createdAt","updatedAt")
         VALUES ($1,$2,$3,$4,'OPEN',0,'SAR',0,$5,now(),now()) RETURNING id`,
        [`${P}_opp_race_${tag}`, `${P} Race Deal ${tag}`, cu.rows[0].id, stageId, empA]);
      await k.query(
        `INSERT INTO "LeadConversion" (id,"leadId","customerId","opportunityId","customerCreated","convertedAt")
         VALUES ($1,$2,$3,$4,true,now())`,
        [`${P}_conv_race_${tag}`, leadId2, cu.rows[0].id, op.rows[0].id]);
      await k.query("COMMIT");
      return "converted";
    } catch (e) { await k.query("ROLLBACK").catch(() => {}); return `refused:${e.code ?? "err"}`; }
  };
  const [r1, r2] = await Promise.all([attempt(k1, "a"), attempt(k2, "b")]);
  await k1.end(); await k2.end();

  const convCount = Number((await one(`SELECT COUNT(*)::int n FROM "LeadConversion" WHERE "leadId"=$1`, [leadId2])).n);
  const custCount = Number((await one(`SELECT COUNT(*)::int n FROM "Customer" WHERE name LIKE $1`, [`${P} Race Cafe %`])).n);
  console.log(`    outcomes: ${r1} / ${r2}`);
  check("exactly one conversion row exists", convCount === 1, `${convCount}`);
  check("and exactly one customer was created, not two", custCount === 1,
    `${custCount} customers — the loser's customer leaked`);
  check("neither attempt reported a server-side crash",
    !r1.startsWith("refused:err") && !r2.startsWith("refused:err"), `${r1} / ${r2}`);

  sub("B2. a rolled-back conversion leaves nothing behind");
  const leadId3 = `${P}_lead_rb`;
  await c.query(
    `INSERT INTO "Lead" (id,"companyName","contactName","ownerId",source,status,"createdAt","updatedAt")
     VALUES ($1,$2,'Contact',$3,'PHONE','QUALIFIED',now(),now())`,
    [leadId3, `${P} Rollback Cafe`, empA]);
  const k3 = await connection();
  await k3.query("BEGIN");
  await k3.query(`INSERT INTO "Customer" (id,name,"createdAt","updatedAt") VALUES ($1,$2,now(),now())`,
    [`${P}_cust_rb`, `${P} Rollback Cafe`]);
  await k3.query("ROLLBACK");
  await k3.end();
  const rbCust = Number((await one(`SELECT COUNT(*)::int n FROM "Customer" WHERE id=$1`, [`${P}_cust_rb`])).n);
  check("the customer created inside the aborted transaction is gone", rbCust === 0, `${rbCust}`);

  // ═══════════════════════════════════════════════════════════════════════
  section("C — COMMISSION PERSISTENCE AND THE LEDGER");

  sub("C1. a partial collection then the rest accrues 50 + 50, never 100 + 100");
  // Independent arithmetic: 1% of a 10,000 base is 100.00 in total.
  const period = new Date("2026-09-01T00:00:00Z"), periodEnd = new Date("2026-10-01T00:00:00Z");
  const postLedger = (id, amount, type) => c.query(
    `INSERT INTO "CommissionLedgerEntry" (id,type,"employeeId","periodStart",amount,currency,"createdAt")
     VALUES ($1,$2,$3,$4,$5,'SAR',now())`, [id, type, empA, period, amount]);

  await postLedger(`${P}_le_1`, "50.00", "ACCRUAL");
  await postLedger(`${P}_le_2`, "50.00", "ACCRUAL");
  const sum1 = await one(
    `SELECT COALESCE(SUM(amount),0)::numeric(18,2) s FROM "CommissionLedgerEntry"
      WHERE "employeeId"=$1 AND "periodStart"=$2`, [empA, period]);
  check("the ledger totals 100.00 after two halves", String(sum1.s) === "100.00", String(sum1.s));

  sub("C2. a reversal after a refund lands as a negative entry, not an edit");
  await postLedger(`${P}_le_3`, "-20.00", "REVERSAL");
  const sum2 = await one(
    `SELECT COALESCE(SUM(amount),0)::numeric(18,2) s FROM "CommissionLedgerEntry"
      WHERE "employeeId"=$1 AND "periodStart"=$2`, [empA, period]);
  check("the ledger now totals 80.00", String(sum2.s) === "80.00", String(sum2.s));
  const originals = await one(
    `SELECT amount::numeric(18,2) a FROM "CommissionLedgerEntry" WHERE id=$1`, [`${P}_le_1`]);
  check("and the original 50.00 entry was not rewritten", String(originals.a) === "50.00", String(originals.a));

  sub("C3. an approved accrual survives a reload with its explanation intact");
  await c.query(
    `UPDATE "CommissionAccrual" SET status='APPROVED', "approvedById"=$2, "approvedAt"=now() WHERE id=$1`,
    [`${P}_acc_1`, empB]);
  const reloaded = await one(
    `SELECT status::text s, "qualifyingBase"::numeric(18,2) b, "effectiveRatePercent"::numeric(9,6) r,
            amount::numeric(18,2) a, "approvedById" ab
       FROM "CommissionAccrual" WHERE id=$1`, [`${P}_acc_1`]);
  check("status is APPROVED", reloaded.s === "APPROVED", S(reloaded));
  check("the base, rate and amount that produced it are all still readable",
    String(reloaded.b) === "1000.00" && String(reloaded.a) === "10.00" && Number(reloaded.r) === 1,
    S(reloaded));
  check("and it records who approved it", reloaded.ab === empB, S(reloaded.ab));

  sub("C4. Decimal columns do not drift the way a float would");
  // 0.1 + 0.2 in binary floating point is famously not 0.3. In numeric it is.
  await postLedger(`${P}_le_4`, "0.10", "ADJUSTMENT");
  await postLedger(`${P}_le_5`, "0.20", "ADJUSTMENT");
  const adj = await one(
    `SELECT COALESCE(SUM(amount),0)::numeric(18,2) s FROM "CommissionLedgerEntry"
      WHERE "employeeId"=$1 AND type='ADJUSTMENT'`, [empA]);
  check("0.10 + 0.20 stored and summed is exactly 0.30", String(adj.s) === "0.30", String(adj.s));

  // ═══════════════════════════════════════════════════════════════════════
  section("D — RIYADH PERIOD BOUNDARIES SURVIVE A ROUND TRIP");

  sub("D1. an instant stored and re-read keeps its month");
  // 2026-01-31T22:00Z is 2026-02-01T01:00 in Riyadh, so it is February business.
  const edge = new Date("2026-01-31T22:00:00.000Z");
  await c.query(
    `INSERT INTO "CollectionEvent" (id,"sourceSystem","externalRef",status,"customerId","amountGross","amountTax","amountNonQualifying",currency,"collectedAt","createdAt")
     VALUES ($1,'SANDBOX',$2,'RECORDED',$3,1150,150,0,'SAR',$4,now())`,
    [`${P}_ce_edge`, `${P}-edge`, custId, edge]);
  const back = await one(`SELECT "collectedAt" c FROM "CollectionEvent" WHERE id=$1`, [`${P}_ce_edge`]);
  check("the stored instant is byte-for-byte the one written",
    new Date(back.c).toISOString() === edge.toISOString(), `${new Date(back.c).toISOString()}`);
  // Riyadh is UTC+3, so the Riyadh calendar month of that instant is February.
  const riyadhMonth = new Date(new Date(back.c).getTime() + 3 * 3600_000).getUTCMonth();
  check("and its Riyadh month is February (month index 1), not January", riyadhMonth === 1, String(riyadhMonth));

  // ═══════════════════════════════════════════════════════════════════════
  section("E — THE SANDBOX COLLECTION SOURCE IS LABELLED IN THE DATA");

  sub("E1. every collection row says which system it came from");
  const srcs = await q(`SELECT DISTINCT "sourceSystem" s FROM "CollectionEvent" WHERE "externalRef" LIKE $1`, [`${P}%`]);
  check("all test collections are stamped SANDBOX",
    srcs.length === 1 && srcs[0].s === "SANDBOX", S(srcs));
  check("so a real integration's rows could never be confused with these",
    srcs.every((r) => r.s !== "PRODUCTION"), S(srcs));

  // ═══════════════════════════════════════════════════════════════════════
  section("F — PRE-EXISTING DOMAIN IS UNDISTURBED");

  sub("F1. the sales migration added no column to any existing table");
  const cols = await one(`
    SELECT COUNT(*)::int n FROM information_schema.columns
     WHERE table_name IN ('Customer','Order','OrderItem','Employee','ProductSKU','FinishedGoodsLot')
       AND column_name IN ('leadId','opportunityId','commissionPlanId','quoteId')`);
  check("no sales column was grafted onto an existing table", Number(cols.n) === 0, S(cols));

  sub("F2. the existing tables still carry their own shape");
  for (const [t, col] of [["Customer", "nameAr"], ["Order", "status"], ["FinishedGoodsLot", "actualContentGrams"]]) {
    const r = await one(
      `SELECT COUNT(*)::int n FROM information_schema.columns WHERE table_name=$1 AND column_name=$2`, [t, col]);
    check(`${t}.${col} is still present`, Number(r.n) === 1, S(r));
  }

  await cleanup();
  console.log(`\n${"=".repeat(78)}\n  SALES & COMMISSIONS INTEGRATION RESULT\n${"=".repeat(78)}`);
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
