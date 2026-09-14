// ORDER EDIT / DELETE INTEGRITY — R2.6.
//
// One route structurally changes an existing order: PUT /api/orders/[id], with DELETE beside
// it. Everything below is about what that route does not do.
//
// ── It only knows about kilograms ───────────────────────────────────────────
// The edit path reads and writes quantityKg and never touches quantityUnits. On a SKU line
// units are the authority and kilograms are derived from them, so editing such a line writes
// whatever kilogram figure the client sent and leaves the unit count untouched — the two
// truths drift apart. Creating a line is worse: it sets productSkuId and never sets
// quantityUnits at all, producing a SKU-backed line with null units, which is the one shape
// the unit logic everywhere else assumes cannot exist.
//
// ── It hands back only half the shelf ───────────────────────────────────────
// Removing a line calls releaseShelfStock, the kilogram path. StockAllocation cascades from
// OrderItem so the unit rows vanish with it, but FinishedGoodsLot.unitsReserved is a
// denormalised counter that only the unit release helper maintains — those units stay
// marked as promised to a line that no longer exists.
//
// ── It is not one transaction, and it has no lifecycle gate ─────────────────
// Deletions run in a transaction; the per-item updates and creates that follow run as bare
// prisma calls outside it, so a failure half way through leaves the earlier lines rewritten.
// And nothing checks the order's status: a Cancelled or Completed order can be restructured.
//
// ── It shares demand with three other operations and locks none of it ───────
// production-requirement scheduling and order-backed roast creation both serialise on
// pg_advisory_xact_lock(7762, advisoryKey(orderItemId)) because they consume the same
// demand. Editing the quantity changes that demand and takes no lock at all.
import {
  ADMIN_PIN, db, api, check, section, sub, one, all, num, near, invariants, loginAs, results,
  Client, DB_URL, ensureUser,
} from "./harness.mjs";
import { buildCatalog, teardown, roastAndPass } from "./catalog.mjs";

const S = (v) => { try { return JSON.stringify(v) ?? String(v); } catch { return String(v); } };
const P = "OEDT";
let C;

// The roasting surplus gate ends "Only an admin can authorize surplus production", so an
// admin is deliberately allowed straight through it. The race below is about whether the
// edit and the roast agree on the ceiling at all, which cannot be observed while the caller
// is exempt from it — so that one roast is made by an ordinary roaster.
const ROASTER_PIN = "770041";

// ── helpers ────────────────────────────────────────────────────────────────
const topUpGreen = (beanId, kg) =>
  db.query('UPDATE "GreenBean" SET "quantityKg" = "quantityKg" + $2 WHERE id=$1', [beanId, kg]);

let roastSeq = 0;
async function stockRoast(coffee, bean, roastedKg) {
  const greenKg = roastedKg + 2;
  await topUpGreen(bean.id, greenKg);
  const b = await roastAndPass(P, coffee, bean, greenKg, roastedKg, 2, `S${++roastSeq}`);
  if (!b.id) throw new Error(`stock roast failed: ${S(b.error?.json ?? b)}`);
  return b.id;
}

const packSku = (batchId, skuId, units) =>
  api(`/api/roasting-batches/${batchId}/pack-sku`, { method: "POST", body: { productSkuId: skuId, units } });

/** An approved order with one SKU line, optionally preparation-reviewed. */
async function skuOrder(note, sku, units, { review = true } = {}) {
  const r = await api("/api/orders", {
    method: "POST",
    body: { customerId: C.customers.cafe.id, notes: `${P} ${note}`,
            items: [{ productSkuId: sku.id, quantityUnits: units }] },
  });
  if (r.status !== 201) throw new Error(`order create failed: ${S(r.json)}`);
  await api(`/api/orders/${r.json.id}/approve`, { method: "POST", body: { decision: "Yes" } });
  if (review) {
    await api(`/api/orders/${r.json.id}/preparation-review`, {
      method: "POST", body: { items: r.json.items.map((i) => ({ orderItemId: i.id })) },
    });
  }
  return { id: r.json.id, itemId: r.json.items[0].id, sku };
}

/**
 * Edit an order through the real route.
 *
 * Sends quantityUnits AND quantityKg on SKU lines deliberately. The route as it stands reads
 * only kilograms, so a pre-fix run exercises its real behaviour instead of bouncing off
 * validation — and the two figures agreeing is exactly what the desync assertions check.
 */
const editOrder = (orderId, items) =>
  api(`/api/orders/${orderId}`, { method: "PUT", body: { items } });

const skuLine = (sku, units, extra = {}) => ({
  beanTypeName: `${P} line`,
  productSkuId: sku.id,
  productId: null,
  quantityUnits: units,
  quantityKg: +(units * sku.grams / 1000).toFixed(3),
  ...extra,
});

const itemRow = (itemId) => one(
  `SELECT "quantityKg" kg, "quantityUnits" u, "deliveredQty" dq, "deliveredUnits" du,
          "productSkuId" sku, "productId" pid, "productionStatus" ps
     FROM "OrderItem" WHERE id=$1`, [itemId]);

const itemsOf = (orderId) => all(
  `SELECT id, "quantityKg" kg, "quantityUnits" u, "productSkuId" sku
     FROM "OrderItem" WHERE "orderId"=$1 ORDER BY "createdAt"`, [orderId]);

const reservedUnits = async (itemId) => num((await one(
  `SELECT COALESCE(SUM("quantityUnits"),0)::int n FROM "StockAllocation"
    WHERE "orderItemId"=$1 AND status='RESERVED' AND "quantityUnits" IS NOT NULL`, [itemId])).n);

const reservedKg = async (itemId) => num((await one(
  `SELECT COALESCE(SUM("quantityKg"),0) n FROM "StockAllocation"
    WHERE "orderItemId"=$1 AND status='RESERVED' AND "quantityUnits" IS NULL`, [itemId])).n);

const lotUnits = (lotId) => one(
  `SELECT "unitsAvailable" a, "unitsReserved" r FROM "FinishedGoodsLot" WHERE id=$1`, [lotId]);

const skuLotFor = (batchId) => one(
  `SELECT id FROM "FinishedGoodsLot" WHERE "packedFromBatchId"=$1`, [batchId]);

/** Units this SKU has marked reserved across every lot — the denormalised counter. */
const skuUnitsReserved = async (skuId) => num((await one(
  `SELECT COALESCE(SUM("unitsReserved"),0)::int n FROM "FinishedGoodsLot" WHERE "productSkuId"=$1`,
  [skuId])).n);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * A SKU nothing else in this suite has touched, with its own bill of materials.
 *
 * The coverage cases below assert exact reservation figures, and preparation review reserves
 * from every lot of the SKU it can find. Sharing a catalog SKU with an earlier section would
 * make those figures depend on what that section happened to leave on the shelf; a SKU of its
 * own makes each fixture mean exactly what it says. The prefix keeps teardown working.
 */
let covSeq = 0;
async function freshSku(coffeeKey, grams) {
  const code = `${P}-COV${++covSeq}`;
  const r = await api("/api/products", {
    method: "POST",
    body: { productId: C.coffees[coffeeKey].id, skuCode: code,
            name: `${P} coverage ${covSeq}`, weightGrams: grams, price: 50 },
  });
  if (r.status !== 201) throw new Error(`sku create failed: ${S(r.json)}`);
  const sku = { id: r.json.id, code, grams, kg: grams / 1000, coffee: coffeeKey };
  const bom = await api(`/api/products/${sku.id}/bom`, { method: "PUT", body: { components: [
    { type: "ROASTED_COFFEE", coffeeProductId: C.coffees[coffeeKey].id, quantityPerUnit: sku.kg },
    { type: "MATERIAL", materialItemId: C.materials[grams >= 1000 ? "bag1kg" : "bag250"].id, quantityPerUnit: 1 },
    { type: "MATERIAL", materialItemId: C.materials.label.id, quantityPerUnit: 1 },
  ]}});
  if (bom.status !== 200) throw new Error(`bom save failed: ${S(bom.json)}`);
  return sku;
}

/** Mark an API-created batch the way catalog.roastAndPass does, so teardown can find it. */
async function passBatch(batchId, label) {
  await db.query('UPDATE "RoastingBatch" SET "batchNumber"=$2 WHERE id=$1', [batchId, `${P}-${label}`]);
  await db.query(`UPDATE "RoastingBatch" SET status='Passed' WHERE id=$1`, [batchId]);
}

/** Raw target units on this line's non-cancelled production orders — NOT coverage. */
const rawScheduled = async (itemId) => num((await one(
  `SELECT COALESCE(SUM("targetUnits"),0)::int n FROM "ProductionOrder"
    WHERE "sourceOrderItemId"=$1 AND status <> 'CANCELLED'`, [itemId])).n);

/**
 * Units this line's open production orders still owe: SUM(max(0, target − produced)).
 *
 * Written out in SQL on purpose. The invariant has to be measured independently of the
 * implementation it is checking — importing the service's own arithmetic would make a wrong
 * formula agree with itself. The produced term mirrors the canonical one: a lot counts only
 * through the batch it was packed from, only for the production order's own SKU, and blends
 * and rejected batches never count.
 */
const scheduledRemaining = async (itemId) => num((await one(
  `SELECT COALESCE(SUM(GREATEST(0, po."targetUnits" - COALESCE(p.units, 0))), 0)::int n
     FROM "ProductionOrder" po
     LEFT JOIN (
       SELECT rb."productionOrderId" poid, COALESCE(SUM(f."unitsProduced"),0)::int units
         FROM "FinishedGoodsLot" f
         JOIN "RoastingBatch"   rb  ON rb.id  = f."packedFromBatchId"
         JOIN "ProductionOrder" po2 ON po2.id = rb."productionOrderId"
        WHERE rb."isBlend" = false AND rb.status <> 'Rejected'
          AND f."productSkuId" = po2."productSkuId" AND f."isUnitTracked" = true
        GROUP BY rb."productionOrderId"
     ) p ON p.poid = po.id
    WHERE po."sourceOrderItemId" = $1 AND po.status <> 'CANCELLED'`, [itemId])).n);

/** delivered + reserved + still-scheduled: everything covering the line right now. */
async function coverageOf(itemId) {
  const row = await itemRow(itemId);
  const reserved = await reservedUnits(itemId);
  const scheduled = await scheduledRemaining(itemId);
  const delivered = num(row.du);
  return { delivered, reserved, scheduled, total: delivered + reserved + scheduled, ordered: num(row.u) };
}

/** A lot's denormalised unit counters against the allocations that should explain them. */
const lotReconciles = async (lotId) => {
  const lot = await lotUnits(lotId);
  const summed = num((await one(
    `SELECT COALESCE(SUM("quantityUnits"),0)::int n FROM "StockAllocation"
      WHERE "finishedGoodsLotId"=$1 AND status='RESERVED' AND "quantityUnits" IS NOT NULL`,
    [lotId])).n);
  return { reserved: num(lot?.r), available: num(lot?.a), summed };
};

/** A legacy kilogram line: no SKU, kilograms authoritative. The orders API cannot create
 *  one — it requires a productSkuId — so it is inserted directly, which is also how the
 *  historical rows this branch exists for came to be. */
async function legacyKgOrder(note, kg, { review = false } = {}) {
  const r = await api("/api/orders", {
    method: "POST",
    body: { customerId: C.customers.cafe.id, notes: `${P} ${note}`,
            items: [{ productSkuId: C.skus.bra1kg.id, quantityUnits: 1 }] },
  });
  if (r.status !== 201) throw new Error(`order create failed: ${S(r.json)}`);
  await api(`/api/orders/${r.json.id}/approve`, { method: "POST", body: { decision: "Yes" } });
  if (review) {
    await api(`/api/orders/${r.json.id}/preparation-review`, {
      method: "POST", body: { items: r.json.items.map((i) => ({ orderItemId: i.id })) },
    });
  }
  const itemId = r.json.items[0].id;
  await db.query(
    `UPDATE "OrderItem" SET "productSkuId"=NULL, "quantityUnits"=NULL, "quantityKg"=$2,
            "remainingQty"=$2, "productId"=$3 WHERE id=$1`,
    [itemId, kg, C.coffees.brazil.id]);
  return { id: r.json.id, itemId };
}

async function main() {
  await db.connect();
  await teardown(P);
  await loginAs(ADMIN_PIN);
  C = await buildCatalog(P);

  await ensureUser(`${P}_emp_roaster`, `${P} Roaster`, "production", {
    dashboard: { access: "edit" },
    production: { access: "edit", sub: { start_batch: true } },
    orders: { access: "edit", sub: { edit: true } },
  }, ROASTER_PIN);

  // ═══════════════════════════════════════════════════════════════════════
  section("A — A SKU LINE IS CREATED IN UNITS, WITH KILOGRAMS DERIVED");

  sub("A1. 8 units of a 250 g SKU is 2.0 kg");
  const oA = await skuOrder("create", C.skus.bra250, 4, { review: false });
  const addA = await editOrder(oA.id, [
    skuLine(C.skus.bra250, 4, { id: oA.itemId }),
    skuLine(C.skus.bra250, 8),
  ]);
  check("the edit is accepted", addA.status === 200, `status=${addA.status} ${S(addA.json).slice(0, 120)}`);
  const linesA = await itemsOf(oA.id);
  const addedA = linesA.find((l) => l.id !== oA.itemId);
  console.log(`    added line: units=${addedA?.u} kg=${addedA?.kg}`);
  check("a second line exists", linesA.length === 2, `${linesA.length} lines`);
  check("its unit count is what was ordered", num(addedA?.u) === 8, `quantityUnits=${addedA?.u}`);
  check("and its kilograms are derived from it", near(num(addedA?.kg), 2.0), `quantityKg=${addedA?.kg}`);

  sub("A2. a SKU line can never be created without units");
  const oB = await skuOrder("null units", C.skus.bra250, 4, { review: false });
  const beforeB = (await itemsOf(oB.id)).length;
  const addB = await editOrder(oB.id, [
    skuLine(C.skus.bra250, 4, { id: oB.itemId }),
    { beanTypeName: `${P} line`, productSkuId: C.skus.bra250.id, productId: null, quantityKg: 2 },
  ]);
  console.log(`    SKU line with no units -> ${addB.status} ${S(addB.json).slice(0, 120)}`);
  check("refused with a 4xx", addB.status >= 400 && addB.status < 500, `status=${addB.status}`);
  check("no line was created", (await itemsOf(oB.id)).length === beforeB,
    `${beforeB} -> ${(await itemsOf(oB.id)).length}`);
  check("no SKU line anywhere has null units",
    num((await one(
      `SELECT COUNT(*)::int n FROM "OrderItem" oi JOIN "Order" o ON o.id=oi."orderId"
        WHERE o.notes LIKE $1 AND oi."productSkuId" IS NOT NULL AND oi."quantityUnits" IS NULL`,
      [P + "%"])).n) === 0,
    "a SKU line with null units exists");

  sub("A3. a kilogram figure that contradicts the units is refused");
  const oC = await skuOrder("kg assertion", C.skus.bra250, 4, { review: false });
  const beforeC = (await itemsOf(oC.id)).length;
  const addC = await editOrder(oC.id, [
    skuLine(C.skus.bra250, 4, { id: oC.itemId }),
    skuLine(C.skus.bra250, 8, { quantityKg: 7 }),   // 8 × 250 g is 2 kg, not 7
  ]);
  console.log(`    units 8 but kg 7 -> ${addC.status} ${S(addC.json).slice(0, 120)}`);
  check("refused with a 4xx", addC.status >= 400 && addC.status < 500, `status=${addC.status}`);
  check("nothing was created", (await itemsOf(oC.id)).length === beforeC,
    `${beforeC} -> ${(await itemsOf(oC.id)).length}`);

  // ═══════════════════════════════════════════════════════════════════════
  section("B — EDITING A SKU LINE KEEPS THE TWO FIGURES IN STEP");

  sub("B1. 8 units becomes 12, and the kilograms follow");
  const oD = await skuOrder("edit qty", C.skus.bra250, 8, { review: false });
  const editD = await editOrder(oD.id, [skuLine(C.skus.bra250, 12, { id: oD.itemId })]);
  const rowD = await itemRow(oD.itemId);
  console.log(`    after edit: units=${rowD.u} kg=${rowD.kg}`);
  check("the edit is accepted", editD.status === 200, `status=${editD.status} ${S(editD.json).slice(0, 120)}`);
  check("units are 12", num(rowD.u) === 12, `quantityUnits=${rowD.u}`);
  check("kilograms are 3.0, derived", near(num(rowD.kg), 3.0), `quantityKg=${rowD.kg}`);

  // ═══════════════════════════════════════════════════════════════════════
  section("C — SHRINKING A LINE HANDS BACK WHAT IT NO LONGER NEEDS");

  sub("C1. 10 ordered with 8 reserved, shrunk to 5");
  const batchC = await stockRoast(C.coffees.ethiopia, C.beans.ethiopia, 10);
  await packSku(batchC, C.skus.eth1kg.id, 8);
  const lotC = await skuLotFor(batchC);
  const oE = await skuOrder("shrink", C.skus.eth1kg, 10);
  const reservedBeforeE = await reservedUnits(oE.itemId);
  const lotBeforeE = await lotUnits(lotC.id);
  check("8 units are reserved to the line", reservedBeforeE === 8, `${reservedBeforeE} units`);

  const shrinkE = await editOrder(oE.id, [skuLine(C.skus.eth1kg, 5, { id: oE.itemId })]);
  const rowE = await itemRow(oE.itemId);
  const reservedAfterE = await reservedUnits(oE.itemId);
  const lotAfterE = await lotUnits(lotC.id);
  console.log(`    shrink 10->5: reserved ${reservedBeforeE} -> ${reservedAfterE}, lot reserved ${lotBeforeE?.r} -> ${lotAfterE?.r}`);
  check("the edit is accepted", shrinkE.status === 200, `status=${shrinkE.status} ${S(shrinkE.json).slice(0, 120)}`);
  check("units are 5", num(rowE.u) === 5, `quantityUnits=${rowE.u}`);
  check("kilograms are derived at 5.0", near(num(rowE.kg), 5.0), `quantityKg=${rowE.kg}`);
  check("the reservation is trimmed to 5", reservedAfterE === 5, `${reservedAfterE} units`);
  check("the lot's reserved counter came down by 3", num(lotAfterE?.r) === num(lotBeforeE?.r) - 3,
    `${lotBeforeE?.r} -> ${lotAfterE?.r}`);
  check("the lot never reserves more than it holds", num(lotAfterE?.r) <= num(lotAfterE?.a),
    `${lotAfterE?.r} <= ${lotAfterE?.a}`);
  check("no allocation is left stranded above the new demand", reservedAfterE <= num(rowE.u),
    `${reservedAfterE} <= ${rowE.u}`);

  sub("C2. a line cannot be shrunk below what has already been delivered");
  const batchF = await stockRoast(C.coffees.indonesia, C.beans.indonesia, 12);
  await packSku(batchF, C.skus.idn250.id, 10);
  const lotF = await skuLotFor(batchF);
  const oF = await skuOrder("delivered floor", C.skus.idn250, 10);
  const shipF = await api("/api/deliveries", {
    method: "POST",
    body: { orderItemId: oF.itemId, quantityUnits: 4, deliveryType: "partial", finishedGoodsLotId: lotF.id },
  });
  check("4 units are delivered", shipF.status === 201, `status=${shipF.status} ${S(shipF.json).slice(0, 110)}`);
  const beforeF = await itemRow(oF.itemId);

  const shrinkF = await editOrder(oF.id, [skuLine(C.skus.idn250, 3, { id: oF.itemId })]);
  const afterF = await itemRow(oF.itemId);
  console.log(`    shrink below delivered -> ${shrinkF.status} ${S(shrinkF.json).slice(0, 120)}`);
  check("refused with 409", shrinkF.status === 409, `status=${shrinkF.status}`);
  check("the line is unchanged",
    num(afterF.u) === num(beforeF.u) && near(num(afterF.kg), num(beforeF.kg)),
    `${beforeF.u}/${beforeF.kg} -> ${afterF.u}/${afterF.kg}`);
  check("delivered units are untouched", num(afterF.du) === 4, `deliveredUnits=${afterF.du}`);

  sub("C3. a legacy kilogram line trims against kilograms");
  const oG = await legacyKgOrder("legacy shrink", 10);
  // 7 kg reserved, 2 kg delivered — set up directly, as the legacy path has no API.
  // Only the columns that are NOT NULL without a database default need supplying; the rest
  // (status, reservedQty, createdAt) carry their own defaults, and FinishedGoodsLot has no
  // updatedAt column at all.
  const lotG = await one(
    `INSERT INTO "FinishedGoodsLot" (id,"productId","batchNumber","quantityKg","availableQty","reservedQty")
     VALUES ($1,$2,$3,20,20,7) RETURNING id`,
    [`${P}_lot_legacy`, C.coffees.brazil.id, `${P}-LEG`]);
  await db.query(
    `INSERT INTO "StockAllocation" (id,"orderItemId","finishedGoodsLotId","quantityKg","updatedAt")
     VALUES ($1,$2,$3,7,now())`,
    [`${P}_alloc_legacy`, oG.itemId, lotG.id]);
  await db.query(`UPDATE "OrderItem" SET "deliveredQty"=2 WHERE id=$1`, [oG.itemId]);
  check("the legacy line starts with 7 kg reserved", near(await reservedKg(oG.itemId), 7),
    `${await reservedKg(oG.itemId)}`);

  const shrinkG = await editOrder(oG.id, [
    { id: oG.itemId, beanTypeName: `${P} legacy`, productId: C.coffees.brazil.id, quantityKg: 6 },
  ]);
  const rowG = await itemRow(oG.itemId);
  const resG = await reservedKg(oG.itemId);
  console.log(`    legacy 10kg -> 6kg with 2kg delivered: reserved 7 -> ${resG}`);
  check("the edit is accepted", shrinkG.status === 200, `status=${shrinkG.status} ${S(shrinkG.json).slice(0, 120)}`);
  check("the line is 6 kg", near(num(rowG.kg), 6), `quantityKg=${rowG.kg}`);
  check("it stays a legacy line with no units", rowG.u === null, `quantityUnits=${rowG.u}`);
  check("the reservation is trimmed to 4 kg (6 ordered - 2 delivered)", near(resG, 4), `${resG}`);
  check("the lot's reserved kilograms came down",
    near(num((await one(`SELECT "reservedQty" r FROM "FinishedGoodsLot" WHERE id=$1`, [lotG.id])).r), 4),
    `${(await one(`SELECT "reservedQty" r FROM "FinishedGoodsLot" WHERE id=$1`, [lotG.id])).r}`);

  // ═══════════════════════════════════════════════════════════════════════
  section("D — GROWING A LINE DOES NOT INVENT STOCK");

  sub("D1. 10 ordered with 8 reserved, increased to 15");
  const batchH = await stockRoast(C.coffees.brazil, C.beans.brazil, 12);
  await packSku(batchH, C.skus.bra1kg.id, 8);
  const oH = await skuOrder("increase", C.skus.bra1kg, 10);
  const reservedBeforeH = await reservedUnits(oH.itemId);
  check("8 units are reserved", reservedBeforeH === 8, `${reservedBeforeH}`);

  const growH = await editOrder(oH.id, [skuLine(C.skus.bra1kg, 15, { id: oH.itemId })]);
  const rowH = await itemRow(oH.itemId);
  const reservedAfterH = await reservedUnits(oH.itemId);
  console.log(`    grow 10->15: reserved ${reservedBeforeH} -> ${reservedAfterH}`);
  check("the edit is accepted", growH.status === 200, `status=${growH.status} ${S(growH.json).slice(0, 120)}`);
  check("units are 15", num(rowH.u) === 15, `quantityUnits=${rowH.u}`);
  check("the reservation is unchanged at 8", reservedAfterH === 8, `${reservedAfterH}`);
  const reqH = await api(`/api/order-items/${oH.itemId}/production-requirement`);
  check("the new outstanding demand is 7", num(reqH.json?.shortfallUnits) === 7,
    `shortfallUnits=${reqH.json?.shortfallUnits}`);

  // ═══════════════════════════════════════════════════════════════════════
  section("E — REMOVING A LINE GIVES EVERYTHING BACK");

  sub("E1. a unit-reserved line releases its units and its lot counter");
  const batchI = await stockRoast(C.coffees.ethiopia, C.beans.ethiopia, 8);
  await packSku(batchI, C.skus.eth250.id, 10);
  const lotI = await skuLotFor(batchI);
  const oI = await skuOrder("remove units", C.skus.eth250, 6);
  const keepI = await skuOrder("remove units keep", C.skus.eth250, 1, { review: false });
  void keepI;
  const reservedI = await reservedUnits(oI.itemId);
  const lotBeforeI = await lotUnits(lotI.id);
  check("the line holds a unit reservation", reservedI > 0, `${reservedI} units`);

  // Removing the only line: send an empty item list.
  const rmI = await editOrder(oI.id, []);
  const stillI = await one('SELECT id FROM "OrderItem" WHERE id=$1', [oI.itemId]);
  const lotAfterI = await lotUnits(lotI.id);
  const strandedI = num((await one(
    `SELECT COUNT(*)::int n FROM "StockAllocation" WHERE "orderItemId"=$1 AND status='RESERVED'`,
    [oI.itemId])).n);
  console.log(`    remove line -> ${rmI.status}; lot reserved ${lotBeforeI?.r} -> ${lotAfterI?.r}, stranded=${strandedI}`);
  check("the removal is accepted", rmI.status === 200, `status=${rmI.status} ${S(rmI.json).slice(0, 120)}`);
  check("the line is gone", stillI === undefined, "line survives");
  check("the lot's reserved counter is handed back",
    num(lotAfterI?.r) === num(lotBeforeI?.r) - reservedI,
    `${lotBeforeI?.r} -> ${lotAfterI?.r}, expected -${reservedI}`);
  check("the counter never goes negative", num(lotAfterI?.r) >= 0, `${lotAfterI?.r}`);
  check("no RESERVED allocation is left behind", strandedI === 0, `${strandedI} rows`);

  sub("E2. a delivered line cannot be removed at all");
  const rmK = await editOrder(oF.id, []);
  console.log(`    remove a delivered line -> ${rmK.status} ${S(rmK.json).slice(0, 120)}`);
  check("refused with a 4xx", rmK.status >= 400 && rmK.status < 500, `status=${rmK.status}`);
  check("the line survives", (await one('SELECT id FROM "OrderItem" WHERE id=$1', [oF.itemId])) !== undefined,
    "line removed");
  check("its delivered units survive", num((await itemRow(oF.itemId)).du) === 4,
    `deliveredUnits=${(await itemRow(oF.itemId)).du}`);

  sub("E3. removing a line must not orphan its production order");
  // ProductionOrder.sourceOrderItemId is ON DELETE SET NULL, so the database will happily
  // detach an active production order and leave it pointing at nobody.
  const oL = await skuOrder("po orphan", C.skus.idn250, 20);
  const schedL = await api(`/api/order-items/${oL.itemId}/production-requirement`, { method: "POST" });
  check("a production order exists", schedL.status === 201, S(schedL.json).slice(0, 120));
  const poL = schedL.json?.productionOrder?.id;

  const rmL = await editOrder(oL.id, []);
  const poRow = await one(
    `SELECT id, status, "sourceOrderItemId" src FROM "ProductionOrder" WHERE id=$1`, [poL]);
  const lineGone = (await one('SELECT id FROM "OrderItem" WHERE id=$1', [oL.itemId])) === undefined;
  console.log(`    remove -> ${rmL.status}; line gone=${lineGone}, PO status=${poRow?.status}, src=${poRow?.src}`);
  check("no ACTIVE production order is left pointing at nobody",
    !(lineGone && poRow && poRow.src === null &&
      (poRow.status === "PENDING" || poRow.status === "IN_PRODUCTION")),
    `line gone=${lineGone}, PO ${poRow?.status} src=${poRow?.src}`);

  // ═══════════════════════════════════════════════════════════════════════
  section("F — ONE REQUEST IS ONE TRANSACTION");

  sub("F1. a valid line and an invalid one change nothing at all");
  const oM = await skuOrder("atomic A", C.skus.bra250, 6, { review: false });
  const addM = await editOrder(oM.id, [
    skuLine(C.skus.bra250, 6, { id: oM.itemId }),
    skuLine(C.skus.bra250, 4),
  ]);
  check("a second line is added", addM.status === 200, S(addM.json).slice(0, 120));
  const linesM = await itemsOf(oM.id);
  const second = linesM.find((l) => l.id !== oM.itemId);
  await db.query(`UPDATE "OrderItem" SET "deliveredUnits"=3 WHERE id=$1`, [second.id]);

  const beforeM = await itemsOf(oM.id);
  const mixed = await editOrder(oM.id, [
    skuLine(C.skus.bra250, 9, { id: oM.itemId }),      // valid
    skuLine(C.skus.bra250, 1, { id: second.id }),      // invalid: below 3 delivered
  ]);
  const afterM = await itemsOf(oM.id);
  console.log(`    one valid + one invalid -> ${mixed.status}`);
  check("the whole request is refused", mixed.status >= 400 && mixed.status < 500,
    `status=${mixed.status}`);
  check("the VALID line was not changed either",
    num(afterM.find((l) => l.id === oM.itemId)?.u) === num(beforeM.find((l) => l.id === oM.itemId)?.u),
    `${beforeM.find((l) => l.id === oM.itemId)?.u} -> ${afterM.find((l) => l.id === oM.itemId)?.u}`);
  check("and neither did the invalid one",
    num(afterM.find((l) => l.id === second.id)?.u) === num(beforeM.find((l) => l.id === second.id)?.u),
    `${beforeM.find((l) => l.id === second.id)?.u} -> ${afterM.find((l) => l.id === second.id)?.u}`);

  // ═══════════════════════════════════════════════════════════════════════
  section("G — A TERMINAL ORDER IS NOT EDITABLE");

  sub("G1. structural edits stop when the order is cancelled");
  const oN = await skuOrder("terminal", C.skus.bra250, 6, { review: false });
  await api(`/api/orders/${oN.id}/status`, { method: "POST", body: { action: "cancel", reason: `${P} t` } });
  const statusN = (await one('SELECT status FROM "Order" WHERE id=$1', [oN.id])).status;
  check("the order is Cancelled", statusN === "Cancelled", statusN);
  const beforeN = await itemRow(oN.itemId);

  const editN = await editOrder(oN.id, [skuLine(C.skus.bra250, 99, { id: oN.itemId })]);
  const afterN = await itemRow(oN.itemId);
  console.log(`    edit a cancelled order -> ${editN.status} ${S(editN.json).slice(0, 120)}`);
  check("refused with a 4xx", editN.status >= 400 && editN.status < 500, `status=${editN.status}`);
  check("the line is untouched", num(afterN.u) === num(beforeN.u),
    `${beforeN.u} -> ${afterN.u}`);

  // ═══════════════════════════════════════════════════════════════════════
  section("H — EDITING SHARES THE DEMAND LOCK WITH PRODUCTION");

  sub("H1. a shrink racing a production-requirement post");
  const oO = await skuOrder("race schedule", C.skus.eth250, 20);
  const gate1 = new Client({ connectionString: DB_URL });
  await gate1.connect();
  await gate1.query("BEGIN");
  await gate1.query(`SELECT pg_advisory_xact_lock(7762, $1::int)`, [advisoryKeyOf(oO.itemId)]);

  const racedO = Promise.all([
    editOrder(oO.id, [skuLine(C.skus.eth250, 4, { id: oO.itemId })]),
    api(`/api/order-items/${oO.itemId}/production-requirement`, { method: "POST" }),
  ]);
  await new Promise((r) => setTimeout(r, 2500));
  await gate1.query("ROLLBACK");
  await gate1.end();
  const [editO, schedO] = await racedO;

  const rowO = await itemRow(oO.itemId);
  const scheduledO = num((await one(
    `SELECT COALESCE(SUM("targetUnits"),0)::int n FROM "ProductionOrder"
      WHERE "sourceOrderItemId"=$1 AND status <> 'CANCELLED'`, [oO.itemId])).n);
  console.log(`    edit=${editO.status} schedule=${schedO.status} -> units=${rowO.u}, scheduled=${scheduledO}`);
  check("neither returned a server error", editO.status !== 500 && schedO.status !== 500,
    `${editO.status}/${schedO.status}`);
  check("neither deadlocked", !/deadlock|40P01/i.test(S(editO.json) + S(schedO.json)),
    (S(editO.json) + S(schedO.json)).slice(0, 130));
  check("production was not scheduled beyond the final ordered quantity",
    scheduledO <= num(rowO.u), `scheduled ${scheduledO} vs ordered ${rowO.u}`);

  sub("H2. a shrink racing an order-backed roast");
  const oP = await skuOrder("race roast", C.skus.eth250, 20);
  await topUpGreen(C.beans.ethiopia.id, 30);
  const gate2 = new Client({ connectionString: DB_URL });
  await gate2.connect();
  await gate2.query("BEGIN");
  await gate2.query(`SELECT pg_advisory_xact_lock(7762, $1::int)`, [advisoryKeyOf(oP.itemId)]);

  await loginAs(ROASTER_PIN);
  const racedP = Promise.all([
    editOrder(oP.id, [skuLine(C.skus.eth250, 4, { id: oP.itemId })]),
    api("/api/roasting-batches", {
      method: "POST",
      body: { orderItemId: oP.itemId, greenBeanId: C.beans.ethiopia.id,
              greenBeanQuantity: 8, roastedBeanQuantity: 5, wasteQuantity: 3 },
    }),
  ]);
  await new Promise((r) => setTimeout(r, 2500));
  await gate2.query("ROLLBACK");
  await gate2.end();
  const [editP, roastP] = await racedP;
  await loginAs(ADMIN_PIN);
  const rowP = await itemRow(oP.itemId);
  const roastedP = num((await one(
    `SELECT COALESCE(SUM("roastedBeanQuantity"),0) n FROM "RoastingBatch"
      WHERE "orderItemId"=$1 AND NOT "isBlend" AND status <> 'Rejected'`, [oP.itemId])).n);
  console.log(`    edit=${editP.status} roast=${roastP.status} -> units=${rowP.u}, roasted=${roastedP}kg`);
  check("neither returned a server error", editP.status !== 500 && roastP.status !== 500,
    `${editP.status}/${roastP.status}`);
  check("neither deadlocked", !/deadlock|40P01/i.test(S(editP.json) + S(roastP.json)),
    (S(editP.json) + S(roastP.json)).slice(0, 130));
  // Whichever way they serialise, the two must agree: if the shrink committed first the
  // roast is over the new ceiling and is refused, and if the roast committed first the
  // shrink would strand it and is refused. Both cannot succeed.
  check("the edit and the roast did not both succeed",
    !(editP.status === 200 && roastP.status === 201),
    `edit=${editP.status} roast=${roastP.status}`);
  check("no roast exceeded the finally-ordered quantity",
    roastedP <= num(rowP.u) * (C.skus.eth250.grams / 1000) + 0.001,
    `${roastedP}kg vs ${num(rowP.u) * (C.skus.eth250.grams / 1000)}kg ordered`);

  sub("H3. two concurrent edits of the same line leave one coherent state");
  const oQ = await skuOrder("race edits", C.skus.bra250, 20, { review: false });
  const [q1, q2] = await Promise.all([
    editOrder(oQ.id, [skuLine(C.skus.bra250, 12, { id: oQ.itemId })]),
    editOrder(oQ.id, [skuLine(C.skus.bra250, 7, { id: oQ.itemId })]),
  ]);
  const rowQ = await itemRow(oQ.itemId);
  console.log(`    ${q1.status}/${q2.status} -> units=${rowQ.u} kg=${rowQ.kg}`);
  check("neither returned a server error", q1.status !== 500 && q2.status !== 500,
    `${q1.status}/${q2.status}`);
  check("the line holds one of the two requested values",
    num(rowQ.u) === 12 || num(rowQ.u) === 7, `quantityUnits=${rowQ.u}`);
  check("and its kilograms match that value exactly",
    near(num(rowQ.kg), num(rowQ.u) * C.skus.bra250.grams / 1000),
    `${rowQ.u} units vs ${rowQ.kg} kg`);

  // ═══════════════════════════════════════════════════════════════════════
  section("I — SKU IDENTITY IS NOT SWAPPED UNDER OPERATIONAL HISTORY");

  sub("I1. a line with reservations cannot change SKU");
  const batchR = await stockRoast(C.coffees.brazil, C.beans.brazil, 10);
  await packSku(batchR, C.skus.bra1kg.id, 6);
  const oR = await skuOrder("sku swap", C.skus.bra1kg, 6);
  check("the line has a reservation", (await reservedUnits(oR.itemId)) > 0,
    `${await reservedUnits(oR.itemId)}`);
  const swapR = await editOrder(oR.id, [skuLine(C.skus.bra250, 6, { id: oR.itemId })]);
  const rowR = await itemRow(oR.itemId);
  console.log(`    swap SKU on a reserved line -> ${swapR.status} ${S(swapR.json).slice(0, 120)}`);
  check("refused with a 4xx", swapR.status >= 400 && swapR.status < 500, `status=${swapR.status}`);
  check("the line keeps its original SKU", rowR.sku === C.skus.bra1kg.id, `productSkuId=${rowR.sku}`);

  // ═══════════════════════════════════════════════════════════════════════
  section("J — DELETING A WHOLE ORDER");

  sub("J1. an order with history cannot be physically deleted");
  const delS = await api(`/api/orders/${oF.id}`, { method: "DELETE" });
  console.log(`    delete an order with deliveries -> ${delS.status} ${S(delS.json).slice(0, 120)}`);
  check("refused with a 4xx", delS.status >= 400 && delS.status < 500, `status=${delS.status}`);
  check("the order survives", (await one('SELECT id FROM "Order" WHERE id=$1', [oF.id])) !== undefined,
    "order deleted");

  sub("J2. an untouched order deletes and hands back everything it held");
  const batchT = await stockRoast(C.coffees.brazil, C.beans.brazil, 8);
  await packSku(batchT, C.skus.bra250.id, 8);
  const lotT = await skuLotFor(batchT);
  const oT = await skuOrder("delete clean", C.skus.bra250, 5);
  const reservedT = await reservedUnits(oT.itemId);
  const lotBeforeT = await lotUnits(lotT.id);
  check("it holds a reservation", reservedT > 0, `${reservedT} units`);

  const delT = await api(`/api/orders/${oT.id}`, { method: "DELETE" });
  const lotAfterT = await lotUnits(lotT.id);
  console.log(`    delete untouched order -> ${delT.status}; lot reserved ${lotBeforeT?.r} -> ${lotAfterT?.r}`);
  check("the delete is accepted", delT.status === 200, `status=${delT.status} ${S(delT.json).slice(0, 120)}`);
  check("the order is gone", (await one('SELECT id FROM "Order" WHERE id=$1', [oT.id])) === undefined,
    "order survives");
  check("its reserved units were handed back",
    num(lotAfterT?.r) === num(lotBeforeT?.r) - reservedT,
    `${lotBeforeT?.r} -> ${lotAfterT?.r}, expected -${reservedT}`);
  check("no allocation row survives the order",
    num((await one(
      `SELECT COUNT(*)::int n FROM "StockAllocation" WHERE "orderItemId"=$1`, [oT.itemId])).n) === 0,
    "allocations survive");

  // ═══════════════════════════════════════════════════════════════════════
  section("K — A SHRINK RECONCILES TOTAL COVERAGE, NOT ONE TERM OF IT");
  //
  // A line is covered by delivered units, reserved units and the part of its open production
  // orders that has not been packed yet. Comparing the new quantity against production alone
  // leaves the other two terms free to overshoot it, and comparing it against raw targetUnits
  // counts units that were already produced — and are therefore already counted as reserved —
  // a second time. What has to hold after a successful shrink is the canonical demand
  // equation itself: delivered + reserved + scheduled <= ordered.

  sub("K1. 10 ordered, 8 reserved, 2 scheduled, shrunk to 8");
  const skuK1 = await freshSku("indonesia", 250);
  const bK1 = await stockRoast(C.coffees.indonesia, C.beans.indonesia, 3);
  await packSku(bK1, skuK1.id, 8);
  const lotK1 = await skuLotFor(bK1);
  const oK1 = await skuOrder("coverage A", skuK1, 10);
  const schedK1 = await api(`/api/order-items/${oK1.itemId}/production-requirement`, { method: "POST" });
  const beforeK1 = await coverageOf(oK1.itemId);
  console.log(`    fixture: delivered ${beforeK1.delivered}, reserved ${beforeK1.reserved}, scheduled ${beforeK1.scheduled} of ${beforeK1.ordered}`);
  check("the fixture reserves 8 units", beforeK1.reserved === 8, `${beforeK1.reserved} reserved`);
  check("and schedules the remaining 2", schedK1.status === 201 && beforeK1.scheduled === 2,
    `status=${schedK1.status}, scheduled=${beforeK1.scheduled}`);

  const shrinkK1 = await editOrder(oK1.id, [skuLine(skuK1, 8, { id: oK1.itemId })]);
  const afterK1 = await coverageOf(oK1.itemId);
  const lotAfterK1 = await lotReconciles(lotK1.id);
  console.log(`    shrink 10->8: reserved ${beforeK1.reserved} -> ${afterK1.reserved}, scheduled ${afterK1.scheduled}, coverage ${afterK1.total}`);
  check("the edit is accepted", shrinkK1.status === 200,
    `status=${shrinkK1.status} ${S(shrinkK1.json).slice(0, 140)}`);
  check("the line now orders 8", afterK1.ordered === 8, `ordered=${afterK1.ordered}`);
  check("total coverage does not exceed the new quantity", afterK1.total <= afterK1.ordered,
    `${afterK1.delivered}+${afterK1.reserved}+${afterK1.scheduled} vs ${afterK1.ordered}`);
  check("the reservation was trimmed to 6, leaving room for the 2 scheduled",
    afterK1.reserved === 6, `${afterK1.reserved} reserved`);
  check("the scheduled production was left alone", afterK1.scheduled === 2,
    `${afterK1.scheduled} scheduled`);
  check("the lot counter matches its own allocations",
    lotAfterK1.reserved === lotAfterK1.summed, `counter ${lotAfterK1.reserved} vs rows ${lotAfterK1.summed}`);
  check("and never exceeds what the lot holds", lotAfterK1.reserved <= lotAfterK1.available,
    `${lotAfterK1.reserved} <= ${lotAfterK1.available}`);

  sub("K2. 12 ordered with 3 delivered, 5 reserved and 4 scheduled, shrunk to 10");
  const skuK2 = await freshSku("brazil", 250);
  const bK2 = await stockRoast(C.coffees.brazil, C.beans.brazil, 3);
  await packSku(bK2, skuK2.id, 8);
  const lotK2 = await skuLotFor(bK2);
  const oK2 = await skuOrder("coverage B", skuK2, 12);
  const shipK2 = await api("/api/deliveries", {
    method: "POST",
    body: { orderItemId: oK2.itemId, quantityUnits: 3, deliveryType: "partial", finishedGoodsLotId: lotK2.id },
  });
  const schedK2 = await api(`/api/order-items/${oK2.itemId}/production-requirement`, { method: "POST" });
  const beforeK2 = await coverageOf(oK2.itemId);
  console.log(`    fixture: delivered ${beforeK2.delivered}, reserved ${beforeK2.reserved}, scheduled ${beforeK2.scheduled} of ${beforeK2.ordered}`);
  check("3 units are delivered", shipK2.status === 201 && beforeK2.delivered === 3,
    `status=${shipK2.status} delivered=${beforeK2.delivered}`);
  check("5 remain reserved", beforeK2.reserved === 5, `${beforeK2.reserved} reserved`);
  check("and 4 are scheduled", schedK2.status === 201 && beforeK2.scheduled === 4,
    `status=${schedK2.status} scheduled=${beforeK2.scheduled}`);
  check("the line starts exactly covered", beforeK2.total === 12, `coverage ${beforeK2.total}`);

  const shrinkK2 = await editOrder(oK2.id, [skuLine(skuK2, 10, { id: oK2.itemId })]);
  const afterK2 = await coverageOf(oK2.itemId);
  const lotAfterK2 = await lotReconciles(lotK2.id);
  console.log(`    shrink 12->10: ${S(shrinkK2.status)} -> delivered ${afterK2.delivered}, reserved ${afterK2.reserved}, scheduled ${afterK2.scheduled}`);
  check("the edit is either accepted or safely refused",
    shrinkK2.status === 200 || shrinkK2.status === 409,
    `status=${shrinkK2.status} ${S(shrinkK2.json).slice(0, 140)}`);
  check("coverage never exceeds the quantity the line now carries",
    afterK2.total <= afterK2.ordered,
    `${afterK2.delivered}+${afterK2.reserved}+${afterK2.scheduled} vs ${afterK2.ordered}`);
  check("delivered units are untouched", afterK2.delivered === 3, `delivered=${afterK2.delivered}`);
  check("scheduled production is untouched", afterK2.scheduled === 4, `scheduled=${afterK2.scheduled}`);
  check("the reservation absorbed the reduction", shrinkK2.status !== 200 || afterK2.reserved === 3,
    `${afterK2.reserved} reserved`);
  check("the lot counter matches its own allocations",
    lotAfterK2.reserved === lotAfterK2.summed, `counter ${lotAfterK2.reserved} vs rows ${lotAfterK2.summed}`);

  sub("K3. a production order that is mostly packed does not block a safe shrink");
  const skuK3 = await freshSku("ethiopia", 250);
  const oK3 = await skuOrder("coverage C", skuK3, 10);
  const schedK3 = await api(`/api/order-items/${oK3.itemId}/production-requirement`, { method: "POST" });
  const poK3 = schedK3.json?.productionOrder?.id;
  check("a production order for all 10 units exists", schedK3.status === 201 && poK3,
    `status=${schedK3.status} ${S(schedK3.json).slice(0, 120)}`);
  await topUpGreen(C.beans.ethiopia.id, 6);
  const rbK3 = await api("/api/roasting-batches", {
    method: "POST",
    body: { orderItemId: oK3.itemId, productionOrderId: poK3, greenBeanId: C.beans.ethiopia.id,
            greenBeanQuantity: 4, roastedBeanQuantity: 2.5, wasteQuantity: 1.5 },
  });
  check("the roast against that production order is accepted", rbK3.status === 201,
    `status=${rbK3.status} ${S(rbK3.json).slice(0, 140)}`);
  await passBatch(rbK3.json.id, "K3");
  const packK3 = await packSku(rbK3.json.id, skuK3.id, 8);
  check("8 of the 10 units are packed", packK3.status === 201,
    `status=${packK3.status} ${S(packK3.json).slice(0, 140)}`);
  const beforeK3 = await coverageOf(oK3.itemId);
  const rawK3 = await rawScheduled(oK3.itemId);
  console.log(`    fixture: raw target ${rawK3}, still owed ${beforeK3.scheduled}, reserved ${beforeK3.reserved} of ${beforeK3.ordered}`);
  check("the raw target is still 10", rawK3 === 10, `${rawK3}`);
  check("but only 2 units are still owed", beforeK3.scheduled === 2, `${beforeK3.scheduled} owed`);
  check("the 8 produced units are reserved to the line", beforeK3.reserved === 8,
    `${beforeK3.reserved} reserved`);
  check("so the line is covered exactly once, not twice", beforeK3.total === 10,
    `coverage ${beforeK3.total} of ${beforeK3.ordered}`);

  const shrinkK3 = await editOrder(oK3.id, [skuLine(skuK3, 9, { id: oK3.itemId })]);
  const afterK3 = await coverageOf(oK3.itemId);
  console.log(`    shrink 10->9: ${shrinkK3.status} -> reserved ${afterK3.reserved}, still owed ${afterK3.scheduled}`);
  check("the shrink is accepted even though raw targetUnits exceeds it",
    shrinkK3.status === 200, `status=${shrinkK3.status} ${S(shrinkK3.json).slice(0, 160)}`);
  check("coverage comes down with it", afterK3.total <= afterK3.ordered,
    `${afterK3.delivered}+${afterK3.reserved}+${afterK3.scheduled} vs ${afterK3.ordered}`);
  check("the produced units were not pretended away", afterK3.scheduled === 2,
    `${afterK3.scheduled} still owed`);

  sub("K4. produced units are not counted a second time as scheduled");
  const coverK4 = await api(`/api/order-items/${oK3.itemId}/production-requirement`, { method: "POST" });
  console.log(`    schedule again -> ${coverK4.status} ${S(coverK4.json).slice(0, 150)}`);
  check("scheduling again is refused, the line being fully covered", coverK4.status === 409,
    `status=${coverK4.status}`);
  check("the canonical demand reports the unpacked remainder, not the whole target",
    coverK4.json?.scheduledUnits === 2, `scheduledUnits=${S(coverK4.json?.scheduledUnits)}`);
  check("and counts the packed units once, as reserved",
    coverK4.json?.reservedUnits === afterK3.reserved,
    `reservedUnits=${S(coverK4.json?.reservedUnits)} vs ${afterK3.reserved}`);

  sub("K5. two open production orders are weighed together, not one at a time");
  const skuK5 = await freshSku("brazil", 1000);
  const oK5 = await skuOrder("coverage D", skuK5, 3);
  const po1K5 = await api(`/api/order-items/${oK5.itemId}/production-requirement`, { method: "POST" });
  const growK5 = await editOrder(oK5.id, [skuLine(skuK5, 6, { id: oK5.itemId })]);
  const po2K5 = await api(`/api/order-items/${oK5.itemId}/production-requirement`, { method: "POST" });
  const beforeK5 = await coverageOf(oK5.itemId);
  console.log(`    fixture: two production orders, ${beforeK5.scheduled} units owed of ${beforeK5.ordered}`);
  check("the increase is accepted", growK5.status === 200, `status=${growK5.status}`);
  check("two production orders now cover the line",
    po1K5.status === 201 && po2K5.status === 201 && beforeK5.scheduled === 6,
    `${po1K5.status}/${po2K5.status}, scheduled=${beforeK5.scheduled}`);

  const shrinkK5 = await editOrder(oK5.id, [skuLine(skuK5, 4, { id: oK5.itemId })]);
  const midK5 = await coverageOf(oK5.itemId);
  console.log(`    shrink 6->4 against 3+3 scheduled -> ${shrinkK5.status} ${S(shrinkK5.json).slice(0, 130)}`);
  check("shrinking below the combined commitment is refused", shrinkK5.status === 409,
    `status=${shrinkK5.status}`);
  check("neither production order was weighed on its own", midK5.ordered === 6,
    `ordered=${midK5.ordered}`);

  const exactK5 = await editOrder(oK5.id, [skuLine(skuK5, 6, { id: oK5.itemId })]);
  check("a shrink that exactly meets the commitment is allowed", exactK5.status === 200,
    `status=${exactK5.status} ${S(exactK5.json).slice(0, 130)}`);

  sub("K6. a cancelled production order stops covering anything");
  const cancelK6 = await api(`/api/production-orders/${po2K5.json?.productionOrder?.id}/status`, {
    method: "POST", body: { action: "cancel", reason: `${P} coverage test` },
  });
  const afterCancelK6 = await coverageOf(oK5.itemId);
  console.log(`    cancel one of the two -> ${cancelK6.status}, ${afterCancelK6.scheduled} units still owed`);
  check("the cancellation is accepted", cancelK6.status === 200,
    `status=${cancelK6.status} ${S(cancelK6.json).slice(0, 130)}`);
  check("only the surviving production order still counts", afterCancelK6.scheduled === 3,
    `${afterCancelK6.scheduled} owed`);

  const shrinkK6 = await editOrder(oK5.id, [skuLine(skuK5, 3, { id: oK5.itemId })]);
  const afterK6 = await coverageOf(oK5.itemId);
  console.log(`    shrink 6->3 -> ${shrinkK6.status}, coverage ${afterK6.total} of ${afterK6.ordered}`);
  check("the freed demand can now be given up", shrinkK6.status === 200,
    `status=${shrinkK6.status} ${S(shrinkK6.json).slice(0, 130)}`);
  check("and coverage still does not exceed the order", afterK6.total <= afterK6.ordered,
    `${afterK6.total} vs ${afterK6.ordered}`);

  sub("K7. a legacy kilogram line cannot carry production at all");
  const oK7 = await legacyKgOrder("legacy production", 10, { review: true });
  const schedK7 = await api(`/api/order-items/${oK7.itemId}/production-requirement`, { method: "POST" });
  console.log(`    schedule production for a legacy line -> ${schedK7.status} ${S(schedK7.json).slice(0, 130)}`);
  check("the production route refuses it", schedK7.status === 409, `status=${schedK7.status}`);
  check("no production order was created for it", (await rawScheduled(oK7.itemId)) === 0,
    "a production order exists");
  check("ProductionOrder.productSkuId is NOT NULL, so one could not exist",
    (await one(`SELECT is_nullable n FROM information_schema.columns
                 WHERE table_name='ProductionOrder' AND column_name='productSkuId'`)).n === "NO",
    "productSkuId is nullable");
  check("and no production order anywhere points at a line without a SKU",
    num((await one(`SELECT COUNT(*)::int n FROM "ProductionOrder" po
                      JOIN "OrderItem" oi ON oi.id = po."sourceOrderItemId"
                     WHERE oi."productSkuId" IS NULL`)).n) === 0,
    "an orphaned legacy production order exists");

  sub("K8. a legacy line still cannot be shrunk below what was roasted for it");
  await topUpGreen(C.beans.brazil.id, 8);
  const rbK8 = await api("/api/roasting-batches", {
    method: "POST",
    body: { orderItemId: oK7.itemId, greenBeanId: C.beans.brazil.id,
            greenBeanQuantity: 6, roastedBeanQuantity: 4, wasteQuantity: 2 },
  });
  check("a roast against the legacy line is accepted", rbK8.status === 201,
    `status=${rbK8.status} ${S(rbK8.json).slice(0, 140)}`);
  await passBatch(rbK8.json.id, "K8");
  const tooFarK8 = await editOrder(oK7.id, [
    { id: oK7.itemId, beanTypeName: `${P} legacy`, productId: C.coffees.brazil.id, quantityKg: 3 },
  ]);
  const fitsK8 = await editOrder(oK7.id, [
    { id: oK7.itemId, beanTypeName: `${P} legacy`, productId: C.coffees.brazil.id, quantityKg: 5 },
  ]);
  const rowK8 = await itemRow(oK7.itemId);
  console.log(`    legacy 10kg with 4kg roasted: ->3kg ${tooFarK8.status}, ->5kg ${fitsK8.status}, now ${rowK8.kg}kg`);
  check("shrinking below the roast is refused", tooFarK8.status === 409, `status=${tooFarK8.status}`);
  check("shrinking to something the roast fits inside is allowed", fitsK8.status === 200,
    `status=${fitsK8.status} ${S(fitsK8.json).slice(0, 130)}`);
  check("the line ends at 5 kg", near(num(rowK8.kg), 5), `quantityKg=${rowK8.kg}`);

  // ═══════════════════════════════════════════════════════════════════════
  section("L — THE EDIT TAKES ITS ROW LOCKS IN THE ORDER EVERYTHING ELSE DOES");
  //
  // StockAllocation → FinishedGoodsLot → OrderItem is the order lockOrderLifecycleResources
  // and lockDeliveryResources both take. The edit ends up needing all three — the trim claims
  // allocations and lots, the update writes the line — and taking them lazily reverses it: the
  // OrderItem written first, then the allocations reached for afterwards.
  //
  // ── How the cycle is forced, rather than hoped for ─────────────────────────
  // The side connection holds the LOT rows, which is the second resource in the order, not
  // the first. That lets the opposing operation take the allocations and stop, holding them:
  //
  //   side    holds the lot
  //   cancel  takes StockAllocation, blocks on the lot          → holds allocations
  //   edit    takes OrderItem (it writes the line first), then
  //           reaches back for the allocations                  → holds the line, wants allocations
  //   side    releases  → cancel gets the lot, then wants the line the edit is holding
  //
  // which is a cycle, and PostgreSQL breaks it with 40P01. Holding the allocations instead
  // would only queue the two behind each other and prove nothing. With the locks taken up
  // front in canonical order the edit never holds the line while asking for an allocation,
  // so the two simply serialise.

  sub("L1. a shrink and a cancel contend for the same allocations and lot");
  const skuL1 = await freshSku("indonesia", 250);
  const bL1 = await stockRoast(C.coffees.indonesia, C.beans.indonesia, 3);
  await packSku(bL1, skuL1.id, 8);
  const lotL1 = await skuLotFor(bL1);
  const oL1 = await skuOrder("lock order cancel", skuL1, 10);
  check("the line holds the lot's units", (await reservedUnits(oL1.itemId)) === 8,
    `${await reservedUnits(oL1.itemId)} reserved`);

  const holdL1 = new Client({ connectionString: DB_URL });
  await holdL1.connect();
  await holdL1.query("BEGIN");
  await holdL1.query(`SELECT id FROM "FinishedGoodsLot" WHERE id=$1 FOR UPDATE`, [lotL1.id]);

  // The cancel goes first: it claims the allocations and then stops on the lot, so it is
  // provably HOLDING the allocations while the edit runs.
  const cancelL1 = api(`/api/orders/${oL1.id}/status`, {
    method: "POST", body: { action: "cancel", reason: `${P} lock order` },
  });
  await sleep(1500);
  // Long enough for the edit to get through its reads and reach the point where it wants
  // the allocations — holding the line by then, if it takes its locks lazily.
  const editL1 = editOrder(oL1.id, [skuLine(skuL1, 5, { id: oL1.itemId })]);
  await sleep(5000);
  await holdL1.query("ROLLBACK");
  await holdL1.end();
  const [cancelResL1, editResL1] = await Promise.all([cancelL1, editL1]);

  const rowL1 = await one('SELECT status FROM "Order" WHERE id=$1', [oL1.id]);
  const lotResL1 = await lotReconciles(lotL1.id);
  const leftL1 = await reservedUnits(oL1.itemId);
  console.log(`    cancel=${cancelResL1.status} edit=${editResL1.status} -> order ${rowL1?.status}, reserved ${leftL1}, lot ${lotResL1.reserved}/${lotResL1.available}`);
  check("neither returned a server error",
    cancelResL1.status !== 500 && editResL1.status !== 500,
    `${cancelResL1.status}/${editResL1.status}`);
  check("neither deadlocked",
    !/deadlock|40P01/i.test(S(cancelResL1.json) + S(editResL1.json)),
    (S(cancelResL1.json) + S(editResL1.json)).slice(0, 150));
  check("one serialization won and the order is coherent",
    cancelResL1.status !== 200 || rowL1?.status === "Cancelled",
    `cancel=${cancelResL1.status} status=${rowL1?.status}`);
  check("a cancelled order strands no reservation",
    rowL1?.status !== "Cancelled" || leftL1 === 0, `${leftL1} units still reserved`);
  check("the lot counter still matches its own allocations",
    lotResL1.reserved === lotResL1.summed, `counter ${lotResL1.reserved} vs rows ${lotResL1.summed}`);
  check("and no counter went negative",
    lotResL1.reserved >= 0 && lotResL1.available >= 0,
    `${lotResL1.reserved}/${lotResL1.available}`);

  sub("L2. a shrink and a delivery contend for the same allocations and lot");
  const skuL2 = await freshSku("brazil", 250);
  const bL2 = await stockRoast(C.coffees.brazil, C.beans.brazil, 3);
  await packSku(bL2, skuL2.id, 8);
  const lotL2 = await skuLotFor(bL2);
  const oL2 = await skuOrder("lock order delivery", skuL2, 10);

  const holdL2 = new Client({ connectionString: DB_URL });
  await holdL2.connect();
  await holdL2.query("BEGIN");
  await holdL2.query(`SELECT id FROM "FinishedGoodsLot" WHERE id=$1 FOR UPDATE`, [lotL2.id]);

  // Same construction against the delivery path, which takes the same two resources through
  // lockDeliveryResources before it claims the line.
  const shipL2 = api("/api/deliveries", {
    method: "POST",
    body: { orderItemId: oL2.itemId, quantityUnits: 4, deliveryType: "partial", finishedGoodsLotId: lotL2.id },
  });
  await sleep(1500);
  const editL2 = editOrder(oL2.id, [skuLine(skuL2, 6, { id: oL2.itemId })]);
  await sleep(5000);
  await holdL2.query("ROLLBACK");
  await holdL2.end();
  const [shipResL2, editResL2] = await Promise.all([shipL2, editL2]);

  const coverL2 = await coverageOf(oL2.itemId);
  const lotResL2 = await lotReconciles(lotL2.id);
  console.log(`    deliver=${shipResL2.status} edit=${editResL2.status} -> ordered ${coverL2.ordered}, delivered ${coverL2.delivered}, reserved ${coverL2.reserved}`);
  check("neither returned a server error",
    shipResL2.status !== 500 && editResL2.status !== 500,
    `${shipResL2.status}/${editResL2.status}`);
  check("neither deadlocked",
    !/deadlock|40P01/i.test(S(shipResL2.json) + S(editResL2.json)),
    (S(shipResL2.json) + S(editResL2.json)).slice(0, 150));
  check("delivered units never exceed the quantity the line ends up carrying",
    coverL2.delivered <= coverL2.ordered, `${coverL2.delivered} delivered of ${coverL2.ordered}`);
  check("coverage still does not exceed the order", coverL2.total <= coverL2.ordered,
    `${coverL2.delivered}+${coverL2.reserved}+${coverL2.scheduled} vs ${coverL2.ordered}`);
  check("the lot counter still matches its own allocations",
    lotResL2.reserved === lotResL2.summed, `counter ${lotResL2.reserved} vs rows ${lotResL2.summed}`);
  check("and no counter went negative",
    lotResL2.reserved >= 0 && lotResL2.available >= 0,
    `${lotResL2.reserved}/${lotResL2.available}`);

  await invariants("after the order edit suite");

  section("ORDER EDIT INTEGRITY RESULT");
  console.log(`${results.pass} passed, ${results.fail} failed`);
  if (results.failures.length) console.log("FAILURES:\n  - " + results.failures.join("\n  - "));
  await db.end();
  process.exit(results.fail === 0 ? 0 : 1);
}

/** The same 32-bit key production-planning uses for pg_advisory_xact_lock(7762, …). */
function advisoryKeyOf(id) {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (Math.imul(31, h) + id.charCodeAt(i)) | 0;
  return h;
}

main().catch(async (e) => {
  console.log("FATAL:", e?.stack || e);
  try { await db.end(); } catch {}
  process.exit(1);
});
