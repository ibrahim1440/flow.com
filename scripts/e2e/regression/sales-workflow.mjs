// SALES CRM & COMMISSIONS — THE WORKFLOWS, through the real HTTP API.
//
// The engine and quotes suites prove the arithmetic with no database. The security suite
// proves what is refused. This one proves the ordinary path actually works end to end: a
// lead becomes a deal, the deal gets a quotation, the quotation becomes an order, the money
// comes in, and somebody is paid the right amount for it — with the persisted rows checked
// after every step rather than the response believed.
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
if (dbName !== "sales_crm_preview") {
  console.log(`FATAL: refusing to run against database "${dbName ?? "(none)"}" — this suite writes freely.`);
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
const one = async (s, p = []) => (await q(s, p))[0];
const P = "WFL";

const pinLookup = (pin) =>
  crypto.createHmac("sha256", SECRET).update("pin:lookup:v1:" + pin).digest("base64");
const pinVerifier = (pin) =>
  crypto.createHmac("sha384", SECRET).update("pin:verify:v1:" + pin).digest("base64");

let cookies = {};
async function api(pathname, opts = {}) {
  const jar = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join("; ");
  const res = await fetch(BASE + pathname, {
    method: opts.method ?? "GET",
    headers: { "Content-Type": "application/json", ...(jar ? { Cookie: jar } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    redirect: "manual",
  });
  for (const sc of res.headers.getSetCookie?.() ?? []) {
    const [pair] = sc.split(";");
    const i = pair.indexOf("=");
    if (i > 0) cookies[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
  }
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, json, text };
}
const logout = () => { cookies = {}; };
async function loginAs(pin) {
  logout();
  const r = await api("/api/auth/login", { method: "POST", body: { method: "pin", pin } });
  if (r.status !== 200) throw new Error(`login failed ${r.status} ${S(r.json).slice(0, 160)}`);
}

// ── Roles ────────────────────────────────────────────────────────────────────
// Built from the application's own privilege list, so a typo becomes a missing key rather
// than a silently weaker role that makes the test pass for the wrong reason.
const mod = await import(`file://${path.join(ROOT, ".test-build/lib/auth-shared.js")}`).catch(() => null);
const SUBS = mod?.MODULE_SUB_PRIVILEGES ?? null;
const subsFor = (m, keys) =>
  SUBS
    ? Object.fromEntries((SUBS[m] ?? []).map((s) => [s.key, keys === "all" ? true : keys.includes(s.key)]))
    : Object.fromEntries((keys === "all" ? [] : keys).map((k) => [k, true]));

const REP = "930101";
const MANAGER = "930202";
const FINANCE = "930303";

async function mkEmployee(id, name, pin, permissions) {
  await c.query(`DELETE FROM "Employee" WHERE id=$1`, [id]);
  await c.query(
    `INSERT INTO "Employee" (id,name,pin,"pinLookup",role,permissions,"defaultRoute",active,"preferredLanguage","createdAt","updatedAt")
     VALUES ($1,$2,$3,$4,'custom',$5,'/dashboard',true,'en',now(),now())`,
    [id, name, bcrypt.hashSync(pinVerifier(pin), 10), pinLookup(pin), JSON.stringify(permissions)]);
}

async function cleanup() {
  const like = `${P}%`;
  for (const sql of [
    `DELETE FROM "CommissionLedgerEntry" WHERE "employeeId" LIKE '${P}%'`,
    `DELETE FROM "CommissionAccrual" WHERE "employeeId" LIKE '${P}%'`,
    `DELETE FROM "CollectionEvent" WHERE "externalRef" LIKE '${P}%'`,
    `DELETE FROM "CommissionAssignment" WHERE "employeeId" LIKE '${P}%'`,
    `DELETE FROM "CommissionTier" WHERE "planVersionId" IN (SELECT id FROM "CommissionPlanVersion" WHERE "planId" IN (SELECT id FROM "CommissionPlan" WHERE code LIKE '${P}%'))`,
    `DELETE FROM "CommissionPlanVersion" WHERE "planId" IN (SELECT id FROM "CommissionPlan" WHERE code LIKE '${P}%')`,
    `DELETE FROM "CommissionPlan" WHERE code LIKE '${P}%'`,
    `DELETE FROM "SalesTarget" WHERE "employeeId" LIKE '${P}%'`,
    // The order chain the quote-to-order path creates.
    `DELETE FROM "OpportunityOrder" WHERE "opportunityId" IN (SELECT id FROM "Opportunity" WHERE title LIKE '${P}%')`,
    `DELETE FROM "OrderItem" WHERE "orderId" IN (SELECT id FROM "Order" WHERE "quotationNumber" LIKE '${P}%' OR "customerId" IN (SELECT id FROM "Customer" WHERE name LIKE '${P}%'))`,
    `DELETE FROM "OrderActivity" WHERE "orderId" IN (SELECT id FROM "Order" WHERE "customerId" IN (SELECT id FROM "Customer" WHERE name LIKE '${P}%'))`,
    `DELETE FROM "Order" WHERE "customerId" IN (SELECT id FROM "Customer" WHERE name LIKE '${P}%')`,
    `DELETE FROM "QuoteLine" WHERE "quoteId" IN (SELECT id FROM "Quote" WHERE "opportunityId" IN (SELECT id FROM "Opportunity" WHERE title LIKE '${P}%'))`,
    // Revision chains point at each other, so break the link before deleting.
    `UPDATE "Quote" SET "supersedesId" = NULL WHERE "opportunityId" IN (SELECT id FROM "Opportunity" WHERE title LIKE '${P}%')`,
    `DELETE FROM "Quote" WHERE "opportunityId" IN (SELECT id FROM "Opportunity" WHERE title LIKE '${P}%')`,
    `DELETE FROM "SampleShipment" WHERE "opportunityId" IN (SELECT id FROM "Opportunity" WHERE title LIKE '${P}%')`,
    `DELETE FROM "Activity" WHERE "ownerId" LIKE '${P}%' OR subject LIKE '${P}%' OR "opportunityId" IN (SELECT id FROM "Opportunity" WHERE title LIKE '${P}%')`,
    `DELETE FROM "OpportunityStageEvent" WHERE "opportunityId" IN (SELECT id FROM "Opportunity" WHERE title LIKE '${P}%')`,
    `DELETE FROM "OpportunityOwner" WHERE "opportunityId" IN (SELECT id FROM "Opportunity" WHERE title LIKE '${P}%')`,
    `DELETE FROM "LeadConversion" WHERE "leadId" IN (SELECT id FROM "Lead" WHERE "companyName" LIKE '${P}%')`,
    `DELETE FROM "Opportunity" WHERE title LIKE '${P}%'`,
    `DELETE FROM "Lead" WHERE "companyName" LIKE '${P}%' OR "ownerId" LIKE '${P}%'`,
    `DELETE FROM "PipelineStage" WHERE code LIKE '${P}%'`,
    `DELETE FROM "BomComponent" WHERE "productSkuId" IN (SELECT id FROM "ProductSKU" WHERE "skuCode" LIKE '${P}%')`,
    `DELETE FROM "ProductSKU" WHERE "skuCode" LIKE '${P}%'`,
    `DELETE FROM "CoffeeProduct" WHERE id LIKE '${P}%'`,
    `DELETE FROM "Customer" WHERE name LIKE '${P}%'`,
    `DELETE FROM "Employee" WHERE id LIKE '${P}%'`,
  ]) {
    // A foreign-key failure is re-thrown rather than swallowed: a teardown that quietly
    // leaves rows behind is how the next run fails for a reason that has nothing to do
    // with the change under test.
    await c.query(sql).catch((e) => { if (e.code === "23503") throw e; });
  }
  void like;
}

// ── Fixtures ─────────────────────────────────────────────────────────────────
const ids = {};
async function fixtures() {
  await mkEmployee(`${P}_rep`, `${P} Rep`, REP, {
    dashboard: { access: "edit" },
    sales: { access: "edit", sub: subsFor("sales", ["lead_write", "lead_convert", "quote_write", "lead_import", "lead_export"]) },
    commissions: { access: "view", sub: subsFor("commissions", ["view_own"]) },
    orders: { access: "edit", sub: subsFor("orders", ["create"]) },
  });
  await mkEmployee(`${P}_mgr`, `${P} Manager`, MANAGER, {
    dashboard: { access: "edit" },
    sales: { access: "edit", sub: subsFor("sales", "all") },
    commissions: { access: "edit", sub: subsFor("commissions", ["view_own", "view_team", "manage_plans", "sandbox_collections"]) },
    orders: { access: "edit", sub: subsFor("orders", ["create"]) },
    inventory: { access: "view", sub: subsFor("inventory", []) },
  });
  await mkEmployee(`${P}_fin`, `${P} Finance`, FINANCE, {
    dashboard: { access: "edit" },
    commissions: { access: "edit", sub: subsFor("commissions", ["view_own", "view_team", "approve", "record_payout"]) },
  });

  // Pipeline stages — configuration, not constants.
  for (const [i, [code, en, ar]] of [
    ["NEW", "New", "جديد"],
    ["QUALIFY", "Qualifying", "تأهيل"],
    ["PROPOSAL", "Proposal", "عرض سعر"],
  ].entries()) {
    await c.query(
      `INSERT INTO "PipelineStage" (id,code,"nameEn","nameAr",position,probability,"isActive","createdAt","updatedAt")
       VALUES ($1,$2,$3,$4,$5,$6,true,now(),now())
       ON CONFLICT (code) DO NOTHING`,
      [`${P}_stage_${code}`, `${P}_${code}`, en, ar, (i + 1) * 10, (i + 1) * 25]);
  }
  ids.stageNew = `${P}_stage_NEW`;
  ids.stageProposal = `${P}_stage_PROPOSAL`;

  // A sellable product for the quotation lines and the order they become.
  await c.query(
    `INSERT INTO "CoffeeProduct" (id,"productNameEn","countryEn","expectedRoastLoss","createdAt","updatedAt")
     VALUES ($1,$2,'Yemen',16,now(),now()) ON CONFLICT (id) DO NOTHING`,
    [`${P}_coffee`, `${P} Haraz`]);
  const sku = await one(
    `INSERT INTO "ProductSKU" (id,"productId","skuCode","weightGrams","isBulk",price,name,category,"unitOfMeasure","isActive","createdAt","updatedAt")
     VALUES ($1,$2,$3,1000,false,110,$4,'ROASTED_COFFEE','UNIT',true,now(),now())
     ON CONFLICT ("skuCode") DO UPDATE SET "isActive" = true RETURNING id`,
    [`${P}_sku`, `${P}_coffee`, `${P}-HAR-1KG`, `${P} Haraz 1 KG`]);
  ids.skuId = sku.id;

  const cust = await one(
    `INSERT INTO "Customer" (id,name,"createdAt","updatedAt") VALUES ($1,$2,now(),now())
     ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
    [`${P}_cust`, `${P} Existing Cafe`]);
  ids.customerId = cust.id;
}

/** The current Riyadh month, as the API's `month` parameter wants it. */
function riyadhMonth(d = new Date()) {
  const r = new Date(d.getTime() + 3 * 3600_000);
  return `${r.getUTCFullYear()}-${String(r.getUTCMonth() + 1).padStart(2, "0")}`;
}
/**
 * A collection date on a given day of the current Riyadh month.
 *
 * Distinct days matter: a split takes effect from its own date, so testing that the history
 * is NOT re-pointed needs payments on either side of it. With every payment sharing one
 * timestamp the split applied to all of them and the test proved the opposite of what it
 * claimed to.
 */
function dayOfMonthISO(day) {
  const r = new Date(Date.now() + 3 * 3600_000);
  return new Date(Date.UTC(r.getUTCFullYear(), r.getUTCMonth(), day, 9, 0, 0)).toISOString();
}

async function main() {
  await c.connect();
  await cleanup();
  await fixtures();

  // ═════════════════════════════════════════════════════════════════════════
  section("A — LEAD TO DEAL");

  await loginAs(REP);

  sub("A1. a rep creates a lead and it is theirs");
  const leadRes = await api("/api/sales/leads", {
    method: "POST",
    body: {
      companyName: `${P} Aroma Roasters`, contactName: "Sara Ahmed",
      phone: "0501110001", city: "Jeddah", source: "REFERRAL",
    },
  });
  check("created", leadRes.status === 201, S(leadRes.json).slice(0, 200));
  ids.leadId = leadRes.json?.lead?.id;
  {
    const row = await one(`SELECT "ownerId", status, "normalizedPhone" FROM "Lead" WHERE id=$1`, [ids.leadId]);
    check("owned by the rep who created it, not by whoever the body named", row?.ownerid ?? row?.ownerId, "");
    check("owner is the rep", (row?.ownerId ?? row?.ownerid) === `${P}_rep`, S(row));
    check("the duplicate key was normalised to the last nine digits",
      (row?.normalizedPhone ?? row?.normalizedphone) === "501110001", S(row));
  }

  sub("A2. the same phone in a different format is reported as a duplicate");
  {
    const dup = await api("/api/sales/leads", {
      method: "POST",
      body: { companyName: `${P} Aroma Branch Two`, contactName: "Khalid", phone: "+966 50 111 0001" },
    });
    check("refused with 409", dup.status === 409, S(dup.json).slice(0, 200));
    check("and the existing lead is named", dup.json?.duplicates?.[0]?.leadId === ids.leadId, S(dup.json?.duplicates));
    const n = await one(`SELECT COUNT(*)::int n FROM "Lead" WHERE "companyName" = $1`, [`${P} Aroma Branch Two`]);
    check("nothing was created", n.n === 0, S(n));
  }

  sub("A3. acknowledged, it is created — the operator decides, not the system");
  {
    const dup = await api("/api/sales/leads", {
      method: "POST",
      body: {
        companyName: `${P} Aroma Branch Two`, contactName: "Khalid",
        phone: "+966 50 111 0001", acknowledgeDuplicate: true,
      },
    });
    check("created", dup.status === 201, S(dup.json).slice(0, 200));
    check("and nothing was merged: both leads exist",
      (await one(`SELECT COUNT(*)::int n FROM "Lead" WHERE "normalizedPhone"='501110001'`)).n === 2, "");
  }

  sub("A4. the lead can be edited, and the duplicate key follows the edit");
  {
    const r = await api(`/api/sales/leads/${ids.leadId}`, {
      method: "PATCH",
      body: { phone: "0509990009", status: "QUALIFIED" },
    });
    check("updated", r.status === 200, S(r.json).slice(0, 200));
    const row = await one(`SELECT status, "normalizedPhone" FROM "Lead" WHERE id=$1`, [ids.leadId]);
    check("status is QUALIFIED in the row", row.status === "QUALIFIED", S(row));
    check("and the normalised phone was recomputed, not left stale",
      row.normalizedPhone === "509990009", S(row));
  }

  sub("A5. conversion creates one customer and one deal, and is idempotent");
  {
    const r1 = await api(`/api/sales/leads/${ids.leadId}/convert`, {
      method: "POST", body: { stageId: ids.stageNew, title: `${P} Aroma annual supply` },
    });
    check("converted", r1.status === 200 || r1.status === 201, S(r1.json).slice(0, 200));
    ids.opportunityId = r1.json?.conversion?.opportunityId ?? r1.json?.opportunityId;
    check("an opportunity id came back", !!ids.opportunityId, S(r1.json).slice(0, 200));

    const r2 = await api(`/api/sales/leads/${ids.leadId}/convert`, { method: "POST", body: {} });
    check("the second call replays rather than converting again",
      (r2.json?.replayed ?? r2.json?.conversion?.replayed) === true, S(r2.json).slice(0, 200));

    const n = await one(`SELECT COUNT(*)::int n FROM "LeadConversion" WHERE "leadId"=$1`, [ids.leadId]);
    check("exactly one conversion row", n.n === 1, S(n));
    const lead = await one(`SELECT status FROM "Lead" WHERE id=$1`, [ids.leadId]);
    check("the lead now reads CONVERTED", lead.status === "CONVERTED", S(lead));
  }

  sub("A6. a converted lead is read-only");
  {
    const r = await api(`/api/sales/leads/${ids.leadId}`, { method: "PATCH", body: { city: "Riyadh" } });
    check("refused with 409", r.status === 409, S(r.json).slice(0, 200));
    const row = await one(`SELECT city FROM "Lead" WHERE id=$1`, [ids.leadId]);
    check("and the row is unchanged", row.city === "Jeddah", S(row));
  }

  // ═════════════════════════════════════════════════════════════════════════
  section("B — ACTIVITIES AND SAMPLES");

  sub("B1. logging a call, and completing a task");
  {
    const call = await api("/api/sales/activities", {
      method: "POST",
      body: { type: "CALL", subject: `${P} intro call`, opportunityId: ids.opportunityId, completed: true },
    });
    check("the call is logged", call.status === 201, S(call.json).slice(0, 200));
    const row = await one(`SELECT "completedAt","ownerId" FROM "Activity" WHERE id=$1`, [call.json.activity.id]);
    check("recorded as already done", row.completedAt !== null, S(row));
    check("and owned by the caller, never by the body", row.ownerId === `${P}_rep`, S(row));

    const noDate = await api("/api/sales/activities", {
      method: "POST",
      body: { type: "TASK", subject: `${P} chase`, opportunityId: ids.opportunityId },
    });
    check("a task with no due date is refused — it would never appear on an overdue list",
      noDate.status === 400, S(noDate.json).slice(0, 160));

    const task = await api("/api/sales/activities", {
      method: "POST",
      body: {
        type: "TASK", subject: `${P} send proposal`, opportunityId: ids.opportunityId,
        dueAt: new Date(Date.now() - 86400_000).toISOString(),
      },
    });
    check("a task with one is created", task.status === 201, S(task.json).slice(0, 160));
    ids.taskId = task.json.activity.id;

    const overdue = await api("/api/sales/activities?filter=overdue");
    check("and it shows on the overdue list",
      overdue.json.rows.some((a) => a.id === ids.taskId), S(overdue.json.counts));

    const done = await api(`/api/sales/activities/${ids.taskId}`, { method: "PATCH", body: { completed: true } });
    check("completing it succeeds", done.status === 200, S(done.json).slice(0, 160));
    const first = (await one(`SELECT "completedAt" FROM "Activity" WHERE id=$1`, [ids.taskId])).completedAt;

    await api(`/api/sales/activities/${ids.taskId}`, { method: "PATCH", body: { completed: true } });
    const second = (await one(`SELECT "completedAt" FROM "Activity" WHERE id=$1`, [ids.taskId])).completedAt;
    check("completing twice keeps the ORIGINAL timestamp, so 'when did you visit' stays answerable",
      String(first) === String(second), `${first} vs ${second}`);

    const del = await api(`/api/sales/activities/${ids.taskId}`, { method: "DELETE" });
    check("and a completed activity cannot be deleted", del.status === 409, S(del.json).slice(0, 160));
  }

  sub("B2. a sample is recorded, and it does NOT move stock");
  {
    const before = await one(
      `SELECT COUNT(*)::int n FROM "InventoryMovement" WHERE "referenceEntityId" = $1`, [ids.skuId]);
    const s = await api("/api/sales/samples", {
      method: "POST",
      body: { opportunityId: ids.opportunityId, productSkuId: ids.skuId, quantity: "0.25", unit: "KG", status: "SENT" },
    });
    check("recorded", s.status === 201, S(s.json).slice(0, 200));
    check("and the response says plainly that stock did not move",
      /does not move stock/i.test(s.json?.notice ?? ""), S(s.json?.notice));

    const after = await one(
      `SELECT COUNT(*)::int n FROM "InventoryMovement" WHERE "referenceEntityId" = $1`, [ids.skuId]);
    check("no inventory movement was written", after.n === before.n, `${before.n} → ${after.n}`);

    const follow = await one(
      `SELECT COUNT(*)::int n FROM "Activity" WHERE "opportunityId"=$1 AND type='SAMPLE_FOLLOW_UP'`,
      [ids.opportunityId]);
    check("a follow-up task was scheduled with it", follow.n === 1, S(follow));

    const back = await api(`/api/sales/samples/${s.json.sample.id}`, {
      method: "PATCH", body: { status: "FEEDBACK_RECEIVED", feedbackScore: 4, feedbackNotes: "liked it" },
    });
    check("feedback is recorded", back.status === 200, S(back.json).slice(0, 160));

    const early = await api("/api/sales/samples", {
      method: "POST",
      body: { opportunityId: ids.opportunityId, description: `${P} second sample`, quantity: "0.2" },
    });
    const score = await api(`/api/sales/samples/${early.json.sample.id}`, {
      method: "PATCH", body: { feedbackScore: 5 },
    });
    check("a score on a sample that was never sent is refused", score.status === 409, S(score.json).slice(0, 160));
  }

  // ═════════════════════════════════════════════════════════════════════════
  section("C — QUOTATIONS");

  sub("C1. a deal cannot be won before a quotation is accepted");
  {
    await loginAs(MANAGER);
    const r = await api(`/api/sales/opportunities/${ids.opportunityId}/transition`, {
      method: "POST", body: { toOutcome: "WON" },
    });
    check("refused", r.status === 409, S(r.json).slice(0, 200));
    check("and the message says why", /quotation/i.test(r.json?.error ?? ""), S(r.json?.error));
    const row = await one(`SELECT outcome FROM "Opportunity" WHERE id=$1`, [ids.opportunityId]);
    check("the deal is still open", row.outcome === "OPEN", S(row));
  }

  sub("C2. a rep raises a quotation and the server prices it");
  {
    await loginAs(REP);
    const tomorrow = new Date(Date.now() + 30 * 86400_000).toISOString().slice(0, 10);
    const r = await api("/api/sales/quotes", {
      method: "POST",
      body: {
        opportunityId: ids.opportunityId,
        validUntil: tomorrow,
        lines: [{ productSkuId: ids.skuId, quantity: "10", unit: "UNIT", unitPrice: "110", taxRatePercent: "15" }],
      },
    });
    check("created", r.status === 201, S(r.json).slice(0, 250));
    ids.quoteId = r.json?.quote?.id;
    ids.quoteNumber = r.json?.quote?.quoteNumber;
    // 10 x 110 = 1,100; VAT 15% = 165; total 1,265.
    check("the total is the server's arithmetic: 1265.00", r.json?.totals?.grandTotal === "1265.00", S(r.json?.totals));

    const row = await one(`SELECT "grandTotal","taxTotal",status FROM "Quote" WHERE id=$1`, [ids.quoteId]);
    check("and it is what was stored", String(row.grandTotal) === "1265.00", S(row));
    check("tax stored separately", String(row.taxTotal) === "165.00", S(row));
    check("status DRAFT", row.status === "DRAFT", S(row));
  }

  sub("C3. a client-supplied total is ignored, not trusted");
  {
    const r = await api(`/api/sales/quotes/${ids.quoteId}`, {
      method: "PUT",
      body: {
        grandTotal: "1.00", subtotal: "1.00",
        lines: [{ productSkuId: ids.skuId, quantity: "10", unit: "UNIT", unitPrice: "110", taxRatePercent: "15" }],
      },
    });
    check("accepted", r.status === 200, S(r.json).slice(0, 200));
    const row = await one(`SELECT "grandTotal" FROM "Quote" WHERE id=$1`, [ids.quoteId]);
    check("the stored total is still 1265.00, not the 1.00 the body claimed",
      String(row.grandTotal) === "1265.00", S(row));
  }

  sub("C4. a fractional pack count is refused");
  {
    const r = await api(`/api/sales/quotes/${ids.quoteId}`, {
      method: "PUT",
      body: { lines: [{ productSkuId: ids.skuId, quantity: "1.5", unit: "UNIT", unitPrice: "110" }] },
    });
    check("refused", r.status === 400, S(r.json).slice(0, 200));
    check("and the SKU is named", /HAR-1KG/.test(r.json?.error ?? ""), S(r.json?.error));
  }

  sub("C5. a discount above the threshold cannot be issued by a rep");
  {
    await api(`/api/sales/quotes/${ids.quoteId}`, {
      method: "PUT",
      body: {
        lines: [{ productSkuId: ids.skuId, quantity: "10", unit: "UNIT", unitPrice: "110",
                  discountPercent: "25", taxRatePercent: "15" }],
      },
    });
    const r = await api(`/api/sales/quotes/${ids.quoteId}/transition`, { method: "POST", body: { to: "ISSUED" } });
    check("the rep is refused with 403", r.status === 403, S(r.json).slice(0, 220));
    const row = await one(`SELECT status FROM "Quote" WHERE id=$1`, [ids.quoteId]);
    check("and the quotation is still a draft", row.status === "DRAFT", S(row));

    await loginAs(MANAGER);
    const m = await api(`/api/sales/quotes/${ids.quoteId}/transition`, { method: "POST", body: { to: "ISSUED" } });
    check("a manager with discount approval can issue it", m.status === 200, S(m.json).slice(0, 220));
    const after = await one(
      `SELECT status,"discountApprovedById","issuedSnapshot" IS NOT NULL AS frozen FROM "Quote" WHERE id=$1`,
      [ids.quoteId]);
    check("status ISSUED", after.status === "ISSUED", S(after.status));
    check("the approver is recorded on the quotation, not merely implied",
      after.discountApprovedById === `${P}_mgr`, S(after.discountApprovedById));
    check("and the lines and prices were frozen into a snapshot", after.frozen === true, S(after));
  }

  sub("C6. an issued quotation cannot be edited");
  {
    const r = await api(`/api/sales/quotes/${ids.quoteId}`, {
      method: "PUT",
      body: { lines: [{ productSkuId: ids.skuId, quantity: "1", unit: "UNIT", unitPrice: "1" }] },
    });
    check("refused with 409", r.status === 409, S(r.json).slice(0, 200));
    const row = await one(`SELECT "grandTotal" FROM "Quote" WHERE id=$1`, [ids.quoteId]);
    // 10 x 110 = 1,100; 25% off = 275; net 825; VAT 15% = 123.75; total 948.75.
    check("and the issued total is untouched", String(row.grandTotal) === "948.75", S(row));
  }

  sub("C7. revising supersedes the original and starts a new draft");
  {
    const r = await api(`/api/sales/quotes/${ids.quoteId}/revise`, { method: "POST" });
    check("created", r.status === 201, S(r.json).slice(0, 200));
    ids.revisionId = r.json?.quote?.id;
    check("revision 2", r.json?.quote?.revision === 2, S(r.json?.quote));

    const old = await one(`SELECT status FROM "Quote" WHERE id=$1`, [ids.quoteId]);
    check("the original reads SUPERSEDED", old.status === "SUPERSEDED", S(old));
    const nu = await one(`SELECT status,"supersedesId","grandTotal" FROM "Quote" WHERE id=$1`, [ids.revisionId]);
    check("the revision is a draft", nu.status === "DRAFT", S(nu));
    check("and points back at what it revises", nu.supersedesId === ids.quoteId, S(nu));
    check("with the lines carried over and re-priced", String(nu.grandTotal) === "948.75", S(nu));

    const lines = await one(`SELECT COUNT(*)::int n FROM "QuoteLine" WHERE "quoteId"=$1`, [ids.revisionId]);
    check("one line copied", lines.n === 1, S(lines));
  }

  sub("C8. the revision is issued and accepted at a corrected price");
  {
    await api(`/api/sales/quotes/${ids.revisionId}`, {
      method: "PUT",
      body: {
        validUntil: new Date(Date.now() + 30 * 86400_000).toISOString().slice(0, 10),
        lines: [{ productSkuId: ids.skuId, quantity: "10", unit: "UNIT", unitPrice: "110",
                  discountPercent: "5", taxRatePercent: "15" }],
      },
    });
    const issued = await api(`/api/sales/quotes/${ids.revisionId}/transition`, { method: "POST", body: { to: "ISSUED" } });
    check("issued", issued.status === 200, S(issued.json).slice(0, 200));
    // 1,100 less 5% = 1,045; VAT 156.75; total 1,201.75.
    check("at 1201.75", issued.json?.grandTotal === "1201.75", S(issued.json));

    const accepted = await api(`/api/sales/quotes/${ids.revisionId}/transition`, { method: "POST", body: { to: "ACCEPTED" } });
    check("accepted", accepted.status === 200, S(accepted.json).slice(0, 200));
    const row = await one(`SELECT status,"acceptedAt" FROM "Quote" WHERE id=$1`, [ids.revisionId]);
    check("stored as ACCEPTED with a timestamp", row.status === "ACCEPTED" && row.acceptedAt !== null, S(row));

    const again = await api(`/api/sales/quotes/${ids.revisionId}/transition`, { method: "POST", body: { to: "REJECTED", note: "changed my mind" } });
    check("an accepted quotation cannot then be rejected", again.status === 409, S(again.json).slice(0, 200));
  }

  // ═════════════════════════════════════════════════════════════════════════
  section("D — QUOTE TO ORDER, THROUGH THE ORDER SERVICE");

  sub("D1. the accepted quotation becomes a real order");
  {
    const before = await one(`SELECT COUNT(*)::int n FROM "Order"`);
    const r = await api(`/api/sales/quotes/${ids.revisionId}/create-order`, { method: "POST", body: {} });
    check("created", r.status === 201, S(r.json).slice(0, 250));
    ids.orderId = r.json?.orderId;
    ids.orderNumber = r.json?.orderNumber;
    check("it is flagged as the first order on the deal", r.json?.isFirstOrder === true, S(r.json));

    const after = await one(`SELECT COUNT(*)::int n FROM "Order"`);
    check("exactly one order was added", after.n === before.n + 1, `${before.n} → ${after.n}`);

    const order = await one(
      `SELECT o.status, o."quotationNumber", o."customerId", COUNT(i.id)::int lines,
              SUM(i."quantityUnits")::int units, SUM(i."quantityKg")::numeric kg
         FROM "Order" o JOIN "OrderItem" i ON i."orderId" = o.id
        WHERE o.id = $1 GROUP BY o.id`, [ids.orderId]);
    check("one line", order.lines === 1, S(order));
    check("ten units, taken from the quotation", order.units === 10, S(order));
    // The order service derives kilograms from the SKU: 10 x 1,000 g = 10 kg. A client
    // cannot supply a rival total, which is what this figure proves.
    check("and the kilograms were DERIVED by the order service, not sent by the CRM",
      Number(order.kg) === 10, S(order));
    check("the order carries the quotation reference", order.quotationNumber?.startsWith("Q-"), S(order));
    check("and goes to the state the preparation review runs from",
      order.status === "Waiting Preparation Review", S(order));

    const link = await one(
      `SELECT "quoteId","isFirstOrder","requestKey" FROM "OpportunityOrder" WHERE "orderId"=$1`, [ids.orderId]);
    check("the link back to the quotation exists", link.quoteId === ids.revisionId, S(link));
  }

  sub("D2. clicking twice does not make two orders");
  {
    const before = await one(`SELECT COUNT(*)::int n FROM "Order"`);
    const r = await api(`/api/sales/quotes/${ids.revisionId}/create-order`, { method: "POST", body: {} });
    check("the second call succeeds rather than erroring", r.status === 200, S(r.json).slice(0, 200));
    check("and reports the replay plainly", r.json?.replayed === true, S(r.json));
    check("returning the SAME order", r.json?.orderNumber === ids.orderNumber, S(r.json));
    const after = await one(`SELECT COUNT(*)::int n FROM "Order"`);
    check("no second order was created", after.n === before.n, `${before.n} → ${after.n}`);
  }

  sub("D3. a draft quotation cannot become an order");
  {
    const draft = await api("/api/sales/quotes", {
      method: "POST",
      body: {
        opportunityId: ids.opportunityId,
        validUntil: new Date(Date.now() + 10 * 86400_000).toISOString().slice(0, 10),
        lines: [{ productSkuId: ids.skuId, quantity: "1", unit: "UNIT", unitPrice: "110" }],
      },
    });
    const r = await api(`/api/sales/quotes/${draft.json.quote.id}/create-order`, { method: "POST", body: {} });
    check("refused with 409", r.status === 409, S(r.json).slice(0, 200));
    check("and the message says what state it is in", /draft/i.test(r.json?.error ?? ""), S(r.json?.error));
    ids.draftQuoteId = draft.json.quote.id;
  }

  sub("D4. a free-text line is refused by name, not silently dropped");
  {
    await api(`/api/sales/quotes/${ids.draftQuoteId}`, {
      method: "PUT",
      body: {
        lines: [
          { productSkuId: ids.skuId, quantity: "2", unit: "UNIT", unitPrice: "110" },
          { description: `${P} bespoke house blend`, quantity: "5", unit: "KG", unitPrice: "80" },
        ],
      },
    });
    await api(`/api/sales/quotes/${ids.draftQuoteId}/transition`, { method: "POST", body: { to: "ISSUED" } });
    await api(`/api/sales/quotes/${ids.draftQuoteId}/transition`, { method: "POST", body: { to: "ACCEPTED" } });

    const before = await one(`SELECT COUNT(*)::int n FROM "Order"`);
    const r = await api(`/api/sales/quotes/${ids.draftQuoteId}/create-order`, { method: "POST", body: {} });
    check("refused with 409", r.status === 409, S(r.json).slice(0, 250));
    check("and the offending line is named", /Line 2/.test(r.json?.error ?? ""), S(r.json?.error));
    const after = await one(`SELECT COUNT(*)::int n FROM "Order"`);
    check("no partial order was created", after.n === before.n, `${before.n} → ${after.n}`);
  }

  sub("D5. the deal can now be won, and the pipeline records it");
  {
    await loginAs(MANAGER);
    const r = await api(`/api/sales/opportunities/${ids.opportunityId}/transition`, {
      method: "POST", body: { toOutcome: "WON" },
    });
    check("won", r.status === 200, S(r.json).slice(0, 200));
    const row = await one(`SELECT outcome,"closedAt" FROM "Opportunity" WHERE id=$1`, [ids.opportunityId]);
    check("stored as WON with a close date", row.outcome === "WON" && row.closedAt !== null, S(row));

    const ev = await one(
      `SELECT COUNT(*)::int n FROM "OpportunityStageEvent" WHERE "opportunityId"=$1 AND "toOutcome"='WON'`,
      [ids.opportunityId]);
    check("and the move is on the deal's timeline", ev.n === 1, S(ev));

    const lost = await api(`/api/sales/opportunities/${ids.opportunityId}/transition`, {
      method: "POST", body: { toOutcome: "LOST", lostReason: "changed my mind" },
    });
    check("a won deal cannot be flipped to lost without reopening", lost.status === 409, S(lost.json).slice(0, 200));
  }

  // ═════════════════════════════════════════════════════════════════════════
  section("E — COMMISSION: PLAN, COLLECTION, ACCRUAL");

  sub("E1. a manager creates a tiered plan and assigns the rep");
  {
    await loginAs(MANAGER);
    const monthStart = `${riyadhMonth()}-01`;
    const plan = await api("/api/commissions/plans", {
      method: "POST",
      body: {
        code: `${P}STD`, name: `${P} Standard`,
        version: {
          baseRatePercent: "1", tierMode: "INCREMENTAL", currency: "SAR",
          effectiveFrom: `2020-01-01`,
          tiers: [{ fromAmount: "100000", toAmount: "120000", ratePercent: "0.5" }],
        },
      },
    });
    check("plan created", plan.status === 201, S(plan.json).slice(0, 250));
    ids.planVersionId = plan.json?.planVersionId;

    const self = await api("/api/commissions/assignments", {
      method: "POST",
      body: { employeeId: `${P}_mgr`, planVersionId: ids.planVersionId, effectiveFrom: "2020-01-01" },
    });
    check("a manager cannot put THEMSELVES on a plan", self.status === 403, S(self.json).slice(0, 220));

    const assign = await api("/api/commissions/assignments", {
      method: "POST",
      body: { employeeId: `${P}_rep`, planVersionId: ids.planVersionId, effectiveFrom: "2020-01-01" },
    });
    check("but can assign the rep", assign.status === 201, S(assign.json).slice(0, 220));

    const overlap = await api("/api/commissions/assignments", {
      method: "POST",
      body: { employeeId: `${P}_rep`, planVersionId: ids.planVersionId, effectiveFrom: "2021-01-01" },
    });
    check("a second, overlapping assignment is refused", overlap.status === 409, S(overlap.json).slice(0, 220));
    void monthStart;
  }

  sub("E2. a retroactive plan is refused rather than half-implemented");
  {
    const r = await api("/api/commissions/plans", {
      method: "POST",
      body: {
        code: `${P}RETRO`, name: `${P} Retro`,
        version: { baseRatePercent: "1", tierMode: "RETROACTIVE", currency: "SAR", effectiveFrom: "2020-01-01", tiers: [] },
      },
    });
    check("refused with 400", r.status === 400, S(r.json).slice(0, 220));
    check("and the refusal explains the difference", /retroactive/i.test(r.json?.error ?? ""), S(r.json?.error));
  }

  sub("E3. a partial collection accrues once");
  {
    const r = await api("/api/commissions/sandbox-collections", {
      method: "POST",
      body: {
        externalRef: `${P}-PAY-1`, opportunityId: ids.opportunityId, customerId: ids.customerId,
        amountGross: "5750", amountTax: "750", collectedAt: dayOfMonthISO(5),
      },
    });
    check("recorded", r.status === 201, S(r.json).slice(0, 250));
    // 5,750 less 750 VAT = 5,000 qualifying; 1% = 50.00.
    const led = await one(
      `SELECT COALESCE(SUM(amount),0)::numeric total, COUNT(*)::int n
         FROM "CommissionLedgerEntry" WHERE "employeeId"=$1 AND type IN ('ACCRUAL','REVERSAL')`, [`${P}_rep`]);
    check("the ledger holds 50.00", Number(led.total) === 50, S(led));
    check("from exactly one entry", led.n === 1, S(led));
  }

  sub("E4. the same payment delivered twice changes nothing");
  {
    const r = await api("/api/commissions/sandbox-collections", {
      method: "POST",
      body: {
        externalRef: `${P}-PAY-1`, opportunityId: ids.opportunityId,
        amountGross: "5750", amountTax: "750", collectedAt: dayOfMonthISO(5),
      },
    });
    check("reported as a replay", r.json?.replayed === true, S(r.json).slice(0, 200));
    const led = await one(
      `SELECT COALESCE(SUM(amount),0)::numeric total, COUNT(*)::int n
         FROM "CommissionLedgerEntry" WHERE "employeeId"=$1 AND type IN ('ACCRUAL','REVERSAL')`, [`${P}_rep`]);
    check("still 50.00, not 100.00", Number(led.total) === 50, S(led));
    check("and no second ledger entry was written", led.n === 1, S(led));
  }

  sub("E5. the second instalment adds the DIFFERENCE, and the rows sum to the period");
  {
    // This is the regression test for the defect the review screen was built on: every
    // accrual row used to carry the period's RUNNING TOTAL, so a month with 50 then 100
    // showed rows of 50 and 150 and summed to 200 against a real 150.
    const r = await api("/api/commissions/sandbox-collections", {
      method: "POST",
      body: {
        externalRef: `${P}-PAY-2`, opportunityId: ids.opportunityId,
        amountGross: "5750", amountTax: "750", collectedAt: dayOfMonthISO(6),
      },
    });
    check("recorded", r.status === 201, S(r.json).slice(0, 200));

    const led = await one(
      `SELECT COALESCE(SUM(amount),0)::numeric total FROM "CommissionLedgerEntry"
        WHERE "employeeId"=$1 AND type IN ('ACCRUAL','REVERSAL')`, [`${P}_rep`]);
    check("the ledger now holds 100.00 — the second payment added 50, not another 100",
      Number(led.total) === 100, S(led));

    const rows = await q(
      `SELECT amount::numeric amount, "qualifyingBase"::numeric base FROM "CommissionAccrual"
        WHERE "employeeId"=$1 ORDER BY "createdAt"`, [`${P}_rep`]);
    check("two accrual rows", rows.length === 2, S(rows));
    check("each carries its OWN event's contribution: 50 and 50",
      rows.every((x) => Number(x.amount) === 50), S(rows));
    check("each carries its own base of 5,000 rather than a running 10,000",
      rows.every((x) => Number(x.base) === 5000), S(rows));

    const sum = rows.reduce((a, x) => a + Number(x.amount), 0);
    check("so the rows sum to exactly what the ledger says", sum === Number(led.total), `${sum} vs ${led.total}`);
  }

  sub("E6. the review screen reconciles the two and says so");
  {
    await loginAs(FINANCE);
    const r = await api(`/api/commissions/review?month=${riyadhMonth()}`);
    check("readable by finance", r.status === 200, S(r.json).slice(0, 200));
    const row = r.json.employees.find((e) => e.employeeId === `${P}_rep`);
    check("the rep appears", !!row, S(r.json.employees));
    check("accrued 100.00", row?.accrued === "100.00", S(row));
    check("the accrual rows total the same", row?.accrualRowsTotal === "100.00", S(row));
    check("and it is reported as reconciled", row?.reconciled === true, S(row));
    check("the whole screen is marked sandbox", r.json.sandbox === true, S(r.json.notice));
  }

  sub("E7. nobody approves their own commission");
  {
    await loginAs(FINANCE);
    const self = await api("/api/commissions/review/actions", {
      method: "POST", body: { action: "approve", employeeId: `${P}_fin`, month: riyadhMonth() },
    });
    check("refused with 403", self.status === 403, S(self.json).slice(0, 220));

    const rep = await api("/api/commissions/review/actions", {
      method: "POST", body: { action: "approve", employeeId: `${P}_rep`, month: riyadhMonth() },
    });
    check("but the rep's period can be approved", rep.status === 200, S(rep.json).slice(0, 220));
    check("two accruals approved", rep.json?.approved === 2, S(rep.json));

    const rows = await q(
      `SELECT status,"approvedById" FROM "CommissionAccrual" WHERE "employeeId"=$1`, [`${P}_rep`]);
    check("both rows read APPROVED", rows.every((x) => x.status === "APPROVED"), S(rows));
    check("and carry the approver", rows.every((x) => x.approvedById === `${P}_fin`), S(rows));
  }

  sub("E8. a refund after approval corrects the LEDGER and leaves the approved rows alone");
  {
    const beforeRows = await q(
      `SELECT id, amount::numeric amount, status FROM "CommissionAccrual" WHERE "employeeId"=$1 ORDER BY id`,
      [`${P}_rep`]);

    await loginAs(MANAGER);
    const r = await api("/api/commissions/sandbox-collections", {
      method: "PATCH", body: { externalRef: `${P}-PAY-2` },
    });
    check("the reversal is accepted", r.status === 200, S(r.json).slice(0, 220));

    const led = await one(
      `SELECT COALESCE(SUM(amount),0)::numeric total FROM "CommissionLedgerEntry"
        WHERE "employeeId"=$1 AND type IN ('ACCRUAL','REVERSAL')`, [`${P}_rep`]);
    check("the ledger drops to 50.00", Number(led.total) === 50, S(led));

    const rev = await one(
      `SELECT amount::numeric amount FROM "CommissionLedgerEntry"
        WHERE "employeeId"=$1 AND type='REVERSAL' ORDER BY "createdAt" DESC LIMIT 1`, [`${P}_rep`]);
    check("recorded as a NEGATIVE reversal entry, not as an edit", Number(rev.amount) === -50, S(rev));

    const afterRows = await q(
      `SELECT id, amount::numeric amount, status FROM "CommissionAccrual" WHERE "employeeId"=$1 ORDER BY id`,
      [`${P}_rep`]);
    const unchanged = beforeRows.every((b) => {
      const a = afterRows.find((x) => x.id === b.id);
      return a && Number(a.amount) === Number(b.amount) && a.status === b.status;
    });
    check("and every APPROVED accrual is byte-for-byte what was approved", unchanged,
      `${S(beforeRows)} vs ${S(afterRows)}`);

    const again = await api("/api/commissions/sandbox-collections", {
      method: "PATCH", body: { externalRef: `${P}-PAY-2` },
    });
    check("reversing twice is harmless", again.status === 200, S(again.json).slice(0, 200));
    const led2 = await one(
      `SELECT COALESCE(SUM(amount),0)::numeric total FROM "CommissionLedgerEntry"
        WHERE "employeeId"=$1 AND type IN ('ACCRUAL','REVERSAL')`, [`${P}_rep`]);
    check("and the ledger is still 50.00", Number(led2.total) === 50, S(led2));
  }

  sub("E9. an adjustment appends, and a payout cannot exceed what is owed");
  {
    await loginAs(FINANCE);
    const zero = await api("/api/commissions/review/actions", {
      method: "POST", body: { action: "adjust", employeeId: `${P}_rep`, month: riyadhMonth(), amount: "0", reason: "nothing" },
    });
    check("a zero adjustment is refused rather than stored", zero.status === 400, S(zero.json).slice(0, 200));

    const noReason = await api("/api/commissions/review/actions", {
      method: "POST", body: { action: "adjust", employeeId: `${P}_rep`, month: riyadhMonth(), amount: "10" },
    });
    check("an adjustment with no reason is refused", noReason.status === 400, S(noReason.json).slice(0, 200));

    const adj = await api("/api/commissions/review/actions", {
      method: "POST",
      body: { action: "adjust", employeeId: `${P}_rep`, month: riyadhMonth(), amount: "10", reason: "agreed goodwill" },
    });
    check("a reasoned adjustment is recorded", adj.status === 201, S(adj.json).slice(0, 200));
    check("outstanding becomes 60.00", adj.json?.statement?.outstanding === "60.00", S(adj.json?.statement));
    check("and it is reported SEPARATELY from the accrued figure, not folded into it",
      adj.json?.statement?.accrued === "50.00" && adj.json?.statement?.adjustments === "10.00",
      S(adj.json?.statement));

    const entry = await one(
      `SELECT reason,"actorId" FROM "CommissionLedgerEntry" WHERE id=$1`, [adj.json.entryId]);
    check("carrying the reason", entry.reason === "agreed goodwill", S(entry));
    check("and who made it", entry.actorId === `${P}_fin`, S(entry));

    const over = await api("/api/commissions/review/actions", {
      method: "POST", body: { action: "payout", employeeId: `${P}_rep`, month: riyadhMonth(), amount: "500" },
    });
    check("paying more than is owed is refused", over.status === 409, S(over.json).slice(0, 220));

    const pay = await api("/api/commissions/review/actions", {
      method: "POST", body: { action: "payout", employeeId: `${P}_rep`, month: riyadhMonth(), amount: "60" },
    });
    check("paying exactly what is owed is recorded", pay.status === 201, S(pay.json).slice(0, 220));
    check("and nothing remains outstanding", pay.json?.statement?.outstanding === "0.00", S(pay.json?.statement));
    check("the response says plainly that no money moved",
      /does not move money/i.test(pay.json?.notice ?? ""), S(pay.json?.notice));

    const paid = await q(`SELECT status FROM "CommissionAccrual" WHERE "employeeId"=$1`, [`${P}_rep`]);
    check("the approved accruals now read PAID",
      paid.filter((x) => x.status === "PAID").length >= 1, S(paid));
  }

  sub("E10. the rep sees their own figure, and the same figure");
  {
    await loginAs(REP);
    const me = await api(`/api/commissions/me?month=${riyadhMonth()}`);
    check("readable", me.status === 200, S(me.json).slice(0, 200));
    check("accrued 50.00, matching what finance saw", me.json?.statement?.accrued === "50.00", S(me.json?.statement));
    check("paid 60.00", me.json?.statement?.paid === "60.00", S(me.json?.statement));
    check("and the sandbox notice is on the rep's own screen too", me.json?.sandbox === true, S(me.json?.notice));

    const team = await api(`/api/commissions/review?month=${riyadhMonth()}`);
    check("but the rep cannot open the team review", team.status === 403, S(team.json).slice(0, 160));
  }

  // ═════════════════════════════════════════════════════════════════════════
  section("F — SPLIT ATTRIBUTION");

  sub("F1. a split divides the BASE between two people");
  {
    await loginAs(MANAGER);
    const assign = await api("/api/commissions/assignments", {
      method: "POST",
      body: { employeeId: `${P}_fin`, planVersionId: ids.planVersionId, effectiveFrom: "2020-01-01" },
    });
    check("the second person is on the plan too", assign.status === 201, S(assign.json).slice(0, 200));

    // Effective from the 10th: AFTER the first payment, BEFORE the third. That is what
    // makes the next two assertions mean something — the earlier money stays wholly the
    // rep's, and only what arrives after the split is divided.
    const split = await api(`/api/sales/opportunities/${ids.opportunityId}/owners`, {
      method: "PUT",
      body: {
        splits: [{ employeeId: `${P}_rep`, sharePercent: "60" }, { employeeId: `${P}_fin`, sharePercent: "40" }],
        effectiveFrom: dayOfMonthISO(10),
      },
    });
    check("the split is stored", split.status === 200, S(split.json).slice(0, 200));

    const bad = await api(`/api/sales/opportunities/${ids.opportunityId}/owners`, {
      method: "PUT", body: { splits: [{ employeeId: `${P}_rep`, sharePercent: "90" }] },
    });
    check("a split that does not total 100 is refused, not normalised", bad.status === 400, S(bad.json).slice(0, 200));

    const r = await api("/api/commissions/sandbox-collections", {
      method: "POST",
      body: {
        externalRef: `${P}-PAY-3`, opportunityId: ids.opportunityId,
        amountGross: "11500", amountTax: "1500", collectedAt: dayOfMonthISO(20),
      },
    });
    check("the collection is recorded", r.status === 201, S(r.json).slice(0, 200));

    // Base 10,000 split 60/40 → 6,000 and 4,000 → at 1% → 60.00 and 40.00.
    const finLed = await one(
      `SELECT COALESCE(SUM(amount),0)::numeric total FROM "CommissionLedgerEntry"
        WHERE "employeeId"=$1 AND type IN ('ACCRUAL','REVERSAL')`, [`${P}_fin`]);
    check("the 40% share earns 40.00", Number(finLed.total) === 40, S(finLed));

    const repLed = await one(
      `SELECT COALESCE(SUM(amount),0)::numeric total FROM "CommissionLedgerEntry"
        WHERE "employeeId"=$1 AND type IN ('ACCRUAL','REVERSAL')`, [`${P}_rep`]);
    // 50 from the first payment, which predates the split and stays wholly the rep's, plus
    // 60 from the 60% share of this one. If the split were applied retroactively the rep
    // would be on 90 and the earlier month's approved figure would have moved under them.
    check("and the 60% share adds 60.00 to what the rep already had", Number(repLed.total) === 110, S(repLed));

    const acc = await q(
      `SELECT "qualifyingBase"::numeric base, "sharePercent"::numeric share
         FROM "CommissionAccrual" a JOIN "CollectionEvent" e ON e.id = a."collectionEventId"
        WHERE a."employeeId"=$1 AND e."externalRef"=$2`, [`${P}_rep`, `${P}-PAY-1`]);
    check("the accrual for the payment that predates the split still records a 100% share",
      Number(acc[0]?.share) === 100 && Number(acc[0]?.base) === 5000, S(acc));
  }

  // ═════════════════════════════════════════════════════════════════════════
  section("G — TARGETS AND REPORTS");

  sub("G1. a target is set by a manager, never by its owner");
  {
    await loginAs(MANAGER);
    const self = await api("/api/sales/targets", {
      method: "PUT", body: { employeeId: `${P}_mgr`, month: riyadhMonth(), targetAmount: "1000" },
    });
    check("setting your own target is refused", self.status === 403, S(self.json).slice(0, 200));

    const zero = await api("/api/sales/targets", {
      method: "PUT", body: { employeeId: `${P}_rep`, month: riyadhMonth(), targetAmount: "0" },
    });
    check("a target of zero is refused — it is met by doing nothing", zero.status === 400, S(zero.json).slice(0, 200));

    const ok = await api("/api/sales/targets", {
      method: "PUT",
      body: { employeeId: `${P}_rep`, month: riyadhMonth(), targetAmount: "10000", bonusAmount: "500" },
    });
    check("a real target is stored", ok.status === 200, S(ok.json).slice(0, 200));
  }

  sub("G2. progress is measured against collections, not deal value");
  {
    const r = await api(`/api/sales/targets?month=${riyadhMonth()}`);
    check("readable", r.status === 200, S(r.json).slice(0, 200));
    const row = r.json.rows.find((x) => x.employeeId === `${P}_rep`);
    // Collected and still standing in this period, at the rep's share: 5,000 from PAY-1
    // (PAY-2 was reversed) plus 6,000 from the 60% of PAY-3 = 11,000.
    check("achieved 11000.00 from the collections, not from the pipeline", row?.achieved === "11000.00", S(row));
    check("the 10,000 target is met", row?.met === true, S(row));
    check("and the figure is marked as coming from the sandbox", r.json.sandbox === true, S(r.json.notice));
  }

  sub("G3. conversion rate is a cohort rate, computed from real links");
  {
    const r = await api(`/api/sales/reports?month=${riyadhMonth()}`);
    check("readable", r.status === 200, S(r.json).slice(0, 200));
    check("the leads created this month are counted", r.json.leads.created >= 2, S(r.json.leads));
    check("and the conversions among THEM", r.json.leads.converted >= 1, S(r.json.leads));
    const expected = ((r.json.leads.converted / r.json.leads.created) * 100).toFixed(1);
    check(`the rate is converted/created, not an unrelated ratio (${expected}%)`,
      r.json.leads.conversionRatePercent === expected, `${r.json.leads.conversionRatePercent} vs ${expected}`);
    check("a won deal is reported", r.json.closed.won >= 1, S(r.json.closed));
    check("and the cycle length carries its sample size", typeof r.json.duration.sampleSize === "number", S(r.json.duration));
  }

  // ═════════════════════════════════════════════════════════════════════════
  section("H — CSV IMPORT AND EXPORT");

  sub("H1. a dry run reports without writing");
  {
    await loginAs(REP);
    const before = await one(`SELECT COUNT(*)::int n FROM "Lead" WHERE "companyName" LIKE '${P}%'`);
    const r = await api("/api/sales/leads/import", {
      method: "POST",
      body: {
        dryRun: true,
        csv: `companyName,contactName,phone\n${P} Import One,Ali,0551110001\n${P} Import Two,Noura,0551110002\nX,Bad,\n`,
      },
    });
    check("the dry run answers", r.status === 200, S(r.json).slice(0, 250));
    check("two rows would import", r.json?.wouldImport === 2, S(r.json));
    check("and the third is reported by its spreadsheet row number",
      r.json?.problems?.[0]?.row === 4, S(r.json?.problems));
    const after = await one(`SELECT COUNT(*)::int n FROM "Lead" WHERE "companyName" LIKE '${P}%'`);
    check("nothing was written", after.n === before.n, `${before.n} → ${after.n}`);
  }

  sub("H2. the commit writes exactly what the dry run promised");
  {
    const r = await api("/api/sales/leads/import", {
      method: "POST",
      body: {
        csv: `companyName,contactName,phone\n${P} Import One,Ali,0551110001\n${P} Import Two,Noura,0551110002\nX,Bad,\n`,
      },
    });
    check("imported", r.status === 201, S(r.json).slice(0, 250));
    check("two rows", r.json?.imported === 2, S(r.json));
    const rows = await q(
      `SELECT "companyName","ownerId","normalizedPhone" FROM "Lead"
        WHERE "companyName" LIKE '${P} Import%' ORDER BY "companyName"`);
    check("both are in the database", rows.length === 2, S(rows));
    check("owned by the importer, not by anything the body could name",
      rows.every((x) => x.ownerId === `${P}_rep`), S(rows));
    check("with duplicate keys computed on the way in",
      rows[0].normalizedPhone === "551110001", S(rows[0]));
  }

  sub("H3. a row whose phone already exists is held back until acknowledged");
  {
    const r = await api("/api/sales/leads/import", {
      method: "POST",
      body: { csv: `companyName,contactName,phone\n${P} Import Three,Omar,0551110001\n` },
    });
    check("refused with 409", r.status === 409, S(r.json).slice(0, 250));
    check("naming the lead it matches", r.json?.duplicatesInSystem?.[0]?.matchesCompany?.includes("Import One"),
      S(r.json?.duplicatesInSystem));
    const n = await one(`SELECT COUNT(*)::int n FROM "Lead" WHERE "companyName"=$1`, [`${P} Import Three`]);
    check("and nothing was written", n.n === 0, S(n));

    const ack = await api("/api/sales/leads/import", {
      method: "POST",
      body: {
        acknowledgeDuplicates: true,
        csv: `companyName,contactName,phone\n${P} Import Three,Omar,0551110001\n`,
      },
    });
    check("acknowledged, it imports", ack.status === 201 && ack.json?.imported === 1, S(ack.json).slice(0, 200));
  }

  sub("H4. two rows in the FILE sharing a phone: the second is held back");
  {
    const r = await api("/api/sales/leads/import", {
      method: "POST",
      body: {
        dryRun: true,
        csv: `companyName,contactName,phone\n${P} Twin A,Ali,0559990001\n${P} Twin B,Ali,0559990001\n`,
      },
    });
    check("one of the two would import", r.json?.wouldImport === 1, S(r.json));
    check("and the duplicate names the row it repeats",
      /row 2/i.test(r.json?.duplicatesInFile?.[0]?.message ?? ""), S(r.json?.duplicatesInFile));
  }

  sub("H5. export needs its own privilege, and neutralises formulas");
  {
    // A lead whose notes begin with `=` — stored verbatim on purpose, because a company
    // legitimately called "-Aroma-" must not be corrupted on the way in.
    await api("/api/sales/leads", {
      method: "POST",
      body: { companyName: `${P} Formula Co`, contactName: "Mia", notes: "=HYPERLINK(\"http://x\",\"click\")" },
    });

    const r = await fetch(`${BASE}/api/sales/leads/export`, {
      headers: { Cookie: Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join("; ") },
    });
    check("the rep may export their own", r.status === 200, String(r.status));
    check("served as a CSV attachment",
      /text\/csv/.test(r.headers.get("content-type") ?? "") &&
      /attachment/.test(r.headers.get("content-disposition") ?? ""),
      `${r.headers.get("content-type")} ${r.headers.get("content-disposition")}`);
    check("and never cached", /no-store/.test(r.headers.get("cache-control") ?? ""), r.headers.get("cache-control"));

    // Read as bytes: Response.text() UTF-8-decodes and silently drops a leading BOM, so
    // checking the decoded string can never see the thing being asserted.
    const bytes = new Uint8Array(await r.clone().arrayBuffer());
    check("the file starts with a UTF-8 BOM so Excel reads Arabic properly",
      bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf,
      [bytes[0], bytes[1], bytes[2]].join(","));
    const body = await r.text();
    check("the formula is neutralised with a leading apostrophe",
      body.includes("'=HYPERLINK"), body.slice(0, 40));
    check("and it is NOT left executable", !/,=HYPERLINK/.test(body), "");

    // Finance holds no sales module at all.
    await loginAs(FINANCE);
    const denied = await fetch(`${BASE}/api/sales/leads/export`, {
      headers: { Cookie: Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join("; ") },
    });
    check("somebody without the privilege is refused", denied.status === 403, String(denied.status));
  }

  // ═════════════════════════════════════════════════════════════════════════
  console.log(`\n${"=".repeat(78)}\n  SALES WORKFLOW RESULT\n${"=".repeat(78)}`);
  console.log(`${results.pass} passed, ${results.fail} failed`);
  if (results.failures.length) console.log("FAILURES:\n  - " + results.failures.join("\n  - "));
}

try {
  await main();
} catch (e) {
  console.log(`\n[FATAL] ${e?.stack ?? e}`);
  results.fail++;
} finally {
  await cleanup().catch((e) => console.log("[teardown] " + (e?.message ?? e)));
  await c.end().catch(() => {});
}
process.exit(results.fail === 0 ? 0 : 1);
