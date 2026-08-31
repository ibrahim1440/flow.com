import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
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

  await withDb(async (db) => {
    const q = (sql: string) => db.query(sql);
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
  });
}

export default async function globalSetup() {
  assertTestDatabase();
  await teardown();

  // ── Employees ────────────────────────────────────────────────────────────
  await withDb(async (db) => {
    for (const [key, r] of Object.entries(ROLES)) {
      await db.query(
        `INSERT INTO "Employee" (id,name,pin,"pinHash",role,permissions,"defaultRoute",active,"preferredLanguage","createdAt","updatedAt")
         VALUES ($1,$2,$3,$4,$5,$6,'/dashboard',true,'en',now(),now())`,
        [
          `${TAG}_emp_${key}`, r.name, hashSync(r.pin, 10),
          createHash("sha256").update(r.pin).digest("hex"),
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

  const catalog: Catalog = { beans, coffees, materials, skus, customers };
  writeFileSync(CATALOG_PATH, JSON.stringify(catalog, null, 2));
  console.log(`\n  UAT fixtures ready — 6 employees, 3 origins, 4 SKUs, 4 materials, 3 customers\n`);
}
