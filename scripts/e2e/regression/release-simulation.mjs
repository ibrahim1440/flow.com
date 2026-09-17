// PASS 3 — Release simulation. A working day with different data and different shapes
// from Pass 1: several customers, mixed order sizes, production against demand,
// partial and full shipment, a cancellation, a hold/resume, and a final reconciliation
// computed independently of the ERP.
import {
  ADMIN_PIN, db, api, check, issue, section, sub, one, all, num, near, invariants,
  loginAs, concurrently, greenStock, materialStock, skuUnits, roastedStock, results,
} from "./harness.mjs";
import { buildCatalog, teardown, roastAndPass} from "./catalog.mjs";

const S = (v) => { try { return JSON.stringify(v) ?? String(v); } catch { return String(v); } };
const P = "P3";

// Independent ledger kept by the test, never read from the ERP. Reconciled at the end.
const book = {
  greenIn: {}, greenUsed: {},
  matIn: {}, matUsed: {},
  unitsProduced: {}, unitsShipped: {},
};
const add = (o, k, v) => { o[k] = (o[k] ?? 0) + v; };

async function main() {
  await db.connect();
  await teardown(P);
  await loginAs(ADMIN_PIN);

  section("PASS 3 — RELEASE SIMULATION (a working day)");
  const { beans, coffees, materials, skus, customers } = await buildCatalog(P);
  for (const [k, b] of Object.entries(beans)) add(book.greenIn, k, b.openingKg);
  for (const [k, m] of Object.entries(materials)) add(book.matIn, k, m.openingQty);

  // ── Morning: three customer orders arrive ────────────────────────────────
  sub("09:00 — three orders arrive, nothing in finished stock yet");
  const mk = async (cust, note, items) => {
    const r = await api("/api/orders", { method: "POST", body: { customerId: cust, notes: `${P} ${note}`, items } });
    if (r.status !== 201) throw new Error("order failed: " + S(r.json));
    return r.json;
  };
  const oCafe = await mk(customers.cafe.id, "cafe weekly", [
    { productSkuId: skus.bra250.id, quantityUnits: 40 },
    { productSkuId: skus.eth250.id, quantityUnits: 24 },
  ]);
  const oHotel = await mk(customers.hotel.id, "hotel bulk", [{ productSkuId: skus.bra1kg.id, quantityUnits: 12 }]);
  const oRetail = await mk(customers.retail.id, "retail mixed", [
    { productSkuId: skus.idn250.id, quantityUnits: 16 },
    { productSkuId: skus.eth1kg.id, quantityUnits: 6 },
  ]);
  check("three orders created (5 lines total)",
    oCafe.items.length === 2 && oHotel.items.length === 1 && oRetail.items.length === 2);

  for (const o of [oCafe, oHotel, oRetail]) {
    const a = await api(`/api/orders/${o.id}/approve`, { method: "POST", body: { decision: "Yes" } });
    check(`order #${o.orderNumber} approved`, a.status === 200, "status=" + a.status);
  }

  sub("09:30 — first review: nothing on the shelf, everything must be produced");
  for (const o of [oCafe, oHotel, oRetail]) {
    const r = await api(`/api/orders/${o.id}/preparation-review`, { method: "POST", body: { items: o.items.map((i) => ({ orderItemId: i.id })) } });
    check(`review order #${o.orderNumber}`, r.status === 200, S(r.json).slice(0, 140));
  }
  const allNeedProd = await all(`SELECT oi."preparationDecision" d FROM "OrderItem" oi JOIN "Order" o ON o.id=oi."orderId" WHERE o.notes LIKE $1`, [P + "%"]);
  check("every line reads 'Needs Production'", allNeedProd.every((x) => x.d === "Needs Production"), S(allNeedProd.map((x) => x.d)));

  sub("09:45 — production requirements raised for every short line");
  const allItems = [...oCafe.items, ...oHotel.items, ...oRetail.items];
  let poCount = 0;
  for (const it of allItems) {
    const r = await api(`/api/order-items/${it.id}/production-requirement`, { method: "POST" });
    if (r.status === 201) poCount++;
    else check(`production requirement for line ${it.id}`, false, "status=" + r.status + " " + S(r.json).slice(0, 120));
  }
  check("a production order per line (5)", poCount === 5, "created=" + poCount);

  const pos = await all(`SELECT po."targetUnits", po."targetWeightKg", po."expectedGreenBeanKg", s."skuCode"
      FROM "ProductionOrder" po JOIN "ProductSKU" s ON s.id=po."productSkuId"
      JOIN "OrderItem" oi ON oi.id=po."sourceOrderItemId" JOIN "Order" o ON o.id=oi."orderId"
     WHERE o.notes LIKE $1 ORDER BY s."skuCode"`, [P + "%"]);
  // Verify the green draw independently: target kg / (1 - loss)
  let mathOk = true;
  for (const po of pos) {
    const sku = Object.values(skus).find((s) => s.code === po.skuCode);
    const cof = coffees[sku.coffee];
    const expected = +(num(po.targetWeightKg) / (1 - cof.roastLoss / 100)).toFixed(3);
    if (!near(num(po.expectedGreenBeanKg), expected, 0.002)) {
      mathOk = false;
      console.log(`    ${po.skuCode}: expected ${expected} got ${po.expectedGreenBeanKg}`);
    }
  }
  check("green-bean draw on every production order matches target / (1 - loss)", mathOk);

  // ── Midday: roast against demand ─────────────────────────────────────────
  sub("11:00 — roasting against the day's requirements");
  // Brazil: 40 x 250 g = 10 kg finished, plus 12 x 1 kg = 12 kg -> 22 kg at 15% loss.
  const braGreen = 26, braRoast = 22.1, braWaste = 3.9;
  const rb1 = await roastAndPass(P, coffees.brazil, beans.brazil, braGreen, braRoast, braWaste, "R01");
  check("Brazil roast recorded", !rb1.error, S(rb1.error?.json).slice(0, 140));
  add(book.greenUsed, "brazil", braGreen);

  // Ethiopia: 24 x 250 g = 6 kg, plus 6 x 1 kg = 6 kg -> 12 kg at 18% loss.
  const ethGreen = 15, ethRoast = 12.3, ethWaste = 2.7;
  const rb2 = await roastAndPass(P, coffees.ethiopia, beans.ethiopia, ethGreen, ethRoast, ethWaste, "R02");
  add(book.greenUsed, "ethiopia", ethGreen);

  // Indonesia: 16 x 250 g = 4 kg at 12% loss.
  const idnGreen = 5, idnRoast = 4.4, idnWaste = 0.6;
  const rb3 = await roastAndPass(P, coffees.indonesia, beans.indonesia, idnGreen, idnRoast, idnWaste, "R03");
  add(book.greenUsed, "indonesia", idnGreen);

  for (const [k, bean] of Object.entries(beans)) {
    const expect = book.greenIn[k] - (book.greenUsed[k] ?? 0);
    check(`green ${k}: ${book.greenIn[k]} - ${book.greenUsed[k] ?? 0} = ${expect}`, near(await greenStock(bean.id), expect), String(await greenStock(bean.id)));
  }

  sub("13:00 — packaging the roasts into finished goods");
  const packs = [
    [rb1.id, skus.bra250, 40], [rb1.id, skus.bra1kg, 12],
    [rb2.id, skus.eth250, 24], [rb2.id, skus.eth1kg, 6],
    [rb3.id, skus.idn250, 16],
  ];
  for (const [batchId, sku, units] of packs) {
    const r = await api(`/api/roasting-batches/${batchId}/pack-sku`, { method: "POST", body: { productSkuId: sku.id, units } });
    check(`packed ${units} x ${sku.code}`, r.status === 201, S(r.json).slice(0, 160));
    if (r.status === 201) {
      add(book.unitsProduced, sku.code, units);
      const bagKey = sku.grams >= 1000 ? "bag1kg" : "bag250";
      add(book.matUsed, bagKey, units);
      add(book.matUsed, "label", units);
    }
  }
  for (const [k, m] of Object.entries(materials)) {
    const expect = book.matIn[k] - (book.matUsed[k] ?? 0);
    check(`material ${k}: ${book.matIn[k]} - ${book.matUsed[k] ?? 0} = ${expect}`, (await materialStock(m.id)) === expect, String(await materialStock(m.id)));
  }

  // ── Afternoon: re-review now that stock exists ───────────────────────────
  sub("14:00 — re-review: the shelf can now cover the orders");
  for (const o of [oCafe, oHotel, oRetail]) {
    const r = await api(`/api/orders/${o.id}/preparation-review`, { method: "POST", body: { items: o.items.map((i) => ({ orderItemId: i.id })) } });
    check(`re-review order #${o.orderNumber}`, r.status === 200, S(r.json).slice(0, 140));
  }
  const decisions = await all(`SELECT oi."preparationDecision" d, s."skuCode" FROM "OrderItem" oi
      JOIN "Order" o ON o.id=oi."orderId" JOIN "ProductSKU" s ON s.id=oi."productSkuId" WHERE o.notes LIKE $1`, [P + "%"]);
  check("every line now reads 'Available on Shelf'", decisions.every((x) => x.d === "Available on Shelf"), S(decisions));
  const statuses = await all(`SELECT "orderNumber", status FROM "Order" WHERE notes LIKE $1 ORDER BY "orderNumber"`, [P + "%"]);
  check("every order is Ready for Shipping", statuses.every((s) => s.status === "Ready for Shipping"), S(statuses));

  // ── Shipping ─────────────────────────────────────────────────────────────
  sub("15:00 — shipping: one full, one partial, one held then resumed");
  const lotFor = async (skuId) => (await one(`SELECT id FROM "FinishedGoodsLot" WHERE "productSkuId"=$1 AND "isUnitTracked" AND "unitsAvailable">0 LIMIT 1`, [skuId]))?.id;

  // Hotel: full shipment.
  const hotelLot = await lotFor(skus.bra1kg.id);
  const shipHotel = await api("/api/deliveries", { method: "POST", body: { orderItemId: oHotel.items[0].id, quantityUnits: 12, deliveryType: "full", finishedGoodsLotId: hotelLot } });
  check("hotel: 12 units shipped in full", shipHotel.status === 200 || shipHotel.status === 201, "status=" + shipHotel.status + " " + S(shipHotel.json).slice(0, 140));
  if (shipHotel.status < 400) add(book.unitsShipped, skus.bra1kg.code, 12);

  // Cafe: partial on one line.
  const cafeLot = await lotFor(skus.bra250.id);
  const shipCafe = await api("/api/deliveries", { method: "POST", body: { orderItemId: oCafe.items[0].id, quantityUnits: 25, deliveryType: "partial", finishedGoodsLotId: cafeLot } });
  check("cafe: 25 of 40 units shipped", shipCafe.status === 200 || shipCafe.status === 201, "status=" + shipCafe.status + " " + S(shipCafe.json).slice(0, 140));
  if (shipCafe.status < 400) add(book.unitsShipped, skus.bra250.code, 25);
  const cafeLine = await one('SELECT "deliveredUnits","deliveryStatus" FROM "OrderItem" WHERE id=$1', [oCafe.items[0].id]);
  check("cafe line reads Partial Delivered (25/40)", num(cafeLine.deliveredUnits) === 25 && cafeLine.deliveryStatus === "Partial Delivered", S(cafeLine));

  // Retail: hold then resume.
  const held = await api(`/api/orders/${oRetail.id}/status`, { method: "POST", body: { action: "hold", reason: P + " customer asked to wait" } });
  check("retail order held", held.status === 200, "status=" + held.status);
  const heldStatus = await one('SELECT status FROM "Order" WHERE id=$1', [oRetail.id]);
  check("status = On Hold", heldStatus.status === "On Hold", heldStatus.status);
  const shipHeld = await api("/api/deliveries", { method: "POST", body: { orderItemId: oRetail.items[0].id, quantityUnits: 1, deliveryType: "partial", finishedGoodsLotId: await lotFor(skus.idn250.id) } });
  if (shipHeld.status < 400) issue("MEDIUM", "A held order can still be shipped", "Delivery does not check order status; an On Hold order accepted a shipment.");
  check("shipping a held order is refused", shipHeld.status >= 400, "status=" + shipHeld.status);
  if (shipHeld.status < 400) add(book.unitsShipped, skus.idn250.code, 1);

  const resumed = await api(`/api/orders/${oRetail.id}/status`, { method: "POST", body: { action: "resume" } });
  check("retail order resumed", resumed.status === 200, "status=" + resumed.status);
  const resumedStatus = await one('SELECT status FROM "Order" WHERE id=$1', [oRetail.id]);
  check("resume recomputes to Ready for Shipping", resumedStatus.status === "Ready for Shipping", resumedStatus.status);

  await invariants("after shipping");



  // ── A cancellation late in the day ───────────────────────────────────────
  sub("16:00 — a late cancellation returns its stock to the shelf");
  const beforeCancel = await skuUnits(skus.eth1kg.id);
  const cancel = await api(`/api/orders/${oRetail.id}/status`, { method: "POST", body: { action: "cancel", reason: P + " customer cancelled" } });
  check("retail order cancelled", cancel.status === 200, "status=" + cancel.status);
  const afterCancel = await skuUnits(skus.eth1kg.id);
  check(`ETH-1KG reservations returned (${beforeCancel.reserved} -> ${afterCancel.reserved})`, afterCancel.reserved === 0, S(afterCancel));
  check("free stock rose by exactly what was released", afterCancel.free === beforeCancel.free + beforeCancel.reserved, `${S(beforeCancel)} -> ${S(afterCancel)}`);

  sub("16:30 — the cafe order cannot be completed while a line is still owed");
  // DEF-001 regression guard, in its multi-line form. The cafe order has two lines: 25 of
  // 40 shipped on the first, nothing at all on the second. This step used to complete it
  // and assert that completion released the undelivered remainder — closing an order as
  // fulfilled while 39 units were still owed to the customer. Completion now refuses, and
  // cancelling is the mechanism that legitimately closes an order and returns its stock.
  const cafeResBefore = num((await one(`SELECT COALESCE(SUM("quantityUnits"),0)::int u FROM "StockAllocation" WHERE "orderItemId"=$1 AND status='RESERVED'`, [oCafe.items[0].id])).u);
  const doneCafe = await api(`/api/orders/${oCafe.id}/status`, { method: "POST", body: { action: "complete" } });
  check("completing a partly-delivered multi-line order refused -> 409", doneCafe.status === 409, "status=" + doneCafe.status);
  if (doneCafe.status === 200) issue("HIGH", "Order completed with lines still undelivered", "A multi-line order was closed as fulfilled while one line had shipped nothing.");
  const cafeStatusAfter = await one('SELECT status FROM "Order" WHERE id=$1', [oCafe.id]);
  check("the refused completion left the order open", cafeStatusAfter.status !== "Completed", cafeStatusAfter.status);
  const cafeResStill = num((await one(`SELECT COALESCE(SUM("quantityUnits"),0)::int u FROM "StockAllocation" WHERE "orderItemId"=$1 AND status='RESERVED'`, [oCafe.items[0].id])).u);
  check("the refused completion released nothing", cafeResStill === cafeResBefore, `before=${cafeResBefore} after=${cafeResStill}`);

  sub("16:45 — cancelling the cafe order is what returns its undelivered remainder");
  const cancelCafe = await api(`/api/orders/${oCafe.id}/status`, { method: "POST", body: { action: "cancel", reason: P + " cannot fulfil the remainder today" } });
  check("cafe order cancelled", cancelCafe.status === 200, "status=" + cancelCafe.status);
  const cafeResAfter = num((await one(`SELECT COALESCE(SUM("quantityUnits"),0)::int u FROM "StockAllocation" WHERE "orderItemId"=$1 AND status='RESERVED'`, [oCafe.items[0].id])).u);
  check(`cancelling released the ${cafeResBefore} undelivered units`, cafeResAfter === 0, `before=${cafeResBefore} after=${cafeResAfter}`);

  // The status gate deliberately allows "Preparing" — a mixed order whose other line
  // still needs production must still be able to dispatch the line the shelf covers.
  // If that were refused the gate would have broken ordinary partial dispatch.
  sub("17:00 — a mixed order in 'Preparing' can still dispatch its covered line");
  const oMixed = await mk(customers.cafe.id, "mixed partial", [
    { productSkuId: skus.eth250.id, quantityUnits: 10 },   // covered from stock the day released
    { productSkuId: skus.bra1kg.id, quantityUnits: 50 },   // far beyond stock -> production
  ]);
  await api(`/api/orders/${oMixed.id}/approve`, { method: "POST", body: { decision: "Yes" } });
  await api(`/api/orders/${oMixed.id}/preparation-review`, { method: "POST", body: { items: oMixed.items.map((i) => ({ orderItemId: i.id })) } });
  const mixedStatus = await one('SELECT status FROM "Order" WHERE id=$1', [oMixed.id]);
  check("mixed order aggregates to 'Preparing'", mixedStatus.status === "Preparing", mixedStatus.status);
  const shipMixed = await api("/api/deliveries", { method: "POST", body: { orderItemId: oMixed.items[0].id, quantityUnits: 10, deliveryType: "full", finishedGoodsLotId: await lotFor(skus.eth250.id) } });
  check("its shelf-covered line still ships", shipMixed.status === 200 || shipMixed.status === 201, "status=" + shipMixed.status + " " + S(shipMixed.json).slice(0, 140));
  if (shipMixed.status < 400) add(book.unitsShipped, skus.eth250.code, 10);
  // Leave nothing reserved behind: cancel it so the day's reconciliation stays readable.
  await api(`/api/orders/${oMixed.id}/status`, { method: "POST", body: { action: "cancel", reason: P + " end of scenario" } });

  await invariants("after end of day");

  // ── Independent reconciliation ───────────────────────────────────────────
  section("PASS 3 — INDEPENDENT RECONCILIATION");

  sub("Green coffee (test ledger vs ERP)");
  for (const [k, bean] of Object.entries(beans)) {
    const expected = book.greenIn[k] - (book.greenUsed[k] ?? 0);
    const actual = await greenStock(bean.id);
    check(`${k}: in ${book.greenIn[k]} - used ${book.greenUsed[k] ?? 0} = ${expected} (ERP ${actual})`, near(expected, actual), `diff ${(actual - expected).toFixed(3)}`);
  }

  sub("Packaging materials (test ledger vs ERP)");
  for (const [k, m] of Object.entries(materials)) {
    const expected = book.matIn[k] - (book.matUsed[k] ?? 0);
    const actual = await materialStock(m.id);
    check(`${k}: in ${book.matIn[k]} - used ${book.matUsed[k] ?? 0} = ${expected} (ERP ${actual})`, expected === actual, `diff ${actual - expected}`);
  }

  sub("Finished goods (test ledger vs ERP)");
  for (const sku of Object.values(skus)) {
    const produced = book.unitsProduced[sku.code] ?? 0;
    const shipped = book.unitsShipped[sku.code] ?? 0;
    if (produced === 0 && shipped === 0) continue;
    const onHand = (await skuUnits(sku.id)).available;
    check(`${sku.code}: produced ${produced} - shipped ${shipped} = ${produced - shipped} (ERP ${onHand})`, produced - shipped === onHand, `diff ${onHand - (produced - shipped)}`);
  }

  sub("Roasted coffee (roasted - packed = unpacked)");
  for (const [k, cof] of Object.entries(coffees)) {
    const roasted = num((await one(`SELECT COALESCE(SUM("roastedBeanQuantity"),0) kg FROM "RoastingBatch" WHERE "productId"=$1 AND status<>'Rejected'`, [cof.id])).kg);
    const packedKg = Object.values(skus).filter((s) => s.coffee === k)
      .reduce((sum, s) => sum + (book.unitsProduced[s.code] ?? 0) * s.kg, 0);
    const remaining = await roastedStock(cof.id);
    check(`${k}: roasted ${roasted.toFixed(3)} - packed ${packedKg.toFixed(3)} = ${(roasted - packedKg).toFixed(3)} (ERP ${remaining.toFixed(3)})`,
      near(roasted - packedKg, remaining, 0.002), `diff ${(remaining - (roasted - packedKg)).toFixed(3)}`);
  }

  sub("Ordered vs reserved vs delivered");
  const lines = await all(`SELECT s."skuCode", oi."quantityUnits" q, oi."deliveredUnits" d, o.status,
      COALESCE((SELECT SUM(sa."quantityUnits") FROM "StockAllocation" sa WHERE sa."orderItemId"=oi.id AND sa.status='RESERVED'),0)::int reserved
    FROM "OrderItem" oi JOIN "Order" o ON o.id=oi."orderId" JOIN "ProductSKU" s ON s.id=oi."productSkuId"
    WHERE o.notes LIKE $1 ORDER BY o."orderNumber", s."skuCode"`, [P + "%"]);
  let bad = 0;
  for (const l of lines) {
    const over = num(l.d) + num(l.reserved) > num(l.q);
    const terminalHolding = ["Completed", "Cancelled", "Rejected"].includes(l.status) && num(l.reserved) > 0;
    if (over || terminalHolding) { bad++; console.log(`    ${l.skuCode} [${l.status}] ordered ${l.q} delivered ${l.d} reserved ${l.reserved}`); }
    else console.log(`    ${l.skuCode} [${l.status}] ordered ${l.q} delivered ${l.d} reserved ${l.reserved}`);
  }
  check("no line over-commits, and no terminal order holds stock", bad === 0, `${bad} bad of ${lines.length}`);

  await invariants("final");

  section("PASS 3 RESULT");
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
