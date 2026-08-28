// ─────────────────────────────────────────────────────────────────────────────
//  Shelf-first fulfilment end-to-end suite.
//
//  Run against a dev server + disposable database:
//      node scripts/e2e/shelf-flow.mjs
//
//  Every scenario is written as the assertion of the CORRECT behaviour, so the
//  same file documents the defects (it fails before the fix) and guards them
//  (it passes after).
// ─────────────────────────────────────────────────────────────────────────────
import { api, login, sql, sqlOne, sqlExec, check, note, section, summary, esc } from "./harness.mjs";

const TAG = "E2E-SHELF";

// ── fixtures ─────────────────────────────────────────────────────────────────
function cleanup() {
  // Remove everything this suite created on previous runs. Order matters (FKs).
  sqlExec(`
    -- Ledger rows written by the app carry notes = NULL, so they cannot be matched by
    -- tag. Reach them through the lots and batches this suite owns instead, otherwise
    -- they outlive their lot and skew the ledger reconciliation at the end of the run.
    DELETE FROM "InventoryMovement" WHERE notes LIKE '${TAG}%'
       OR "referenceEntityId" IN (
        SELECT fgl.id FROM "FinishedGoodsLot" fgl
        LEFT JOIN "RoastingBatch" rb ON rb.id = fgl."roastingBatchId"
        LEFT JOIN "OrderItem" oi ON oi.id = rb."orderItemId"
        LEFT JOIN "Order" o ON o.id = oi."orderId"
        WHERE fgl."batchNumber" LIKE '${TAG}%' OR o.notes LIKE '${TAG}%')
       OR "referenceEntityId" IN (SELECT id FROM "GreenBean" WHERE "serialNumber" LIKE '${TAG}%')
       OR "sourceDocId" IN (
        SELECT rb.id FROM "RoastingBatch" rb
        JOIN "OrderItem" oi ON oi.id = rb."orderItemId"
        JOIN "Order" o ON o.id = oi."orderId" WHERE o.notes LIKE '${TAG}%');
    DELETE FROM "StockAllocation" WHERE "orderItemId" IN (
      SELECT oi.id FROM "OrderItem" oi JOIN "Order" o ON o.id = oi."orderId"
      WHERE o.notes LIKE '${TAG}%');
    DELETE FROM "Delivery" WHERE "orderItemId" IN (
      SELECT oi.id FROM "OrderItem" oi JOIN "Order" o ON o.id = oi."orderId"
      WHERE o.notes LIKE '${TAG}%');
    DELETE FROM "FinishedGoodsLot" WHERE "batchNumber" LIKE '${TAG}%'
       OR "roastingBatchId" IN (
        SELECT rb.id FROM "RoastingBatch" rb JOIN "OrderItem" oi ON oi.id = rb."orderItemId"
        JOIN "Order" o ON o.id = oi."orderId" WHERE o.notes LIKE '${TAG}%');
    DELETE FROM "QcRecord" WHERE "batchId" IN (
      SELECT rb.id FROM "RoastingBatch" rb JOIN "OrderItem" oi ON oi.id = rb."orderItemId"
      JOIN "Order" o ON o.id = oi."orderId" WHERE o.notes LIKE '${TAG}%');
    DELETE FROM "RoastingBatch" WHERE "orderItemId" IN (
      SELECT oi.id FROM "OrderItem" oi JOIN "Order" o ON o.id = oi."orderId"
      WHERE o.notes LIKE '${TAG}%');
    DELETE FROM "OrderActivity" WHERE "orderId" IN (SELECT id FROM "Order" WHERE notes LIKE '${TAG}%');
    DELETE FROM "OrderItem" WHERE "orderId" IN (SELECT id FROM "Order" WHERE notes LIKE '${TAG}%');
    DELETE FROM "Order" WHERE notes LIKE '${TAG}%';
    DELETE FROM "CoffeeProduct" WHERE "productNameEn" LIKE '${TAG}%';
    DELETE FROM "GreenBean" WHERE "serialNumber" LIKE '${TAG}%';
    DELETE FROM "Customer" WHERE name LIKE '${TAG}%';
  `);
}

function fixtures() {
  const customerId = sqlOne(
    `INSERT INTO "Customer" (id, name, "createdAt", "updatedAt")
     VALUES ('${TAG}-cust', '${TAG} Test Customer', now(), now()) RETURNING id;`);
  // Two distinct products so "pooled by product" can be tested against a non-match.
  const productA = sqlOne(
    `INSERT INTO "CoffeeProduct" (id, "productNameEn", "countryEn", "createdAt", "updatedAt")
     VALUES ('${TAG}-prodA', '${TAG} Product A', 'Ethiopia', now(), now()) RETURNING id;`);
  const productB = sqlOne(
    `INSERT INTO "CoffeeProduct" (id, "productNameEn", "countryEn", "createdAt", "updatedAt")
     VALUES ('${TAG}-prodB', '${TAG} Product B', 'Yemen', now(), now()) RETURNING id;`);
  // Green stock: deliberately scarce, so "shelf covers it" and "green covers it" differ.
  const beanA = sqlOne(
    `INSERT INTO "GreenBean" (id, "serialNumber", "beanType", country, "quantityKg", "isActive", "receivedDate", "createdAt", "updatedAt")
     VALUES ('${TAG}-beanA', '${TAG}-SN-A', 'Test Bean A', 'Ethiopia', 40, true, now(), now(), now()) RETURNING id;`);
  const beanB = sqlOne(
    `INSERT INTO "GreenBean" (id, "serialNumber", "beanType", country, "quantityKg", "isActive", "receivedDate", "createdAt", "updatedAt")
     VALUES ('${TAG}-beanB', '${TAG}-SN-B', 'Test Bean B', 'Yemen', 3, true, now(), now(), now()) RETURNING id;`);
  return { customerId, productA, productB, beanA, beanB };
}

const greenQty = (id) => Number(sqlOne(`SELECT "quantityKg" FROM "GreenBean" WHERE id='${esc(id)}';`));
const lotQty = (id) => Number(sqlOne(`SELECT "availableQty" FROM "FinishedGoodsLot" WHERE id='${esc(id)}';`));

async function createOrder(f, items, label) {
  const r = await api("/api/orders", {
    method: "POST",
    body: { customerId: f.customerId, notes: `${TAG} ${label}`, items },
  });
  return r;
}

async function approve(orderId) {
  return api(`/api/orders/${orderId}/approve`, { method: "POST", body: { decision: "Yes" } });
}

// Roast -> QC pass -> package. Returns the FinishedGoodsLot id that lands on the shelf.
async function produceToShelf({ orderItemId, greenBeanId, greenKg, roastedKg, bags1kg, packAsProductId }) {
  const b = await api("/api/roasting-batches", {
    method: "POST",
    body: { orderItemId, greenBeanId, greenBeanQuantity: greenKg, roastedBeanQuantity: roastedKg, wasteQuantity: 0 },
  });
  if (b.status !== 201) throw new Error(`batch create failed: ${b.status} ${JSON.stringify(b.json)}`);
  const batchId = b.json.id;

  const qc = await api(`/api/qc/${batchId}/records`, {
    method: "POST",
    body: { testerName: "E2E Tester", decision: "Accept", aroma: 8, flavor: 8, acidity: 8, body: 8, notes: `${TAG} qc` },
  });
  if (qc.status !== 200 && qc.status !== 201) throw new Error(`qc record failed: ${qc.status} ${JSON.stringify(qc.json)}`);

  const fin = await api(`/api/qc/${batchId}/finalize`, { method: "POST", body: { outcome: "Passed" } });
  if (fin.status !== 200) throw new Error(`qc finalize failed: ${fin.status} ${JSON.stringify(fin.json)}`);

  // Items with no product of their own still have to be packaged as something — the
  // operator picks the product at packaging time, exactly as the real UI requires.
  const pkg = await api(`/api/roasting-batches/${batchId}/package`, {
    method: "PUT",
    body: packAsProductId ? { bags1kg, productId: packAsProductId } : { bags1kg },
  });
  if (pkg.status !== 200) throw new Error(`package failed: ${pkg.status} ${JSON.stringify(pkg.json)}`);

  const lotId = sqlOne(`SELECT id FROM "FinishedGoodsLot" WHERE "roastingBatchId"='${esc(batchId)}';`);
  return { batchId, lotId };
}

// ── main ─────────────────────────────────────────────────────────────────────
async function main() {
  cleanup();
  const f = fixtures();
  await login("1234");

  section("SETUP — fill the shelf legitimately (surplus from order #1)");

  const o1 = await createOrder(f, [{ beanTypeName: "Test Bean A", quantityKg: 20, greenBeanId: f.beanA, productId: f.productA }], "order-1");
  check("SETUP order #1 created", o1.status === 201, `got ${o1.status} ${JSON.stringify(o1.json)}`);
  const item1 = o1.json.items[0].id;
  await approve(o1.json.id);

  const greenBefore = greenQty(f.beanA);
  // Admin roasts 30kg green -> 25kg roasted for a 20kg order: 5kg of deliberate surplus.
  const { lotId } = await produceToShelf({ orderItemId: item1, greenBeanId: f.beanA, greenKg: 30, roastedKg: 25, bags1kg: 25 });
  check("SETUP green stock deducted by the roast", greenQty(f.beanA) === greenBefore - 30,
    `before=${greenBefore} after=${greenQty(f.beanA)}`);
  check("SETUP shelf lot created with 25kg", lotQty(lotId) === 25, `availableQty=${lotQty(lotId)}`);

  const d1 = await api("/api/deliveries", {
    method: "POST",
    body: { orderItemId: item1, quantityKg: 20, deliveryType: "Full", finishedGoodsLotId: lotId },
  });
  check("SETUP order #1 delivered 20kg", d1.status === 200 || d1.status === 201, `got ${d1.status} ${JSON.stringify(d1.json)}`);
  check("SETUP 5kg surplus remains on the shelf", lotQty(lotId) === 5, `availableQty=${lotQty(lotId)}`);
  note(`shelf lot ${lotId} now holds ${lotQty(lotId)}kg of Product A, owned by nobody`);

  // ── D5 ─────────────────────────────────────────────────────────────────────
  section("D5 — order creation must count the shelf, not green beans alone");
  sqlExec(`UPDATE "GreenBean" SET "quantityKg"=0 WHERE id='${esc(f.beanA)}';`);
  note("green stock for Bean A forced to 0; shelf still holds 5kg of Product A");
  const o2 = await createOrder(f, [{ beanTypeName: "Test Bean A", quantityKg: 5, greenBeanId: f.beanA, productId: f.productA }], "order-2");
  check("D5 order for 5kg is accepted because the shelf covers it in full",
    o2.status === 201, `got ${o2.status} ${JSON.stringify(o2.json)}`);

  // ── D1 ─────────────────────────────────────────────────────────────────────
  section("D1 — a new order must be able to draw on the shelf without roasting first");
  let item2 = null;
  if (o2.status === 201) {
    item2 = o2.json.items[0].id;
    await approve(o2.json.id);
    const d2 = await api("/api/deliveries", {
      method: "POST",
      body: { orderItemId: item2, quantityKg: 5, deliveryType: "Full", finishedGoodsLotId: lotId },
    });
    check("D1 delivery straight from the pooled shelf lot succeeds",
      d2.status === 200 || d2.status === 201, `got ${d2.status} ${JSON.stringify(d2.json)}`);
    check("D1 shelf drops to 0 after that delivery", lotQty(lotId) === 0, `availableQty=${lotQty(lotId)}`);
  } else {
    check("D1 delivery straight from the pooled shelf lot succeeds", false, "skipped — D5 blocked order creation");
    check("D1 shelf drops to 0 after that delivery", false, "skipped");
  }

  // ── D2 ─────────────────────────────────────────────────────────────────────
  section("D2 — a false 'Available on Shelf' claim must be rejected");
  const o3 = await createOrder(f, [{ beanTypeName: "Test Bean B", quantityKg: 3, greenBeanId: f.beanB, productId: f.productB }], "order-3");
  check("D2 setup order #3 created", o3.status === 201, `got ${o3.status} ${JSON.stringify(o3.json)}`);
  if (o3.status === 201) {
    const item3 = o3.json.items[0].id;
    await approve(o3.json.id);
    note("Product B has never been produced — its shelf balance is 0");
    const lie = await api(`/api/orders/${o3.json.id}/preparation-review`, {
      method: "POST",
      body: { items: [{ orderItemId: item3, decision: "Available on Shelf", availableQuantity: 3, productionRequiredQuantity: 0 }] },
    });
    check("D2 server refuses a shelf claim it cannot back with real stock",
      lie.status === 409 || lie.status === 422, `got ${lie.status} ${JSON.stringify(lie.json)}`);

    const honest = await api(`/api/orders/${o3.json.id}/preparation-review`, {
      method: "POST",
      body: { items: [{ orderItemId: item3, decision: "Needs Production", availableQuantity: 0, productionRequiredQuantity: 3 }] },
    });
    check("D2 the honest 'Needs Production' decision is accepted",
      honest.status === 200, `got ${honest.status} ${JSON.stringify(honest.json)}`);

    // ── D4 ───────────────────────────────────────────────────────────────────
    section("D4 — production must be capped by the shortfall, not the full order");
    const over = await api("/api/roasting-batches", {
      method: "POST",
      body: { orderItemId: item3, greenBeanId: f.beanB, greenBeanQuantity: 3, roastedBeanQuantity: 2.5, wasteQuantity: 0.5 },
    });
    check("D4 roasting the shortfall quantity is allowed",
      over.status === 201, `got ${over.status} ${JSON.stringify(over.json)}`);
  }

  // ── D3 ─────────────────────────────────────────────────────────────────────
  section("D3 — the same kilograms must not be promised to two orders");
  const bId = sqlOne(`SELECT id FROM "GreenBean" WHERE id='${esc(f.beanA)}';`);
  sqlExec(`UPDATE "GreenBean" SET "quantityKg"=100 WHERE id='${esc(bId)}';`);
  const o4 = await createOrder(f, [{ beanTypeName: "Test Bean A", quantityKg: 10, greenBeanId: f.beanA, productId: f.productA }], "order-4");
  const o5 = await createOrder(f, [{ beanTypeName: "Test Bean A", quantityKg: 10, greenBeanId: f.beanA, productId: f.productA }], "order-5");
  if (o4.status === 201 && o5.status === 201) {
    const i4 = o4.json.items[0].id, i5 = o5.json.items[0].id;
    await approve(o4.json.id); await approve(o5.json.id);
    // Put exactly 10kg on the shelf — enough for one of the two, not both.
    const { lotId: lot2 } = await produceToShelf({ orderItemId: i4, greenBeanId: f.beanA, greenKg: 12, roastedKg: 10, bags1kg: 10 });
    note(`shelf now holds ${lotQty(lot2)}kg — enough for exactly one of the two 10kg orders`);

    const claimA = await api(`/api/orders/${o4.json.id}/preparation-review`, {
      method: "POST",
      body: { items: [{ orderItemId: i4, decision: "Available on Shelf", availableQuantity: 10, productionRequiredQuantity: 0 }] },
    });
    const claimB = await api(`/api/orders/${o5.json.id}/preparation-review`, {
      method: "POST",
      body: { items: [{ orderItemId: i5, decision: "Available on Shelf", availableQuantity: 10, productionRequiredQuantity: 0 }] },
    });
    check("D3 first order reserves the shelf stock", claimA.status === 200, `got ${claimA.status} ${JSON.stringify(claimA.json)}`);
    check("D3 second order is refused — the stock is already reserved",
      claimB.status === 409 || claimB.status === 422, `got ${claimB.status} ${JSON.stringify(claimB.json)}`);
  } else {
    check("D3 first order reserves the shelf stock", false, "setup failed");
    check("D3 second order is refused — the stock is already reserved", false, "setup failed");
  }

  // ── D6 ─────────────────────────────────────────────────────────────────────
  section("D6 — a roast must always consume green stock and write a ledger entry");
  const o6 = await createOrder(f, [{ beanTypeName: "Test Bean A", quantityKg: 5, greenBeanId: f.beanA, productId: f.productA }], "order-6");
  if (o6.status === 201) {
    const i6 = o6.json.items[0].id;
    await approve(o6.json.id);
    const ghost = await api("/api/roasting-batches", {
      method: "POST",
      body: { orderItemId: i6, greenBeanQuantity: 5, roastedBeanQuantity: 4, wasteQuantity: 1 },
    });
    check("D6 a batch with no green bean source is rejected",
      ghost.status === 400 || ghost.status === 422, `got ${ghost.status} ${JSON.stringify(ghost.json)}`);
  } else {
    check("D6 a batch with no green bean source is rejected", false, "setup failed");
  }

  // ── D7 ─────────────────────────────────────────────────────────────────────
  section("D7 — outstanding demand must stay distinguishable from produced-not-delivered");
  const o7 = await createOrder(f, [{ beanTypeName: "Test Bean A", quantityKg: 8, greenBeanId: f.beanA, productId: f.productA }], "order-7");
  if (o7.status === 201) {
    const i7 = o7.json.items[0].id;
    await approve(o7.json.id);
    const before = sql(`SELECT "remainingQty","quantityKg","deliveredQty" FROM "OrderItem" WHERE id='${esc(i7)}';`)[0];
    note(`at creation: remainingQty=${before[0]} quantityKg=${before[1]} deliveredQty=${before[2]}`);

    const fo1 = await api(`/api/order-items/${i7}/fulfillment-options`);
    check("D7 fulfillment-options reports the full 8kg as outstanding before production",
      fo1.status === 200 && Number(fo1.json?.outstandingQty ?? fo1.json?.shortageQty) === 8,
      `got ${fo1.status} ${JSON.stringify(fo1.json)}`);

    await produceToShelf({ orderItemId: i7, greenBeanId: f.beanA, greenKg: 10, roastedKg: 8, bags1kg: 8 });
    const after = sql(`SELECT "remainingQty" FROM "OrderItem" WHERE id='${esc(i7)}';`)[0];
    note(`after producing 8kg: remainingQty=${after[0]}`);
    const fo2 = await api(`/api/order-items/${i7}/fulfillment-options`);
    check("D7 outstanding demand drops to 0 once the full quantity is produced",
      fo2.status === 200 && Number(fo2.json?.outstandingQty ?? fo2.json?.shortageQty) === 0,
      `got ${fo2.status} ${JSON.stringify(fo2.json)}`);
  } else {
    check("D7 fulfillment-options reports the full 8kg as outstanding before production", false, "setup failed");
    check("D7 outstanding demand drops to 0 once the full quantity is produced", false, "setup failed");
  }

  // ── green-bean pooling ─────────────────────────────────────────────────────
  // Every order item in the live database names a bean but no product, so shelf-first
  // has to work off the green bean alone or it never applies to real data.
  section("POOLING — items with a bean but no product still reach the shelf");
  const o8 = await createOrder(f, [{ beanTypeName: "Test Bean A", quantityKg: 6, greenBeanId: f.beanA }], "order-8");
  if (o8.status === 201) {
    const i8 = o8.json.items[0].id;
    await approve(o8.json.id);
    // Produce 9kg against a 6kg order: 6 claimed by this item, 3 surplus left free.
    await produceToShelf({ orderItemId: i8, greenBeanId: f.beanA, greenKg: 11, roastedKg: 9, bags1kg: 9, packAsProductId: f.productA });

    const o9 = await createOrder(f, [{ beanTypeName: "Test Bean A", quantityKg: 3, greenBeanId: f.beanA }], "order-9");
    check("POOLING a second no-product order is accepted", o9.status === 201,
      `got ${o9.status} ${JSON.stringify(o9.json)}`);
    if (o9.status === 201) {
      const i9 = o9.json.items[0].id;
      await approve(o9.json.id);
      const fo = await api(`/api/order-items/${i9}/fulfillment-options`);
      note(`free to promise for the no-product item: ${fo.json?.freeToPromiseQty}kg`);
      check("POOLING the surplus is visible to it via the green bean",
        fo.status === 200 && Number(fo.json?.freeToPromiseQty) >= 3,
        `got ${JSON.stringify(fo.json?.freeToPromiseQty)}`);

      const rev = await api(`/api/orders/${o9.json.id}/preparation-review`, {
        method: "POST",
        body: { items: [{ orderItemId: i9, decision: "Available on Shelf" }] },
      });
      check("POOLING it can be covered entirely from the shelf", rev.status === 200,
        `got ${rev.status} ${JSON.stringify(rev.json)}`);
    }
  } else {
    check("POOLING a second no-product order is accepted", false, "setup failed");
    check("POOLING the surplus is visible to it via the green bean", false, "setup failed");
    check("POOLING it can be covered entirely from the shelf", false, "setup failed");
  }

  // ── the lot an order reserved must remain shippable BY that order ──────────
  // Packaging claims a batch's output for its own order, driving that lot's free quantity
  // to zero. Anything that offers lots by free quantity alone therefore hides the one lot
  // the order needs, and the ordinary roast -> package -> deliver path stops working.
  section("OWN-LOT — an order can ship the stock reserved to it, even at zero free");
  const o11 = await createOrder(f, [{ beanTypeName: "Test Bean A", quantityKg: 7, greenBeanId: f.beanA, productId: f.productA }], "order-11");
  if (o11.status === 201) {
    const i11 = o11.json.items[0].id;
    await approve(o11.json.id);
    const { lotId: lot11 } = await produceToShelf({ orderItemId: i11, greenBeanId: f.beanA, greenKg: 9, roastedKg: 7, bags1kg: 7 });

    const lotFree = Number(sqlOne(
      `SELECT "availableQty" - "reservedQty" FROM "FinishedGoodsLot" WHERE id='${esc(lot11)}';`));
    note(`the batch's own lot has free-to-promise = ${lotFree}kg`);
    check("OWN-LOT the lot is fully reserved to its order, so free is zero", lotFree === 0, `free=${lotFree}`);

    const opts = await api(`/api/order-items/${i11}/fulfillment-options`);
    const offered = (opts.json?.matchingLots ?? []).find((l) => l.id === lot11);
    check("OWN-LOT it is still offered to its own order as deliverable",
      !!offered && Number(offered.deliverableQty) === 7,
      `offered=${JSON.stringify(offered)}`);

    const d11 = await api("/api/deliveries", {
      method: "POST",
      body: { orderItemId: i11, quantityKg: 7, deliveryType: "full", finishedGoodsLotId: lot11 },
    });
    check("OWN-LOT the delivery goes through", d11.status === 201 || d11.status === 200,
      `got ${d11.status} ${JSON.stringify(d11.json)}`);

    // A different order must NOT be able to take it while it is reserved.
    const o12 = await createOrder(f, [{ beanTypeName: "Test Bean A", quantityKg: 4, greenBeanId: f.beanA, productId: f.productA }], "order-12");
    if (o12.status === 201) {
      const i12 = o12.json.items[0].id;
      await approve(o12.json.id);
      const { lotId: lot12 } = await produceToShelf({ orderItemId: i12, greenBeanId: f.beanA, greenKg: 6, roastedKg: 4, bags1kg: 4 });
      const o13 = await createOrder(f, [{ beanTypeName: "Test Bean A", quantityKg: 4, greenBeanId: f.beanA, productId: f.productA }], "order-13");
      if (o13.status === 201) {
        const i13 = o13.json.items[0].id;
        await approve(o13.json.id);
        const steal = await api("/api/deliveries", {
          method: "POST",
          body: { orderItemId: i13, quantityKg: 4, deliveryType: "full", finishedGoodsLotId: lot12 },
        });
        check("OWN-LOT another order cannot ship stock reserved to someone else",
          steal.status === 409, `got ${steal.status} ${JSON.stringify(steal.json)}`);
      }
    }
  } else {
    check("OWN-LOT the lot is fully reserved to its order, so free is zero", false, "setup failed");
    check("OWN-LOT it is still offered to its own order as deliverable", false, "setup failed");
    check("OWN-LOT the delivery goes through", false, "setup failed");
    check("OWN-LOT another order cannot ship stock reserved to someone else", false, "setup failed");
  }

  // ── partial delivery against a split reservation ───────────────────────────
  // The trickiest path in consumeShelfStock: a delivery smaller than the reservation has
  // to retire part of an allocation row and leave the rest standing.
  section("SPLIT — partial deliveries draw down a reservation without losing kilograms");
  const o10 = await createOrder(f, [{ beanTypeName: "Test Bean A", quantityKg: 12, greenBeanId: f.beanA, productId: f.productA }], "order-10");
  if (o10.status === 201) {
    const i10 = o10.json.items[0].id;
    await approve(o10.json.id);
    const { lotId: lot10 } = await produceToShelf({ orderItemId: i10, greenBeanId: f.beanA, greenKg: 14, roastedKg: 12, bags1kg: 12 });

    const reservedOf = (item) => Number(sqlOne(
      `SELECT COALESCE(SUM("quantityKg"),0) FROM "StockAllocation" WHERE "orderItemId"='${esc(item)}' AND status='RESERVED';`));
    const consumedOf = (item) => Number(sqlOne(
      `SELECT COALESCE(SUM("quantityKg"),0) FROM "StockAllocation" WHERE "orderItemId"='${esc(item)}' AND status='CONSUMED';`));

    check("SPLIT packaging reserved the full 12kg to the order", reservedOf(i10) === 12, `reserved=${reservedOf(i10)}`);

    for (const part of [5, 4, 3]) {
      const d = await api("/api/deliveries", {
        method: "POST",
        body: { orderItemId: i10, quantityKg: part, deliveryType: "partial", finishedGoodsLotId: lot10 },
      });
      if (d.status !== 201 && d.status !== 200) {
        check(`SPLIT delivery of ${part}kg succeeds`, false, `got ${d.status} ${JSON.stringify(d.json)}`);
        break;
      }
    }
    note(`after 5+4+3kg: reserved=${reservedOf(i10)} consumed=${consumedOf(i10)} lot=${lotQty(lot10)}`);
    check("SPLIT the reservation is fully drawn down", reservedOf(i10) === 0, `reserved=${reservedOf(i10)}`);
    check("SPLIT consumed allocations account for every delivered kilogram", consumedOf(i10) === 12, `consumed=${consumedOf(i10)}`);
    check("SPLIT the lot is emptied exactly", lotQty(lot10) === 0, `availableQty=${lotQty(lot10)}`);

    const over = await api("/api/deliveries", {
      method: "POST",
      body: { orderItemId: i10, quantityKg: 1, deliveryType: "partial", finishedGoodsLotId: lot10 },
    });
    check("SPLIT delivering beyond the ordered quantity is refused",
      over.status === 400 || over.status === 409, `got ${over.status} ${JSON.stringify(over.json)}`);
  } else {
    check("SPLIT packaging reserved the full 12kg to the order", false, "setup failed");
    check("SPLIT the reservation is fully drawn down", false, "setup failed");
    check("SPLIT consumed allocations account for every delivered kilogram", false, "setup failed");
    check("SPLIT the lot is emptied exactly", false, "setup failed");
    check("SPLIT delivering beyond the ordered quantity is refused", false, "setup failed");
  }

  // ── ledger integrity ───────────────────────────────────────────────────────
  section("LEDGER — every shelf movement is mirrored in InventoryMovement");
  // Scoped to the lots this suite produced through the real packaging route. Fixtures
  // inserted straight into the table by other suites have no ledger rows by design and
  // would otherwise show up here as a phantom imbalance.
  const ownLots = `
    SELECT fgl.id FROM "FinishedGoodsLot" fgl
    JOIN "RoastingBatch" rb ON rb.id = fgl."roastingBatchId"
    JOIN "OrderItem" oi ON oi.id = rb."orderItemId"
    JOIN "Order" o ON o.id = oi."orderId"
    WHERE o.notes LIKE '${TAG}%'`;
  const fgIn = Number(sqlOne(`SELECT COALESCE(SUM("quantityChanged"),0) FROM "InventoryMovement" WHERE category='FINISHED_GOODS' AND type='IN' AND "referenceEntityId" IN (${ownLots});`));
  const fgOut = Number(sqlOne(`SELECT COALESCE(SUM("quantityChanged"),0) FROM "InventoryMovement" WHERE category='FINISHED_GOODS' AND type='OUT' AND "referenceEntityId" IN (${ownLots});`));
  const onShelf = Number(sqlOne(`SELECT COALESCE(SUM("availableQty"),0) FROM "FinishedGoodsLot" WHERE id IN (${ownLots});`));
  note(`ledger IN=${fgIn} OUT=${fgOut} net=${fgIn + fgOut} | actual on shelf=${onShelf}`);
  check("LEDGER net finished-goods movement equals the shelf balance",
    Math.abs(fgIn + fgOut - onShelf) < 0.001, `net=${fgIn + fgOut} shelf=${onShelf}`);

  process.exit(summary() === 0 ? 0 : 1);
}

main().catch((e) => { console.error("\nFATAL:", e); process.exit(2); });
