// PACKAGING CONCURRENCY & LOCK-ORDER NORMALIZATION — R2.2A.
//
// Two properties, both proved by forcing the contention rather than hoping for it.
//
// ── 1. One canonical order for finished-goods lots ──────────────────────────
// The lot is the most contended row in this system and it was being acquired in four
// different orders: reserve paths walked candidates oldest-first, trim paths walked them
// newest-first, the bulk release left it to the planner, and the two lifecycle helpers
// used id. Any two of those touching the same pair of lots could take them in opposite
// directions and cycle.
//
// The obvious objection to testing this is that cuid ids are roughly time-ordered, so
// createdAt order and id order usually agree and the bug usually hides. This suite does
// not rely on that: it builds two lots and then deliberately INVERTS their createdAt
// against their id, so the two orderings provably disagree, and runs the paths against
// each other through a held-row barrier.
//
// ── 2. One packaging method per roast ───────────────────────────────────────
// The kilogram path and the unit path each refused to run on a batch the other had
// already packed, but each checked through an unlocked read. Two requests arriving
// together both saw nothing and both proceeded, so one roast could become both a kilogram
// lot and a unit lot — the same roasted coffee sold twice. Both routes now take the same
// RoastingBatch row lock as their first statement; exactly one may win.
import {
  ADMIN_PIN, db, api, check, section, sub, one, all, num, near, invariants, loginAs, results,
  DB_URL, Client, materialStock,
} from "./harness.mjs";
import { buildCatalog, teardown, roastAndPass } from "./catalog.mjs";

const S = (v) => { try { return JSON.stringify(v) ?? String(v); } catch { return String(v); } };
const P = "PKC";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let C;

/** Hold one row so both racers are forced to meet on it, then release together. */
async function holdRow(table, id) {
  const c = new Client({ connectionString: DB_URL });
  c.on("error", () => {});
  await c.connect();
  await c.query("BEGIN");
  await c.query(`SELECT "id" FROM "${table}" WHERE "id" = $1 FOR UPDATE`, [id]);
  return async () => { try { await c.query("COMMIT"); } catch {} await c.end(); };
}

/** 40P01 surfaces through the app as a 500. */
const anyServerError = (...rs) => rs.filter((r) => r.status === 500);

const stockBatch = (label, greenKg, roastedKg, wasteKg) =>
  roastAndPass(P, C.coffees.brazil, C.beans.brazil, greenKg, roastedKg, wasteKg, label);

const pack = (batchId, body) => api(`/api/roasting-batches/${batchId}/package`, { method: "PUT", body });
const packSku = (batchId, body) => api(`/api/roasting-batches/${batchId}/pack-sku`, { method: "POST", body });

/** A legacy kilogram order line, the shape the kg shelf actually serves. */
async function kgOrderLine(note, kg) {
  const r = await api("/api/orders", { method: "POST", body: {
    customerId: C.customers.cafe.id, notes: `${P} ${note}`,
    items: [{ productSkuId: C.skus.bra250.id, quantityUnits: 4 }],
  }});
  if (r.status !== 201) throw new Error(`kgOrderLine: ${r.status} ${S(r.json)}`);
  await api(`/api/orders/${r.json.id}/approve`, { method: "POST", body: { decision: "Yes" } });
  const itemId = r.json.items[0].id;
  await db.query(
    `UPDATE "OrderItem" SET "quantityUnits"=NULL, "deliveredUnits"=0, "quantityKg"=$2,
        "deliveredQty"=0, "productSkuId"=NULL, "productId"=$3,
        "preparationDecision"='Needs Production' WHERE id=$1`,
    [itemId, kg, C.coffees.brazil.id]);
  await db.query(`UPDATE "Order" SET status='Preparing', "approvalStatus"='Yes' WHERE id=$1`, [r.json.id]);
  return { orderId: r.json.id, itemId };
}

const review = (orderId, itemId) => api(`/api/orders/${orderId}/preparation-review`, {
  method: "POST", body: { items: [{ orderItemId: itemId }] } });
const cancel = (orderId, why) => api(`/api/orders/${orderId}/status`, {
  method: "POST", body: { action: "cancel", reason: `${P} ${why}` } });

const lotRow = async (id) => await one(
  `SELECT "availableQty" a, "reservedQty" r FROM "FinishedGoodsLot" WHERE id=$1`, [id]);

/** Lots whose createdAt order is deliberately the OPPOSITE of their id order. */
async function invertedLotPair(label, kgEach) {
  const b1 = await stockBatch(`${label}1`, kgEach + 2, kgEach, 2);
  const b2 = await stockBatch(`${label}2`, kgEach + 2, kgEach, 2);
  const p1 = await pack(b1.id, { bags1kg: kgEach });
  const p2 = await pack(b2.id, { bags1kg: kgEach });
  if (p1.status !== 200 || p2.status !== 200) throw new Error(`invertedLotPair pack: ${p1.status}/${p2.status}`);

  const lots = await all(
    `SELECT id FROM "FinishedGoodsLot" WHERE "roastingBatchId" IN ($1,$2) ORDER BY id ASC`, [b1.id, b2.id]);
  if (lots.length !== 2) throw new Error(`expected 2 lots, got ${lots.length}`);
  const [lowId, highId] = [lots[0].id, lots[1].id];

  // The inversion: the LOWER id gets the LATER createdAt. Anything ordering by createdAt
  // now visits highId first; anything ordering by id visits lowId first.
  await db.query(`UPDATE "FinishedGoodsLot" SET "createdAt" = now() - interval '2 hours' WHERE id=$1`, [highId]);
  await db.query(`UPDATE "FinishedGoodsLot" SET "createdAt" = now() - interval '1 hour'  WHERE id=$1`, [lowId]);

  const check2 = await all(
    `SELECT id FROM "FinishedGoodsLot" WHERE id IN ($1,$2) ORDER BY "createdAt" ASC`, [lowId, highId]);
  return { lowId, highId, createdAtFirst: check2[0].id };
}

async function main() {
  await db.connect();
  await teardown(P);
  await loginAs(ADMIN_PIN);
  C = await buildCatalog(P);

  // ═══════════════════════════════════════════════════════════════════════
  section("A — ONE CANONICAL LOT ORDER, WITH createdAt DELIBERATELY INVERTED");

  sub("A1. the fixture really does put createdAt and id in opposite orders");
  const pair = await invertedLotPair("A", 3);
  console.log(`    id-asc first = ${pair.lowId.slice(-6)} | createdAt-asc first = ${pair.createdAtFirst.slice(-6)}`);
  check("the two orderings disagree — the bug cannot hide behind cuid time-ordering",
    pair.createdAtFirst === pair.highId,
    `createdAt-first ${pair.createdAtFirst.slice(-6)} should be the HIGHER id ${pair.highId.slice(-6)}`);

  sub("A2. re-review vs cancellation, both spanning the same two lots");
  const l1 = await kgOrderLine("span cancel", 5);          // 5 kg over two 3 kg lots
  const seed1 = await review(l1.orderId, l1.itemId);
  check("the line reserved across both lots", seed1.status === 200, `status=${seed1.status}`);
  const spread1 = await all(
    `SELECT "finishedGoodsLotId" lot FROM "StockAllocation" WHERE "orderItemId"=$1 AND status='RESERVED'`,
    [l1.itemId]);
  check("reservation really does span two lots", new Set(spread1.map((r) => r.lot)).size === 2,
    `${new Set(spread1.map((r) => r.lot)).size} lot(s)`);

  const release1 = await holdRow("FinishedGoodsLot", pair.lowId);
  const rr = review(l1.orderId, l1.itemId);   // release both, then re-reserve both
  const cc = cancel(l1.orderId, "span cancel");
  await sleep(800);                            // both are now queued on the held lot
  await release1();
  const [rrRes, ccRes] = await Promise.all([rr, cc]);
  console.log(`    re-review ${rrRes.status}, cancel ${ccRes.status}`);
  check("neither side hit a deadlock or a server error",
    anyServerError(rrRes, ccRes).length === 0,
    `re-review ${rrRes.status} ${S(rrRes.json).slice(0, 90)} | cancel ${ccRes.status} ${S(ccRes.json).slice(0, 90)}`);
  check("at least one of the two was applied", rrRes.status === 200 || ccRes.status === 200,
    `${rrRes.status} / ${ccRes.status}`);
  const st1 = (await one('SELECT status FROM "Order" WHERE id=$1', [l1.orderId])).status;
  const held1 = num((await one(
    `SELECT COALESCE(SUM("quantityKg"),0)::float8 n FROM "StockAllocation"
      WHERE "orderItemId"=$1 AND status='RESERVED'`, [l1.itemId])).n);
  console.log(`    order ${st1}, still reserved ${held1} kg`);
  check("a cancelled order holds no reservations", st1 !== "Cancelled" || near(held1, 0),
    `order ${st1}, reserved ${held1} kg`);

  sub("A3. re-review vs delivery, both spanning the same two lots");
  const l2 = await kgOrderLine("span delivery", 5);
  const seed2 = await review(l2.orderId, l2.itemId);
  check("the second line reserved across both lots", seed2.status === 200, `status=${seed2.status}`);
  const spread2 = await all(
    `SELECT DISTINCT "finishedGoodsLotId" lot FROM "StockAllocation" WHERE "orderItemId"=$1 AND status='RESERVED'`,
    [l2.itemId]);
  const shipFrom = spread2[0]?.lot;

  const release2 = await holdRow("FinishedGoodsLot", pair.lowId);
  const rr2 = review(l2.orderId, l2.itemId);
  const dd = api("/api/deliveries", { method: "POST", body: {
    orderItemId: l2.itemId, quantityKg: 1, deliveryType: "partial", finishedGoodsLotId: shipFrom } });
  await sleep(800);
  await release2();
  const [rr2Res, ddRes] = await Promise.all([rr2, dd]);
  console.log(`    re-review ${rr2Res.status}, delivery ${ddRes.status}`);
  check("neither side hit a deadlock or a server error",
    anyServerError(rr2Res, ddRes).length === 0,
    `re-review ${rr2Res.status} ${S(rr2Res.json).slice(0, 90)} | delivery ${ddRes.status} ${S(ddRes.json).slice(0, 90)}`);

  sub("A4. both lots survive in a consistent state");
  for (const [name, id] of [["low-id", pair.lowId], ["high-id", pair.highId]]) {
    const r = await lotRow(id);
    check(`${name} lot: reserved never exceeds available`, num(r.r) <= num(r.a) + 0.0005,
      `available ${r.a}, reserved ${r.r}`);
    check(`${name} lot: no negative balance`, num(r.a) >= -0.0005 && num(r.r) >= -0.0005,
      `available ${r.a}, reserved ${r.r}`);
  }
  await invariants("after the inverted-order races");

  // ═══════════════════════════════════════════════════════════════════════
  section("B — ONE PACKAGING METHOD PER ROAST  (KG vs SKU)");

  sub("B1. kilogram and unit packaging race the same batch, three rounds");
  let wins = 0, losses = 0, serverErrors = 0, bothWon = 0;
  const bagBefore = await materialStock(C.materials.bag1kg.id);

  for (let round = 1; round <= 3; round++) {
    const b = await stockBatch(`B0${round}`, 12, 10, 2);
    const releaseBatch = await holdRow("RoastingBatch", b.id);
    const kg = pack(b.id, { bags1kg: 5 });
    const sku = packSku(b.id, { productSkuId: C.skus.bra1kg.id, units: 5 });
    await sleep(800);              // both are provably queued on the batch row
    await releaseBatch();
    const [kgRes, skuRes] = await Promise.all([kg, sku]);

    const ok = [kgRes.status === 200, skuRes.status === 201].filter(Boolean).length;
    if (ok === 1) wins++; if (ok === 2) bothWon++;
    losses += [kgRes, skuRes].filter((r) => r.status >= 400 && r.status < 500).length;
    serverErrors += anyServerError(kgRes, skuRes).length;

    const shapes = await one(
      `SELECT (SELECT COUNT(*) FROM "FinishedGoodsLot" WHERE "roastingBatchId"=$1)::int kglots,
              (SELECT COUNT(*) FROM "FinishedGoodsLot" WHERE "packedFromBatchId"=$1)::int unitlots`, [b.id]);
    const bat = await one(
      `SELECT "roastedAvailableKg" rak, "bags1kg" b1 FROM "RoastingBatch" WHERE id=$1`, [b.id]);
    const moves = num((await one(
      `SELECT COUNT(*)::int n FROM "InventoryMovement" WHERE "sourceDocId"=$1 AND category='FINISHED_GOODS'`,
      [b.id])).n);

    console.log(`    round ${round}: kg ${kgRes.status}, sku ${skuRes.status} -> kg-lots ${shapes.kglots}, unit-lots ${shapes.unitlots}, roasted left ${bat.rak}, finished movements ${moves}`);

    check(`round ${round}: exactly one packaging method succeeded`, ok === 1,
      `kg ${kgRes.status} ${S(kgRes.json).slice(0, 80)} | sku ${skuRes.status} ${S(skuRes.json).slice(0, 80)}`);
    check(`round ${round}: only one lot shape exists for the batch`,
      num(shapes.kglots) + num(shapes.unitlots) === 1,
      `kg-lots ${shapes.kglots}, unit-lots ${shapes.unitlots}`);
    check(`round ${round}: the roast was drawn down exactly once (10 - 5 = 5)`,
      near(num(bat.rak), 5), `roastedAvailableKg ${bat.rak}`);
    check(`round ${round}: one finished-goods movement, from the winner only`, moves === 1,
      `${moves} movements`);
    // The loser must leave no trace on the other model's counters.
    if (num(shapes.unitlots) === 1) {
      check(`round ${round}: the unit winner left the bag counters untouched`, num(bat.b1) === 0,
        `bags1kg ${bat.b1}`);
    } else {
      check(`round ${round}: the kilogram winner recorded its bags`, num(bat.b1) === 5,
        `bags1kg ${bat.b1}`);
    }
  }

  check("no round let both methods through", bothWon === 0, `${bothWon} round(s) double-packed`);
  check("no round produced a server error", serverErrors === 0, `${serverErrors} server error(s)`);
  check("every round produced exactly one loser with a domain-safe 4xx", losses === 3, `${losses} 4xx of 3 expected`);

  // The race above was won by the unit path every round, which on its own would be equally
  // consistent with the kilogram path being broken and always refusing. These two prove
  // the exclusivity is mutual: each method can win, and whichever gets there first locks
  // the other out — the outcome depends on who arrives first, not on which method it is.
  sub("B2. exclusivity is mutual — whichever arrives first wins");
  const bKg = await stockBatch("B-KG", 12, 10, 2);
  const kgFirst = await pack(bKg.id, { bags1kg: 5 });
  const skuSecond = await packSku(bKg.id, { productSkuId: C.skus.bra1kg.id, units: 5 });
  const kgShapes = await one(
    `SELECT (SELECT COUNT(*) FROM "FinishedGoodsLot" WHERE "roastingBatchId"=$1)::int kglots,
            (SELECT COUNT(*) FROM "FinishedGoodsLot" WHERE "packedFromBatchId"=$1)::int unitlots`, [bKg.id]);
  console.log(`    kg first -> ${kgFirst.status}, then sku -> ${skuSecond.status}  (kg-lots ${kgShapes.kglots}, unit-lots ${kgShapes.unitlots})`);
  check("the kilogram path CAN win", kgFirst.status === 200, `status=${kgFirst.status} ${S(kgFirst.json).slice(0, 100)}`);
  check("and then locks the unit path out with a 4xx",
    skuSecond.status >= 400 && skuSecond.status < 500, `status=${skuSecond.status} ${S(skuSecond.json).slice(0, 100)}`);
  check("only the kilogram lot shape exists",
    num(kgShapes.kglots) === 1 && num(kgShapes.unitlots) === 0,
    `kg-lots ${kgShapes.kglots}, unit-lots ${kgShapes.unitlots}`);

  const bSku = await stockBatch("B-SKU", 12, 10, 2);
  const skuFirst = await packSku(bSku.id, { productSkuId: C.skus.bra1kg.id, units: 5 });
  const kgSecond = await pack(bSku.id, { bags1kg: 5 });
  const skuShapes = await one(
    `SELECT (SELECT COUNT(*) FROM "FinishedGoodsLot" WHERE "roastingBatchId"=$1)::int kglots,
            (SELECT COUNT(*) FROM "FinishedGoodsLot" WHERE "packedFromBatchId"=$1)::int unitlots`, [bSku.id]);
  console.log(`    sku first -> ${skuFirst.status}, then kg -> ${kgSecond.status}  (kg-lots ${skuShapes.kglots}, unit-lots ${skuShapes.unitlots})`);
  check("the unit path CAN win", skuFirst.status === 201, `status=${skuFirst.status} ${S(skuFirst.json).slice(0, 100)}`);
  check("and then locks the kilogram path out with a 4xx",
    kgSecond.status >= 400 && kgSecond.status < 500, `status=${kgSecond.status} ${S(kgSecond.json).slice(0, 100)}`);
  check("only the unit lot shape exists",
    num(skuShapes.kglots) === 0 && num(skuShapes.unitlots) === 1,
    `kg-lots ${skuShapes.kglots}, unit-lots ${skuShapes.unitlots}`);

  sub("B3. packaging materials were consumed only by the winners");
  const bagAfter = await materialStock(C.materials.bag1kg.id);
  const unitWins = num((await one(
    `SELECT COUNT(*)::int n FROM "FinishedGoodsLot" f
       JOIN "RoastingBatch" rb ON rb.id = f."packedFromBatchId"
      WHERE rb."batchNumber" LIKE $1`, [`${P}-B%`])).n);
  console.log(`    1kg bags ${bagBefore} -> ${bagAfter} (consumed ${bagBefore - bagAfter}); unit-path winners ${unitWins}`);
  check("bags were drawn only for the rounds the unit path won",
    near(bagBefore - bagAfter, unitWins * 5), `consumed ${bagBefore - bagAfter}, expected ${unitWins * 5}`);

  await invariants("after the packaging-method races");

  section("PACKAGING CONCURRENCY RESULT");
  console.log(`${results.pass} passed, ${results.fail} failed`);
  if (results.failures.length) console.log("FAILURES:\n  - " + results.failures.join("\n  - "));
  await db.end();
  process.exit(results.fail === 0 ? 0 : 1);
}

main().catch(async (e) => { console.log("FATAL:", e?.stack || e); try { await db.end(); } catch {} process.exit(1); });
