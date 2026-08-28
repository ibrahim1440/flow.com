// ─────────────────────────────────────────────────────────────────────────────
//  Roast-to-stock: deliberately replenishing the shelf with no order behind it.
//
//  Shelf-first fulfilment is only half a mechanism while nothing can fill the shelf on
//  purpose. Before this feature the only stock that ever reached it was accidental — an
//  admin over-roasting against an order, or leftovers from a cancelled one.
//
//      node scripts/e2e/roast-to-stock.mjs
// ─────────────────────────────────────────────────────────────────────────────
import { api, login, clearCookie, sqlOne, sqlExec, check, note, section, summary, esc } from "./harness.mjs";

const TAG = "E2E-STOCK";

function cleanup() {
  sqlExec(`
    DELETE FROM "InventoryMovement" WHERE "referenceEntityId" IN (
        SELECT id FROM "FinishedGoodsLot" WHERE "batchNumber" LIKE '${TAG}%')
      OR "referenceEntityId" IN (SELECT id FROM "GreenBean" WHERE "serialNumber" LIKE '${TAG}%')
      OR "sourceDocId" IN (SELECT id FROM "RoastingBatch" WHERE "greenBeanId" IN (
          SELECT id FROM "GreenBean" WHERE "serialNumber" LIKE '${TAG}%'));
    DELETE FROM "StockAllocation" WHERE "finishedGoodsLotId" IN (
        SELECT fgl.id FROM "FinishedGoodsLot" fgl
        LEFT JOIN "RoastingBatch" rb ON rb.id = fgl."roastingBatchId"
        WHERE rb."greenBeanId" IN (SELECT id FROM "GreenBean" WHERE "serialNumber" LIKE '${TAG}%'))
      OR "orderItemId" IN (SELECT oi.id FROM "OrderItem" oi JOIN "Order" o ON o.id=oi."orderId"
                            WHERE o.notes LIKE '${TAG}%');
    DELETE FROM "Delivery" WHERE "orderItemId" IN (
        SELECT oi.id FROM "OrderItem" oi JOIN "Order" o ON o.id=oi."orderId" WHERE o.notes LIKE '${TAG}%');
    DELETE FROM "FinishedGoodsLot" WHERE "roastingBatchId" IN (
        SELECT id FROM "RoastingBatch" WHERE "greenBeanId" IN (
          SELECT id FROM "GreenBean" WHERE "serialNumber" LIKE '${TAG}%'));
    DELETE FROM "QcRecord" WHERE "batchId" IN (SELECT id FROM "RoastingBatch" WHERE "greenBeanId" IN (
        SELECT id FROM "GreenBean" WHERE "serialNumber" LIKE '${TAG}%'));
    DELETE FROM "RoastingBatch" WHERE "greenBeanId" IN (
        SELECT id FROM "GreenBean" WHERE "serialNumber" LIKE '${TAG}%');
    DELETE FROM "OrderActivity" WHERE "orderId" IN (SELECT id FROM "Order" WHERE notes LIKE '${TAG}%');
    DELETE FROM "OrderItem" WHERE "orderId" IN (SELECT id FROM "Order" WHERE notes LIKE '${TAG}%');
    DELETE FROM "Order" WHERE notes LIKE '${TAG}%';
    DELETE FROM "CoffeeProduct" WHERE "productNameEn" LIKE '${TAG}%';
    DELETE FROM "GreenBean" WHERE "serialNumber" LIKE '${TAG}%';
    DELETE FROM "Customer" WHERE name LIKE '${TAG}%';
  `);
}

const greenQty = (id) => Number(sqlOne(`SELECT "quantityKg" FROM "GreenBean" WHERE id='${esc(id)}';`));
const lotFreeQty = (id) =>
  Number(sqlOne(`SELECT "availableQty" - "reservedQty" FROM "FinishedGoodsLot" WHERE id='${esc(id)}';`));

async function main() {
  // This suite mutates an Employee row (see the privilege section below), so refuse to run
  // anywhere that is not obviously disposable — the same guard reset.mjs uses.
  const dbName = sqlOne("SELECT current_database();");
  if (!/test|dev|demo/i.test(dbName ?? "")) {
    console.error(`Refusing to run against database "${dbName}" — this suite temporarily rewrites employee permissions.`);
    process.exit(2);
  }

  cleanup();

  const customerId = sqlOne(
    `INSERT INTO "Customer"(id,name,"createdAt","updatedAt")
     VALUES ('${TAG}-c','${TAG} Customer',now(),now()) RETURNING id;`);
  const productId = sqlOne(
    `INSERT INTO "CoffeeProduct"(id,"productNameEn","countryEn","createdAt","updatedAt")
     VALUES ('${TAG}-p','${TAG} Product','Ethiopia',now(),now()) RETURNING id;`);
  const beanId = sqlOne(
    `INSERT INTO "GreenBean"(id,"serialNumber","beanType",country,"quantityKg","isActive","receivedDate","createdAt","updatedAt")
     VALUES ('${TAG}-g','${TAG}-SN','${TAG} Bean','Ethiopia',200,true,now(),now(),now()) RETURNING id;`);

  await login("1234");

  // ── the feature itself ─────────────────────────────────────────────────────
  section("STOCK — the roastery can roast for the shelf with no order behind it");

  const greenBefore = greenQty(beanId);
  const batch = await api("/api/roasting-batches", {
    method: "POST",
    body: { greenBeanId: beanId, productId, greenBeanQuantity: 24, roastedBeanQuantity: 20, wasteQuantity: 4 },
  });
  check("STOCK a batch with no order item is accepted", batch.status === 201,
    `got ${batch.status} ${JSON.stringify(batch.json)}`);
  if (batch.status !== 201) process.exit(summary() === 0 ? 0 : 1);

  const batchId = batch.json.id;
  check("STOCK it is recorded as belonging to no order", batch.json.orderItemId === null,
    `orderItemId=${JSON.stringify(batch.json.orderItemId)}`);
  check("STOCK green stock is still deducted", greenQty(beanId) === greenBefore - 24,
    `before=${greenBefore} after=${greenQty(beanId)}`);

  const rawMove = Number(sqlOne(
    `SELECT COALESCE(SUM("quantityChanged"),0) FROM "InventoryMovement"
      WHERE category='RAW_MATERIAL' AND "sourceDocId"='${esc(batchId)}';`));
  check("STOCK the raw-material ledger records the draw-down", rawMove === -24, `sum=${rawMove}`);

  // Roasting to stock is deliberate surplus production — the very thing the per-order
  // surplus gate controls — so it is its own revocable privilege rather than a side effect
  // of being allowed to roast at all.
  section("STOCK — the privilege is separately revocable");
  // This temporarily rewrites a real Employee row. It is restored in the finally block
  // below whatever happens, and main() refuses to run outside a disposable database.
  const roaster = sqlOne(`SELECT id FROM "Employee" WHERE role='roasting' LIMIT 1;`);
  const savedPerms = sqlOne(`SELECT permissions FROM "Employee" WHERE id='${esc(roaster)}';`);
  try {
    sqlExec(`UPDATE "Employee" SET permissions='{"production":{"access":"edit","sub":{"start_batch":true,"roast_to_stock":false}}}' WHERE id='${esc(roaster)}';`);
    clearCookie();
    await login("3456");
    const denied = await api("/api/roasting-batches", {
      method: "POST",
      body: { greenBeanId: beanId, productId, greenBeanQuantity: 5, roastedBeanQuantity: 4, wasteQuantity: 1 },
    });
    check("STOCK a roaster without roast_to_stock is refused", denied.status === 403,
      `got ${denied.status} ${JSON.stringify(denied.json)}`);

    const stillRoasts = await api("/api/roasting-batches", {
      method: "POST",
      body: { greenBeanId: beanId, productId, greenBeanQuantity: 5, roastedBeanQuantity: 4, wasteQuantity: 1, orderItemId: "does-not-exist" },
    });
    check("STOCK revoking it does not take away ordinary roasting", stillRoasts.status === 404,
      `expected 404 order-item-not-found, got ${stillRoasts.status} ${JSON.stringify(stillRoasts.json)}`);
  } finally {
    sqlExec(`UPDATE "Employee" SET permissions='${esc(savedPerms)}' WHERE id='${esc(roaster)}';`);
    clearCookie();
    await login("1234");
  }

  const noProduct = await api("/api/roasting-batches", {
    method: "POST",
    body: { greenBeanId: beanId, greenBeanQuantity: 5, roastedBeanQuantity: 4, wasteQuantity: 1 },
  });
  check("STOCK a stock batch with no product is refused — nothing could identify the coffee",
    noProduct.status === 400, `got ${noProduct.status} ${JSON.stringify(noProduct.json)}`);

  // ── QC then packaging ──────────────────────────────────────────────────────
  section("STOCK — it flows through QC and packaging like any other batch");

  const qc = await api(`/api/qc/${batchId}/records`, {
    method: "POST",
    body: { testerName: "E2E Tester", decision: "Accept", aroma: 8, flavor: 8, acidity: 8, body: 8 },
  });
  check("STOCK QC record accepted", qc.status === 200 || qc.status === 201,
    `got ${qc.status} ${JSON.stringify(qc.json)}`);

  const fin = await api(`/api/qc/${batchId}/finalize`, { method: "POST", body: { outcome: "Passed" } });
  check("STOCK QC finalize passes with no order item to recalculate", fin.status === 200,
    `got ${fin.status} ${JSON.stringify(fin.json)}`);

  const pkg = await api(`/api/roasting-batches/${batchId}/package`, { method: "PUT", body: { bags1kg: 20 } });
  check("STOCK packaging succeeds", pkg.status === 200, `got ${pkg.status} ${JSON.stringify(pkg.json)}`);

  const lotId = sqlOne(`SELECT id FROM "FinishedGoodsLot" WHERE "roastingBatchId"='${esc(batchId)}';`);
  note(`stock lot free-to-promise = ${lotFreeQty(lotId)}kg`);
  check("STOCK the whole lot lands on the shelf FREE — reserved to nobody",
    lotFreeQty(lotId) === 20, `free=${lotFreeQty(lotId)}`);

  // ── the point of the whole exercise ────────────────────────────────────────
  section("STOCK — a later order is filled from it with no roasting at all");

  sqlExec(`UPDATE "GreenBean" SET "quantityKg"=0 WHERE id='${esc(beanId)}';`);
  note("green stock forced to 0 — the shelf is the only way to serve this order");

  const order = await api("/api/orders", {
    method: "POST",
    body: {
      customerId,
      notes: `${TAG} order`,
      items: [{ beanTypeName: `${TAG} Bean`, quantityKg: 15, greenBeanId: beanId, productId }],
    },
  });
  check("STOCK the order is accepted because the shelf covers it", order.status === 201,
    `got ${order.status} ${JSON.stringify(order.json)}`);
  if (order.status !== 201) process.exit(summary() === 0 ? 0 : 1);

  const itemId = order.json.items[0].id;
  await api(`/api/orders/${order.json.id}/approve`, { method: "POST", body: { decision: "Yes" } });

  const review = await api(`/api/orders/${order.json.id}/preparation-review`, {
    method: "POST",
    body: { items: [{ orderItemId: itemId, decision: "Available on Shelf" }] },
  });
  check("STOCK preparation review covers it entirely from the shelf",
    review.status === 200 && review.json?.items?.[0]?.preparationDecision === "Available on Shelf",
    `got ${review.status} ${JSON.stringify(review.json)}`);
  check("STOCK nothing at all needs roasting",
    review.json?.items?.[0]?.productionRequiredQuantity === 0,
    `productionRequired=${JSON.stringify(review.json?.items?.[0]?.productionRequiredQuantity)}`);

  const delivery = await api("/api/deliveries", {
    method: "POST",
    body: { orderItemId: itemId, quantityKg: 15, deliveryType: "full", finishedGoodsLotId: lotId },
  });
  check("STOCK it ships straight off the shelf", delivery.status === 201 || delivery.status === 200,
    `got ${delivery.status} ${JSON.stringify(delivery.json)}`);

  check("STOCK the 5kg remainder stays free for the next order", lotFreeQty(lotId) === 5,
    `free=${lotFreeQty(lotId)}`);

  const roasted = Number(sqlOne(
    `SELECT count(*) FROM "RoastingBatch" WHERE "orderItemId"='${esc(itemId)}';`));
  check("STOCK the order was filled without a single roast of its own", roasted === 0, `batches=${roasted}`);

  // ── ledger ─────────────────────────────────────────────────────────────────
  section("LEDGER — the stock batch is fully accounted for");
  const fgNet = Number(sqlOne(
    `SELECT COALESCE(SUM("quantityChanged"),0) FROM "InventoryMovement"
      WHERE category='FINISHED_GOODS' AND "referenceEntityId"='${esc(lotId)}';`));
  const onShelf = Number(sqlOne(`SELECT "availableQty" FROM "FinishedGoodsLot" WHERE id='${esc(lotId)}';`));
  note(`ledger net for this lot = ${fgNet} | on shelf = ${onShelf}`);
  check("LEDGER net movement equals the lot balance", Math.abs(fgNet - onShelf) < 0.001,
    `net=${fgNet} shelf=${onShelf}`);

  process.exit(summary() === 0 ? 0 : 1);
}

main().catch((e) => { console.error("\nFATAL:", e); process.exit(2); });
