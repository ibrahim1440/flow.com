// HOSTED PAYOUT ACCEPTANCE — two synthetic people, one clean and one unresolved.
//
// What this is for
// ────────────────
// The payout gate has two sides that have to be seen TOGETHER on a real deployment: a
// period whose entitlement is fully derivable stays payable, and one that is not is
// refused outright. Reading that off the reviewers' own rows proves only the second half,
// because every reviewer period in this database already carries unattributable history.
// So this makes a clean one.
//
// What it deliberately does NOT do
// ────────────────────────────────
// • It does not touch a reviewer's employee, collection, accrual, movement or payout.
//   Every row it writes is prefixed HACC and every row it writes, it removes.
// • It creates NO usable credentials. Both people get `pinLookup = NULL`, which is the
//   login selector — without it no PIN can reach the account, and the bcrypt hash stored
//   in `pin` is over random bytes nobody has seen. They exist to be paid, not to sign in.
// • It writes no accrual, no movement and no payout itself. The commission history is
//   built by the APPLICATION, through the sandbox-collections endpoint, so the provenance
//   under test is provenance the engine actually wrote — not something staged to look
//   like it. The one exception is `residue`, below, which is the point of the exercise.
//
// Usage, always through the preview guard so it cannot reach another database:
//
//   ... payout-acceptance-fixture.mjs up                provision the people and their deals
//   ... payout-acceptance-fixture.mjs add-clean <sfx>  one more clean person, purging nothing
//   ... payout-acceptance-fixture.mjs residue   make the second person's period underivable
//   ... payout-acceptance-fixture.mjs report    what exists right now
//   ... payout-acceptance-fixture.mjs disable   retire the identities, KEEP every financial row
//   ... payout-acceptance-fixture.mjs purge     destructive full removal (see below)
//
// `residue` adds the two unattributable movements that make the second person's period
// underivable — a +9.00 and a -9.00 whose signed sum is exactly zero, which is the shape a
// signed-sum completeness check cannot see.
//
// ── disable, not delete ──
//
// `disable` is how an acceptance run ends. It sets `active = false` on the two identities
// and touches nothing else: every accrual, movement, correction and payout stays exactly
// where it is, readable, with its actor and timestamp intact. A synthetic payment is still
// a payment somebody recorded, and deleting the trail afterwards would mean the evidence
// for an acceptance no longer exists once the acceptance is over. The identities are
// retired instead; they could never sign in anyway.
//
// `purge` is the destructive one and exists only to reset before a NEW run. `up` refuses
// to start on top of existing financial rows rather than quietly erasing them, so purging
// is always something a person chose to do.
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../..");
const require_ = createRequire(path.join(ROOT, "package.json"));
const pg = require_("pg");
const bcrypt = require_("bcryptjs");

const URL_ = process.env.DATABASE_URL ?? "";
const dbName = (URL_.match(/\/([a-z0-9_]+)(\?|$)/) || [])[1];
// The same refusal every other script in this directory makes. A fixture that can reach a
// real database is not a fixture.
if (dbName !== "sales_preview") {
  console.error(`REFUSE: this fixture only runs against sales_preview, not "${dbName ?? "(none)"}".`);
  process.exit(3);
}

const P = "HACC";
const PLAN = `${P}_plan`;
const PV = `${P}_pv`;
const CUST = `${P}_cust`;
const PEOPLE = [
  { id: `${P}_clean`, name: `${P} Clean Rep (hosted acceptance)`, opp: `${P}_opp_clean` },
  { id: `${P}_unres`, name: `${P} Unresolved Rep (hosted acceptance)`, opp: `${P}_opp_unres` },
];
const RESIDUE = [`${P}_residue_pos`, `${P}_residue_neg`];

const c = new pg.Client({ connectionString: URL_ });
await c.connect();
const q = async (s, p = []) => (await c.query(s, p)).rows;

/** Destructive. Only for resetting before a new run — see the header. */
async function purge() {
  for (const sql of [
    `DELETE FROM "CommissionLedgerCorrection" WHERE "entryId" IN (SELECT id FROM "CommissionLedgerEntry" WHERE "employeeId" LIKE '${P}%')
        OR "correctsEntryId" IN (SELECT id FROM "CommissionLedgerEntry" WHERE "employeeId" LIKE '${P}%')`,
    `DELETE FROM "CommissionLedgerEntry" WHERE "employeeId" LIKE '${P}%'`,
    `DELETE FROM "CommissionAccrual" WHERE "employeeId" LIKE '${P}%'`,
    `DELETE FROM "CollectionEvent" WHERE "externalRef" LIKE '${P}%'`,
    `DELETE FROM "CommissionAssignment" WHERE "employeeId" LIKE '${P}%'`,
    `DELETE FROM "CommissionPlanVersion" WHERE "planId" LIKE '${P}%'`,
    `DELETE FROM "CommissionPlan" WHERE id LIKE '${P}%'`,
    `DELETE FROM "OpportunityOwner" WHERE "opportunityId" LIKE '${P}%'`,
    `DELETE FROM "OpportunityStageEvent" WHERE "opportunityId" LIKE '${P}%'`,
    `DELETE FROM "Opportunity" WHERE id LIKE '${P}%'`,
    `DELETE FROM "Customer" WHERE id LIKE '${P}%'`,
    `DELETE FROM "Employee" WHERE id LIKE '${P}%'`,
  ]) {
    await c.query(sql).catch((e) => console.error(`  (left in place) ${e.message.slice(0, 100)}`));
  }
}

async function up() {
  // A previous run's financial rows are evidence. Refuse rather than erase them; purging
  // is a decision somebody makes on purpose.
  const existing = (await q(
    `SELECT count(*)::int n FROM "CommissionLedgerEntry" WHERE "employeeId" LIKE '${P}%'`))[0];
  if (existing.n > 0) {
    console.error(`REFUSE: ${existing.n} ${P} ledger rows already exist from an earlier run.`);
    console.error("Run `report` to see them, or `purge` to remove them deliberately.");
    process.exit(2);
  }
  await purge();

  const stage = (await q(`SELECT id FROM "PipelineStage" ORDER BY "position" LIMIT 1`))[0];
  if (!stage) throw new Error("no pipeline stage exists to hang a deal from");

  for (const p of PEOPLE) {
    // No `pinLookup`, so there is no selector any PIN can resolve to, and the bcrypt hash
    // is over bytes that exist only for the length of this statement. Nobody can sign in
    // as these two, including whoever runs this script.
    await c.query(
      `INSERT INTO "Employee" (id,name,pin,"pinLookup",role,permissions,"defaultRoute",active,"preferredLanguage","createdAt","updatedAt")
       VALUES ($1,$2,$3,NULL,'custom',$4,'/dashboard',true,'en',now(),now())`,
      [
        p.id, p.name,
        bcrypt.hashSync(crypto.randomBytes(32).toString("base64"), 10),
        JSON.stringify({
          dashboard: { access: "edit" },
          commissions: { access: "view", sub: { view_own: true } },
        }),
      ],
    );
  }

  await c.query(
    `INSERT INTO "CommissionPlan" (id,code,name,"isActive","createdAt","updatedAt")
     VALUES ($1,$2,'Hosted acceptance 1%',true,now(),now())`, [PLAN, `${P}_PLAN`]);
  // Flat 1% of the net collection. No tiers, so every figure below is one multiplication
  // and can be checked by hand rather than taken from the engine.
  await c.query(
    `INSERT INTO "CommissionPlanVersion" (id,"planId",version,basis,"tierMode","baseRatePercent",currency,"effectiveFrom","createdAt")
     VALUES ($1,$2,1,'NET_COLLECTION','INCREMENTAL',1,'SAR',$3,now())`,
    [PV, PLAN, new Date("2026-01-01T00:00:00Z")]);

  await c.query(`INSERT INTO "Customer" (id,name,"createdAt","updatedAt") VALUES ($1,$2,now(),now())`,
    [CUST, `${P} Acceptance Customer`]);

  for (const p of PEOPLE) {
    await c.query(
      `INSERT INTO "CommissionAssignment" (id,"employeeId","planId","planVersionId","effectiveFrom","createdAt")
       VALUES ($1,$2,$3,$4,$5,now())`,
      [`${P}_asg_${p.id}`, p.id, PLAN, PV, new Date("2026-01-01T00:00:00Z")]);
    // The deal is what carries attribution: a sandbox collection reaches an employee
    // through its opportunity's owner, which is the only link the engine will follow.
    await c.query(
      `INSERT INTO "Opportunity" (id,title,"customerId","stageId",outcome,amount,currency,probability,"ownerId","createdAt","updatedAt")
       VALUES ($1,$2,$3,$4,'OPEN',1150,'SAR',50,$5,now(),now())`,
      [p.opp, `${P} Acceptance deal — ${p.id}`, CUST, stage.id, p.id]);
  }

  console.log("HACC fixture provisioned. No usable credentials were created.");
  for (const p of PEOPLE) console.log(`  ${p.id.padEnd(12)} deal ${p.opp}`);
  console.log("\nRecord the collections through the running application, as an identity holding");
  console.log("`sandbox_collections`, so the engine writes the provenance under test:");
  for (const p of PEOPLE) {
    console.log(`  POST /api/commissions/sandbox-collections  { externalRef: "${P}-${p.id}-1", opportunityId: "${p.opp}", amountGross: 1150, amountTax: 150 }`);
  }
  console.log("\nEach is net 1000.00 at 1%, so 10.00 of commission, worked from the plan.");
}

/**
 * The two movements that make a period underivable, and the reason this case exists.
 *
 * They belong to no accrual, and their signed sum is exactly 0.00. A completeness check
 * built on that sum reports a healthy period while two movements sit unexplained beside
 * a positive entitlement that looks perfectly payable. Counts and magnitudes cannot
 * cancel, which is why the gate reads those instead.
 */
async function residue() {
  const target = PEOPLE[1].id;
  const accrual = (await q(
    `SELECT "periodStart" FROM "CommissionAccrual" WHERE "employeeId"=$1 LIMIT 1`, [target]))[0];
  if (!accrual) {
    console.error(`REFUSE: ${target} has no accrual yet — record their collection through the app first.`);
    process.exit(2);
  }
  for (const [id, type, amount] of [[RESIDUE[0], "ACCRUAL", "9.00"], [RESIDUE[1], "REVERSAL", "-9.00"]]) {
    await c.query(
      `INSERT INTO "CommissionLedgerEntry" (id,type,"employeeId","periodStart",amount,currency,reason,"createdAt")
       SELECT $1,$2::"LedgerEntryType",$3,a."periodStart",$4,'SAR',
              'HACC hosted acceptance: unattributable movement, removed with the fixture',now()
         FROM "CommissionAccrual" a WHERE a."employeeId"=$3 LIMIT 1`,
      [id, type, target, amount]);
  }
  console.log(`residue added to ${target}: +9.00 and -9.00, signed net 0.00, two movements unplaced`);
}

async function report() {
  console.table(await q(
    `SELECT e.id,
            count(l.*) FILTER (WHERE l.type IN ('ACCRUAL','REVERSAL'))                        AS movements,
            count(l.*) FILTER (WHERE l.type IN ('ACCRUAL','REVERSAL') AND l."accrualId" IS NULL) AS unplaced,
            count(l.*) FILTER (WHERE l.type = 'PAYOUT')                                       AS payouts,
            COALESCE(SUM(l.amount) FILTER (WHERE l.type = 'PAYOUT'), 0)::text                 AS paid
       FROM "Employee" e
       LEFT JOIN "CommissionLedgerEntry" l ON l."employeeId" = e.id
      WHERE e.id LIKE '${P}%'
      GROUP BY e.id ORDER BY e.id`));
  console.table(await q(
    `SELECT a."employeeId", a.status::text, a.amount::text, to_char(a."periodStart" + interval '3 hours','YYYY-MM') AS riyadh_month
       FROM "CommissionAccrual" a WHERE a."employeeId" LIKE '${P}%' ORDER BY a."employeeId"`));
}

/**
 * One more clean person on the same plan, added WITHOUT purging anything.
 *
 * A re-acceptance on a later candidate needs a period nobody has spent yet, and the
 * obvious shortcut — reset the fixture — would destroy the evidence from the previous
 * run. So this adds rather than resets. The suffix goes in the id and the deal, so which
 * candidate a person was made for stays readable afterwards.
 */
async function addClean(suffix) {
  if (!/^[a-z0-9]{1,12}$/.test(suffix ?? "")) {
    console.error("REFUSE: add-clean needs a short lowercase suffix, e.g. `add-clean ed201dd`");
    process.exit(2);
  }
  const id = `${P}_clean_${suffix}`;
  const opp = `${P}_opp_clean_${suffix}`;
  if ((await q(`SELECT 1 FROM "Employee" WHERE id=$1`, [id])).length) {
    console.error(`REFUSE: ${id} already exists. Pick another suffix rather than reusing a spent period.`);
    process.exit(2);
  }
  const stage = (await q(`SELECT id FROM "PipelineStage" ORDER BY "position" LIMIT 1`))[0];
  await c.query(
    `INSERT INTO "Employee" (id,name,pin,"pinLookup",role,permissions,"defaultRoute",active,"preferredLanguage","createdAt","updatedAt")
     VALUES ($1,$2,$3,NULL,'custom',$4,'/dashboard',true,'en',now(),now())`,
    [id, `${P} Clean Rep ${suffix} (hosted acceptance)`,
     bcrypt.hashSync(crypto.randomBytes(32).toString("base64"), 10),
     JSON.stringify({ dashboard: { access: "edit" }, commissions: { access: "view", sub: { view_own: true } } })]);
  await c.query(
    `INSERT INTO "CommissionAssignment" (id,"employeeId","planId","planVersionId","effectiveFrom","createdAt")
     VALUES ($1,$2,$3,$4,$5,now())`,
    [`${P}_asg_${id}`, id, PLAN, PV, new Date("2026-01-01T00:00:00Z")]);
  await c.query(
    `INSERT INTO "Opportunity" (id,title,"customerId","stageId",outcome,amount,currency,probability,"ownerId","createdAt","updatedAt")
     VALUES ($1,$2,$3,$4,'OPEN',1150,'SAR',50,$5,now(),now())`,
    [opp, `${P} Acceptance deal — ${id}`, CUST, stage.id, id]);
  console.log(`${id} provisioned (no usable credentials). Record its collection through the app:`);
  console.log(`  POST /api/commissions/sandbox-collections  { externalRef: "${P}-${id}-1", opportunityId: "${opp}", amountGross: 1150, amountTax: 150 }`);
  console.log("  net 1000.00 at 1% = 10.00 of commission, worked from the plan.");
}

/**
 * Retire the identities and keep every financial record they were involved in.
 *
 * `active = false` is what the login and the permission checks read, so a disabled
 * identity cannot act — and these two never could, having no `pinLookup`. What matters is
 * the other half: the accruals, movements, corrections and payouts stay untouched, so the
 * acceptance run remains auditable after the acceptance is over.
 */
async function disable() {
  const res = await c.query(
    `UPDATE "Employee" SET active = false, "updatedAt" = now() WHERE id LIKE '${P}%' AND active`);
  const kept = (await q(
    `SELECT count(*)::int n FROM "CommissionLedgerEntry" WHERE "employeeId" LIKE '${P}%'`))[0];
  const acc = (await q(
    `SELECT count(*)::int n FROM "CommissionAccrual" WHERE "employeeId" LIKE '${P}%'`))[0];
  console.log(`${res.rowCount} identity(ies) retired. Financial records kept: ${kept.n} movements, ${acc.n} accruals.`);
}

const mode = process.argv[2] ?? "report";
try {
  if (mode === "up") await up();
  else if (mode === "add-clean") await addClean(process.argv[3]);
  else if (mode === "residue") await residue();
  else if (mode === "report") await report();
  else if (mode === "disable") await disable();
  else if (mode === "purge") { await purge(); console.log("HACC fixture purged, including its financial rows."); }
  else {
    console.error(`unknown mode "${mode}" — expected up, add-clean, residue, report, disable or purge`);
    process.exitCode = 2;
  }
} finally {
  await c.end();
}
