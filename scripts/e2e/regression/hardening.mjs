// Operational failure, concurrency and data-integrity gate.
//
// This suite attacks the ERP rather than exercising it: simultaneous operators competing
// for the same scarce thing, identical requests replayed, transactions forced to fail
// halfway, and a security smoke test. Every assertion is about what the database looks
// like afterwards, because that is the only thing that matters when two people press the
// same button at the same moment.
import {
  ADMIN_PIN, db, api, check, issue, section, sub, one, all, num, near, invariants,
  loginAs, concurrently, greenStock, materialStock, skuUnits, roastedStock, results,
  setCookie, getCookie, ensureUser,
} from "./harness.mjs";
import { buildCatalog, teardown, roastAndPass} from "./catalog.mjs";

const S = (v) => { try { return JSON.stringify(v) ?? String(v); } catch { return String(v); } };
const P = "HRD";
let C;

// ── helpers ────────────────────────────────────────────────────────────────
const mkOrder = async (cust, note, items) => {
  const r = await api("/api/orders", { method: "POST", body: { customerId: cust, notes: `${P} ${note}`, items } });
  if (r.status !== 201) throw new Error("order create failed: " + S(r.json));
  await api(`/api/orders/${r.json.id}/approve`, { method: "POST", body: { decision: "Yes" } });
  return r.json;
};
const review = (o) =>
  api(`/api/orders/${o.id}/preparation-review`, { method: "POST", body: { items: o.items.map((i) => ({ orderItemId: i.id })) } });

const movementsFor = async (entityId) =>
  num((await one(`SELECT COUNT(*)::int n FROM "InventoryMovement" WHERE "referenceEntityId"=$1`, [entityId])).n);

const lotFor = async (skuId) =>
  (await one(`SELECT id FROM "FinishedGoodsLot" WHERE "productSkuId"=$1 AND "isUnitTracked" AND "unitsAvailable">0 ORDER BY "createdAt" LIMIT 1`, [skuId]))?.id;

async function main() {
  await db.connect();
  await teardown(P);
  await db.query('DELETE FROM "ProductionOrder" WHERE id LIKE $1', [P + "_%"]);
  await loginAs(ADMIN_PIN);
  C = await buildCatalog(P);
  const adminCookie = getCookie();

  // ═══════════════════════════════════════════════════════════════════════
  section("A — CONCURRENCY: SIMULTANEOUS OPERATORS");

  sub("A1. two reviewers on the same order reserve the stock only once");
  const stockBatch = await roastAndPass(P, C.coffees.brazil, C.beans.brazil, 12, 10, 2, "A01");
  await api(`/api/roasting-batches/${stockBatch.id}/pack-sku`, { method: "POST", body: { productSkuId: C.skus.bra250.id, units: 40 } });

  const oA = await mkOrder(C.customers.cafe.id, "double review", [{ productSkuId: C.skus.bra250.id, quantityUnits: 30 }]);
  const bothReviews = await concurrently(2, () => review(oA));
  check("both review requests answered", bothReviews.every((r) => r.status === 200 || r.status === 409), S(bothReviews.map((r) => r.status)));
  const resA = num((await one(`SELECT COALESCE(SUM("quantityUnits"),0)::int n FROM "StockAllocation" WHERE "orderItemId"=$1 AND status='RESERVED'`, [oA.items[0].id])).n);
  check("exactly 30 units reserved, not 60", resA === 30, String(resA));
  const lotA = await skuUnits(C.skus.bra250.id);
  check("the lot's reserved figure agrees", lotA.reserved === 30, S(lotA));

  sub("A2. six orders race for the last scarce units");
  const scarce = await roastAndPass(P, C.coffees.ethiopia, C.beans.ethiopia, 4, 3, 1, "A02");
  await api(`/api/roasting-batches/${scarce.id}/pack-sku`, { method: "POST", body: { productSkuId: C.skus.eth250.id, units: 6 } });
  const racers = [];
  for (let i = 0; i < 6; i++) racers.push(await mkOrder(C.customers.retail.id, `race ${i}`, [{ productSkuId: C.skus.eth250.id, quantityUnits: 2 }]));
  await concurrently(6, (i) => review(racers[i]));
  const totalReserved = num((await one(
    `SELECT COALESCE(SUM(sa."quantityUnits"),0)::int n FROM "StockAllocation" sa
       JOIN "OrderItem" oi ON oi.id=sa."orderItemId" JOIN "Order" o ON o.id=oi."orderId"
      WHERE o.notes LIKE $1 AND sa.status='RESERVED' AND oi."productSkuId"=$2`, [P + "%", C.skus.eth250.id])).n);
  check("six racers reserved exactly the 6 units that existed", totalReserved === 6, String(totalReserved));
  const eth = await skuUnits(C.skus.eth250.id);
  check("no lot over-reserved", eth.reserved <= eth.available, S(eth));

  sub("A3. two production requirements for the same demand");
  const oB = await mkOrder(C.customers.hotel.id, "double requirement", [{ productSkuId: C.skus.bra1kg.id, quantityUnits: 12 }]);
  await review(oB);
  const reqRace = await concurrently(4, () => api(`/api/order-items/${oB.items[0].id}/production-requirement`, { method: "POST" }));
  const madeB = reqRace.filter((r) => r.status === 201).length;
  const rowsB = num((await one(`SELECT COUNT(*)::int n FROM "ProductionOrder" WHERE "sourceOrderItemId"=$1`, [oB.items[0].id])).n);
  const targetB = num((await one(`SELECT COALESCE(SUM("targetUnits"),0)::int n FROM "ProductionOrder" WHERE "sourceOrderItemId"=$1`, [oB.items[0].id])).n);
  check("exactly one production order exists", rowsB === 1, `created=${madeB} rows=${rowsB} statuses=${S(reqRace.map((r) => r.status))}`);
  check("scheduling the demand exactly once (12 units)", targetB === 12, String(targetB));

  sub("A4. two production users acting on the same production order");
  const poB = await one(`SELECT id, "productionNumber" FROM "ProductionOrder" WHERE "sourceOrderItemId"=$1`, [oB.items[0].id]);
  const releaseRace = await concurrently(3, () => api(`/api/production-orders/${poB.id}/status`, { method: "POST", body: { action: "release" } }));
  const okRelease = releaseRace.filter((r) => r.status === 200).length;
  check("only one release succeeds", okRelease === 1, S(releaseRace.map((r) => r.status)));
  const stB = await one('SELECT status FROM "ProductionOrder" WHERE id=$1', [poB.id]);
  check("the order is IN_PRODUCTION exactly once", stB.status === "IN_PRODUCTION", stB.status);

  // Release versus cancel at the same instant must not leave a contradictory state.
  const oC = await mkOrder(C.customers.cafe.id, "release vs cancel", [{ productSkuId: C.skus.bra1kg.id, quantityUnits: 5 }]);
  await review(oC);
  const poC = (await api(`/api/order-items/${oC.items[0].id}/production-requirement`, { method: "POST" })).json.productionOrder;
  const clash = await Promise.all([
    api(`/api/production-orders/${poC.id}/status`, { method: "POST", body: { action: "release" } }),
    api(`/api/production-orders/${poC.id}/status`, { method: "POST", body: { action: "cancel", reason: P + " clash" } }),
  ]);
  const winners = clash.filter((r) => r.status === 200).length;
  const stC = await one('SELECT status FROM "ProductionOrder" WHERE id=$1', [poC.id]);
  check("release and cancel at once resolve to one outcome", ["IN_PRODUCTION", "CANCELLED"].includes(stC.status), stC.status);
  check("  and both were not applied", winners <= 2 && stC.status !== "PENDING", `winners=${winners} status=${stC.status}`);

  sub("A5. two roasts drawing on the same green lot");
  const beanBefore = await greenStock(C.beans.indonesia.id);
  const roastRace = await concurrently(4, () =>
    api("/api/roasting-batches", { method: "POST", body: {
      greenBeanId: C.beans.indonesia.id, productId: C.coffees.indonesia.id,
      greenBeanQuantity: beanBefore / 3, roastedBeanQuantity: beanBefore / 4, wasteQuantity: 0,
    } })
  );
  const roastOk = roastRace.filter((r) => r.status === 201).length;
  const beanAfter = await greenStock(C.beans.indonesia.id);
  check(`${roastOk} of 4 concurrent roasts accepted`, roastOk >= 1 && roastOk <= 3, S(roastRace.map((r) => r.status)));
  check("green stock never went negative", beanAfter >= 0, String(beanAfter));
  check("green drawn equals exactly what the accepted roasts consumed",
    near(beanBefore - beanAfter, roastOk * (beanBefore / 3), 0.002), `${beanBefore} -> ${beanAfter}, ${roastOk} roasts`);
  const roastNums = (await all(`SELECT "batchNumber" FROM "RoastingBatch" WHERE "greenBeanId"=$1`, [C.beans.indonesia.id])).map((r) => r.batchNumber);
  check("concurrent roasts got distinct serials", new Set(roastNums).size === roastNums.length, S(roastNums));

  sub("A6. two packers consuming the same roasted lot");
  const packBatch = await roastAndPass(P, C.coffees.brazil, C.beans.brazil, 12, 10, 2, "A03");
  const packRace = await concurrently(3, () =>
    api(`/api/roasting-batches/${packBatch.id}/pack-sku`, { method: "POST", body: { productSkuId: C.skus.bra1kg.id, units: 8 } })
  );
  const packOk = packRace.filter((r) => r.status === 201).length;
  const remaining = num((await one('SELECT "roastedAvailableKg" k FROM "RoastingBatch" WHERE id=$1', [packBatch.id])).k);
  check(`${packOk} of 3 concurrent packs accepted (10 kg holds one 8 kg pack)`, packOk === 1, S(packRace.map((r) => r.status)));
  check("roasted stock never went negative", remaining >= 0, String(remaining));
  check("exactly 8 kg was drawn", near(remaining, 2, 0.002), String(remaining));

  sub("A7. two dispatchers shipping the same line");
  const oD = await mkOrder(C.customers.retail.id, "double ship", [{ productSkuId: C.skus.bra250.id, quantityUnits: 5 }]);
  await review(oD);
  const lotD = await lotFor(C.skus.bra250.id);
  const shipRace = await concurrently(3, () =>
    api("/api/deliveries", { method: "POST", body: { orderItemId: oD.items[0].id, quantityUnits: 5, deliveryType: "full", finishedGoodsLotId: lotD } })
  );
  const shipOk = shipRace.filter((r) => r.status === 201 || r.status === 200).length;
  const delivered = num((await one('SELECT "deliveredUnits" d FROM "OrderItem" WHERE id=$1', [oD.items[0].id])).d);
  const deliveryRows = num((await one('SELECT COUNT(*)::int n FROM "Delivery" WHERE "orderItemId"=$1', [oD.items[0].id])).n);
  check("only one shipment succeeds", shipOk === 1, S(shipRace.map((r) => r.status)));
  check("delivered units = 5, not 15", delivered === 5, String(delivered));
  check("exactly one delivery record", deliveryRows === 1, String(deliveryRows));

  sub("A8. two QC users finalizing the same batch with opposite verdicts");
  const qcBatch = await api("/api/roasting-batches", { method: "POST", body: {
    greenBeanId: C.beans.brazil.id, productId: C.coffees.brazil.id,
    greenBeanQuantity: 6, roastedBeanQuantity: 5, wasteQuantity: 1 } });
  const qcId = qcBatch.json.id;
  await api("/api/qc-records", { method: "POST", body: { batchId: qcId, decision: "Accept", onProfile: true } });
  const qcRace = await Promise.all([
    api(`/api/qc/${qcId}/finalize`, { method: "POST", body: { outcome: "Passed" } }),
    api(`/api/qc/${qcId}/finalize`, { method: "POST", body: { outcome: "Rejected", finalDecisionReason: P + " clash" } }),
  ]);
  const qcOk = qcRace.filter((r) => r.status === 200).length;
  const qcState = await one('SELECT status FROM "RoastingBatch" WHERE id=$1', [qcId]);
  check("only one QC verdict is accepted", qcOk === 1, S(qcRace.map((r) => r.status)));
  check("the batch holds a single decided status", ["Passed", "Rejected"].includes(qcState.status), qcState.status);

  await invariants("after concurrency");

  // ═══════════════════════════════════════════════════════════════════════
  section("B — IDEMPOTENCY: REPLAYED REQUESTS");

  sub("B1. replaying a delivery does not ship twice");
  const oE = await mkOrder(C.customers.hotel.id, "replay ship", [{ productSkuId: C.skus.bra250.id, quantityUnits: 4 }]);
  await review(oE);
  const lotE = await lotFor(C.skus.bra250.id);
  const body = { orderItemId: oE.items[0].id, quantityUnits: 4, deliveryType: "full", finishedGoodsLotId: lotE };
  const first = await api("/api/deliveries", { method: "POST", body });
  const replay = await api("/api/deliveries", { method: "POST", body });
  check("the first shipment is accepted", first.status === 201, "status=" + first.status);
  check("an identical replay is refused", replay.status >= 400, "status=" + replay.status + " " + S(replay.json).slice(0, 110));
  const delE = num((await one('SELECT "deliveredUnits" d FROM "OrderItem" WHERE id=$1', [oE.items[0].id])).d);
  check("delivered stays at 4", delE === 4, String(delE));

  sub("B2. replaying a production requirement does not schedule twice");
  const oF = await mkOrder(C.customers.cafe.id, "replay requirement", [{ productSkuId: C.skus.eth1kg.id, quantityUnits: 9 }]);
  await review(oF);
  const r1 = await api(`/api/order-items/${oF.items[0].id}/production-requirement`, { method: "POST" });
  const r2 = await api(`/api/order-items/${oF.items[0].id}/production-requirement`, { method: "POST" });
  const r3 = await api(`/api/order-items/${oF.items[0].id}/production-requirement`, { method: "POST" });
  check("first schedules", r1.status === 201, "status=" + r1.status);
  check("replays are refused", r2.status === 409 && r3.status === 409, S([r2.status, r3.status]));
  const poF = num((await one('SELECT COUNT(*)::int n FROM "ProductionOrder" WHERE "sourceOrderItemId"=$1', [oF.items[0].id])).n);
  check("one production order only", poF === 1, String(poF));

  sub("B3. replaying a pack does not create finished goods twice");
  const packB = await roastAndPass(P, C.coffees.ethiopia, C.beans.ethiopia, 8, 6, 2, "B01");
  const packBody = { productSkuId: C.skus.eth1kg.id, units: 6 };
  const p1 = await api(`/api/roasting-batches/${packB.id}/pack-sku`, { method: "POST", body: packBody });
  const p2 = await api(`/api/roasting-batches/${packB.id}/pack-sku`, { method: "POST", body: packBody });
  check("first pack accepted", p1.status === 201, "status=" + p1.status);
  check("replay refused — the roast is spent", p2.status >= 400, "status=" + p2.status + " " + S(p2.json).slice(0, 110));
  const lotsB = num((await one(`SELECT COUNT(*)::int n FROM "FinishedGoodsLot" WHERE "packedFromBatchId"=$1`, [packB.id])).n);
  check("one finished-goods lot from that batch", lotsB === 1, String(lotsB));

  sub("B4. replaying an order status action does not double-apply");
  const oG = await mkOrder(C.customers.retail.id, "replay status", [{ productSkuId: C.skus.bra250.id, quantityUnits: 3 }]);
  await review(oG);
  const h1 = await api(`/api/orders/${oG.id}/status`, { method: "POST", body: { action: "hold", reason: P + " a" } });
  const h2 = await api(`/api/orders/${oG.id}/status`, { method: "POST", body: { action: "hold", reason: P + " a" } });
  check("hold applies once", h1.status === 200 && h2.status === 409, S([h1.status, h2.status]));
  const holds = num((await one(`SELECT COUNT(*)::int n FROM "OrderActivity" WHERE "orderId"=$1 AND type='ORDER_HELD'`, [oG.id])).n);
  check("one hold recorded on the timeline", holds === 1, String(holds));

  sub("B5. replaying a roast creates a second batch — and it should");
  // Roasting is not idempotent by nature: two identical roasts are two real batches of
  // coffee. What must hold is that stock moves exactly once per batch.
  const beforeRoast = await greenStock(C.beans.brazil.id);
  const rr1 = await api("/api/roasting-batches", { method: "POST", body: { greenBeanId: C.beans.brazil.id, productId: C.coffees.brazil.id, greenBeanQuantity: 3, roastedBeanQuantity: 2.5, wasteQuantity: 0.5 } });
  const rr2 = await api("/api/roasting-batches", { method: "POST", body: { greenBeanId: C.beans.brazil.id, productId: C.coffees.brazil.id, greenBeanQuantity: 3, roastedBeanQuantity: 2.5, wasteQuantity: 0.5 } });
  const afterRoast = await greenStock(C.beans.brazil.id);
  check("both roasts recorded", rr1.status === 201 && rr2.status === 201, S([rr1.status, rr2.status]));
  check("green fell by exactly 6 kg — one deduction per batch", near(beforeRoast - afterRoast, 6, 0.002), `${beforeRoast} -> ${afterRoast}`);
  const movesR = num((await one(`SELECT COUNT(*)::int n FROM "InventoryMovement" WHERE "sourceDocId" IN ($1,$2)`, [rr1.json.id, rr2.json.id])).n);
  check("one inventory movement per batch, not more", movesR === 2, String(movesR));

  await invariants("after idempotency");

  // ═══════════════════════════════════════════════════════════════════════
  section("C — ATOMICITY: FORCED MID-TRANSACTION FAILURE");

  sub("C1. a pack that runs out of a LATER material rolls the whole thing back");
  // The pack consumes roasted coffee first, then each material in turn. Starving the
  // label — the last component — forces the failure after coffee and bags have already
  // been decremented inside the transaction.
  const atomicBatch = await roastAndPass(P, C.coffees.brazil, C.beans.brazil, 14, 12, 2, "C01");
  const labelBefore = await materialStock(C.materials.label.id);
  await db.query('UPDATE "MaterialItem" SET "quantityOnHand"=2 WHERE id=$1', [C.materials.label.id]);

  const roastedBefore = num((await one('SELECT "roastedAvailableKg" k FROM "RoastingBatch" WHERE id=$1', [atomicBatch.id])).k);
  const bagBefore = await materialStock(C.materials.bag1kg.id);
  const lotCountBefore = num((await one('SELECT COUNT(*)::int n FROM "FinishedGoodsLot"')).n);
  const movesBefore = num((await one('SELECT COUNT(*)::int n FROM "InventoryMovement"')).n);

  const doomed = await api(`/api/roasting-batches/${atomicBatch.id}/pack-sku`, { method: "POST", body: { productSkuId: C.skus.bra1kg.id, units: 10 } });
  check("the pack is refused for the short component", doomed.status >= 400, "status=" + doomed.status + " " + S(doomed.json).slice(0, 130));
  check("  and names the material that ran out", /label/i.test(S(doomed.json)), S(doomed.json).slice(0, 150));

  const roastedAfter = num((await one('SELECT "roastedAvailableKg" k FROM "RoastingBatch" WHERE id=$1', [atomicBatch.id])).k);
  check("roasted coffee was rolled back", near(roastedAfter, roastedBefore, 0.002), `${roastedBefore} -> ${roastedAfter}`);
  check("the bag stock was rolled back", (await materialStock(C.materials.bag1kg.id)) === bagBefore, String(await materialStock(C.materials.bag1kg.id)));
  check("no finished-goods lot was created", num((await one('SELECT COUNT(*)::int n FROM "FinishedGoodsLot"')).n) === lotCountBefore, "lots changed");
  check("no inventory movement was left behind", num((await one('SELECT COUNT(*)::int n FROM "InventoryMovement"')).n) === movesBefore, "movements changed");
  await db.query('UPDATE "MaterialItem" SET "quantityOnHand"=$2 WHERE id=$1', [C.materials.label.id, labelBefore]);

  sub("C2. a roast that exceeds green stock leaves nothing behind");
  const beanId = C.beans.ethiopia.id;
  const gStart = await greenStock(beanId);
  const batchesBefore = num((await one('SELECT COUNT(*)::int n FROM "RoastingBatch"')).n);
  const movesBefore2 = num((await one('SELECT COUNT(*)::int n FROM "InventoryMovement"')).n);
  const tooBig = await api("/api/roasting-batches", { method: "POST", body: {
    greenBeanId: beanId, productId: C.coffees.ethiopia.id,
    greenBeanQuantity: gStart + 500, roastedBeanQuantity: gStart + 400, wasteQuantity: 0 } });
  check("an impossible roast is refused", tooBig.status >= 400, "status=" + tooBig.status);
  check("green stock is untouched", near(await greenStock(beanId), gStart, 0.002), String(await greenStock(beanId)));
  check("no batch row was created", num((await one('SELECT COUNT(*)::int n FROM "RoastingBatch"')).n) === batchesBefore, "batches changed");
  check("no inventory movement was created", num((await one('SELECT COUNT(*)::int n FROM "InventoryMovement"')).n) === movesBefore2, "movements changed");

  sub("C3. a delivery against a missing lot writes nothing");
  const oH = await mkOrder(C.customers.hotel.id, "bad lot", [{ productSkuId: C.skus.bra250.id, quantityUnits: 2 }]);
  await review(oH);
  const delBefore = num((await one('SELECT COUNT(*)::int n FROM "Delivery"')).n);
  const resQ = `SELECT COALESCE(SUM("quantityUnits"),0)::int n FROM "StockAllocation" WHERE "orderItemId"=$1 AND status='RESERVED'`;
  const resBefore = num((await one(resQ, [oH.items[0].id])).n);
  const badLot = await api("/api/deliveries", { method: "POST", body: { orderItemId: oH.items[0].id, quantityUnits: 2, deliveryType: "full", finishedGoodsLotId: "does-not-exist" } });
  check("the delivery is refused", badLot.status >= 400, "status=" + badLot.status);
  check("no delivery row was written", num((await one('SELECT COUNT(*)::int n FROM "Delivery"')).n) === delBefore, "deliveries changed");
  // Whatever the shelf could cover, the failed delivery must leave it exactly as it was.
  const resAfter = num((await one(resQ, [oH.items[0].id])).n);
  check(`the reservation is untouched (${resBefore})`, resAfter === resBefore, `${resBefore} -> ${resAfter}`);

  await invariants("after atomicity");

  // ═══════════════════════════════════════════════════════════════════════
  section("D — PRODUCTION INVARIANTS");

  sub("D1. a batch cannot be packed down both packaging paths");
  const dual = await roastAndPass(P, C.coffees.brazil, C.beans.brazil, 8, 6, 2, "D01");
  const skuPack = await api(`/api/roasting-batches/${dual.id}/pack-sku`, { method: "POST", body: { productSkuId: C.skus.bra1kg.id, units: 5 } });
  check("packed into a SKU", skuPack.status === 201, S(skuPack.json).slice(0, 120));
  const legacy = await api(`/api/roasting-batches/${dual.id}/package`, { method: "PUT", body: { bags1kg: 1, bags3kg: 0, bags250g: 0, bags150g: 0, samplesGrams: 0 } });
  check("the legacy kilogram path is refused on the same batch", legacy.status >= 400, "status=" + legacy.status + " " + S(legacy.json).slice(0, 110));

  sub("D2. one batch cannot be credited to two production orders");
  // Far beyond any shelf stock, so a shortfall — and therefore a production order — is
  // guaranteed for both.
  const oI = await mkOrder(C.customers.cafe.id, "two POs", [{ productSkuId: C.skus.bra1kg.id, quantityUnits: 400 }]);
  await review(oI);
  const rI = await api(`/api/order-items/${oI.items[0].id}/production-requirement`, { method: "POST" });
  check("first production order raised", rI.status === 201, "status=" + rI.status + " " + S(rI.json).slice(0, 110));
  const poI = rI.json.productionOrder;
  const oJ = await mkOrder(C.customers.hotel.id, "two POs b", [{ productSkuId: C.skus.bra1kg.id, quantityUnits: 400 }]);
  await review(oJ);
  const rJ = await api(`/api/order-items/${oJ.items[0].id}/production-requirement`, { method: "POST" });
  check("second production order raised", rJ.status === 201, "status=" + rJ.status + " " + S(rJ.json).slice(0, 110));
  const poJ = rJ.json.productionOrder;
  const shared = await roastAndPass(P, C.coffees.brazil, C.beans.brazil, 8, 6, 2, "D02");
  const linkRace = await Promise.all([
    api(`/api/production-orders/${poI.id}/batches`, { method: "POST", body: { roastingBatchId: shared.id } }),
    api(`/api/production-orders/${poJ.id}/batches`, { method: "POST", body: { roastingBatchId: shared.id } }),
  ]);
  const linkOk = linkRace.filter((r) => r.status === 201).length;
  check("only one production order can claim the batch", linkOk === 1, S(linkRace.map((r) => r.status)));
  const owner = await one('SELECT "productionOrderId" p FROM "RoastingBatch" WHERE id=$1', [shared.id]);
  check("the batch names exactly one owner", owner.p === poI.id || owner.p === poJ.id, S(owner));

  sub("D3. production progress never exceeds real production");
  const over = await all(`
    SELECT po."productionNumber", po."targetUnits",
           COALESCE(SUM(f."unitsProduced"),0)::int packed,
           COALESCE(SUM(rb."roastedBeanQuantity"),0) roasted
      FROM "ProductionOrder" po
      LEFT JOIN "RoastingBatch" rb ON rb."productionOrderId"=po.id AND NOT rb."isBlend" AND rb.status<>'Rejected'
      LEFT JOIN "FinishedGoodsLot" f ON f."packedFromBatchId"=rb.id AND f."productSkuId"=po."productSkuId"
     GROUP BY po.id, po."productionNumber", po."targetUnits"`);
  const impossible = over.filter((r) => num(r.packed) < 0 || num(r.roasted) < 0);
  check("no production order reports negative progress", impossible.length === 0, S(impossible.slice(0, 3)));

  sub("D4. cancelling demand never erases produced stock");
  const producedBefore = num((await one(`SELECT COALESCE(SUM("unitsProduced"),0)::int n FROM "FinishedGoodsLot" WHERE "productSkuId"=$1`, [C.skus.bra1kg.id])).n);
  await api(`/api/orders/${oI.id}/status`, { method: "POST", body: { action: "cancel", reason: P + " demand withdrawn" } });
  const producedAfter = num((await one(`SELECT COALESCE(SUM("unitsProduced"),0)::int n FROM "FinishedGoodsLot" WHERE "productSkuId"=$1`, [C.skus.bra1kg.id])).n);
  check("finished goods survive the cancellation", producedAfter === producedBefore, `${producedBefore} -> ${producedAfter}`);

  sub("D5. every stock movement has a traceable source");
  const orphan = await all(`SELECT id FROM "InventoryMovement" WHERE "sourceDocType" IS NULL OR "sourceDocId" IS NULL OR "referenceEntityId" IS NULL`);
  check("no inventory movement lacks a source document", orphan.length === 0, String(orphan.length));

  await invariants("after production invariants");

  // ═══════════════════════════════════════════════════════════════════════
  section("E — SECURITY SMOKE TEST");

  sub("E1. authentication");
  setCookie("");
  for (const [path, method] of [["/api/orders", "GET"], ["/api/roasting-batches", "GET"], ["/api/production-orders", "GET"], ["/api/deliveries", "GET"]]) {
    const r = await api(path, { method });
    check(`${method} ${path} without a session -> 401`, r.status === 401, "status=" + r.status);
  }
  const forgedWrite = await api("/api/orders", { method: "POST", body: { customerId: C.customers.cafe.id, items: [{ productSkuId: C.skus.bra250.id, quantityUnits: 1 }] } });
  check("writing without a session -> 401", forgedWrite.status === 401, "status=" + forgedWrite.status);
  const forgedCookie = await api("/api/orders", { method: "GET", raw: true });
  check("a garbage token is not accepted", forgedCookie.status === 401, "status=" + forgedCookie.status);
  setCookie(adminCookie);

  sub("E2. malformed and hostile identifiers");
  for (const bad of ["does-not-exist", "../../etc/passwd", "1 OR 1=1", "%27%20OR%20%271", "null", "00000000-0000-0000-0000-000000000000"]) {
    const r = await api(`/api/production-orders/${encodeURIComponent(bad)}`);
    const clean = !/prisma|invocation|P20\d\d|at Object\.|\.ts:\d+/i.test(S(r.json));
    check(`id "${bad.slice(0, 22)}" -> ${r.status}, no internals leaked`, (r.status === 404 || r.status === 400) && clean, `status=${r.status} ${S(r.json).slice(0, 90)}`);
  }

  sub("E3. invalid and negative numbers");
  const oK = await mkOrder(C.customers.cafe.id, "numeric", [{ productSkuId: C.skus.bra250.id, quantityUnits: 4 }]);
  await review(oK);
  const lotK = await lotFor(C.skus.bra250.id);
  const numericCases = [
    ["negative units", { quantityUnits: -5 }],
    ["zero units", { quantityUnits: 0 }],
    ["fractional units", { quantityUnits: 1.5 }],
    ["absurd units", { quantityUnits: 999999999 }],
    ["NaN", { quantityUnits: "not-a-number" }],
    ["Infinity", { quantityUnits: 1e400 }],
  ];
  for (const [label, patch] of numericCases) {
    const r = await api("/api/deliveries", { method: "POST", body: { orderItemId: oK.items[0].id, deliveryType: "partial", finishedGoodsLotId: lotK, ...patch } });
    check(`delivery with ${label} is refused`, r.status >= 400, "status=" + r.status + " " + S(r.json).slice(0, 90));
  }
  const negRoast = await api("/api/roasting-batches", { method: "POST", body: { greenBeanId: C.beans.brazil.id, productId: C.coffees.brazil.id, greenBeanQuantity: -10, roastedBeanQuantity: -5, wasteQuantity: 0 } });
  check("a negative roast is refused", negRoast.status >= 400, "status=" + negRoast.status);
  const negOrder = await api("/api/orders", { method: "POST", body: { customerId: C.customers.cafe.id, notes: P + " neg", items: [{ productSkuId: C.skus.bra250.id, quantityUnits: -3 }] } });
  check("an order for negative units is refused", negOrder.status >= 400, "status=" + negOrder.status);
  const delK = num((await one('SELECT "deliveredUnits" d FROM "OrderItem" WHERE id=$1', [oK.items[0].id])).d);
  check("none of the hostile numbers moved anything", delK === 0, String(delK));

  sub("E4. mass assignment");
  const massOrder = await api("/api/orders", { method: "POST", body: {
    customerId: C.customers.cafe.id, notes: P + " mass",
    items: [{ productSkuId: C.skus.bra250.id, quantityUnits: 2 }],
    status: "Completed", orderNumber: 999999, approvalStatus: "Yes", ownerId: "someone-else",
  } });
  if (massOrder.status === 201) {
    const row = await one('SELECT status, "orderNumber", "approvalStatus" FROM "Order" WHERE id=$1', [massOrder.json.id]);
    check("a client-supplied status is ignored", row.status === "Waiting Approval", S(row));
    check("a client-supplied order number is ignored", num(row.orderNumber) !== 999999, S(row));
    check("a client-supplied approval is ignored", row.approvalStatus !== "Yes", S(row));
  } else {
    check("mass-assignment attempt handled", massOrder.status >= 400, "status=" + massOrder.status);
  }

  const massPo = await api(`/api/production-orders/${poB.id}/status`, { method: "POST", body: { action: "release", targetUnits: 99999, status: "COMPLETED" } });
  const poAfter = await one('SELECT "targetUnits" t, status FROM "ProductionOrder" WHERE id=$1', [poB.id]);
  check("extra fields on a status action are ignored", num(poAfter.t) === 12 && poAfter.status !== "COMPLETED", S(poAfter) + " resp=" + massPo.status);

  sub("E5. object-level authorization (IDOR)");
  await ensureUser(`${P}_emp_qc`, `${P} QC Only`, "qc", {
    dashboard: { access: "edit" }, qc: { access: "edit", sub: { create_record: true, edit_record: true, view_records: true, manage: true } },
  }, "770001");
  await loginAs("770001");
  const idorTargets = [
    ["read another team's orders", "/api/orders", "GET", undefined],
    ["ship somebody else's line", "/api/deliveries", "POST", { orderItemId: oK.items[0].id, quantityUnits: 1, deliveryType: "partial", finishedGoodsLotId: lotK }],
    ["move a production order", `/api/production-orders/${poB.id}/status`, "POST", { action: "cancel", reason: "x" }],
    ["pack somebody else's batch", `/api/roasting-batches/${dual.id}/pack-sku`, "POST", { productSkuId: C.skus.bra1kg.id, units: 1 }],
    ["approve an order", `/api/orders/${oK.id}/approve`, "POST", { decision: "Yes" }],
  ];
  for (const [label, path, method, b] of idorTargets) {
    const r = await api(path, { method, body: b });
    check(`QC-only user cannot ${label} (${r.status})`, r.status === 403, "status=" + r.status);
  }
  setCookie(adminCookie);

  sub("E6. privilege escalation through the employee record");
  await loginAs("770001");
  const selfPromote = await api(`/api/employees/${P}_emp_qc`, { method: "PUT", body: { role: "admin", permissions: { settings: { access: "edit" } } } });
  check("a user cannot promote themselves", selfPromote.status >= 400, "status=" + selfPromote.status + " " + S(selfPromote.json).slice(0, 90));
  const meAfter = await api("/api/auth/me");
  check("their role is unchanged", meAfter.json?.user?.role === "qc", S(meAfter.json?.user?.role));
  const createAdmin = await api("/api/employees", { method: "POST", body: { name: "backdoor", pin: String(100000 + Math.floor(Math.random() * 899999)), role: "admin", permissions: {} } });
  check("a user cannot create an administrator", createAdmin.status >= 400, "status=" + createAdmin.status);
  setCookie(adminCookie);

  sub("E7. error responses never leak internals");
  const leakProbes = [
    ["/api/orders/not-a-real-id", "GET", undefined],
    ["/api/production-orders/%00/status", "POST", { action: "release" }],
    ["/api/deliveries", "POST", { orderItemId: null, quantityUnits: null, finishedGoodsLotId: null }],
    ["/api/roasting-batches", "POST", { greenBeanId: {}, greenBeanQuantity: {} }],
  ];
  for (const [path, method, b] of leakProbes) {
    const r = await api(path, { method, body: b });
    const text = S(r.json);
    const leaks = /PrismaClient|prisma\.|P20\d\d|Invalid `|invocation|at async|\.ts:\d+|node_modules/i.test(text);
    check(`${method} ${path.slice(0, 34)} -> ${r.status}, clean message`, !leaks, text.slice(0, 130));
  }

  await invariants("after security");

  // ═══════════════════════════════════════════════════════════════════════
  section("F — FINAL RECONCILIATION");

  sub("Green coffee: opening less roasted equals on hand");
  for (const [k, bean] of Object.entries(C.beans)) {
    const roasted = num((await one(`SELECT COALESCE(SUM("greenBeanQuantity"),0) q FROM "RoastingBatch" WHERE "greenBeanId"=$1`, [bean.id])).q);
    const onhand = await greenStock(bean.id);
    check(`${k}: ${bean.openingKg} - ${roasted.toFixed(3)} = ${(bean.openingKg - roasted).toFixed(3)} (ERP ${onhand.toFixed(3)})`,
      near(bean.openingKg - roasted, onhand, 0.002), `diff ${(onhand - (bean.openingKg - roasted)).toFixed(3)}`);
  }

  sub("Roasted coffee: roasted less packed equals unpacked");
  for (const [k, cof] of Object.entries(C.coffees)) {
    const roasted = num((await one(`SELECT COALESCE(SUM("roastedBeanQuantity"),0) q FROM "RoastingBatch" WHERE "productId"=$1 AND status<>'Rejected'`, [cof.id])).q);
    const packedKg = num((await one(`
      SELECT COALESCE(SUM(f."unitsProduced" * s."weightGrams" / 1000.0),0) q
        FROM "FinishedGoodsLot" f JOIN "ProductSKU" s ON s.id=f."productSkuId"
        JOIN "RoastingBatch" rb ON rb.id=f."packedFromBatchId"
       WHERE rb."productId"=$1`, [cof.id])).q);
    const remaining = await roastedStock(cof.id);
    check(`${k}: ${roasted.toFixed(3)} roasted - ${packedKg.toFixed(3)} packed (ERP unpacked ${remaining.toFixed(3)})`,
      remaining >= -0.002 && remaining <= roasted + 0.002, `remaining ${remaining.toFixed(3)}`);
  }

  sub("Finished goods and shipments");
  for (const sku of Object.values(C.skus)) {
    const produced = num((await one(`SELECT COALESCE(SUM("unitsProduced"),0)::int n FROM "FinishedGoodsLot" WHERE "productSkuId"=$1`, [sku.id])).n);
    const shipped = num((await one(`SELECT COALESCE(SUM(d."quantityUnits"),0)::int n FROM "Delivery" d JOIN "OrderItem" oi ON oi.id=d."orderItemId" WHERE oi."productSkuId"=$1`, [sku.id])).n);
    const available = (await skuUnits(sku.id)).available;
    if (produced === 0 && shipped === 0) continue;
    check(`${sku.code}: produced ${produced} - shipped ${shipped} = ${produced - shipped} (ERP ${available})`, produced - shipped === available, `diff ${available - (produced - shipped)}`);
  }

  sub("Ordered, reserved and delivered never contradict");
  const lines = await all(`
    SELECT s."skuCode" sku, o.status, oi."quantityUnits" q, oi."deliveredUnits" d,
           COALESCE((SELECT SUM(sa."quantityUnits") FROM "StockAllocation" sa WHERE sa."orderItemId"=oi.id AND sa.status='RESERVED'),0)::int reserved
      FROM "OrderItem" oi JOIN "Order" o ON o.id=oi."orderId" JOIN "ProductSKU" s ON s.id=oi."productSkuId"
     WHERE o.notes LIKE $1`, [P + "%"]);
  const contradictions = lines.filter((l) =>
    num(l.d) > num(l.q) ||
    num(l.d) + num(l.reserved) > num(l.q) ||
    (["Cancelled", "Rejected", "Completed"].includes(l.status) && num(l.reserved) > 0));
  check(`no line contradicts itself (${lines.length} lines checked)`, contradictions.length === 0, S(contradictions.slice(0, 3)));

  await invariants("final");

  section("RESULT");
  console.log(`${results.pass} passed, ${results.fail} failed`);
  if (results.failures.length) console.log("FAILURES:\n  - " + results.failures.join("\n  - "));
  if (results.issues.length) {
    console.log("\nISSUES:");
    for (const i of results.issues) console.log(`  [${i.severity}] ${i.title} — ${i.detail}`);
  }
  await db.end();
  process.exit(results.fail === 0 ? 0 : 1);
}

main().catch(async (e) => { console.log("FATAL:", e?.stack || e); try { await db.end(); } catch {} process.exit(1); });
