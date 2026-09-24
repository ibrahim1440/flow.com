import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { requirePinLookupSecret, pinLookup, pinVerifierInput } from "../../../src/lib/pin-lookup";
import { hashSync } from "bcryptjs";
import { withDb, assertTestDatabase } from "./db";
import { ROLES } from "./roles";

// Fixture setup only: the employees who will sign in, and the catalog they will sell.
// Nothing here performs a step of the operational workflow — every order, roast, QC
// record, pack and delivery in this suite is done by clicking the real UI.
//
// The catalog is deliberately different from every earlier test pass: different origins,
// different pack sizes, different roast losses and different customers, so a scenario
// cannot accidentally pass on stock some previous suite left behind.

export const TAG = "UAT";

// Playwright transpiles these specs to CommonJS, so import.meta is unavailable; the path
// is resolved from the repository root, which is where the runner starts.
export const CATALOG_PATH = join(process.cwd(), "tests", "e2e", "support", "catalog.json");

const BASE = process.env.BASE_URL ?? "http://localhost:3010";

export type Catalog = {
  beans: Record<string, { id: string; name: string; openingKg: number }>;
  coffees: Record<string, { id: string; name: string; roastLoss: number }>;
  materials: Record<string, { id: string; code: string; openingQty: number }>;
  skus: Record<string, { id: string; code: string; name: string; grams: number; kg: number; coffee: string; label: string }>;
  customers: Record<string, { id: string; name: string }>;
  /** Pipeline stages and commission plans, for the CRM suite. */
  crm: {
    stages: { id: string; code: string; nameEn: string; nameAr: string }[];
    plans: Record<string, { planId: string; versionId: string; baseRatePercent: string }>;
  };
};

let cookie = "";
async function api(path: string, init: { method?: string; body?: unknown } = {}) {
  const res = await fetch(BASE + path, {
    method: init.method ?? "GET",
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    redirect: "manual",
  });
  for (const c of res.headers.getSetCookie?.() ?? []) if (c.startsWith("token=")) cookie = c.split(";")[0];
  const text = await res.text();
  let json: unknown;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, json: json as never };
}

async function teardown() {
  // Scoped by the fixtures themselves rather than by a name prefix. Records the UI
  // creates do not carry the tag — a roasting batch gets an auto-generated number from
  // the date, and a finished-goods lot inherits it — so anything created during a run is
  // reached through the customer, green bean or SKU it belongs to.
  const ORDERS = `SELECT id FROM "Order" WHERE "customerId" LIKE '${TAG}_cust_%'`;
  const ITEMS = `SELECT id FROM "OrderItem" WHERE "orderId" IN (${ORDERS})`;
  const BATCHES = `SELECT id FROM "RoastingBatch" WHERE "greenBeanId" LIKE '${TAG}_bean_%' OR "productId" LIKE '${TAG}_cof_%' OR "orderItemId" IN (${ITEMS})`;
  const SKUS = `SELECT id FROM "ProductSKU" WHERE "skuCode" LIKE '${TAG}%'`;
  const LOTS = `SELECT id FROM "FinishedGoodsLot" WHERE "productSkuId" IN (${SKUS}) OR "packedFromBatchId" IN (${BATCHES}) OR "roastingBatchId" IN (${BATCHES})`;

  // The CRM rows, identified by the tag on what the suite creates and by the employees
  // that own it. Child-first: each of these is held down by a foreign key from the row
  // below, and an employee cannot be deleted while a lead still points at them — which is
  // exactly how a teardown on this codebase has failed before.
  // The human reviewer's accounts live under this prefix and are NOT ours to touch.
  //
  // What actually PREVENTS that is the identity guard in scripts/e2e/identity-guard.mjs,
  // which every statement passes through before execution and which refuses a mutation that
  // could reach a reserved identity. The count below is a second, weaker net: it DETECTS
  // deletion, after the fact, and nothing else — not a changed PIN, not a deactivation, not
  // a rewritten permissions blob, all of which leave the row count identical. It is kept
  // because a cheap tripwire on the one failure mode that removes rows is still worth having
  // if the guard is ever bypassed by code that opens its own connection.
  const REVIEWER_PREFIX = "RVW";
  const reviewerCount = async () =>
    Number(
      (await withDb(async (db) =>
        db.query(`SELECT COUNT(*)::int AS n FROM "Employee" WHERE id LIKE '${REVIEWER_PREFIX}\\_%'`),
      )).rows[0].n,
    );
  const reviewersBefore = await reviewerCount();

  const CRM_EMPLOYEES = `SELECT id FROM "Employee" WHERE id LIKE '${TAG}_emp_%'`;
  const CRM_OPPS = `SELECT id FROM "Opportunity" WHERE title LIKE '${TAG}%' OR "ownerId" IN (${CRM_EMPLOYEES})`;
  const CRM_QUOTES = `SELECT id FROM "Quote" WHERE "opportunityId" IN (${CRM_OPPS})`;
  const CRM_PLANS = `SELECT id FROM "CommissionPlan" WHERE code LIKE '${TAG}%'`;
  const CRM_VERSIONS = `SELECT id FROM "CommissionPlanVersion" WHERE "planId" IN (${CRM_PLANS})`;

  await withDb(async (db) => {
    const q = (sql: string) => db.query(sql);

    await q(`DELETE FROM "CommissionLedgerEntry" WHERE "employeeId" IN (${CRM_EMPLOYEES})`);
    await q(`DELETE FROM "CommissionAccrual" WHERE "employeeId" IN (${CRM_EMPLOYEES})`);
    await q(`DELETE FROM "CollectionEvent" WHERE "externalRef" LIKE '${TAG}%'`);
    await q(`DELETE FROM "CommissionAssignment" WHERE "employeeId" IN (${CRM_EMPLOYEES}) OR "planVersionId" IN (${CRM_VERSIONS})`);
    await q(`DELETE FROM "CommissionTier" WHERE "planVersionId" IN (${CRM_VERSIONS})`);
    await q(`DELETE FROM "CommissionPlanVersion" WHERE id IN (${CRM_VERSIONS})`);
    await q(`DELETE FROM "CommissionPlan" WHERE id IN (${CRM_PLANS})`);
    await q(`DELETE FROM "SalesTarget" WHERE "employeeId" IN (${CRM_EMPLOYEES})`);
    await q(`DELETE FROM "OpportunityOrder" WHERE "opportunityId" IN (${CRM_OPPS})`);
    await q(`DELETE FROM "QuoteLine" WHERE "quoteId" IN (${CRM_QUOTES})`);
    // A revision points at the quotation it supersedes, so the link goes first.
    await q(`UPDATE "Quote" SET "supersedesId" = NULL WHERE id IN (${CRM_QUOTES})`);
    await q(`DELETE FROM "Quote" WHERE id IN (${CRM_QUOTES})`);
    await q(`DELETE FROM "SampleShipment" WHERE "opportunityId" IN (${CRM_OPPS})`);
    await q(`DELETE FROM "Activity" WHERE "ownerId" IN (${CRM_EMPLOYEES}) OR "opportunityId" IN (${CRM_OPPS})`);
    await q(`DELETE FROM "OpportunityStageEvent" WHERE "opportunityId" IN (${CRM_OPPS})`);
    await q(`DELETE FROM "OpportunityOwner" WHERE "opportunityId" IN (${CRM_OPPS})`);
    await q(`DELETE FROM "LeadConversion" WHERE "opportunityId" IN (${CRM_OPPS})`);
    await q(`DELETE FROM "Opportunity" WHERE id IN (${CRM_OPPS})`);
    await q(`DELETE FROM "Lead" WHERE "ownerId" IN (${CRM_EMPLOYEES}) OR "companyName" LIKE '${TAG}%'`);
    await q(`DELETE FROM "PipelineStage" WHERE code LIKE '${TAG}%'`);

    await q(`DELETE FROM "StockAllocation" WHERE "orderItemId" IN (${ITEMS}) OR "finishedGoodsLotId" IN (${LOTS})`);
    await q(`DELETE FROM "Delivery" WHERE "orderItemId" IN (${ITEMS})`);
    await q(`DELETE FROM "OrderActivity" WHERE "orderId" IN (${ORDERS})`);
    await q(`DELETE FROM "InventoryMovement" WHERE "sourceDocId" IN (${BATCHES})
             OR "referenceEntityId" IN (SELECT id FROM "MaterialItem" WHERE code LIKE '${TAG}%')
             OR "referenceEntityId" LIKE '${TAG}_bean_%'
             OR "referenceEntityId" IN (${LOTS})`);
    await q(`DELETE FROM "FinishedGoodsLot" WHERE id IN (${LOTS})`);
    await q(`DELETE FROM "ProductionOrder" WHERE "productSkuId" IN (${SKUS}) OR "sourceOrderItemId" IN (${ITEMS})`);
    await q(`DELETE FROM "QcCorrectionFieldChange" WHERE "correctionId" IN (SELECT id FROM "QcCorrectionHistory" WHERE "batchId" IN (${BATCHES}))`);
    await q(`DELETE FROM "QcCorrectionHistory" WHERE "batchId" IN (${BATCHES})`);
    await q(`DELETE FROM "QcRecord" WHERE "batchId" IN (${BATCHES})`);
    await q(`DELETE FROM "BatchSerialHistory" WHERE "batchId" IN (${BATCHES})`);
    await q(`DELETE FROM "BlendIngredient" WHERE "sourceBatchId" IN (${BATCHES}) OR "targetBlendBatchId" IN (${BATCHES})`);
    // Migration #17 added PackagingOperation, whose batchId FK is RESTRICT — it holds the
    // batch down and must go first. The teardown predates that table, so it only started
    // failing once packing actually succeeded in this suite and left rows behind.
    await q(`DELETE FROM "PackagingOperation" WHERE "batchId" IN (${BATCHES})`);
    // Blend outputs point at their inputs, so clear the parent link before deleting.
    await q(`UPDATE "RoastingBatch" SET "parentBatchId" = NULL WHERE id IN (${BATCHES})`);
    await q(`DELETE FROM "RoastingBatch" WHERE id IN (${BATCHES})`);
    await q(`DELETE FROM "OrderItem" WHERE "orderId" IN (${ORDERS})`);
    await q(`DELETE FROM "Order" WHERE "customerId" LIKE '${TAG}_cust_%'`);
    await q(`DELETE FROM "BomComponent" WHERE "productSkuId" IN (${SKUS})`);
    await q(`DELETE FROM "ProductSKU" WHERE "skuCode" LIKE '${TAG}%'`);
    await q(`DELETE FROM "MaterialItem" WHERE code LIKE '${TAG}%'`);
    await q(`DELETE FROM "CoffeeProduct" WHERE id LIKE '${TAG}_cof_%'`);
    await q(`DELETE FROM "GreenBean" WHERE id LIKE '${TAG}_bean_%'`);
    await q(`DELETE FROM "Customer" WHERE id LIKE '${TAG}_cust_%'`);
    await q(`DELETE FROM "Employee" WHERE id LIKE '${TAG}_emp_%'`);

    // Detection only, and only of deletion — see REVIEWER_PREFIX above for why that is
    // the weaker half of the protection rather than the protection itself.
    const reviewersAfter = Number(
      (await db.query(`SELECT COUNT(*)::int AS n FROM "Employee" WHERE id LIKE '${REVIEWER_PREFIX}\\_%'`)).rows[0].n,
    );
    if (reviewersAfter !== reviewersBefore) {
      throw new Error(
        `Fixture teardown removed ${reviewersBefore - reviewersAfter} reviewer account(s) ` +
        `under ${REVIEWER_PREFIX}_. Those belong to a person reviewing the Preview, not to ` +
        `this suite. Narrow the teardown pattern that matched them.`,
      );
    }
  });
}

export default async function globalSetup() {
  assertTestDatabase();
  await teardown();

  // ── Employees ────────────────────────────────────────────────────────────
  // Fails loudly rather than seeding rows this deployment could never verify.
  const pinSecret = requirePinLookupSecret();
  await withDb(async (db) => {
    for (const [key, r] of Object.entries(ROLES)) {
      await db.query(
        `INSERT INTO "Employee" (id,name,pin,"pinLookup",role,permissions,"defaultRoute",active,"preferredLanguage","createdAt","updatedAt")
         VALUES ($1,$2,$3,$4,$5,$6,'/dashboard',true,'en',now(),now())`,
        [
          // Secure Version B: the stored verifier is bcrypt over a KEYED derivation of the
          // PIN, and pinLookup is the keyed selector login searches on. Seeding a bcrypt of
          // the raw PIN (plus a sha256 pinHash) is the pre-H2B scheme — every sign-in in this
          // suite failed against it, because no row could be selected and the raw PIN is not
          // what the verifier is built from. pinHash is left null: it is inert under
          // Version B and migration #19 removes it.
          `${TAG}_emp_${key}`, r.name, hashSync(pinVerifierInput(r.pin, pinSecret), 10),
          pinLookup(r.pin, pinSecret),
          r.role, JSON.stringify(r.permissions),
        ]
      );
    }
  });

  // ── Green beans and origins ──────────────────────────────────────────────
  const beanSpec: [string, string, string, number, number][] = [
    ["yemen", "Yemen Haraz", "Yemen", 150, 16],
    ["colombia", "Colombia Huila", "Colombia", 200, 14],
    ["kenya", "Kenya Nyeri AA", "Kenya", 120, 17],
  ];
  const beans: Catalog["beans"] = {};
  const coffees: Catalog["coffees"] = {};
  await withDb(async (db) => {
    for (const [key, name, country, kg, loss] of beanSpec) {
      const beanId = `${TAG}_bean_${key}`;
      await db.query(
        `INSERT INTO "GreenBean" (id,"serialNumber","beanType",country,"quantityKg","isActive","receivedDate","createdAt","updatedAt")
         VALUES ($1,$2,$3,$4,$5,true,now(),now(),now())`,
        [beanId, `${TAG}-${key.toUpperCase()}`, name, country, kg]
      );
      beans[key] = { id: beanId, name, openingKg: kg };

      const cofId = `${TAG}_cof_${key}`;
      await db.query(
        `INSERT INTO "CoffeeProduct" (id,"productNameEn","countryEn","defaultGreenBeanId","expectedRoastLoss","createdAt","updatedAt")
         VALUES ($1,$2,$3,$4,$5,now(),now())`,
        [cofId, `${TAG} ${name}`, country, beanId, loss]
      );
      coffees[key] = { id: cofId, name, roastLoss: loss };
    }

    const custSpec: [string, string][] = [
      ["roastery", "Haraz Roastery Co"],
      ["bakery", "Nyeri Bakehouse"],
      ["hotel", "Huila Grand Hotel"],
    ];
    for (const [key, name] of custSpec) {
      await db.query(`INSERT INTO "Customer" (id,name,"createdAt","updatedAt") VALUES ($1,$2,now(),now())`,
        [`${TAG}_cust_${key}`, `${TAG} ${name}`]);
    }
  });

  const customers: Catalog["customers"] = {
    roastery: { id: `${TAG}_cust_roastery`, name: `${TAG} Haraz Roastery Co` },
    bakery: { id: `${TAG}_cust_bakery`, name: `${TAG} Nyeri Bakehouse` },
    hotel: { id: `${TAG}_cust_hotel`, name: `${TAG} Huila Grand Hotel` },
  };

  // ── Catalog through the API, as an administrator ─────────────────────────
  // Product and packaging catalogue is configuration, not the operational workflow the
  // UAT is proving; the workflow itself never touches the API. A separate UI test covers
  // creating a product and its bill of materials through the Products screen.
  const login = await api("/api/auth/login", { method: "POST", body: { method: "pin", pin: ROLES.admin.pin } });
  if (login.status !== 200) throw new Error("UAT setup: admin login failed " + login.status);

  const materials: Catalog["materials"] = {};
  const matSpec: [string, string, string, string, number][] = [
    ["bag500", `${TAG}-BAG-500G`, "500 g Valve Bag", "PACKAGING", 600],
    ["bag1kg", `${TAG}-BAG-1KG`, "1 KG Valve Bag", "PACKAGING", 400],
    ["label", `${TAG}-LABEL`, "Origin Label", "LABEL", 2000],
    ["box", `${TAG}-BOX`, "Shipping Box", "PACKAGING", 300],
  ];
  for (const [key, code, name, category, qty] of matSpec) {
    const r = await api("/api/materials", { method: "POST", body: { code, name, category, quantityOnHand: qty, reorderPoint: 40 } });
    if (r.status !== 201) throw new Error(`UAT setup: material ${code} failed ${r.status} ${JSON.stringify(r.json)}`);
    materials[key] = { id: (r.json as { id: string }).id, code, openingQty: qty };
  }

  const skus: Catalog["skus"] = {};
  const skuSpec: [string, string, string, string, number, number][] = [
    ["yem500", "yemen", `${TAG}-YEM-500G`, "Yemen Haraz 500 g", 500, 96],
    ["col500", "colombia", `${TAG}-COL-500G`, "Colombia Huila 500 g", 500, 58],
    ["col1kg", "colombia", `${TAG}-COL-1KG`, "Colombia Huila 1 KG", 1000, 110],
    ["ken1kg", "kenya", `${TAG}-KEN-1KG`, "Kenya Nyeri AA 1 KG", 1000, 135],
  ];
  for (const [key, coffeeKey, code, name, grams, price] of skuSpec) {
    const r = await api("/api/products", { method: "POST", body: { productId: coffees[coffeeKey].id, skuCode: code, name, weightGrams: grams, price } });
    if (r.status !== 201) throw new Error(`UAT setup: sku ${code} failed ${r.status} ${JSON.stringify(r.json)}`);
    const id = (r.json as { id: string }).id;
    skus[key] = { id, code, name, grams, kg: grams / 1000, coffee: coffeeKey, label: `${name} — ${code}` };

    const bagKey = grams >= 1000 ? "bag1kg" : "bag500";
    const bom = await api(`/api/products/${id}/bom`, { method: "PUT", body: { components: [
      { type: "ROASTED_COFFEE", coffeeProductId: coffees[coffeeKey].id, quantityPerUnit: grams / 1000 },
      { type: "MATERIAL", materialItemId: materials[bagKey].id, quantityPerUnit: 1 },
      { type: "MATERIAL", materialItemId: materials.label.id, quantityPerUnit: 1 },
    ] } });
    if (bom.status !== 200) throw new Error(`UAT setup: bom ${code} failed ${bom.status} ${JSON.stringify(bom.json)}`);
  }

  // ── CRM fixtures ─────────────────────────────────────────────────────────
  // Pipeline stages, and two commission plans at genuinely different rates so the suite can
  // show two people paid differently for the same collection because of their PLAN, rather
  // than because of something the test arranged afterwards.
  const stages = [
    { id: `${TAG}_stage_new`, code: `${TAG}_NEW`, nameEn: "New", nameAr: "جديد", position: 10, probability: 10 },
    { id: `${TAG}_stage_qual`, code: `${TAG}_QUALIFY`, nameEn: "Qualifying", nameAr: "تأهيل", position: 20, probability: 30 },
    { id: `${TAG}_stage_prop`, code: `${TAG}_PROPOSAL`, nameEn: "Proposal", nameAr: "عرض سعر", position: 30, probability: 60 },
  ];
  const plans: Catalog["crm"]["plans"] = {};

  await withDb(async (db) => {
    for (const s of stages) {
      await db.query(
        `INSERT INTO "PipelineStage" (id,code,"nameEn","nameAr",position,probability,"isActive","createdAt","updatedAt")
         VALUES ($1,$2,$3,$4,$5,$6,true,now(),now())`,
        [s.id, s.code, s.nameEn, s.nameAr, s.position, s.probability]
      );
    }

    // Two rates: the rep on 1%, the manager on 2%.
    const planSpec: [string, string, string, string][] = [
      ["standard", `${TAG}_STD`, "Standard 1%", "1.000000"],
      ["senior", `${TAG}_SNR`, "Senior 2%", "2.000000"],
    ];
    for (const [key, code, name, rate] of planSpec) {
      const planId = `${TAG}_plan_${key}`;
      const versionId = `${TAG}_ver_${key}`;
      await db.query(
        `INSERT INTO "CommissionPlan" (id,code,name,"isActive","createdAt","updatedAt")
         VALUES ($1,$2,$3,true,now(),now())`, [planId, code, name]);
      await db.query(
        `INSERT INTO "CommissionPlanVersion"
           (id,"planId",version,basis,"tierMode","baseRatePercent",currency,"effectiveFrom","createdAt")
         VALUES ($1,$2,1,'NET_COLLECTION','INCREMENTAL',$3,'SAR','2020-01-01',now())`,
        [versionId, planId, rate]);
      plans[key] = { planId, versionId, baseRatePercent: rate };
    }

    // The rep and the manager are on different plans; finance is on none, which is what
    // makes "finance cannot approve their own commission" a real situation rather than a
    // contrived one.
    await db.query(
      `INSERT INTO "CommissionAssignment" (id,"employeeId","planId","planVersionId","effectiveFrom","createdAt")
       VALUES ($1,$2,$3,$4,'2020-01-01',now())`,
      [`${TAG}_asg_rep`, `${TAG}_emp_crmRep`, plans.standard.planId, plans.standard.versionId]);
    await db.query(
      `INSERT INTO "CommissionAssignment" (id,"employeeId","planId","planVersionId","effectiveFrom","createdAt")
       VALUES ($1,$2,$3,$4,'2020-01-01',now())`,
      [`${TAG}_asg_mgr`, `${TAG}_emp_crmManager`, plans.senior.planId, plans.senior.versionId]);
  });

  const catalog: Catalog = {
    beans, coffees, materials, skus, customers,
    crm: {
      stages: stages.map((s) => ({ id: s.id, code: s.code, nameEn: s.nameEn, nameAr: s.nameAr })),
      plans,
    },
  };
  writeFileSync(CATALOG_PATH, JSON.stringify(catalog, null, 2));
  console.log(
    `\n  UAT fixtures ready — ${Object.keys(ROLES).length} employees, 3 origins, 4 SKUs, ` +
    `4 materials, 3 customers, ${stages.length} pipeline stages, ` +
    `${Object.keys(plans).length} commission plans\n`
  );
}
