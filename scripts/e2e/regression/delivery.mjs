// Closes the loop: order in units -> reserve -> deliver in units -> stock and
// reservations settle correctly. Includes partial delivery and over-delivery guards.
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { BASE, DB_URL } from "./harness.mjs";  // importing enforces the test-database allowlist

const req = createRequire(import.meta.url);
const { Client } = req("pg");
const bcrypt = req("bcryptjs");
const fsx = req("fs");

const TAG = "E2E-DEL";
const PIN = String(100000 + Math.floor(Math.random() * 899999));
const EMP = "e2edel_admin", CUST = "e2edel_cust", BEAN = "e2edel_bean", COFFEE = "e2edel_coffee";
const perms = JSON.parse(
  fsx.readFileSync(new URL("./fixtures/admin-permissions.json", import.meta.url), "utf8")
);
const db = new Client({ connectionString: DB_URL });

let pass = 0, fail = 0; const failures = [];
const check = (n, ok, d = "") => { if (ok) { pass++; console.log("  [PASS] " + n); } else { fail++; failures.push(n); console.log("  [FAIL] " + n + "  << " + d); } };
const section = (t) => console.log("\n" + "=".repeat(74) + "\n" + t + "\n" + "=".repeat(74));
const one = async (s, p) => (await db.query(s, p)).rows[0];

let cookie = "";
async function api(path, { method = "GET", body } = {}) {
  const res = await fetch(BASE + path, {
    method, headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  for (const c of res.headers.getSetCookie?.() ?? []) if (c.startsWith("token=")) cookie = c.split(";")[0];
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, json };
}

async function cleanup() {
  await db.query(`DELETE FROM "StockAllocation" WHERE "orderItemId" IN (SELECT oi.id FROM "OrderItem" oi JOIN "Order" o ON o.id=oi."orderId" WHERE o.notes LIKE $1)`, [TAG + "%"]);
  await db.query(`DELETE FROM "Delivery" WHERE "orderItemId" IN (SELECT oi.id FROM "OrderItem" oi JOIN "Order" o ON o.id=oi."orderId" WHERE o.notes LIKE $1)`, [TAG + "%"]);
  await db.query(`DELETE FROM "InventoryMovement" WHERE notes LIKE $1 OR "sourceDocId" IN (SELECT id FROM "RoastingBatch" WHERE "batchNumber" LIKE $1) OR "referenceEntityId" IN (SELECT id FROM "MaterialItem" WHERE code LIKE $1) OR "referenceEntityId" = $2 OR "referenceEntityId" IN (SELECT id FROM "FinishedGoodsLot" WHERE "packedFromBatchId" IN (SELECT id FROM "RoastingBatch" WHERE "batchNumber" LIKE $1))`, [TAG + "%", BEAN]);
  await db.query(`DELETE FROM "FinishedGoodsLot" WHERE "packedFromBatchId" IN (SELECT id FROM "RoastingBatch" WHERE "batchNumber" LIKE $1)`, [TAG + "%"]);
  await db.query(`DELETE FROM "ProductionOrder" WHERE "sourceOrderItemId" IN (SELECT oi.id FROM "OrderItem" oi JOIN "Order" o ON o.id=oi."orderId" WHERE o.notes LIKE $1)`, [TAG + "%"]);
  await db.query(`DELETE FROM "RoastingBatch" WHERE "batchNumber" LIKE $1`, [TAG + "%"]);
  await db.query(`DELETE FROM "Order" WHERE notes LIKE $1`, [TAG + "%"]);
  await db.query(`DELETE FROM "BomComponent" WHERE "productSkuId" IN (SELECT id FROM "ProductSKU" WHERE "skuCode" LIKE $1)`, [TAG + "%"]);
  await db.query(`DELETE FROM "ProductSKU" WHERE "skuCode" LIKE $1`, [TAG + "%"]);
  await db.query(`DELETE FROM "MaterialItem" WHERE code LIKE $1`, [TAG + "%"]);
  await db.query(`DELETE FROM "CoffeeProduct" WHERE id=$1`, [COFFEE]);
  await db.query(`DELETE FROM "GreenBean" WHERE id=$1`, [BEAN]);
  await db.query(`DELETE FROM "Customer" WHERE id=$1`, [CUST]);
  await db.query(`DELETE FROM "Employee" WHERE id=$1`, [EMP]);
}
const counts = () => one(`SELECT (SELECT count(*) FROM "Order")::int o,(SELECT count(*) FROM "OrderItem")::int oi,
  (SELECT count(*) FROM "Delivery")::int d,(SELECT count(*) FROM "FinishedGoodsLot")::int f,
  (SELECT count(*) FROM "StockAllocation")::int sa,(SELECT count(*) FROM "ProductSKU")::int sku,
  (SELECT count(*) FROM "CoffeeProduct")::int cp,(SELECT count(*) FROM "GreenBean")::int gb,
  (SELECT count(*) FROM "MaterialItem")::int mi,(SELECT count(*) FROM "Employee")::int e,
  (SELECT count(*) FROM "Customer")::int c,(SELECT count(*) FROM "RoastingBatch")::int rb`);

async function main() {
  await db.connect();
  await cleanup();
  const before = await counts();
  console.log("baseline: " + JSON.stringify(before));

  await db.query(`INSERT INTO "Employee" (id,name,pin,"pinHash",role,permissions,"defaultRoute",active,"preferredLanguage","createdAt","updatedAt")
    VALUES ($1,'E2E Delivery',$2,$3,'admin',$4,'/dashboard',true,'en',now(),now())`,
    [EMP, bcrypt.hashSync(PIN, 10), createHash("sha256").update(PIN).digest("hex"), JSON.stringify(perms)]);
  await db.query(`INSERT INTO "Customer" (id,name,"createdAt","updatedAt") VALUES ($1,$2,now(),now())`, [CUST, TAG + " Cust"]);
  await db.query(`INSERT INTO "GreenBean" (id,"serialNumber","beanType",country,"quantityKg","isActive","receivedDate","createdAt","updatedAt")
    VALUES ($1,$2,'Del Bean','BR',100,true,now(),now(),now())`, [BEAN, TAG + "-B"]);
  await db.query(`INSERT INTO "CoffeeProduct" (id,"productNameEn","countryEn","defaultGreenBeanId","expectedRoastLoss","createdAt","updatedAt")
    VALUES ($1,$2,'BR',$3,15,now(),now())`, [COFFEE, TAG + " Coffee", BEAN]);

  await api("/api/auth/login", { method: "POST", body: { method: "pin", pin: PIN } });
  const bag = await api("/api/materials", { method: "POST", body: { code: TAG + "-BAG", name: "Del Bag", quantityOnHand: 50 } });
  const sku = await api("/api/products", { method: "POST", body: { productId: COFFEE, skuCode: TAG + "-1KG", name: TAG + " 1KG", weightGrams: 1000, price: 90 } });
  const skuId = sku.json.id;
  await api(`/api/products/${skuId}/bom`, { method: "PUT", body: { components: [
    { type: "ROASTED_COFFEE", coffeeProductId: COFFEE, quantityPerUnit: 1 },
    { type: "MATERIAL", materialItemId: bag.json.id, quantityPerUnit: 1 },
  ]}});
  const batch = await api("/api/roasting-batches", { method: "POST", body: { greenBeanId: BEAN, productId: COFFEE, greenBeanQuantity: 14, roastedBeanQuantity: 12, wasteQuantity: 2 } });
  const batchId = batch.json.id;
  await db.query(`UPDATE "RoastingBatch" SET status='Passed',"batchNumber"=$2 WHERE id=$1`, [batchId, TAG + "-B1"]);
  await api(`/api/roasting-batches/${batchId}/pack-sku`, { method: "POST", body: { productSkuId: skuId, units: 10 } });
  const lot = await one(`SELECT id,"unitsAvailable","unitsReserved" FROM "FinishedGoodsLot" WHERE "packedFromBatchId"=$1`, [batchId]);
  console.log("packed lot: " + JSON.stringify(lot));

  section("SETUP — order 6 units, reserve them");
  const order = await api("/api/orders", { method: "POST", body: { customerId: CUST, notes: TAG + " order", items: [{ productSkuId: skuId, quantityUnits: 6 }] } });
  const orderId = order.json.id, itemId = order.json.items[0].id;
  await api(`/api/orders/${orderId}/approve`, { method: "POST", body: { decision: "Yes" } });
  await api(`/api/orders/${orderId}/preparation-review`, { method: "POST", body: { items: [{ orderItemId: itemId }] } });
  let l = await one(`SELECT "unitsAvailable","unitsReserved" FROM "FinishedGoodsLot" WHERE id=$1`, [lot.id]);
  check("6 of 10 units reserved", Number(l.unitsReserved) === 6 && Number(l.unitsAvailable) === 10, JSON.stringify(l));

  section("1. VALIDATION");
  let r = await api("/api/deliveries", { method: "POST", body: { orderItemId: itemId, quantityUnits: 0, deliveryType: "partial", finishedGoodsLotId: lot.id } });
  check("zero units refused -> 400", r.status === 400, "status=" + r.status);
  r = await api("/api/deliveries", { method: "POST", body: { orderItemId: itemId, quantityUnits: 2.5, deliveryType: "partial", finishedGoodsLotId: lot.id } });
  check("fractional units refused -> 400", r.status === 400, "status=" + r.status);
  r = await api("/api/deliveries", { method: "POST", body: { orderItemId: itemId, quantityUnits: 99, deliveryType: "full", finishedGoodsLotId: lot.id } });
  check("more than ordered refused -> 400", r.status === 400, "status=" + r.status + " " + JSON.stringify(r.json).slice(0, 120));

  section("2. PARTIAL DELIVERY — 4 of 6");
  r = await api("/api/deliveries", { method: "POST", body: { orderItemId: itemId, quantityUnits: 4, deliveryType: "partial", finishedGoodsLotId: lot.id } });
  check("deliver 4 units -> 200/201", r.status === 200 || r.status === 201, "status=" + r.status + " " + JSON.stringify(r.json).slice(0, 160));

  let item = await one(`SELECT "deliveredUnits","deliveredQty","deliveryStatus" FROM "OrderItem" WHERE id=$1`, [itemId]);
  check("deliveredUnits = 4", Number(item.deliveredUnits) === 4, JSON.stringify(item));
  check("deliveredQty derived = 4 kg", Number(item.deliveredQty) === 4, "kg=" + item.deliveredQty);
  check("status = Partial Delivered", item.deliveryStatus === "Partial Delivered", item.deliveryStatus);

  l = await one(`SELECT "unitsAvailable","unitsReserved",status FROM "FinishedGoodsLot" WHERE id=$1`, [lot.id]);
  check("lot units 10 -> 6", Number(l.unitsAvailable) === 6, JSON.stringify(l));
  check("reservation 6 -> 2 (only the shipped part spent)", Number(l.unitsReserved) === 2, JSON.stringify(l));
  check("lot still AVAILABLE", l.status === "AVAILABLE", l.status);

  const consumed = await one(`SELECT COALESCE(SUM("quantityUnits"),0)::int u FROM "StockAllocation" WHERE "orderItemId"=$1 AND status='CONSUMED'`, [itemId]);
  check("4 units booked as CONSUMED", Number(consumed.u) === 4, JSON.stringify(consumed));

  const del = await one(`SELECT "quantityUnits","quantityKg" FROM "Delivery" WHERE "orderItemId"=$1`, [itemId]);
  check("delivery row stores units and derived kg", Number(del.quantityUnits) === 4 && Number(del.quantityKg) === 4, JSON.stringify(del));

  const mv = await one(`SELECT "quantityChanged","previousQuantity","newQuantity" FROM "InventoryMovement" WHERE "sourceDocType"='DELIVERY' AND "referenceEntityId"=$1 ORDER BY timestamp DESC LIMIT 1`, [lot.id]);
  check("ledger records -4 kg (10 -> 6)", mv && Number(mv.quantityChanged) === -4 && Number(mv.previousQuantity) === 10 && Number(mv.newQuantity) === 6, JSON.stringify(mv));

  section("3. FINAL DELIVERY — remaining 2");
  r = await api("/api/deliveries", { method: "POST", body: { orderItemId: itemId, quantityUnits: 2, deliveryType: "full", finishedGoodsLotId: lot.id } });
  check("deliver remaining 2 -> ok", r.status === 200 || r.status === 201, "status=" + r.status);
  item = await one(`SELECT "deliveredUnits","deliveryStatus" FROM "OrderItem" WHERE id=$1`, [itemId]);
  check("deliveredUnits = 6, status Delivered", Number(item.deliveredUnits) === 6 && item.deliveryStatus === "Delivered", JSON.stringify(item));
  l = await one(`SELECT "unitsAvailable","unitsReserved" FROM "FinishedGoodsLot" WHERE id=$1`, [lot.id]);
  check("lot units 6 -> 4, reservation fully spent", Number(l.unitsAvailable) === 4 && Number(l.unitsReserved) === 0, JSON.stringify(l));

  r = await api("/api/deliveries", { method: "POST", body: { orderItemId: itemId, quantityUnits: 1, deliveryType: "full", finishedGoodsLotId: lot.id } });
  check("delivering a completed line refused -> 400", r.status === 400, "status=" + r.status);

  section("4. THE 4 LEFT OVER ARE FREE AGAIN");
  const preview = await api("/api/orders/fulfillment-preview", { method: "POST", body: { lines: [{ productSkuId: skuId, quantityUnits: 4 }] } });
  check("remaining 4 units are free to promise", preview.json?.lines?.[0]?.availableUnits === 4, JSON.stringify(preview.json?.lines?.[0]));

  section("INVARIANTS");
  const bad = await db.query(`SELECT id FROM "FinishedGoodsLot" WHERE "unitsReserved">"unitsAvailable" OR "unitsAvailable">"unitsProduced" OR "unitsReserved"<0`);
  check("unit balances stay ordered", bad.rows.length === 0, "n=" + bad.rows.length);
  const orphan = await db.query(`SELECT f.id FROM "FinishedGoodsLot" f LEFT JOIN "StockAllocation" sa ON sa."finishedGoodsLotId"=f.id AND sa.status='RESERVED' AND sa."quantityUnits" IS NOT NULL
    WHERE f."isUnitTracked" GROUP BY f.id,f."unitsReserved" HAVING f."unitsReserved" IS DISTINCT FROM COALESCE(SUM(sa."quantityUnits"),0)`);
  check("unitsReserved reconciles with RESERVED allocations", orphan.rows.length === 0, "mismatches=" + orphan.rows.length);

  section("CLEANUP");
  await cleanup();
  const after = await counts();
  check("database back to baseline", JSON.stringify(before) === JSON.stringify(after), "before=" + JSON.stringify(before) + "\n           after= " + JSON.stringify(after));

  console.log("\n" + pass + " passed, " + fail + " failed");
  if (failures.length) console.log("FAILED:\n  - " + failures.join("\n  - "));
  await db.end();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.log("FATAL:", e?.message || e);
  try { await cleanup(); await db.end(); } catch {}
  process.exit(1);
});
