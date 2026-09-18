// Builds a realistic multi-origin catalog in the test database, through the real APIs
// wherever one exists (so catalog creation is itself under test).
import { api, db, check, sub, one } from "./harness.mjs";


export async function buildCatalog(prefix) {
  sub("Catalog: 3 origins, 5 SKUs, 4 packaging materials");

  const beans = {};
  for (const [key, name, country, kg] of [
    ["brazil", "Brazil Santos", "Brazil", 120],
    ["ethiopia", "Ethiopia Guji", "Ethiopia", 80],
    ["indonesia", "Indonesia Mandheling", "Indonesia", 60],
  ]) {
    const id = `${prefix}_bean_${key}`;
    await db.query('DELETE FROM "GreenBean" WHERE id=$1', [id]);
    await db.query(
      `INSERT INTO "GreenBean" (id,"serialNumber","beanType",country,"quantityKg","isActive","receivedDate","createdAt","updatedAt")
       VALUES ($1,$2,$3,$4,$5,true,now(),now(),now())`,
      [id, `${prefix}-${key.toUpperCase()}`, name, country, kg]
    );
    beans[key] = { id, name, openingKg: kg };
  }

  // Origins. Roast loss differs per origin so the production maths is not trivially equal.
  const coffees = {};
  for (const [key, name, loss] of [
    ["brazil", "Brazil Santos", 15],
    ["ethiopia", "Ethiopia Guji", 18],
    ["indonesia", "Indonesia Mandheling", 12],
  ]) {
    const id = `${prefix}_cof_${key}`;
    await db.query('DELETE FROM "CoffeeProduct" WHERE id=$1', [id]);
    await db.query(
      `INSERT INTO "CoffeeProduct" (id,"productNameEn","countryEn","defaultGreenBeanId","expectedRoastLoss","createdAt","updatedAt")
       VALUES ($1,$2,$3,$4,$5,now(),now())`,
      [id, `${prefix} ${name}`, name.split(" ")[0], beans[key].id, loss]
    );
    coffees[key] = { id, name, roastLoss: loss };
  }

  // Packaging materials, created through the API.
  const materials = {};
  for (const [key, code, name, qty] of [
    ["bag1kg", `${prefix}-BAG-1KG`, "1 KG Coffee Bag", 500],
    ["bag250", `${prefix}-BAG-250G`, "250 g Coffee Bag", 800],
    ["label", `${prefix}-LABEL`, "Origin Label", 1500],
    ["carton", `${prefix}-CARTON`, "Shipping Carton", 200],
  ]) {
    const r = await api("/api/materials", { method: "POST", body: { code, name, category: key === "label" ? "LABEL" : "PACKAGING", quantityOnHand: qty, reorderPoint: 50 } });
    if (r.status !== 201) throw new Error("material create failed: " + JSON.stringify(r.json));
    materials[key] = { id: r.json.id, code, openingQty: qty };
  }

  // SKUs, created through the API.
  const skus = {};
  const skuSpec = [
    ["bra250", "brazil", `${prefix}-BRA-250G`, "Brazil Santos 250 g", 250, 34],
    ["bra1kg", "brazil", `${prefix}-BRA-1KG`, "Brazil Santos 1 KG", 1000, 120],
    ["eth250", "ethiopia", `${prefix}-ETH-250G`, "Ethiopia Guji 250 g", 250, 42],
    ["eth1kg", "ethiopia", `${prefix}-ETH-1KG`, "Ethiopia Guji 1 KG", 1000, 150],
    ["idn250", "indonesia", `${prefix}-IDN-250G`, "Indonesia Mandheling 250 g", 250, 38],
  ];
  for (const [key, coffeeKey, code, name, grams, price] of skuSpec) {
    const r = await api("/api/products", { method: "POST", body: { productId: coffees[coffeeKey].id, skuCode: code, name, weightGrams: grams, price } });
    if (r.status !== 201) throw new Error("sku create failed: " + JSON.stringify(r.json));
    skus[key] = { id: r.json.id, code, name, grams, price, kg: grams / 1000, coffee: coffeeKey };
  }

  // BOMs. A 250 g pack consumes 0.25 kg roasted + its bag + a label; 1 KG likewise.
  for (const [key, sku] of Object.entries(skus)) {
    const bagKey = sku.grams >= 1000 ? "bag1kg" : "bag250";
    const r = await api(`/api/products/${sku.id}/bom`, { method: "PUT", body: { components: [
      { type: "ROASTED_COFFEE", coffeeProductId: coffees[sku.coffee].id, quantityPerUnit: sku.kg },
      { type: "MATERIAL", materialItemId: materials[bagKey].id, quantityPerUnit: 1 },
      { type: "MATERIAL", materialItemId: materials.label.id, quantityPerUnit: 1 },
    ]}});
    if (r.status !== 200) throw new Error("bom save failed for " + key + ": " + JSON.stringify(r.json));
  }

  const customers = {};
  for (const [key, name] of [["cafe", "ABC Cafe"], ["hotel", "Grand Hotel"], ["retail", "Retail Chain"]]) {
    const id = `${prefix}_cust_${key}`;
    await db.query('DELETE FROM "Customer" WHERE id=$1', [id]);
    await db.query('INSERT INTO "Customer" (id,name,"createdAt","updatedAt") VALUES ($1,$2,now(),now())', [id, `${prefix} ${name}`]);
    customers[key] = { id, name };
  }

  check("catalog built (3 origins, 5 SKUs with BOM, 4 materials, 3 customers)", true);
  return { beans, coffees, materials, skus, customers };
}

/**
 * Seed a legacy kilogram lot the way history left one behind.
 *
 * The endpoint that used to create these is retired — kilogram packaging is not something
 * the system does any more. But the lots it created are still REAL: Production holds four
 * of them, 19.710 kg, and they still serve the legacy bean-based order lines that reserve
 * and ship in kilograms. That behaviour is live and must stay tested.
 *
 * So the fixture writes the row directly, exactly as the old route shaped it — kg-tracked,
 * the unique 1:1 roastingBatchId link, availableQty carrying the balance, units all zero —
 * and draws the roast down to match. Driving a retired write path to build a fixture would
 * be testing the wrong thing; this seeds the DATA whose behaviour is under test.
 */
export async function seedLegacyKgLot(batchId, productId, kg, opts = {}) {
  const b = await one(
    'SELECT "batchNumber" bn, "roastedBeanQuantity" rq, "roastedAvailableKg" ra FROM "RoastingBatch" WHERE id=$1',
    [batchId]);
  if (!b) throw new Error("seedLegacyKgLot: batch not found");

  const r = await db.query(
    `INSERT INTO "FinishedGoodsLot"
       (id,"productId","productSkuId","batchNumber","roastingBatchId","quantityKg","availableQty",
        "reservedQty","isUnitTracked","unitsProduced","unitsAvailable","unitsReserved",status,"createdAt")
     VALUES (gen_random_uuid()::text,$1,$2,$3,$4,$5,$6,0,false,0,0,0,'AVAILABLE',now())
     RETURNING id`,
    [productId, opts.productSkuId ?? null, b.bn, batchId, Number(b.rq), kg]);

  // The roast gave the coffee up, exactly as it would have then.
  await db.query(
    `UPDATE "RoastingBatch"
        SET "roastedAvailableKg" = GREATEST(0, "roastedAvailableKg" - $2),
            "bags1kg" = "bags1kg" + $3,
            status = CASE WHEN ("roastedAvailableKg" - $2) < 0.05 THEN 'Packaged' ELSE 'Partially Packaged' END
      WHERE id = $1`,
    [batchId, kg, Math.round(kg)]);

  return r.rows[0].id;
}

/** Remove everything a prefix created, in FK-safe order. */
export async function teardown(prefix) {
  const p = prefix + "%";
  await db.query(`DELETE FROM "StockAllocation" WHERE "orderItemId" IN (SELECT oi.id FROM "OrderItem" oi JOIN "Order" o ON o.id=oi."orderId" WHERE o.notes LIKE $1)`, [p]);
  await db.query(`DELETE FROM "Delivery" WHERE "orderItemId" IN (SELECT oi.id FROM "OrderItem" oi JOIN "Order" o ON o.id=oi."orderId" WHERE o.notes LIKE $1)`, [p]);
  await db.query(`DELETE FROM "InventoryMovement" WHERE notes LIKE $1
      OR "sourceDocId" IN (SELECT id FROM "RoastingBatch" WHERE "batchNumber" LIKE $1)
      OR "referenceEntityId" IN (SELECT id FROM "MaterialItem" WHERE code LIKE $1)
      OR "referenceEntityId" IN (SELECT id FROM "GreenBean" WHERE "serialNumber" LIKE $1)
      OR "referenceEntityId" IN (SELECT id FROM "FinishedGoodsLot" WHERE "batchNumber" LIKE $1
          OR "packedFromBatchId" IN (SELECT id FROM "RoastingBatch" WHERE "batchNumber" LIKE $1))`, [p]);
  // Matched on the lot's OWN batch number as well as on its batch links, the way the
  // finished-products teardown already does. Both link columns are ON DELETE SET NULL, so
  // a lot whose roast was deleted keeps its stock but loses every trace of where it came
  // from — and a teardown that searches only by link cannot find it, leaving finished
  // coffee behind that then blocks the CoffeeProduct delete on its RESTRICT foreign key.
  // Packaged roasts can no longer be deleted, so this is belt and braces; it is here
  // because a database that has ever seen the old behaviour still contains the wreckage.
  await db.query(`DELETE FROM "FinishedGoodsLot" WHERE "batchNumber" LIKE $1
      OR "packedFromBatchId" IN (SELECT id FROM "RoastingBatch" WHERE "batchNumber" LIKE $1)
      OR "roastingBatchId" IN (SELECT id FROM "RoastingBatch" WHERE "batchNumber" LIKE $1)`, [p]);
  await db.query(`DELETE FROM "ProductionOrder" WHERE "sourceOrderItemId" IN (SELECT oi.id FROM "OrderItem" oi JOIN "Order" o ON o.id=oi."orderId" WHERE o.notes LIKE $1)`, [p]);
  await db.query(`DELETE FROM "QcRecord" WHERE "batchId" IN (SELECT id FROM "RoastingBatch" WHERE "batchNumber" LIKE $1)`, [p]);
  // PackagingOperation.batchId is ON DELETE RESTRICT, so the packaging audit rows must go
  // before the batches they belong to or the teardown fails on a foreign key.
  await db.query(`DELETE FROM "PackagingOperation" WHERE "batchId" IN (SELECT id FROM "RoastingBatch" WHERE "batchNumber" LIKE $1)`, [p]);
  await db.query(`DELETE FROM "RoastingBatch" WHERE "batchNumber" LIKE $1`, [p]);
  await db.query(`DELETE FROM "Order" WHERE notes LIKE $1`, [p]);
  // Production orders are removed by SKU as well as by source order item: an order raised
  // for stock, or one left behind by a test fixture, has no order item to find it by and
  // would otherwise block the ProductSKU delete on its foreign key.
  await db.query(`DELETE FROM "ProductionOrder" WHERE "productSkuId" IN (SELECT id FROM "ProductSKU" WHERE "skuCode" LIKE $1)`, [p]);
  await db.query(`DELETE FROM "BomComponent" WHERE "productSkuId" IN (SELECT id FROM "ProductSKU" WHERE "skuCode" LIKE $1)`, [p]);
  await db.query(`DELETE FROM "ProductSKU" WHERE "skuCode" LIKE $1`, [p]);
  await db.query(`DELETE FROM "MaterialItem" WHERE code LIKE $1`, [p]);
  await db.query(`DELETE FROM "CoffeeProduct" WHERE id LIKE $1`, [prefix + "_cof_%"]);
  await db.query(`DELETE FROM "GreenBean" WHERE id LIKE $1`, [prefix + "_bean_%"]);
  await db.query(`DELETE FROM "Customer" WHERE id LIKE $1`, [prefix + "_cust_%"]);
  await db.query(`DELETE FROM "Employee" WHERE id LIKE $1`, [prefix + "_emp_%"]);
}

/** Roast a batch and take it through QC to Passed. Returns the batch row. */
export async function roastAndPass(prefix, coffee, bean, greenKg, roastedKg, wasteKg, label) {
  const r = await api("/api/roasting-batches", { method: "POST", body: {
    greenBeanId: bean.id, productId: coffee.id,
    greenBeanQuantity: greenKg, roastedBeanQuantity: roastedKg, wasteQuantity: wasteKg,
  }});
  if (r.status !== 201) return { error: r };
  const id = r.json.id;
  await db.query('UPDATE "RoastingBatch" SET "batchNumber"=$2 WHERE id=$1', [id, `${prefix}-${label}`]);
  await db.query(`UPDATE "RoastingBatch" SET status='Passed' WHERE id=$1`, [id]);
  return { id, batch: await one('SELECT * FROM "RoastingBatch" WHERE id=$1', [id]) };
}
