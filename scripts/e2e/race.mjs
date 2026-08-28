// ─────────────────────────────────────────────────────────────────────────────
//  Concurrency proof for the shelf reservation.
//
//  The sequential suite shows that a second review is refused once the first has
//  committed. That is the easy case. This one fires both at the same instant, which is
//  the case a read-then-write implementation would silently get wrong: both requests
//  read "10kg free", both write, and 20kg gets promised off a 10kg shelf.
//
//      node scripts/e2e/race.mjs
// ─────────────────────────────────────────────────────────────────────────────
import { api, login, sql, sqlOne, sqlExec, check, note, section, summary, esc } from "./harness.mjs";

const TAG = "E2E-RACE";
const CONTENDERS = 6;      // orders competing
const SHELF_KG = 10;       // enough for exactly one of them
const ORDER_KG = 10;

function cleanup() {
  sqlExec(`
    DELETE FROM "InventoryMovement" WHERE "referenceEntityId" IN (
        SELECT id FROM "FinishedGoodsLot" WHERE "batchNumber" LIKE '${TAG}%')
      OR "referenceEntityId" IN (SELECT id FROM "GreenBean" WHERE "serialNumber" LIKE '${TAG}%');
    DELETE FROM "StockAllocation" WHERE "finishedGoodsLotId" IN (
        SELECT id FROM "FinishedGoodsLot" WHERE "batchNumber" LIKE '${TAG}%');
    DELETE FROM "FinishedGoodsLot" WHERE "batchNumber" LIKE '${TAG}%';
    DELETE FROM "OrderActivity" WHERE "orderId" IN (SELECT id FROM "Order" WHERE notes LIKE '${TAG}%');
    DELETE FROM "OrderItem" WHERE "orderId" IN (SELECT id FROM "Order" WHERE notes LIKE '${TAG}%');
    DELETE FROM "Order" WHERE notes LIKE '${TAG}%';
    DELETE FROM "CoffeeProduct" WHERE "productNameEn" LIKE '${TAG}%';
    DELETE FROM "GreenBean" WHERE "serialNumber" LIKE '${TAG}%';
    DELETE FROM "Customer" WHERE name LIKE '${TAG}%';
  `);
}

async function main() {
  cleanup();

  const customerId = sqlOne(
    `INSERT INTO "Customer" (id, name, "createdAt", "updatedAt")
     VALUES ('${TAG}-cust', '${TAG} Customer', now(), now()) RETURNING id;`);
  const productId = sqlOne(
    `INSERT INTO "CoffeeProduct" (id, "productNameEn", "countryEn", "createdAt", "updatedAt")
     VALUES ('${TAG}-prod', '${TAG} Product', 'Ethiopia', now(), now()) RETURNING id;`);
  sqlExec(
    `INSERT INTO "GreenBean" (id, "serialNumber", "beanType", country, "quantityKg", "isActive", "receivedDate", "createdAt", "updatedAt")
     VALUES ('${TAG}-bean', '${TAG}-SN', '${TAG} Bean', 'Ethiopia', 1000, true, now(), now(), now());`);
  // Put the shelf stock in place directly — this test is about the reservation guard,
  // not about how the coffee got there.
  const lotId = sqlOne(
    `INSERT INTO "FinishedGoodsLot" (id, "productId", "batchNumber", "quantityKg", "availableQty", "reservedQty", status, "createdAt")
     VALUES ('${TAG}-lot', '${productId}', '${TAG}-B1', ${SHELF_KG}, ${SHELF_KG}, 0, 'AVAILABLE', now()) RETURNING id;`);

  await login("1234");

  section(`RACE — ${CONTENDERS} orders of ${ORDER_KG}kg each against a ${SHELF_KG}kg shelf`);

  const orderIds = [];
  for (let i = 0; i < CONTENDERS; i++) {
    const r = await api("/api/orders", {
      method: "POST",
      body: {
        customerId,
        notes: `${TAG} contender ${i}`,
        items: [{ beanTypeName: `${TAG} Bean`, quantityKg: ORDER_KG, greenBeanId: `${TAG}-bean`, productId }],
      },
    });
    if (r.status !== 201) throw new Error(`order ${i} failed: ${r.status} ${JSON.stringify(r.json)}`);
    await api(`/api/orders/${r.json.id}/approve`, { method: "POST", body: { decision: "Yes" } });
    orderIds.push({ orderId: r.json.id, itemId: r.json.items[0].id });
  }
  note(`${CONTENDERS} orders created and approved`);

  // Fire every preparation review at once, each claiming the full shelf.
  const results = await Promise.all(
    orderIds.map(({ orderId, itemId }) =>
      api(`/api/orders/${orderId}/preparation-review`, {
        method: "POST",
        body: { items: [{ orderItemId: itemId, decision: "Available on Shelf" }] },
      }).catch((e) => ({ status: 0, json: String(e) }))
    )
  );

  const ok = results.filter((r) => r.status === 200).length;
  const refused = results.filter((r) => r.status === 409).length;
  note(`accepted=${ok} refused=${refused} other=${results.length - ok - refused}`);

  check("exactly one order wins the shelf", ok === 1, `accepted=${ok}`);
  check("every other order is refused", refused === CONTENDERS - 1, `refused=${refused}`);

  const reserved = Number(sqlOne(`SELECT "reservedQty" FROM "FinishedGoodsLot" WHERE id='${esc(lotId)}';`));
  const available = Number(sqlOne(`SELECT "availableQty" FROM "FinishedGoodsLot" WHERE id='${esc(lotId)}';`));
  const allocSum = Number(sqlOne(
    `SELECT COALESCE(SUM("quantityKg"),0) FROM "StockAllocation" WHERE "finishedGoodsLotId"='${esc(lotId)}' AND status='RESERVED';`));

  note(`lot: availableQty=${available} reservedQty=${reserved} sum(RESERVED allocations)=${allocSum}`);

  check("the shelf never promises more than it holds", reserved <= available,
    `reservedQty=${reserved} availableQty=${available}`);
  check("exactly the winning quantity is reserved", reserved === ORDER_KG, `reservedQty=${reserved}`);
  check("allocation rows reconcile with the lot's reservedQty", Math.abs(allocSum - reserved) < 0.001,
    `allocations=${allocSum} reservedQty=${reserved}`);

  const decisions = sql(
    `SELECT oi."preparationDecision", count(*) FROM "OrderItem" oi
     JOIN "Order" o ON o.id=oi."orderId" WHERE o.notes LIKE '${TAG}%'
     GROUP BY 1 ORDER BY 1;`);
  note("decisions on disk: " + decisions.map((r) => `${r[0] ?? "null"}=${r[1]}`).join(", "));

  const onShelfClaims = Number(
    sqlOne(`SELECT count(*) FROM "OrderItem" oi JOIN "Order" o ON o.id=oi."orderId"
            WHERE o.notes LIKE '${TAG}%' AND oi."preparationDecision"='Available on Shelf';`));
  check("only one order item is recorded as covered by the shelf", onShelfClaims === 1,
    `count=${onShelfClaims}`);

  process.exit(summary() === 0 ? 0 : 1);
}

main().catch((e) => { console.error("\nFATAL:", e); process.exit(2); });
