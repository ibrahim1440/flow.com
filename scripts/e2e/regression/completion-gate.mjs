// COMPLETION DELIVERY GATE — DEF-001 regression suite.
//
// The defect this covers: an order could be moved to "Completed" purely on the strength of
// its status and the caller's authority. Reaching "Ready for Shipping" only says the shelf
// can cover the order, so an order with nothing delivered could be closed as fulfilled —
// and the release that runs immediately after completion handed its reserved coffee back
// to the free pool, leaving a Completed order with deliveredUnits = 0, no Delivery rows,
// and nothing in the ledger recording that it had never shipped.
//
// Written against the API directly. The UI is defence in depth; the server is the
// authority, and the server is what has to refuse a hand-rolled request.
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { BASE, DB_URL } from "./harness.mjs";  // importing enforces the test-database allowlist

const req = createRequire(import.meta.url);
const { Client } = req("pg");
const bcrypt = req("bcryptjs");
const fsx = req("fs");

const TAG = "E2E-CMPL";
const PIN = String(100000 + Math.floor(Math.random() * 899999));
const PIN_NOSTATUS = String(200000 + Math.floor(Math.random() * 99999));
const PIN_NOTOWNER = String(300000 + Math.floor(Math.random() * 99999));
const EMP = "e2ecmpl_admin", EMP_NOSTATUS = "e2ecmpl_nostatus", EMP_NOTOWNER = "e2ecmpl_notowner";
const CUST = "e2ecmpl_cust", BEAN = "e2ecmpl_bean", COFFEE = "e2ecmpl_coffee";

const adminPerms = JSON.parse(
  fsx.readFileSync(new URL("./fixtures/admin-permissions.json", import.meta.url), "utf8")
);
// Same shape, with exactly one privilege withheld / granted, so the authorization
// assertions below isolate the rule under test rather than a blanket module denial.
const withoutManageStatus = JSON.parse(JSON.stringify(adminPerms));
if (withoutManageStatus.orders?.sub) withoutManageStatus.orders.sub.manage_status = false;
const manageStatusOnly = JSON.parse(JSON.stringify(adminPerms));

const db = new Client({ connectionString: DB_URL });

let pass = 0, fail = 0; const failures = [];
const seen = { http500: 0, deadlock: 0 };
const check = (n, ok, d = "") => { if (ok) { pass++; console.log("  [PASS] " + n); } else { fail++; failures.push(n); console.log("  [FAIL] " + n + "  << " + d); } };
const section = (t) => console.log("\n" + "=".repeat(74) + "\n" + t + "\n" + "=".repeat(74));
const one = async (s, p) => (await db.query(s, p)).rows[0];
const S = (v) => { try { return JSON.stringify(v) ?? String(v); } catch { return String(v); } };

let cookie = "";
async function api(path, { method = "GET", body } = {}) {
  const res = await fetch(BASE + path, {
    method, headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  for (const c of res.headers.getSetCookie?.() ?? []) if (c.startsWith("token=")) cookie = c.split(";")[0];
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  // Global counters the suite asserts on at the end: neither is ever an acceptable
  // outcome, including on the deliberately refused calls.
  if (res.status >= 500) seen.http500++;
  if (/40P01|deadlock detected/i.test(text)) seen.deadlock++;
  return { status: res.status, json };
}
const login = (pin) => { cookie = ""; return api("/api/auth/login", { method: "POST", body: { method: "pin", pin } }); };

const complete = (orderId) => api(`/api/orders/${orderId}/status`, { method: "POST", body: { action: "complete" } });
const deliver = (itemId, lotId, units, type = "partial") =>
  api("/api/deliveries", { method: "POST", body: { orderItemId: itemId, quantityUnits: units, deliveryType: type, finishedGoodsLotId: lotId } });
const orderStatus = async (id) => (await one('SELECT status s FROM "Order" WHERE id=$1', [id])).s;
const completedActivities = async (id) =>
  Number((await one(`SELECT COUNT(*)::int n FROM "OrderActivity" WHERE "orderId"=$1 AND type='ORDER_COMPLETED'`, [id])).n);
const reservedUnits = async (itemId) =>
  Number((await one(`SELECT COALESCE(SUM("quantityUnits"),0)::int u FROM "StockAllocation" WHERE "orderItemId"=$1 AND status='RESERVED'`, [itemId])).u);
const itemRow = (itemId) =>
  one(`SELECT "quantityUnits" q,"deliveredUnits" d,"deliveryStatus" ds FROM "OrderItem" WHERE id=$1`, [itemId]);

async function cleanup() {
  await db.query(`DELETE FROM "StockAllocation" WHERE "orderItemId" IN (SELECT oi.id FROM "OrderItem" oi JOIN "Order" o ON o.id=oi."orderId" WHERE o.notes LIKE $1)`, [TAG + "%"]);
  await db.query(`DELETE FROM "Delivery" WHERE "orderItemId" IN (SELECT oi.id FROM "OrderItem" oi JOIN "Order" o ON o.id=oi."orderId" WHERE o.notes LIKE $1)`, [TAG + "%"]);
  await db.query(`DELETE FROM "OrderActivity" WHERE "orderId" IN (SELECT id FROM "Order" WHERE notes LIKE $1)`, [TAG + "%"]);
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
  await db.query(`DELETE FROM "Employee" WHERE id = ANY($1)`, [[EMP, EMP_NOSTATUS, EMP_NOTOWNER]]);
}

const mkEmployee = (id, name, perms, pin, role = "admin") =>
  db.query(`INSERT INTO "Employee" (id,name,pin,"pinHash",role,permissions,"defaultRoute",active,"preferredLanguage","createdAt","updatedAt")
            VALUES ($1,$2,$3,$4,$5,$6,'/dashboard',true,'en',now(),now())`,
    [id, name, bcrypt.hashSync(pin, 10), createHash("sha256").update(pin).digest("hex"), role, JSON.stringify(perms)]);

async function main() {
  await db.connect();
  await cleanup();

  await mkEmployee(EMP, TAG + " Admin", adminPerms, PIN, "admin");
  await mkEmployee(EMP_NOSTATUS, TAG + " NoStatus", withoutManageStatus, PIN_NOSTATUS, "custom");
  await mkEmployee(EMP_NOTOWNER, TAG + " NotOwner", manageStatusOnly, PIN_NOTOWNER, "custom");
  await db.query(`INSERT INTO "Customer" (id,name,"createdAt","updatedAt") VALUES ($1,$2,now(),now())`, [CUST, TAG + " Cust"]);
  await db.query(`INSERT INTO "GreenBean" (id,"serialNumber","beanType",country,"quantityKg","isActive","receivedDate","createdAt","updatedAt")
    VALUES ($1,$2,'Cmpl Bean','BR',200,true,now(),now(),now())`, [BEAN, TAG + "-B"]);
  await db.query(`INSERT INTO "CoffeeProduct" (id,"productNameEn","countryEn","defaultGreenBeanId","expectedRoastLoss","createdAt","updatedAt")
    VALUES ($1,$2,'BR',$3,15,now(),now())`, [COFFEE, TAG + " Coffee", BEAN]);

  await login(PIN);
  const bag = await api("/api/materials", { method: "POST", body: { code: TAG + "-BAG", name: "Cmpl Bag", quantityOnHand: 200 } });
  const skuA = await api("/api/products", { method: "POST", body: { productId: COFFEE, skuCode: TAG + "-1KG", name: TAG + " 1KG", weightGrams: 1000, price: 90 } });
  const skuB = await api("/api/products", { method: "POST", body: { productId: COFFEE, skuCode: TAG + "-500G", name: TAG + " 500G", weightGrams: 500, price: 50 } });
  for (const s of [skuA, skuB]) {
    await api(`/api/products/${s.json.id}/bom`, { method: "PUT", body: { components: [
      { type: "ROASTED_COFFEE", coffeeProductId: COFFEE, quantityPerUnit: s === skuA ? 1 : 0.5 },
      { type: "MATERIAL", materialItemId: bag.json.id, quantityPerUnit: 1 },
    ]}});
  }
  const batch = await api("/api/roasting-batches", { method: "POST", body: { greenBeanId: BEAN, productId: COFFEE, greenBeanQuantity: 70, roastedBeanQuantity: 60, wasteQuantity: 10 } });
  await db.query(`UPDATE "RoastingBatch" SET status='Passed',"batchNumber"=$2 WHERE id=$1`, [batch.json.id, TAG + "-B1"]);
  await api(`/api/roasting-batches/${batch.json.id}/pack-sku`, { method: "POST", body: { productSkuId: skuA.json.id, units: 30 } });
  await api(`/api/roasting-batches/${batch.json.id}/pack-sku`, { method: "POST", body: { productSkuId: skuB.json.id, units: 20 } });
  const lotA = await one(`SELECT id FROM "FinishedGoodsLot" WHERE "packedFromBatchId"=$1 AND "productSkuId"=$2`, [batch.json.id, skuA.json.id]);
  const lotB = await one(`SELECT id FROM "FinishedGoodsLot" WHERE "packedFromBatchId"=$1 AND "productSkuId"=$2`, [batch.json.id, skuB.json.id]);

  const mkOrder = async (note, items) => {
    const r = await api("/api/orders", { method: "POST", body: { customerId: CUST, notes: `${TAG} ${note}`, items } });
    if (r.status !== 201) throw new Error("order create failed: " + S(r.json));
    await api(`/api/orders/${r.json.id}/approve`, { method: "POST", body: { decision: "Yes" } });
    await api(`/api/orders/${r.json.id}/preparation-review`, { method: "POST", body: { items: r.json.items.map((i) => ({ orderItemId: i.id })) } });
    return r.json;
  };

  // ══════════════════════════════════════════════════════════════════════════
  section("1. ZERO-DELIVERY COMPLETION IS REFUSED");
  const o1 = await mkOrder("zero delivery", [{ productSkuId: skuA.json.id, quantityUnits: 6 }]);
  const i1 = o1.items[0].id;
  check("order is Ready for Shipping before the attempt", (await orderStatus(o1.id)) === "Ready for Shipping");
  check("6 units reserved before the attempt", (await reservedUnits(i1)) === 6, `reserved=${await reservedUnits(i1)}`);

  const r1 = await complete(o1.id);
  check("complete with nothing delivered refused -> 409", r1.status === 409, `status=${r1.status} ${S(r1.json).slice(0, 160)}`);
  check("the refusal names the outstanding quantity", /not been delivered in full|outstanding/i.test(S(r1.json)), S(r1.json).slice(0, 160));
  check("order is NOT Completed", (await orderStatus(o1.id)) !== "Completed", await orderStatus(o1.id));
  check("order still Ready for Shipping", (await orderStatus(o1.id)) === "Ready for Shipping");
  check("a refused completion releases no reservation", (await reservedUnits(i1)) === 6, `reserved=${await reservedUnits(i1)}`);
  check("a refused completion writes no ORDER_COMPLETED activity", (await completedActivities(o1.id)) === 0);

  // ══════════════════════════════════════════════════════════════════════════
  section("2. PARTIAL-DELIVERY COMPLETION IS REFUSED");
  const d1 = await deliver(i1, lotA.id, 2);
  check("deliver 2 of 6 -> 201", d1.status === 201, `status=${d1.status} ${S(d1.json).slice(0, 140)}`);
  const r2 = await complete(o1.id);
  check("complete with 2 of 6 delivered refused -> 409", r2.status === 409, `status=${r2.status} ${S(r2.json).slice(0, 160)}`);
  check("order still not Completed", (await orderStatus(o1.id)) !== "Completed", await orderStatus(o1.id));
  check("the remaining 4 units stay reserved", (await reservedUnits(i1)) === 4, `reserved=${await reservedUnits(i1)}`);

  // ══════════════════════════════════════════════════════════════════════════
  section("3. FULLY DELIVERED COMPLETION SUCCEEDS");
  const d2 = await deliver(i1, lotA.id, 4, "full");
  check("deliver the remaining 4 -> 201", d2.status === 201, `status=${d2.status} ${S(d2.json).slice(0, 140)}`);
  const line1 = await itemRow(i1);
  check("line reads 6/6 Delivered", Number(line1.d) === 6 && line1.ds === "Delivered", S(line1));
  const r3 = await complete(o1.id);
  check("complete once fully delivered -> 200", r3.status === 200, `status=${r3.status} ${S(r3.json).slice(0, 160)}`);
  check("order is Completed", (await orderStatus(o1.id)) === "Completed", await orderStatus(o1.id));
  check("exactly one ORDER_COMPLETED activity", (await completedActivities(o1.id)) === 1, `n=${await completedActivities(o1.id)}`);
  check("a completed order holds no reservation", (await reservedUnits(i1)) === 0, `reserved=${await reservedUnits(i1)}`);

  // ══════════════════════════════════════════════════════════════════════════
  section("4. DUPLICATE COMPLETION IS SAFE");
  const r4 = await complete(o1.id);
  check("second complete refused -> 409", r4.status === 409, `status=${r4.status} ${S(r4.json).slice(0, 160)}`);
  check("still exactly one ORDER_COMPLETED activity", (await completedActivities(o1.id)) === 1, `n=${await completedActivities(o1.id)}`);
  check("order still Completed", (await orderStatus(o1.id)) === "Completed");

  // ══════════════════════════════════════════════════════════════════════════
  section("5. MULTI-LINE: ONE UNDELIVERED LINE BLOCKS COMPLETION");
  const o2 = await mkOrder("multi line", [
    { productSkuId: skuA.json.id, quantityUnits: 3 },
    { productSkuId: skuB.json.id, quantityUnits: 4 },
  ]);
  const [m1, m2] = o2.items.map((i) => i.id);
  const dm1 = await deliver(m1, lotA.id, 3, "full");
  check("first line fully delivered -> 201", dm1.status === 201, `status=${dm1.status}`);
  const r5 = await complete(o2.id);
  check("complete with one line undelivered refused -> 409", r5.status === 409, `status=${r5.status} ${S(r5.json).slice(0, 180)}`);
  check("the refusal counts 1 of 2 lines", /1 of 2 line/.test(S(r5.json)), S(r5.json).slice(0, 180));
  check("multi-line order not Completed", (await orderStatus(o2.id)) !== "Completed", await orderStatus(o2.id));
  check("the undelivered line keeps its reservation", (await reservedUnits(m2)) === 4, `reserved=${await reservedUnits(m2)}`);

  const dm2 = await deliver(m2, lotB.id, 4, "full");
  check("second line fully delivered -> 201", dm2.status === 201, `status=${dm2.status}`);
  const r5b = await complete(o2.id);
  check("complete once every line is delivered -> 200", r5b.status === 200, `status=${r5b.status} ${S(r5b.json).slice(0, 160)}`);
  check("multi-line order is Completed", (await orderStatus(o2.id)) === "Completed");

  // ══════════════════════════════════════════════════════════════════════════
  section("6. AUTHORIZATION IS UNCHANGED");
  const o3 = await mkOrder("authz", [{ productSkuId: skuA.json.id, quantityUnits: 2 }]);
  const i3 = o3.items[0].id;
  await deliver(i3, lotA.id, 2, "full");

  await login(PIN_NOSTATUS);
  const rAuthz = await complete(o3.id);
  check("without orders.manage_status refused -> 403", rAuthz.status === 403, `status=${rAuthz.status} ${S(rAuthz.json).slice(0, 140)}`);

  await login(PIN_NOTOWNER);
  const rOwner = await complete(o3.id);
  check("with manage_status but neither owner nor admin refused -> 403", rOwner.status === 403, `status=${rOwner.status} ${S(rOwner.json).slice(0, 140)}`);
  check("neither authorization refusal completed the order", (await orderStatus(o3.id)) !== "Completed", await orderStatus(o3.id));

  await login(PIN);
  const rOwnerOk = await complete(o3.id);
  check("the owner CAN complete a fully delivered order -> 200", rOwnerOk.status === 200, `status=${rOwnerOk.status} ${S(rOwnerOk.json).slice(0, 140)}`);

  // ══════════════════════════════════════════════════════════════════════════
  section("7. INCONSISTENT DATA THE API CANNOT PRODUCE — the gate must fail closed");
  // These states cannot be reached through the routes: delivery refuses over-shipment, and
  // both delivery paths trim reservations to remaining demand. They are written directly
  // because that is precisely what an integrity gate is for — historical rows, a bad
  // migration, a manual repair. The gate must not wave them through on the strength of
  // "the API makes this impossible".
  const o5 = await mkOrder("over delivered", [{ productSkuId: skuA.json.id, quantityUnits: 2 }]);
  const i5 = o5.items[0].id;
  await deliver(i5, lotA.id, 2, "full");
  check("baseline: exactly delivered order completes", (await complete(o5.id)).status === 200);

  const o6 = await mkOrder("over delivered units", [{ productSkuId: skuA.json.id, quantityUnits: 2 }]);
  const i6 = o6.items[0].id;
  await deliver(i6, lotA.id, 2, "full");
  await db.query('UPDATE "OrderItem" SET "deliveredUnits"="deliveredUnits"+1 WHERE id=$1', [i6]);
  const rOver = await complete(o6.id);
  check("over-delivered unit line refused -> 409", rOver.status === 409, `status=${rOver.status} ${S(rOver.json).slice(0, 180)}`);
  check("refusal distinguishes over-delivery from a shortfall", /delivered against/.test(S(rOver.json)), S(rOver.json).slice(0, 180));
  check("over-delivered order not Completed", (await orderStatus(o6.id)) !== "Completed", await orderStatus(o6.id));
  check("no ORDER_COMPLETED written for the over-delivered order", (await completedActivities(o6.id)) === 0);
  await db.query('UPDATE "OrderItem" SET "deliveredUnits"="deliveredUnits"-1 WHERE id=$1', [i6]);
  check("once corrected, the same order completes -> 200", (await complete(o6.id)).status === 200);

  // Legacy kilogram line: quantityUnits NULL, kg authoritative.
  const o7 = await mkOrder("legacy kg over", [{ productSkuId: skuA.json.id, quantityUnits: 2 }]);
  const i7 = o7.items[0].id;
  await deliver(i7, lotA.id, 2, "full");
  await db.query('UPDATE "OrderItem" SET "quantityUnits"=NULL,"deliveredUnits"=0,"quantityKg"=2,"deliveredQty"=3 WHERE id=$1', [i7]);
  const rLegacyOver = await complete(o7.id);
  check("over-delivered LEGACY kg line refused -> 409", rLegacyOver.status === 409, `status=${rLegacyOver.status} ${S(rLegacyOver.json).slice(0, 180)}`);
  check("legacy refusal is stated in kg", /kg delivered against/.test(S(rLegacyOver.json)), S(rLegacyOver.json).slice(0, 180));
  await db.query('UPDATE "OrderItem" SET "deliveredQty"=2 WHERE id=$1', [i7]);
  check("legacy line delivered exactly in kg completes -> 200", (await complete(o7.id)).status === 200);

  // A fully delivered order that still holds a live reservation.
  const o8 = await mkOrder("stranded reservation", [{ productSkuId: skuA.json.id, quantityUnits: 2 }]);
  const i8 = o8.items[0].id;
  await deliver(i8, lotA.id, 2, "full");
  check("delivery consumed the reservation", (await reservedUnits(i8)) === 0, `reserved=${await reservedUnits(i8)}`);
  // Insert the anomaly: an allocation row left RESERVED against a delivered line. The lot
  // counter is deliberately not touched — that drift is the shape the anomaly really takes.
  await db.query(
    `INSERT INTO "StockAllocation" (id,"orderItemId","finishedGoodsLotId","quantityKg","quantityUnits",status,"createdAt","updatedAt")
     VALUES ($1,$2,$3,1,1,'RESERVED',now(),now())`,
    [TAG + "-stranded", i8, lotA.id]);
  check("anomaly in place: 1 unit reserved on a delivered line", (await reservedUnits(i8)) === 1);

  const rStranded = await complete(o8.id);
  check("fully delivered order holding a reservation refused -> 409", rStranded.status === 409, `status=${rStranded.status} ${S(rStranded.json).slice(0, 200)}`);
  check("refusal names the stranded reservation", /still reserved to it/.test(S(rStranded.json)), S(rStranded.json).slice(0, 200));
  check("refusal says it was left untouched", /untouched for investigation/.test(S(rStranded.json)), S(rStranded.json).slice(0, 200));
  check("the refused completion did NOT release the reservation", (await reservedUnits(i8)) === 1, `reserved=${await reservedUnits(i8)}`);
  check("the refused completion did not change order status", (await orderStatus(o8.id)) === "Ready for Shipping", await orderStatus(o8.id));
  check("the refused completion wrote no ORDER_COMPLETED activity", (await completedActivities(o8.id)) === 0);

  // Cancel keeps its own contract: it still releases, including this stranded row.
  const cancelStranded = await api(`/api/orders/${o8.id}/status`, { method: "POST", body: { action: "cancel", reason: TAG + " release the anomaly" } });
  check("cancel still succeeds on the same order -> 200", cancelStranded.status === 200, `status=${cancelStranded.status}`);
  check("cancel released the reservation as before", (await reservedUnits(i8)) === 0, `reserved=${await reservedUnits(i8)}`);
  check("cancel left the order Cancelled", (await orderStatus(o8.id)) === "Cancelled", await orderStatus(o8.id));

  // ══════════════════════════════════════════════════════════════════════════
  section("8. CONCURRENCY — final delivery racing completion");
  // The gate reads deliveredUnits after taking FOR UPDATE on every OrderItem of the order,
  // so the two transactions serialise on the same rows. Either ordering is acceptable; what
  // must never happen is a Completed order whose lines are short.
  const o4 = await mkOrder("race", [{ productSkuId: skuA.json.id, quantityUnits: 5 }]);
  const i4 = o4.items[0].id;
  await deliver(i4, lotA.id, 3);
  const [raceDeliver, raceComplete] = await Promise.all([
    deliver(i4, lotA.id, 2, "full"),
    complete(o4.id),
  ]);
  const line4 = await itemRow(i4);
  const st4 = await orderStatus(o4.id);
  console.log(`  race outcome: deliver=${raceDeliver.status} complete=${raceComplete.status} status=${st4} delivered=${line4.d}/${line4.q}`);
  check("the final delivery succeeded", raceDeliver.status === 201, `status=${raceDeliver.status}`);
  check("no 5xx from either racer", raceDeliver.status < 500 && raceComplete.status < 500, `${raceDeliver.status}/${raceComplete.status}`);
  check("delivered never exceeds ordered", Number(line4.d) <= Number(line4.q), S(line4));
  check("if the order is Completed then it is fully delivered",
    st4 !== "Completed" || Number(line4.d) === Number(line4.q), `status=${st4} ${S(line4)}`);
  check("completion either won legitimately or was refused with 409",
    raceComplete.status === 200 || raceComplete.status === 409, `status=${raceComplete.status}`);
  if (raceComplete.status === 409) {
    const late = await complete(o4.id);
    check("after the race the fully delivered order can still be completed -> 200", late.status === 200, `status=${late.status}`);
  }
  check("exactly one ORDER_COMPLETED activity after the race", (await completedActivities(o4.id)) === 1, `n=${await completedActivities(o4.id)}`);

  // ══════════════════════════════════════════════════════════════════════════
  section("9. GLOBAL INVARIANTS");
  const negLot = await one(`SELECT COUNT(*)::int n FROM "FinishedGoodsLot" WHERE "unitsAvailable" < 0 OR "unitsReserved" < 0`);
  const negMat = await one(`SELECT COUNT(*)::int n FROM "MaterialItem" WHERE "quantityOnHand" < 0`);
  const negBean = await one(`SELECT COUNT(*)::int n FROM "GreenBean" WHERE "quantityKg" < 0`);
  const overRes = await one(`SELECT COUNT(*)::int n FROM "FinishedGoodsLot" WHERE "unitsReserved" > "unitsAvailable"`);
  const overDel = await one(`SELECT COUNT(*)::int n FROM "OrderItem" WHERE "deliveredUnits" > COALESCE("quantityUnits", 2147483647)`);
  const badComplete = await one(`
    SELECT COUNT(*)::int n FROM "Order" o
     WHERE o.status='Completed' AND o.notes LIKE $1
       AND EXISTS (SELECT 1 FROM "OrderItem" oi WHERE oi."orderId"=o.id
                    AND oi."quantityUnits" IS NOT NULL AND oi."deliveredUnits" < oi."quantityUnits")`, [TAG + "%"]);
  check("no negative lot units", Number(negLot.n) === 0, S(negLot));
  check("no negative material stock", Number(negMat.n) === 0, S(negMat));
  check("no negative green stock", Number(negBean.n) === 0, S(negBean));
  check("no lot reserved beyond available", Number(overRes.n) === 0, S(overRes));
  check("no over-delivered order item", Number(overDel.n) === 0, S(overDel));
  check("NO Completed order has an undelivered line", Number(badComplete.n) === 0, S(badComplete));

  // The two properties the gate exists to guarantee, asserted over the whole suite's data
  // rather than per-scenario: no Completed order is short, over, or still holding stock.
  const badExact = await one(`
    SELECT COUNT(*)::int n FROM "Order" o
     WHERE o.status='Completed' AND o.notes LIKE $1
       AND EXISTS (SELECT 1 FROM "OrderItem" oi WHERE oi."orderId"=o.id
                    AND ((oi."quantityUnits" IS NOT NULL AND oi."deliveredUnits" <> oi."quantityUnits")
                      OR (oi."quantityUnits" IS NULL AND ABS(oi."deliveredQty" - oi."quantityKg") > 0.0005)))`, [TAG + "%"]);
  const badHeld = await one(`
    SELECT COUNT(*)::int n FROM "Order" o
     WHERE o.status='Completed' AND o.notes LIKE $1
       AND EXISTS (SELECT 1 FROM "StockAllocation" sa JOIN "OrderItem" oi ON oi.id=sa."orderItemId"
                    WHERE oi."orderId"=o.id AND sa.status='RESERVED')`, [TAG + "%"]);
  check("NO Completed order is short or over on any line", Number(badExact.n) === 0, S(badExact));
  check("NO Completed order holds a live RESERVED allocation", Number(badHeld.n) === 0, S(badHeld));
  check("no HTTP 500 anywhere in this suite", seen.http500 === 0, `count=${seen.http500}`);
  check("no PostgreSQL 40P01 deadlock anywhere in this suite", seen.deadlock === 0, `count=${seen.deadlock}`);

  section("COMPLETION GATE RESULT");
  console.log(`${pass} passed, ${fail} failed`);
  if (failures.length) console.log("FAILURES:\n  - " + failures.join("\n  - "));
  await cleanup();
  await db.end();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (e) => { console.log("FATAL:", e?.stack || e); try { await db.end(); } catch {} process.exit(1); });
