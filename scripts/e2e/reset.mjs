// ─────────────────────────────────────────────────────────────────────────────
//  Admin reset must survive the new StockAllocation table.
//
//  StockAllocation.finishedGoodsLotId is ON DELETE RESTRICT, so a reset that deletes
//  FinishedGoodsLot before the allocations pointing at it aborts the whole transaction
//  and leaves the operator with a system they cannot clear. This is destructive by
//  definition, so it runs LAST and only against a disposable database.
//
//      node scripts/e2e/reset.mjs
// ─────────────────────────────────────────────────────────────────────────────
import { api, login, sqlOne, sqlExec, check, note, section, summary } from "./harness.mjs";

const TAG = "E2E-RESET";

async function main() {
  const dbName = sqlOne("SELECT current_database();");
  if (!/test|dev|demo/i.test(dbName ?? "")) {
    console.error(`Refusing to run a destructive reset against database "${dbName}".`);
    process.exit(2);
  }

  await login("1234");

  section("RESET — a shelf holding live reservations can still be cleared");

  // Build the exact shape that breaks: a lot with a RESERVED allocation pointing at it.
  sqlExec(`
    INSERT INTO "Customer" (id, name, "createdAt", "updatedAt")
      VALUES ('${TAG}-cust', '${TAG} Customer', now(), now())
      ON CONFLICT (id) DO NOTHING;
    INSERT INTO "CoffeeProduct" (id, "productNameEn", "countryEn", "createdAt", "updatedAt")
      VALUES ('${TAG}-prod', '${TAG} Product', 'Ethiopia', now(), now())
      ON CONFLICT (id) DO NOTHING;
    INSERT INTO "FinishedGoodsLot" (id, "productId", "batchNumber", "quantityKg", "availableQty", "reservedQty", status, "createdAt")
      VALUES ('${TAG}-lot', '${TAG}-prod', '${TAG}-B1', 5, 5, 5, 'AVAILABLE', now())
      ON CONFLICT (id) DO NOTHING;
    INSERT INTO "Order" (id, "orderNumber", "customerId", "createdAt", "updatedAt", status)
      VALUES ('${TAG}-order', 999001, '${TAG}-cust', now(), now(), 'Preparing')
      ON CONFLICT (id) DO NOTHING;
    INSERT INTO "OrderItem" (id, "orderId", "beanTypeName", "quantityKg", "createdAt", "updatedAt")
      VALUES ('${TAG}-item', '${TAG}-order', '${TAG} Bean', 5, now(), now())
      ON CONFLICT (id) DO NOTHING;
    INSERT INTO "StockAllocation" (id, "orderItemId", "finishedGoodsLotId", "quantityKg", status, "createdAt", "updatedAt")
      VALUES ('${TAG}-alloc', '${TAG}-item', '${TAG}-lot', 5, 'RESERVED', now(), now())
      ON CONFLICT (id) DO NOTHING;
  `);

  const before = Number(sqlOne(`SELECT count(*) FROM "StockAllocation";`));
  note(`${before} allocation row(s) in place, one of them blocking the lot delete`);
  check("setup: at least one RESERVED allocation exists", before > 0, `count=${before}`);

  const res = await api("/api/admin/reset", {
    method: "POST",
    body: { phrase: "RESET HIQBAH", pin: "1234" },
  });

  check("admin reset completes instead of failing on the FK", res.status === 200,
    `got ${res.status} ${JSON.stringify(res.json)}`);

  const allocsAfter = Number(sqlOne(`SELECT count(*) FROM "StockAllocation";`));
  const lotsAfter = Number(sqlOne(`SELECT count(*) FROM "FinishedGoodsLot";`));
  const employeesAfter = Number(sqlOne(`SELECT count(*) FROM "Employee";`));

  check("all allocations are gone", allocsAfter === 0, `count=${allocsAfter}`);
  check("all finished goods lots are gone", lotsAfter === 0, `count=${lotsAfter}`);
  check("employees are preserved, as documented", employeesAfter > 0, `count=${employeesAfter}`);

  process.exit(summary() === 0 ? 0 : 1);
}

main().catch((e) => { console.error("\nFATAL:", e); process.exit(2); });
