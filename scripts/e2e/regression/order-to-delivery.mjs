// PASS 1 — Discovery. Runs the whole MVP workflow with realistic multi-origin data,
// then attacks it with negative, edge and concurrency cases. Records defects by severity.
import {
  ADMIN_PIN, db, api, check, issue, section, sub, one, all, num, near, invariants,
  loginAs, concurrently, greenStock, materialStock, skuUnits, roastedStock, results,
} from "./harness.mjs";
const JSON_stringify_safe = (v) => { try { return JSON.stringify(v) ?? String(v); } catch { return String(v); } };
import { buildCatalog, teardown, roastAndPass} from "./catalog.mjs";

const P = "P1";

async function main() {
  await db.connect();
  await teardown(P);
  await loginAs(ADMIN_PIN);

  section("PASS 1 — SETUP");
  const cat = await buildCatalog(P);
  const { beans, coffees, materials, skus, customers } = cat;

  // ══════════════════════════════════════════════════════════════════════════
  section("A. PRODUCTION CYCLE — yield, loss, inventory movement");

  sub("A1. Roasting deducts green stock and creates roasted stock");
  const greenBefore = await greenStock(beans.brazil.id);
  // The mission's worked example: 5.00 kg green -> 4.20 kg roasted -> 0.80 kg loss (16%).
  const b1 = await roastAndPass(P, coffees.brazil, beans.brazil, 5.0, 4.2, 0.8, "B01");
  check("roast created", !b1.error, JSON_stringify_safe(b1.error?.json).slice(0, 160));
  const greenAfter = await greenStock(beans.brazil.id);
  check("green stock 120 -> 115 (exactly the 5 kg charged)", near(greenAfter, greenBefore - 5), `${greenBefore} -> ${greenAfter}`);
  check("roasted stock created = 4.2 kg", near(num(b1.batch.roastedAvailableKg), 4.2), String(b1.batch.roastedAvailableKg));

  sub("A2. Yield / loss arithmetic");
  const g = num(b1.batch.greenBeanQuantity), r = num(b1.batch.roastedBeanQuantity), w = num(b1.batch.wasteQuantity);
  const loss = +(g - r).toFixed(3), lossPct = +((loss / g) * 100).toFixed(2);
  check("loss = 0.80 kg", near(loss, 0.8), String(loss));
  check("loss % = 16.00", near(lossPct, 16, 0.01), String(lossPct));
  check("waste recorded separately (0.8)", near(w, 0.8), String(w));
  // Whether the ERP itself surfaces loss% anywhere is a separate question from whether
  // the inputs are stored correctly; flag it rather than assume a screen shows it.
  const hasLossField = await one(`SELECT column_name FROM information_schema.columns WHERE table_name='RoastingBatch' AND column_name ILIKE '%loss%'`);
  if (!hasLossField) issue("LOW", "Roast loss % is derived, never stored or shown", "greenBeanQuantity/roastedBeanQuantity are stored; no loss field or UI figure. Arithmetic is recoverable, so not a correctness defect.");

  sub("A3. Ledger records the green consumption");
  const mv = await one(`SELECT "quantityChanged","previousQuantity","newQuantity","sourceDocType" FROM "InventoryMovement"
    WHERE "referenceEntityId"=$1 AND "sourceDocType"='ROASTING_BATCH' ORDER BY timestamp DESC LIMIT 1`, [beans.brazil.id]);
  check("ledger row for the roast exists", !!mv, "none");
  if (mv) check("ledger delta = -5 kg and balances match", near(num(mv.quantityChanged), -5) && near(num(mv.previousQuantity) - 5, num(mv.newQuantity)), JSON_stringify_safe(mv));

  sub("A4. Packing consumes BOM and creates finished units");
  const bagBefore = await materialStock(materials.bag1kg.id);
  const labelBefore = await materialStock(materials.label.id);
  const pack = await api(`/api/roasting-batches/${b1.id}/pack-sku`, { method: "POST", body: { productSkuId: skus.bra1kg.id, units: 4 } });
  check("pack 4 x 1 KG -> 201", pack.status === 201, JSON_stringify_safe(pack.json).slice(0, 200));
  check("roasted 4.2 -> 0.2 kg", near(await roastedStock(coffees.brazil.id), 0.2), String(await roastedStock(coffees.brazil.id)));
  check("bags 500 -> 496", (await materialStock(materials.bag1kg.id)) === bagBefore - 4, String(await materialStock(materials.bag1kg.id)));
  check("labels 1500 -> 1496", (await materialStock(materials.label.id)) === labelBefore - 4, String(await materialStock(materials.label.id)));
  const u = await skuUnits(skus.bra1kg.id);
  check("finished goods = 4 free units", u.free === 4, JSON_stringify_safe(u));

  sub("A5. Cannot pack more than the roast holds");
  const over = await api(`/api/roasting-batches/${b1.id}/pack-sku`, { method: "POST", body: { productSkuId: skus.bra1kg.id, units: 5 } });
  check("packing beyond roasted stock refused -> 409", over.status === 409, "status=" + over.status);

  await invariants("after production cycle");

  // ══════════════════════════════════════════════════════════════════════════
  section("B. ORDER CYCLE — the four order shapes");

  // Build stock for the other origins so the scenarios differ.
  const b2 = await roastAndPass(P, coffees.ethiopia, beans.ethiopia, 10, 8.2, 1.8, "B02");
  await api(`/api/roasting-batches/${b2.id}/pack-sku`, { method: "POST", body: { productSkuId: skus.eth250.id, units: 24 } });
  const b3 = await roastAndPass(P, coffees.indonesia, beans.indonesia, 6, 5.28, 0.72, "B03");
  await api(`/api/roasting-batches/${b3.id}/pack-sku`, { method: "POST", body: { productSkuId: skus.idn250.id, units: 20 } });

  const mkOrder = async (custId, note, items) =>
    api("/api/orders", { method: "POST", body: { customerId: custId, notes: `${P} ${note}`, items } });

  sub("B1. Small order, fully covered from stock (2 x BRA-1KG of 4)");
  const o1 = await mkOrder(customers.cafe.id, "small fully available", [{ productSkuId: skus.bra1kg.id, quantityUnits: 2 }]);
  check("order created -> 201", o1.status === 201, JSON_stringify_safe(o1.json).slice(0, 200));
  const i1 = o1.json?.items?.[0]?.id;
  const prev1 = await api("/api/orders/fulfillment-preview", { method: "POST", body: { lines: [{ productSkuId: skus.bra1kg.id, quantityUnits: 2 }] } });
  check("preview: 2 available, 0 to produce", prev1.json?.lines?.[0]?.allocatedUnits === 2 && prev1.json?.lines?.[0]?.productionRequiredUnits === 0, JSON_stringify_safe(prev1.json?.lines?.[0]));

  sub("B2. Medium order, partially available (30 x ETH-250G of 24)");
  const o2 = await mkOrder(customers.hotel.id, "medium partial", [{ productSkuId: skus.eth250.id, quantityUnits: 30 }]);
  const i2 = o2.json?.items?.[0]?.id;
  const prev2 = await api("/api/orders/fulfillment-preview", { method: "POST", body: { lines: [{ productSkuId: skus.eth250.id, quantityUnits: 30 }] } });
  check("preview: 24 from stock, 6 to produce", prev2.json?.lines?.[0]?.allocatedUnits === 24 && prev2.json?.lines?.[0]?.productionRequiredUnits === 6, JSON_stringify_safe(prev2.json?.lines?.[0]));

  sub("B3. Large order, nothing in stock (100 x BRA-250G)");
  const o3 = await mkOrder(customers.retail.id, "large full production", [{ productSkuId: skus.bra250.id, quantityUnits: 100 }]);
  const i3 = o3.json?.items?.[0]?.id;
  check("order accepted despite zero stock (no green-coffee gate)", o3.status === 201, "status=" + o3.status);
  const prev3 = await api("/api/orders/fulfillment-preview", { method: "POST", body: { lines: [{ productSkuId: skus.bra250.id, quantityUnits: 100 }] } });
  check("preview: 0 from stock, 100 to produce", prev3.json?.lines?.[0]?.productionRequiredUnits === 100, JSON_stringify_safe(prev3.json?.lines?.[0]));

  sub("B4. Multi-product order (3 lines, mixed availability)");
  const o4 = await mkOrder(customers.cafe.id, "multi product", [
    { productSkuId: skus.bra1kg.id, quantityUnits: 2 },
    { productSkuId: skus.idn250.id, quantityUnits: 10 },
    { productSkuId: skus.eth1kg.id, quantityUnits: 5 },
  ]);
  check("multi-line order created", o4.status === 201, JSON_stringify_safe(o4.json).slice(0, 200));
  check("all three lines stored", o4.json?.items?.length === 3, "n=" + o4.json?.items?.length);
  const kgOk = (o4.json?.items ?? []).every((it) => {
    const sku = Object.values(skus).find((s) => s.id === it.productSkuId);
    return sku && near(num(it.quantityKg), sku.kg * it.quantityUnits);
  });
  check("kg on every line derived from units x pack size", kgOk, JSON_stringify_safe(o4.json?.items?.map((i) => [i.quantityUnits, i.quantityKg])));

  await invariants("after order creation");

  // ══════════════════════════════════════════════════════════════════════════
  section("C. NEGATIVE / EDGE CASES");

  const bad = async (name, body, expect) => {
    const r = await api("/api/orders", { method: "POST", body });
    check(name, r.status === expect, `status=${r.status} ${JSON_stringify_safe(r.json).slice(0, 110)}`);
  };
  await bad("quantity 0 refused", { customerId: customers.cafe.id, notes: P + " bad", items: [{ productSkuId: skus.bra1kg.id, quantityUnits: 0 }] }, 400);
  await bad("negative quantity refused", { customerId: customers.cafe.id, notes: P + " bad", items: [{ productSkuId: skus.bra1kg.id, quantityUnits: -5 }] }, 400);
  await bad("fractional quantity refused", { customerId: customers.cafe.id, notes: P + " bad", items: [{ productSkuId: skus.bra1kg.id, quantityUnits: 2.5 }] }, 400);
  await bad("unknown product refused", { customerId: customers.cafe.id, notes: P + " bad", items: [{ productSkuId: "does-not-exist", quantityUnits: 1 }] }, 400);
  await bad("missing customer refused", { notes: P + " bad", items: [{ productSkuId: skus.bra1kg.id, quantityUnits: 1 }] }, 400);
  await bad("empty items refused", { customerId: customers.cafe.id, notes: P + " bad", items: [] }, 400);
  await bad("items field missing entirely refused", { customerId: customers.cafe.id, notes: P + " bad" }, 400);
  await bad("items not an array refused", { customerId: customers.cafe.id, notes: P + " bad", items: "nope" }, 400);
  await bad("legacy bean line refused (SKU required)", { customerId: customers.cafe.id, notes: P + " bad", items: [{ beanTypeName: "X", quantityKg: 5, greenBeanId: beans.brazil.id }] }, 400);

  sub("C1. Inactive product cannot be sold");
  await api(`/api/products/${skus.idn250.id}`, { method: "PATCH", body: { isActive: false } });
  const inact = await api("/api/orders", { method: "POST", body: { customerId: customers.cafe.id, notes: P + " bad", items: [{ productSkuId: skus.idn250.id, quantityUnits: 1 }] } });
  check("inactive SKU refused -> 400", inact.status === 400, "status=" + inact.status);
  await api(`/api/products/${skus.idn250.id}`, { method: "PATCH", body: { isActive: true } });

  sub("C2. Very large quantity");
  const huge = await api("/api/orders", { method: "POST", body: { customerId: customers.cafe.id, notes: P + " huge", items: [{ productSkuId: skus.bra1kg.id, quantityUnits: 1000000 }] } });
  if (huge.status === 201) {
    issue("LOW", "No upper bound on order quantity", "1,000,000 units accepted. Not corruption — production requirement simply scales — but a typo cannot be caught.");
    await db.query(`DELETE FROM "Order" WHERE id=$1`, [huge.json.id]);
  } else check("very large quantity handled deliberately", huge.status === 400, "status=" + huge.status);

  sub("C3. Production output cannot exceed input");
  const badRoast = await api("/api/roasting-batches", { method: "POST", body: { greenBeanId: beans.brazil.id, productId: coffees.brazil.id, greenBeanQuantity: 5, roastedBeanQuantity: 7, wasteQuantity: 0 } });
  check("roasted > green refused -> 400", badRoast.status === 400, "status=" + badRoast.status);

  sub("C4. Roasting more green than exists");
  const tooMuch = await api("/api/roasting-batches", { method: "POST", body: { greenBeanId: beans.indonesia.id, productId: coffees.indonesia.id, greenBeanQuantity: 99999, roastedBeanQuantity: 80000, wasteQuantity: 100 } });
  check("insufficient green refused", tooMuch.status >= 400, "status=" + tooMuch.status);

  sub("C5. Packaging before QC passes");
  const pendingBatch = await api("/api/roasting-batches", { method: "POST", body: { greenBeanId: beans.brazil.id, productId: coffees.brazil.id, greenBeanQuantity: 3, roastedBeanQuantity: 2.5, wasteQuantity: 0.5 } });
  await db.query('UPDATE "RoastingBatch" SET "batchNumber"=$2 WHERE id=$1', [pendingBatch.json.id, `${P}-B04`]);
  const packEarly = await api(`/api/roasting-batches/${pendingBatch.json.id}/pack-sku`, { method: "POST", body: { productSkuId: skus.bra1kg.id, units: 1 } });
  check("packing a Pending-QC batch refused -> 409", packEarly.status === 409, "status=" + packEarly.status);

  sub("C6. Packing a SKU with no BOM");
  const noBom = await api("/api/products", { method: "POST", body: { productId: coffees.brazil.id, skuCode: `${P}-NOBOM`, name: "No BOM SKU", weightGrams: 500, price: 10 } });
  await db.query(`UPDATE "RoastingBatch" SET status='Passed' WHERE id=$1`, [pendingBatch.json.id]);
  const packNoBom = await api(`/api/roasting-batches/${pendingBatch.json.id}/pack-sku`, { method: "POST", body: { productSkuId: noBom.json.id, units: 1 } });
  check("packing a SKU without a BOM refused -> 409", packNoBom.status === 409, "status=" + packNoBom.status);

  await invariants("after negative cases");

  // ══════════════════════════════════════════════════════════════════════════
  section("D. STATE TRANSITIONS");

  sub("D1. Approve then review");
  await api(`/api/orders/${o1.json.id}/approve`, { method: "POST", body: { decision: "Yes" } });
  let st = await one('SELECT status FROM "Order" WHERE id=$1', [o1.json.id]);
  check("Yes -> Waiting Preparation Review", st.status === "Waiting Preparation Review", st.status);
  const rev1 = await api(`/api/orders/${o1.json.id}/preparation-review`, { method: "POST", body: { items: [{ orderItemId: i1 }] } });
  check("review -> 200", rev1.status === 200, JSON_stringify_safe(rev1.json).slice(0, 140));
  st = await one('SELECT status FROM "Order" WHERE id=$1', [o1.json.id]);
  check("fully covered order -> Ready for Shipping", st.status === "Ready for Shipping", st.status);

  sub("D2. Invalid transitions are refused");
  const cmpEarly = await api(`/api/orders/${o3.json.id}/status`, { method: "POST", body: { action: "complete" } });
  check("complete before Ready for Shipping refused -> 409", cmpEarly.status === 409, "status=" + cmpEarly.status);
  const resumeNotHeld = await api(`/api/orders/${o1.json.id}/status`, { method: "POST", body: { action: "resume" } });
  check("resume on a non-held order refused -> 409", resumeNotHeld.status === 409, "status=" + resumeNotHeld.status);

  sub("D3. Completed order is terminal");
  const done = await api(`/api/orders/${o1.json.id}/status`, { method: "POST", body: { action: "complete" } });
  check("complete from Ready for Shipping -> 200", done.status === 200, "status=" + done.status);
  const backToProd = await api(`/api/orders/${o1.json.id}/preparation-review`, { method: "POST", body: { items: [{ orderItemId: i1 }] } });
  check("a completed order cannot re-enter preparation -> 409", backToProd.status === 409, "status=" + backToProd.status);
  const reApprove = await api(`/api/orders/${o1.json.id}/approve`, { method: "POST", body: { decision: "Yes" } });
  check("a completed order cannot be re-approved -> 409", reApprove.status === 409, "status=" + reApprove.status);
  const cancelDone = await api(`/api/orders/${o1.json.id}/status`, { method: "POST", body: { action: "cancel", reason: "x" } });
  check("a completed order cannot be cancelled -> 409", cancelDone.status === 409, "status=" + cancelDone.status);

  sub("D3b. A completed order must not keep holding stock");
  // Regression guard: completing an order whose units were never delivered used to leave
  // them reserved to a closed order forever, invisible to every other order.
  const heldByCompleted = num((await one(
    `SELECT COALESCE(SUM("quantityUnits"),0)::int u FROM "StockAllocation" WHERE "orderItemId"=$1 AND status='RESERVED'`, [i1])).u);
  check("a completed order holds no reservations", heldByCompleted === 0, `still holding ${heldByCompleted} units`);
  if (heldByCompleted > 0) issue("HIGH", "Completed orders strand reserved stock", `${heldByCompleted} units remain reserved to a closed order and can never be released.`);

  sub("D4. Cancellation releases stock");
  await api(`/api/orders/${o2.json.id}/approve`, { method: "POST", body: { decision: "Yes" } });
  await api(`/api/orders/${o2.json.id}/preparation-review`, { method: "POST", body: { items: [{ orderItemId: i2 }] } });
  const heldBefore = (await skuUnits(skus.eth250.id)).reserved;
  check("24 units reserved by the partial order", heldBefore === 24, String(heldBefore));
  await api(`/api/orders/${o2.json.id}/status`, { method: "POST", body: { action: "cancel", reason: P + " cancel test" } });
  const heldAfter = await skuUnits(skus.eth250.id);
  check("cancel returns all 24 units to free stock", heldAfter.reserved === 0 && heldAfter.free === 24, JSON_stringify_safe(heldAfter));
  const cancelledConsumes = await one(`SELECT COALESCE(SUM("quantityUnits"),0)::int u FROM "StockAllocation" WHERE "orderItemId"=$1 AND status='RESERVED'`, [i2]);
  check("a cancelled order holds no reservations", num(cancelledConsumes.u) === 0, JSON_stringify_safe(cancelledConsumes));

  await invariants("after state transitions");

  // ══════════════════════════════════════════════════════════════════════════
  section("E. PRODUCTION REQUIREMENT — only the shortfall, and only once");

  await api(`/api/orders/${o3.json.id}/approve`, { method: "POST", body: { decision: "Yes" } });
  await api(`/api/orders/${o3.json.id}/preparation-review`, { method: "POST", body: { items: [{ orderItemId: i3 }] } });
  const req = await api(`/api/order-items/${i3}/production-requirement`);
  check("shortfall = 100 units (nothing in stock)", req.json?.shortfallUnits === 100, JSON_stringify_safe(req.json).slice(0, 160));
  const made = await api(`/api/order-items/${i3}/production-requirement`, { method: "POST" });
  check("production order created -> 201", made.status === 201, JSON_stringify_safe(made.json).slice(0, 160));
  check("targets 100 units / 25 kg", num(made.json?.productionOrder?.targetUnits) === 100 && near(num(made.json?.productionOrder?.targetWeightKg), 25), JSON_stringify_safe(made.json?.productionOrder));
  // 25 kg finished at 15% roast loss => 25 / 0.85 = 29.412 kg green
  check("green draw = 29.412 kg (25 / 0.85)", near(num(made.json?.productionOrder?.expectedGreenBeanKg), 29.412, 0.002), String(made.json?.productionOrder?.expectedGreenBeanKg));

  sub("E1. Duplicate production orders");
  const dupSeq = await api(`/api/order-items/${i3}/production-requirement`, { method: "POST" });
  check("second sequential request refused -> 409", dupSeq.status === 409, "status=" + dupSeq.status);
  const dupPar = await concurrently(4, () => api(`/api/order-items/${i3}/production-requirement`, { method: "POST" }));
  const created = dupPar.filter((x) => x.status === 201).length;
  const poCount = num((await one('SELECT count(*)::int n FROM "ProductionOrder" WHERE "sourceOrderItemId"=$1', [i3])).n);
  check("4 simultaneous requests create no extra orders", created === 0 && poCount === 1, `created=${created} total=${poCount}`);
  if (poCount > 1) issue("CRITICAL", "Concurrent production-requirement requests create duplicates", `${poCount} production orders exist for one line; the open-order guard is a read-then-write with no unique constraint behind it.`);

  await invariants("after production requirement");

  // ══════════════════════════════════════════════════════════════════════════
  section("F. CONCURRENCY — the same units must not be sold twice");

  sub("F1. Six orders race for 4 units of BRA-1KG");
  // Free stock is 2 units (4 packed, 2 consumed by the completed order o1).
  const free0 = (await skuUnits(skus.bra1kg.id)).free;
  const reservedBefore = (await skuUnits(skus.bra1kg.id)).reserved;
  const racers = [];
  for (let i = 0; i < 6; i++) {
    const o = await mkOrder(customers.retail.id, `race ${i}`, [{ productSkuId: skus.bra1kg.id, quantityUnits: 1 }]);
    await api(`/api/orders/${o.json.id}/approve`, { method: "POST", body: { decision: "Yes" } });
    racers.push({ orderId: o.json.id, itemId: o.json.items[0].id });
  }
  const raceRes = await concurrently(racers.length, (i) =>
    api(`/api/orders/${racers[i].orderId}/preparation-review`, { method: "POST", body: { items: [{ orderItemId: racers[i].itemId }] } })
  );
  const okCount = raceRes.filter((x) => x.status === 200).length;
  const afterRace = await skuUnits(skus.bra1kg.id);
  const totalReserved = num((await one(
    `SELECT COALESCE(SUM(sa."quantityUnits"),0)::int u FROM "StockAllocation" sa
      JOIN "FinishedGoodsLot" f ON f.id=sa."finishedGoodsLotId"
     WHERE sa.status='RESERVED' AND f."productSkuId"=$1`, [skus.bra1kg.id])).u);
  const gained = totalReserved - reservedBefore;
  check(`racers together take at most the ${free0} units that were free`, gained <= free0, `gained=${gained} free0=${free0} totalReserved=${totalReserved} reviews_ok=${okCount}`);
  check('reserved never exceeds available on the lot', afterRace.reserved <= afterRace.available, JSON_stringify_safe(afterRace));
  check("lot balance stays consistent after the race", afterRace.reserved <= afterRace.available, JSON_stringify_safe(afterRace));
  if (gained > free0) issue("BLOCKER", "Concurrent reservations oversell finished goods", `${gained} units taken from ${free0} free.`);

  sub("F2. Duplicate delivery submissions (double-click)");
  const dlvOrder = await mkOrder(customers.cafe.id, "double click delivery", [{ productSkuId: skus.idn250.id, quantityUnits: 5 }]);
  const dlvItem = dlvOrder.json.items[0].id;
  await api(`/api/orders/${dlvOrder.json.id}/approve`, { method: "POST", body: { decision: "Yes" } });
  await api(`/api/orders/${dlvOrder.json.id}/preparation-review`, { method: "POST", body: { items: [{ orderItemId: dlvItem }] } });
  const lotIdn = await one(`SELECT id FROM "FinishedGoodsLot" WHERE "productSkuId"=$1 AND "isUnitTracked" LIMIT 1`, [skus.idn250.id]);
  const dblRes = await concurrently(3, () =>
    api("/api/deliveries", { method: "POST", body: { orderItemId: dlvItem, quantityUnits: 5, deliveryType: "full", finishedGoodsLotId: lotIdn.id } })
  );
  const dlvOk = dblRes.filter((x) => x.status === 200 || x.status === 201).length;
  const delivered = num((await one('SELECT "deliveredUnits" FROM "OrderItem" WHERE id=$1', [dlvItem])).deliveredUnits);
  check("3 simultaneous identical deliveries ship exactly 5 units once", dlvOk === 1 && delivered === 5, `ok=${dlvOk} delivered=${delivered}`);
  if (delivered > 5) issue("BLOCKER", "Duplicate delivery submissions over-ship", `deliveredUnits=${delivered} for a 5-unit line.`);

  await invariants("after concurrency");

  // ══════════════════════════════════════════════════════════════════════════
  section("G. RECONCILIATION");

  sub("G1. Green coffee: opening - consumed = closing");
  for (const [key, bean] of Object.entries(beans)) {
    const consumed = num((await one(
      `SELECT COALESCE(SUM("greenBeanQuantity"),0) kg FROM "RoastingBatch" WHERE "greenBeanId"=$1`, [bean.id])).kg);
    const closing = await greenStock(bean.id);
    check(`green ${key}: ${bean.openingKg} - ${consumed.toFixed(3)} = ${closing.toFixed(3)}`,
      near(bean.openingKg - consumed, closing), `expected ${(bean.openingKg - consumed).toFixed(3)} got ${closing.toFixed(3)}`);
  }

  sub("G2. Packaging materials: opening - consumed = closing");
  for (const [key, m] of Object.entries(materials)) {
    const outMv = num((await one(
      `SELECT COALESCE(SUM(-"quantityChanged"),0) q FROM "InventoryMovement"
        WHERE "referenceEntityId"=$1 AND category='PACKAGING_MATERIAL' AND type='OUT'`, [m.id])).q);
    const closing = await materialStock(m.id);
    check(`material ${key}: ${m.openingQty} - ${outMv} = ${closing}`, near(m.openingQty - outMv, closing), `expected ${m.openingQty - outMv} got ${closing}`);
  }

  sub("G3. Finished goods: produced - shipped = on hand");
  for (const [key, sku] of Object.entries(skus)) {
    const lots = await one(
      `SELECT COALESCE(SUM("unitsProduced"),0)::int prod, COALESCE(SUM("unitsAvailable"),0)::int avail
         FROM "FinishedGoodsLot" WHERE "productSkuId"=$1 AND "isUnitTracked"`, [sku.id]);
    const shipped = num((await one(
      `SELECT COALESCE(SUM(d."quantityUnits"),0)::int u FROM "Delivery" d
         JOIN "OrderItem" oi ON oi.id=d."orderItemId" WHERE oi."productSkuId"=$1`, [sku.id])).u);
    if (num(lots.prod) === 0 && shipped === 0) continue;
    check(`finished ${key}: produced ${lots.prod} - shipped ${shipped} = on hand ${lots.avail}`,
      num(lots.prod) - shipped === num(lots.avail), `expected ${num(lots.prod) - shipped} got ${lots.avail}`);
  }

  sub("G4. Roasted stock: roasted - packed = unpacked");
  for (const [key, cof] of Object.entries(coffees)) {
    const roasted = num((await one(`SELECT COALESCE(SUM("roastedBeanQuantity"),0) kg FROM "RoastingBatch" WHERE "productId"=$1 AND status <> 'Rejected'`, [cof.id])).kg);
    const consumedKg = num((await one(
      `SELECT COALESCE(SUM(-"quantityChanged"),0) kg FROM "InventoryMovement"
        WHERE category='ROASTED_COFFEE' AND type='OUT' AND "sourceDocId" IN (SELECT id FROM "RoastingBatch" WHERE "productId"=$1)`, [cof.id])).kg);
    const remaining = await roastedStock(cof.id);
    check(`roasted ${key}: ${roasted.toFixed(3)} - ${consumedKg.toFixed(3)} = ${remaining.toFixed(3)}`,
      near(roasted - consumedKg, remaining, 0.002), `expected ${(roasted - consumedKg).toFixed(3)} got ${remaining.toFixed(3)}`);
  }

  sub("G5. Ordered vs reserved vs delivered per line");
  const lines = await all(`SELECT oi.id, oi."quantityUnits" q, oi."deliveredUnits" d, o.status,
      COALESCE((SELECT SUM(sa."quantityUnits") FROM "StockAllocation" sa WHERE sa."orderItemId"=oi.id AND sa.status='RESERVED'),0)::int reserved
    FROM "OrderItem" oi JOIN "Order" o ON o.id=oi."orderId" WHERE o.notes LIKE $1 AND oi."quantityUnits" IS NOT NULL`, [P + "%"]);
  let lineProblems = 0;
  for (const l of lines) {
    if (num(l.d) + num(l.reserved) > num(l.q)) { lineProblems++; console.log(`    over-committed line ${l.id}: ordered ${l.q}, delivered ${l.d}, reserved ${l.reserved}`); }
  }
  check(`no line reserves+delivers more than ordered (${lines.length} lines)`, lineProblems === 0, `${lineProblems} bad`);

  await invariants("final");

  // ══════════════════════════════════════════════════════════════════════════
  section("PASS 1 RESULT");
  console.log(`${results.pass} passed, ${results.fail} failed`);
  if (results.failures.length) console.log("FAILURES:\n  - " + results.failures.join("\n  - "));
  if (results.issues.length) {
    console.log("\nISSUES LOGGED:");
    for (const i of results.issues) console.log(`  [${i.severity}] ${i.title}\n      ${i.detail}`);
  }
  await db.end();
  process.exit(results.fail === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.log("FATAL:", e?.stack || e?.message || e);
  try { await db.end(); } catch {}
  process.exit(1);
});
