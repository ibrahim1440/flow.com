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
import { buildCatalog, teardown, roastAndPass, seedLegacyKgLot } from "./catalog.mjs";

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

/** The one packaging operation, as the screen drives it. */
const packV2 = (batchId, lines) => api(`/api/roasting-batches/${batchId}/pack`, {
  method: "POST", body: { lines },
  headers: { "Idempotency-Key": `${P}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` },
});
/** The compatibility adapter, which must take the very same lock. */
const packSku = (batchId, body) => api(`/api/roasting-batches/${batchId}/pack-sku`, {
  method: "POST", body,
  headers: { "Idempotency-Key": `${P}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` },
});
const packed = (r) => r.status === 200 || r.status === 201;

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

/**
 * Lots whose createdAt order is deliberately the OPPOSITE of their id order.
 *
 * These are KILOGRAM lots on purpose: the allocator ordering under test is the one that
 * serves legacy kilogram order lines, which is live for the lots Production already holds.
 * The endpoint that used to create them is retired, so the fixture writes the rows the way
 * history left them rather than driving a withdrawn write path to manufacture them.
 */
async function invertedLotPair(label, kgEach) {
  const b1 = await stockBatch(`${label}1`, kgEach + 2, kgEach, 2);
  const b2 = await stockBatch(`${label}2`, kgEach + 2, kgEach, 2);
  await seedLegacyKgLot(b1.id, C.coffees.brazil.id, kgEach);
  await seedLegacyKgLot(b2.id, C.coffees.brazil.id, kgEach);

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
  section("B — ONE OPERATION AT A TIME PER ROAST");

  // This section used to prove that the kilogram path and the unit path could never both
  // run on one roast. That question is gone: there is one packaging operation now, and the
  // kilogram path cannot write at all. What replaces it is the guarantee that still has to
  // hold — two operations racing the same roast are SERIALISED on the batch row, so the
  // same roasted coffee can never be spent twice — and one the old shape never asked: that
  // the compatibility adapter takes that very same lock rather than slipping past it.

  sub("B1. two packaging operations race the same roast, three rounds");
  let serverErrors = 0, overdrawn = 0, bothWon = 0, singleWinner = 0;
  const bagBefore = await materialStock(C.materials.bag1kg.id);
  let expectedPackages = 0;

  for (let round = 1; round <= 3; round++) {
    // 10 kg roasted, two operations of 6 kg each: they cannot both fit, so serialisation is
    // the difference between one refusal and six kilograms conjured out of nothing.
    const b = await stockBatch(`B0${round}`, 12, 10, 2);
    const releaseBatch = await holdRow("RoastingBatch", b.id);
    const first = packV2(b.id, [{ kind: "pack", productSkuId: C.skus.bra1kg.id, packages: 6 }]);
    const second = packV2(b.id, [{ kind: "pack", productSkuId: C.skus.bra1kg.id, packages: 6 }]);
    await sleep(800);              // both are provably queued on the batch row
    await releaseBatch();
    const [r1, r2] = await Promise.all([first, second]);

    const won = [r1, r2].filter(packed).length;
    if (won === 1) singleWinner++;
    if (won === 2) bothWon++;
    expectedPackages += won * 6;
    serverErrors += anyServerError(r1, r2).length;

    const row = await one(
      `SELECT "roastedAvailableKg" rak, "roastedBeanQuantity" rbq FROM "RoastingBatch" WHERE id=$1`, [b.id]);
    if (num(row.rak) < -0.0005) overdrawn++;
    const units = num((await one(
      `SELECT COALESCE(SUM("unitsProduced"),0)::int u FROM "FinishedGoodsLot" WHERE "packedFromBatchId"=$1`,
      [b.id])).u);
    console.log(`    round ${round}: ${r1.status}/${r2.status} -> ${won} accepted, roasted left ${row.rak}, units ${units}`);
    if (units * 1 > num(row.rbq) + 0.0005) overdrawn++;
  }

  check("no round let both operations through on coffee that only covers one",
    bothWon === 0, `${bothWon} round(s) double-drew the same roast`);
  check("every round produced exactly one winner", singleWinner === 3, `${singleWinner} of 3 rounds`);
  check("no round produced a server error", serverErrors === 0, `${serverErrors} server error(s)`);
  check("no round drew more coffee than the roast held", overdrawn === 0, `${overdrawn} overdraw(s)`);

  sub("B2. the compatibility adapter contends on the same row, not beside it");
  // pack-sku no longer implements packaging — it reshapes the request and hands it to the
  // same route. If it had kept its own transaction it would take its own lock, and these
  // two would draw the same coffee concurrently instead of queueing.
  const bMix = await stockBatch("B-MIX", 12, 10, 2);
  const releaseMix = await holdRow("RoastingBatch", bMix.id);
  const direct = packV2(bMix.id, [{ kind: "pack", productSkuId: C.skus.bra1kg.id, packages: 6 }]);
  const viaAdapter = packSku(bMix.id, { productSkuId: C.skus.bra1kg.id, units: 6 });
  await sleep(800);
  await releaseMix();
  const [dRes, aRes] = await Promise.all([direct, viaAdapter]);
  const mixWon = [dRes, aRes].filter(packed).length;
  const mixRow = await one(
    `SELECT "roastedAvailableKg" rak FROM "RoastingBatch" WHERE id=$1`, [bMix.id]);
  const mixUnits = num((await one(
    `SELECT COALESCE(SUM("unitsProduced"),0)::int u FROM "FinishedGoodsLot" WHERE "packedFromBatchId"=$1`,
    [bMix.id])).u);
  console.log(`    direct ${dRes.status}, adapter ${aRes.status} -> ${mixWon} accepted, roasted left ${mixRow.rak}, units ${mixUnits}`);
  expectedPackages += mixWon * 6;

  check("exactly one of the two was accepted", mixWon === 1,
    `direct ${dRes.status} ${S(dRes.json).slice(0, 80)} | adapter ${aRes.status} ${S(aRes.json).slice(0, 80)}`);
  check("the loser was refused with a domain 4xx, not a server error",
    [dRes, aRes].some((r) => r.status >= 400 && r.status < 500) && anyServerError(dRes, aRes).length === 0,
    `${dRes.status}/${aRes.status}`);
  check("only six packages exist, not twelve", mixUnits === 6, `units ${mixUnits}`);
  check("and the roast was drawn exactly once", near(num(mixRow.rak), 4), `roastedAvailableKg ${mixRow.rak}`);

  sub("B3. packaging materials were consumed only by the operations that succeeded");
  const bagAfter = await materialStock(C.materials.bag1kg.id);
  console.log(`    1kg bags ${bagBefore} -> ${bagAfter} (consumed ${bagBefore - bagAfter}); packages made ${expectedPackages}`);
  check("one bag per package that was actually made, and none for the refusals",
    near(bagBefore - bagAfter, expectedPackages),
    `consumed ${bagBefore - bagAfter}, expected ${expectedPackages}`);

  await invariants("after the packaging concurrency races");

  section("PACKAGING CONCURRENCY RESULT");
  console.log(`${results.pass} passed, ${results.fail} failed`);
  if (results.failures.length) console.log("FAILURES:\n  - " + results.failures.join("\n  - "));
  await db.end();
  process.exit(results.fail === 0 ? 0 : 1);
}

main().catch(async (e) => { console.log("FATAL:", e?.stack || e); try { await db.end(); } catch {} process.exit(1); });
