// End-to-end proof of the Finished Products chain:
//   GreenBean -> Roasting -> roasted stock -> BOM packing -> Finished Goods units
//   -> SKU sales order -> fulfilment split -> reservation -> release
// All fixtures are tagged E2E-FP and removed at the end.
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { BASE, DB_URL } from "./harness.mjs";  // importing enforces the test-database allowlist

const req = createRequire(import.meta.url);
const { Client } = req("pg");
const bcrypt = req("bcryptjs");
const fs = req("fs");

const TAG = "E2E-FP";
// Generated per run: this user is created and deleted by this suite, and a literal
// credential in a tracked file is a credential in a tracked file whatever it unlocks.
const PIN = String(100000 + Math.floor(Math.random() * 899999));
const EMP = "e2efp_admin";
const CUST = "e2efp_customer";
const BEAN = "e2efp_bean";
const COFFEE = "e2efp_coffee";
const perms = JSON.parse(
  fs.readFileSync(new URL("./fixtures/admin-permissions.json", import.meta.url), "utf8")
);

const db = new Client({ connectionString: DB_URL });
let cookie = "";
let pass = 0, fail = 0;
const failures = [];

function check(name, ok, detail = "") {
  if (ok) { pass++; console.log("  [PASS] " + name); }
  else { fail++; failures.push(name); console.log("  [FAIL] " + name + "  << " + detail); }
}
function section(t) { console.log("\n" + "=".repeat(78) + "\n" + t + "\n" + "=".repeat(78)); }

async function api(path, { method = "GET", body } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "manual",
  });
  for (const c of res.headers.getSetCookie?.() ?? []) if (c.startsWith("token=")) cookie = c.split(";")[0];
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, json };
}
const one = async (s, p) => (await db.query(s, p)).rows[0];

async function cleanup() {
  await db.query(`DELETE FROM "StockAllocation" WHERE "orderItemId" IN (SELECT oi.id FROM "OrderItem" oi JOIN "Order" o ON o.id=oi."orderId" WHERE o.notes LIKE $1)`, [TAG + "%"]);
  await db.query(`DELETE FROM "InventoryMovement" WHERE notes LIKE $1 OR "referenceEntityId" IN (SELECT id FROM "FinishedGoodsLot" WHERE "batchNumber" LIKE $1) OR "sourceDocId" IN (SELECT id FROM "RoastingBatch" WHERE "batchNumber" LIKE $1) OR "referenceEntityId" IN (SELECT id FROM "MaterialItem" WHERE code LIKE $1) OR "referenceEntityId" = $2`, [TAG + "%", BEAN]);
  await db.query(`DELETE FROM "FinishedGoodsLot" WHERE "batchNumber" LIKE $1 OR "packedFromBatchId" IN (SELECT id FROM "RoastingBatch" WHERE "batchNumber" LIKE $1)`, [TAG + "%"]);
  await db.query(`DELETE FROM "RoastingBatch" WHERE "batchNumber" LIKE $1`, [TAG + "%"]);
  await db.query(`DELETE FROM "ProductionOrder" WHERE "sourceOrderItemId" IN (SELECT oi.id FROM "OrderItem" oi JOIN "Order" o ON o.id=oi."orderId" WHERE o.notes LIKE $1)`, [TAG + "%"]);
  await db.query(`DELETE FROM "Order" WHERE notes LIKE $1`, [TAG + "%"]);
  await db.query(`DELETE FROM "BomComponent" WHERE "productSkuId" IN (SELECT id FROM "ProductSKU" WHERE "skuCode" LIKE $1)`, [TAG + "%"]);
  await db.query(`DELETE FROM "ProductSKU" WHERE "skuCode" LIKE $1`, [TAG + "%"]);
  await db.query(`DELETE FROM "MaterialItem" WHERE code LIKE $1`, [TAG + "%"]);
  await db.query(`DELETE FROM "CoffeeProduct" WHERE id=$1`, [COFFEE]);
  await db.query(`DELETE FROM "GreenBean" WHERE id=$1`, [BEAN]);
  await db.query(`DELETE FROM "Customer" WHERE id=$1`, [CUST]);
  await db.query(`DELETE FROM "Employee" WHERE id=$1`, [EMP]);
}

async function counts() {
  return await one(`SELECT (SELECT count(*) FROM "Order")::int o,(SELECT count(*) FROM "OrderItem")::int oi,
    (SELECT count(*) FROM "FinishedGoodsLot")::int f,(SELECT count(*) FROM "RoastingBatch")::int rb,
    (SELECT count(*) FROM "ProductSKU")::int sku,(SELECT count(*) FROM "MaterialItem")::int mi,
    (SELECT count(*) FROM "BomComponent")::int bom,(SELECT count(*) FROM "StockAllocation")::int sa,
    (SELECT count(*) FROM "GreenBean")::int gb,(SELECT count(*) FROM "CoffeeProduct")::int cp,
    (SELECT count(*) FROM "Employee")::int e,(SELECT count(*) FROM "Customer")::int c,
    (SELECT count(*) FROM "InventoryMovement")::int im,
    (SELECT count(*) FROM "ProductionOrder")::int po`);
}

async function main() {
  await db.connect();
  await cleanup();
  const before = await counts();
  console.log("baseline: " + JSON.stringify(before));

  // fixtures
  await db.query(`INSERT INTO "Employee" (id,name,pin,"pinHash",role,permissions,"defaultRoute",active,"preferredLanguage","createdAt","updatedAt")
    VALUES ($1,$2,$3,$4,'admin',$5,'/dashboard',true,'en',now(),now())`,
    [EMP, TAG + " Admin", bcrypt.hashSync(PIN, 10), createHash("sha256").update(PIN).digest("hex"), JSON.stringify(perms)]);
  await db.query(`INSERT INTO "Customer" (id,name,"createdAt","updatedAt") VALUES ($1,$2,now(),now())`, [CUST, TAG + " Customer"]);
  await db.query(`INSERT INTO "GreenBean" (id,"serialNumber","beanType",country,"quantityKg","isActive","receivedDate","createdAt","updatedAt")
    VALUES ($1,$2,'FP Test Bean','Brazil',100,true,now(),now(),now())`, [BEAN, TAG + "-BEAN"]);
  await db.query(`INSERT INTO "CoffeeProduct" (id,"productNameEn","countryEn","defaultGreenBeanId","expectedRoastLoss","createdAt","updatedAt")
    VALUES ($1,$2,'Brazil',$3,15,now(),now())`, [COFFEE, TAG + " Brazil Coffee", BEAN]);

  await api("/api/auth/login", { method: "POST", body: { method: "pin", pin: PIN } });

  section("1. MATERIALS - stocked packaging items the BOM can point at");
  const bag = await api("/api/materials", { method: "POST", body: { code: TAG + "-BAG-1KG", name: "1KG Coffee Bag", category: "PACKAGING", quantityOnHand: 50 } });
  const label = await api("/api/materials", { method: "POST", body: { code: TAG + "-LBL-BRA", name: "Brazil Label", category: "LABEL", quantityOnHand: 40 } });
  check("create bag material -> 201", bag.status === 201, JSON.stringify(bag.json).slice(0, 200));
  check("create label material -> 201", label.status === 201, JSON.stringify(label.json).slice(0, 200));
  const dupe = await api("/api/materials", { method: "POST", body: { code: TAG + "-BAG-1KG", name: "dupe" } });
  check("duplicate material code refused -> 409", dupe.status === 409, "status=" + dupe.status);

  section("2. PRODUCTS - one row per sellable SKU");
  const sku = await api("/api/products", { method: "POST", body: {
    productId: COFFEE, skuCode: TAG + "-BRA-1KG", name: "Brazil Coffee - 1 KG", weightGrams: 1000, price: 120,
  }});
  check("create SKU -> 201", sku.status === 201, JSON.stringify(sku.json).slice(0, 250));
  const skuId = sku.json?.id;
  if (!skuId) { console.log("FATAL: no SKU"); await finish(before); return; }
  const weightChange = await api(`/api/products/${skuId}`, { method: "PATCH", body: { weightGrams: 500 } });
  check("pack size is immutable once created -> 409", weightChange.status === 409, "status=" + weightChange.status);

  section("3. BOM - roasted coffee in kg + materials in pieces");
  const badBom = await api(`/api/products/${skuId}/bom`, { method: "PUT", body: { components: [
    { type: "ROASTED_COFFEE", materialItemId: bag.json.id, quantityPerUnit: 1 },
  ]}});
  check("coffee component without a coffeeProductId refused -> 400", badBom.status === 400, "status=" + badBom.status);

  const bom = await api(`/api/products/${skuId}/bom`, { method: "PUT", body: { components: [
    { type: "ROASTED_COFFEE", coffeeProductId: COFFEE, quantityPerUnit: 1 },
    { type: "MATERIAL", materialItemId: bag.json.id, quantityPerUnit: 1 },
    { type: "MATERIAL", materialItemId: label.json.id, quantityPerUnit: 1 },
  ]}});
  check("save BOM -> 200", bom.status === 200, JSON.stringify(bom.json).slice(0, 250));
  check("BOM has three components", bom.json?.components?.length === 3, "n=" + bom.json?.components?.length);

  section("4. ROASTING - green coffee becomes roasted stock");
  const batch = await api("/api/roasting-batches", { method: "POST", body: {
    greenBeanId: BEAN, productId: COFFEE, greenBeanQuantity: 12, roastedBeanQuantity: 10, wasteQuantity: 2,
  }});
  check("create stock roast -> 201", batch.status === 201, JSON.stringify(batch.json).slice(0, 250));
  const batchId = batch.json?.id;
  if (!batchId) { console.log("FATAL: no batch"); await finish(before); return; }
  await db.query(`UPDATE "RoastingBatch" SET "batchNumber"=$2 WHERE id=$1`, [batchId, TAG + "-B1"]);
  let rb = await one(`SELECT "roastedAvailableKg","roastedBeanQuantity",status FROM "RoastingBatch" WHERE id=$1`, [batchId]);
  check("roasted output becomes roasted stock (10kg)", Number(rb.roastedAvailableKg) === 10, "roastedAvailableKg=" + rb.roastedAvailableKg);
  const bean = await one(`SELECT "quantityKg" FROM "GreenBean" WHERE id=$1`, [BEAN]);
  check("green coffee consumed by roasting (100 -> 88)", Number(bean.quantityKg) === 88, "quantityKg=" + bean.quantityKg);

  section("5. PACKAGING - BOM turns roasted stock + materials into SKU units");
  const tooEarly = await api(`/api/roasting-batches/${batchId}/pack-sku`, { method: "POST", body: { productSkuId: skuId, units: 5 } });
  check("cannot pack before QC passes -> 409", tooEarly.status === 409, "status=" + tooEarly.status);

  await db.query(`UPDATE "RoastingBatch" SET status='Passed' WHERE id=$1`, [batchId]);

  const packTooMany = await api(`/api/roasting-batches/${batchId}/pack-sku`, { method: "POST", body: { productSkuId: skuId, units: 99 } });
  check("packing beyond roasted stock refused -> 409", packTooMany.status === 409, "status=" + packTooMany.status + " " + JSON.stringify(packTooMany.json).slice(0, 160));

  const packed = await api(`/api/roasting-batches/${batchId}/pack-sku`, { method: "POST", body: { productSkuId: skuId, units: 5 } });
  check("pack 5 units -> 201", packed.status === 201, JSON.stringify(packed.json).slice(0, 250));

  rb = await one(`SELECT "roastedAvailableKg" FROM "RoastingBatch" WHERE id=$1`, [batchId]);
  check("roasted stock drawn down by BOM (10 -> 5)", Number(rb.roastedAvailableKg) === 5, "roastedAvailableKg=" + rb.roastedAvailableKg);
  const bagRow = await one(`SELECT "quantityOnHand" FROM "MaterialItem" WHERE id=$1`, [bag.json.id]);
  const lblRow = await one(`SELECT "quantityOnHand" FROM "MaterialItem" WHERE id=$1`, [label.json.id]);
  check("bags consumed (50 -> 45)", Number(bagRow.quantityOnHand) === 45, "bags=" + bagRow.quantityOnHand);
  check("labels consumed (40 -> 35)", Number(lblRow.quantityOnHand) === 35, "labels=" + lblRow.quantityOnHand);
  const lot = await one(`SELECT "isUnitTracked","unitsProduced","unitsAvailable","unitsReserved","availableQty","reservedQty","quantityKg","roastingBatchId","packedFromBatchId" FROM "FinishedGoodsLot" WHERE "packedFromBatchId"=$1`, [batchId]);
  check("finished lot is unit-tracked", lot?.isUnitTracked === true, JSON.stringify(lot));
  check("lot holds 5 available units", Number(lot.unitsAvailable) === 5, "unitsAvailable=" + lot.unitsAvailable);
  check("legacy kg balances stay zero on a unit lot", Number(lot.availableQty) === 0 && Number(lot.reservedQty) === 0, `availableQty=${lot.availableQty} reservedQty=${lot.reservedQty}`);
  check("kg equivalent derived from units (5 x 1kg)", Number(lot.quantityKg) === 5, "quantityKg=" + lot.quantityKg);
  check("unit lot uses packedFromBatchId, not the legacy 1:1 link", lot.roastingBatchId === null && lot.packedFromBatchId === batchId, JSON.stringify({ r: lot.roastingBatchId, p: lot.packedFromBatchId }));

  const legacyBlocked = await api(`/api/roasting-batches/${batchId}/package`, { method: "PUT", body: { bags1kg: 1 } });
  check("legacy kg packing refused on a unit-packed batch -> 409", legacyBlocked.status === 409, "status=" + legacyBlocked.status);

  section("6. SALES ORDER - customer + product + quantity, nothing else");
  const beanLine = await api("/api/orders", { method: "POST", body: {
    customerId: CUST, notes: TAG + " legacy attempt", items: [{ beanTypeName: "FP Test Bean", quantityKg: 5, greenBeanId: BEAN }],
  }});
  check("bean-based line refused - SKU is required -> 400", beanLine.status === 400, "status=" + beanLine.status + " " + JSON.stringify(beanLine.json).slice(0, 160));

  const order = await api("/api/orders", { method: "POST", body: {
    customerId: CUST, notes: TAG + " sku order", items: [{ productSkuId: skuId, quantityUnits: 8 }],
  }});
  check("SKU order for 8 units -> 201", order.status === 201, JSON.stringify(order.json).slice(0, 250));
  const orderId = order.json?.id;
  const itemId = order.json?.items?.[0]?.id;
  const item = await one(`SELECT "quantityUnits","quantityKg","productSkuId","productId","beanTypeName" FROM "OrderItem" WHERE id=$1`, [itemId]);
  check("line stores 8 units", Number(item.quantityUnits) === 8, "quantityUnits=" + item.quantityUnits);
  check("kg derived from units (8 x 1kg)", Number(item.quantityKg) === 8, "quantityKg=" + item.quantityKg);
  check("SKU, coffee and name resolved automatically", item.productSkuId === skuId && item.productId === COFFEE && !!item.beanTypeName, JSON.stringify(item));
  check("order accepted despite only 5 units on the shelf (no green-coffee gate)", order.status === 201);

  section("7. FULFILMENT CHECK - shelf covers what it can, the rest is production");
  const preview = await api("/api/orders/fulfillment-preview", { method: "POST", body: {
    lines: [{ productSkuId: skuId, quantityUnits: 8 }],
  }});
  check("preview -> 200", preview.status === 200, JSON.stringify(preview.json).slice(0, 250));
  const row = preview.json?.lines?.[0];
  check("ordered 8", row?.orderedUnits === 8, JSON.stringify(row));
  check("available 5", row?.availableUnits === 5, "available=" + row?.availableUnits);
  check("allocated from shelf 5", row?.allocatedUnits === 5, "allocated=" + row?.allocatedUnits);
  check("production required 3 - only the shortfall", row?.productionRequiredUnits === 3, "production=" + row?.productionRequiredUnits);
  const reqComponents = row?.productionRequirement?.components ?? [];
  const coffeeReq = reqComponents.find((c) => c.type === "ROASTED_COFFEE");
  check("shortfall explodes through the BOM (3 x 1kg roasted)", coffeeReq?.quantityRequired === 3, JSON.stringify(reqComponents));
  const bagReq = reqComponents.find((c) => c.label.includes("1KG Coffee Bag"));
  check("shortfall needs 3 bags", bagReq?.quantityRequired === 3, JSON.stringify(bagReq));

  const twoLines = await api("/api/orders/fulfillment-preview", { method: "POST", body: {
    lines: [{ productSkuId: skuId, quantityUnits: 3 }, { productSkuId: skuId, quantityUnits: 4 }],
  }});
  const l1 = twoLines.json?.lines?.[0], l2 = twoLines.json?.lines?.[1];
  check("free stock is drawn down across lines, not double-promised",
    l1?.allocatedUnits === 3 && l2?.allocatedUnits === 2 && l2?.productionRequiredUnits === 2,
    JSON.stringify([l1, l2]));

  section("8. RESERVATION - preparation review holds units");
  await api(`/api/orders/${orderId}/approve`, { method: "POST", body: { decision: "Yes" } });
  const review = await api(`/api/orders/${orderId}/preparation-review`, { method: "POST", body: { items: [{ orderItemId: itemId }] } });
  check("preparation review -> 200", review.status === 200, JSON.stringify(review.json).slice(0, 250));
  const reviewed = await one(`SELECT "preparationDecision","availableQuantity","productionRequiredQuantity" FROM "OrderItem" WHERE id=$1`, [itemId]);
  check("decision is 'Partially Available'", reviewed.preparationDecision === "Partially Available", "decision=" + reviewed.preparationDecision);
  check("available recorded as 5kg (5 units x 1kg)", Number(reviewed.availableQuantity) === 5, "available=" + reviewed.availableQuantity);
  check("production required recorded as 3kg", Number(reviewed.productionRequiredQuantity) === 3, "required=" + reviewed.productionRequiredQuantity);
  const lotAfter = await one(`SELECT "unitsAvailable","unitsReserved" FROM "FinishedGoodsLot" WHERE "packedFromBatchId"=$1`, [batchId]);
  check("lot now shows 5 units reserved", Number(lotAfter.unitsReserved) === 5, JSON.stringify(lotAfter));
  const alloc = await one(`SELECT "quantityUnits","quantityKg" FROM "StockAllocation" WHERE "orderItemId"=$1 AND status='RESERVED'`, [itemId]);
  check("allocation row records units", Number(alloc.quantityUnits) === 5, JSON.stringify(alloc));
  check("allocation kg is derived, not independent", Number(alloc.quantityKg) === 5, JSON.stringify(alloc));

  const afterReserve = await api("/api/orders/fulfillment-preview", { method: "POST", body: { lines: [{ productSkuId: skuId, quantityUnits: 5 }] } });
  check("reserved units leave the free pool", afterReserve.json?.lines?.[0]?.availableUnits === 0, JSON.stringify(afterReserve.json?.lines?.[0]));

  section("8b. PRODUCTION REQUIREMENT - only the shortfall is scheduled");
  const reqView = await api(`/api/order-items/${itemId}/production-requirement`);
  check("requirement view -> 200", reqView.status === 200, JSON.stringify(reqView.json).slice(0, 250));
  check("ordered 8, reserved 5, shortfall 3",
    reqView.json?.orderedUnits === 8 && reqView.json?.reservedUnits === 5 && reqView.json?.shortfallUnits === 3,
    JSON.stringify(reqView.json).slice(0, 250));
  check("shortfall in kg is derived (3 x 1kg)", reqView.json?.shortfallKg === 3, "kg=" + reqView.json?.shortfallKg);

  const made = await api(`/api/order-items/${itemId}/production-requirement`, { method: "POST" });
  check("create production order -> 201", made.status === 201, JSON.stringify(made.json).slice(0, 250));
  check("targets 3 units, not the whole 8", made.json?.productionOrder?.targetUnits === 3, "targetUnits=" + made.json?.productionOrder?.targetUnits);
  check("target weight is the shortfall (3kg)", made.json?.productionOrder?.targetWeightKg === 3, "targetWeightKg=" + made.json?.productionOrder?.targetWeightKg);
  check("green bean draw accounts for roast loss (3 / 0.85 = 3.529)",
    Math.abs(Number(made.json?.productionOrder?.expectedGreenBeanKg) - 3.529) < 0.002,
    "expectedGreenBeanKg=" + made.json?.productionOrder?.expectedGreenBeanKg);

  const dupe2 = await api(`/api/order-items/${itemId}/production-requirement`, { method: "POST" });
  check("re-running does not stack a duplicate run -> 409", dupe2.status === 409, "status=" + dupe2.status);

  section("9. RELEASE - cancelling gives the units back");
  const cancel = await api(`/api/orders/${orderId}/status`, { method: "POST", body: { action: "cancel", reason: TAG + " done" } });
  check("cancel -> 200", cancel.status === 200, "status=" + cancel.status);
  const lotFinal = await one(`SELECT "unitsAvailable","unitsReserved" FROM "FinishedGoodsLot" WHERE "packedFromBatchId"=$1`, [batchId]);
  check("units released back to the shelf", Number(lotFinal.unitsReserved) === 0, JSON.stringify(lotFinal));

  section("10. GLOBAL INVARIANTS");
  const bad = await db.query(`SELECT id FROM "FinishedGoodsLot" WHERE "unitsReserved" > "unitsAvailable" OR "unitsAvailable" > "unitsProduced" OR "unitsReserved" < 0`);
  check("unit balances stay ordered everywhere", bad.rows.length === 0, "violations=" + bad.rows.length);
  const negMat = await db.query(`SELECT id FROM "MaterialItem" WHERE "quantityOnHand" < 0`);
  check("no negative material stock", negMat.rows.length === 0, "n=" + negMat.rows.length);
  const negRoast = await db.query(`SELECT id FROM "RoastingBatch" WHERE "roastedAvailableKg" < 0`);
  check("no negative roasted stock", negRoast.rows.length === 0, "n=" + negRoast.rows.length);
  const bothLinks = await db.query(`SELECT id FROM "FinishedGoodsLot" WHERE "roastingBatchId" IS NOT NULL AND "packedFromBatchId" IS NOT NULL`);
  check("no lot carries both batch links", bothLinks.rows.length === 0, "n=" + bothLinks.rows.length);

  await finish(before);
}

async function finish(before) {
  section("CLEANUP");
  await cleanup();
  const after = await counts();
  check("all fixtures removed - counts back to baseline",
    JSON.stringify(before) === JSON.stringify(after),
    "before=" + JSON.stringify(before) + "\n         after= " + JSON.stringify(after));
  console.log("\n" + pass + " passed, " + fail + " failed");
  if (failures.length) console.log("FAILED:\n  - " + failures.join("\n  - "));
  await db.end();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.log("FATAL:", e);
  try { await cleanup(); await db.end(); } catch {}
  process.exit(1);
});
