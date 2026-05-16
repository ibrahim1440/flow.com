import "dotenv/config";
import { Pool } from "pg";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const client = await pool.connect();
  try {
    // 1. All batches — show isBlend, blendTiming, status, parentBatchId, childBatch count
    console.log("\n=== ALL ROASTING BATCHES ===");
    const { rows: allBatches } = await client.query(`
      SELECT
        rb.id,
        rb."batchNumber",
        rb.status,
        rb."isBlend",
        rb."blendTiming",
        rb."parentBatchId",
        rb."greenBeanQuantity",
        rb."roastedBeanQuantity",
        rb."orderItemId",
        (SELECT COUNT(*) FROM "RoastingBatch" child WHERE child."parentBatchId" = rb.id) AS "childCount"
      FROM "RoastingBatch" rb
      ORDER BY rb."createdAt"
    `);
    for (const b of allBatches) {
      console.log(
        `  ${b.batchNumber.padEnd(20)} status=${b.status.padEnd(20)} isBlend=${String(b.isBlend).padEnd(6)} blendTiming=${String(b.blendTiming).padEnd(12)} parentBatchId=${b.parentBatchId ?? "null"} children=${b.childCount}`
      );
    }

    // 2. Batches that have children (likely blend outputs)
    console.log("\n=== BATCHES WITH CHILDREN (potential blend outputs) ===");
    const { rows: parentBatches } = await client.query(`
      SELECT
        rb.id,
        rb."batchNumber",
        rb.status,
        rb."isBlend",
        rb."blendTiming",
        rb."roastedBeanQuantity",
        rb."greenBeanQuantity",
        json_agg(json_build_object('id', child.id, 'batchNumber', child."batchNumber", 'status', child.status, 'roastedBeanQuantity', child."roastedBeanQuantity")) AS children
      FROM "RoastingBatch" rb
      JOIN "RoastingBatch" child ON child."parentBatchId" = rb.id
      GROUP BY rb.id
      ORDER BY rb."createdAt"
    `);
    for (const b of parentBatches) {
      console.log(`\n  BLEND OUTPUT: ${b.batchNumber} | status=${b.status} | isBlend=${b.isBlend} | blendTiming=${b.blendTiming}`);
      console.log(`    roastedQty=${b.roastedBeanQuantity} greenQty=${b.greenBeanQuantity}`);
      for (const c of b.children) {
        console.log(`    SOURCE: ${c.batchNumber} status=${c.status} roasted=${c.roastedBeanQuantity}`);
      }
    }

    // 3. Existing BlendIngredient records
    console.log("\n=== EXISTING BLEND INGREDIENT RECORDS ===");
    const { rows: ingredients } = await client.query(`
      SELECT COUNT(*) AS count FROM "BlendIngredient"
    `);
    console.log(`  Total BlendIngredient rows: ${ingredients[0].count}`);

    // 4. OrderItems with their batch breakdown — spot negative remainders
    console.log("\n=== ORDER ITEMS WITH BATCH PRODUCTION SUMMARY ===");
    const { rows: items } = await client.query(`
      SELECT
        oi.id,
        oi."beanTypeName",
        oi."quantityKg",
        oi."productionStatus",
        o."orderNumber",
        json_agg(json_build_object(
          'batchNumber', rb."batchNumber",
          'status', rb.status,
          'isBlend', rb."isBlend",
          'roasted', rb."roastedBeanQuantity",
          'green', rb."greenBeanQuantity",
          'blendTiming', rb."blendTiming",
          'childCount', (SELECT COUNT(*) FROM "RoastingBatch" c WHERE c."parentBatchId" = rb.id)
        ) ORDER BY rb."createdAt") AS batches
      FROM "OrderItem" oi
      JOIN "Order" o ON o.id = oi."orderId"
      LEFT JOIN "RoastingBatch" rb ON rb."orderItemId" = oi.id
      GROUP BY oi.id, o."orderNumber"
      ORDER BY o."orderNumber"
    `);

    const COMPLETION_STATUSES = new Set(["Passed", "Partially Packaged", "Packaged", "Blended"]);
    for (const item of items) {
      const batches = item.batches.filter((b: any) => b.batchNumber !== null);
      const completionTotal = batches
        .filter((b: any) => COMPLETION_STATUSES.has(b.status) && !b.isBlend)
        .reduce((sum: number, b: any) => sum + (b.roasted > 0 ? b.roasted : b.green), 0);
      const remaining = item.quantityKg - completionTotal;
      const flag = remaining < 0 ? " ⚠️  NEGATIVE" : "";
      if (batches.length > 0) {
        console.log(`\n  Order #${item.orderNumber} | ${item.beanTypeName} | ordered=${item.quantityKg}kg | completionTotal=${completionTotal.toFixed(2)}kg | remaining=${remaining.toFixed(2)}kg${flag}`);
        for (const b of batches) {
          console.log(`    ${b.batchNumber?.padEnd(20)} status=${b.status?.padEnd(20)} isBlend=${String(b.isBlend).padEnd(6)} roasted=${b.roasted} children=${b.childCount}`);
        }
      }
    }

  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
