/**
 * One-time data migration: fix historical blend batches
 *
 * Problems fixed:
 *  1. Blend output batches have isBlend=false  → set to true
 *  2. No BlendIngredient records exist         → rebuild from parentBatchId lineage
 *  3. OrderItem.productionStatus is wrong      → recalculate for all affected items
 *
 * Identification rule:
 *   A batch is a blend OUTPUT if it has at least one source batch pointing to it
 *   via `parentBatchId`, OR if `blendTiming IS NOT NULL`.
 *   Both conditions are equivalent in the historical data.
 *
 * Safe to re-run: skips BlendIngredient inserts that already exist; idempotent updates.
 */

import "dotenv/config";
import { Pool } from "pg";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const COMPLETION_STATUSES = new Set([
  "Passed",
  "Partially Packaged",
  "Packaged",
  "Blended",
]);

async function main() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // ─────────────────────────────────────────────────────────────────────────
    // STEP 1: Identify blend output batches and set isBlend = true
    // ─────────────────────────────────────────────────────────────────────────
    console.log("\n▶ STEP 1 — Marking historical blend output batches (isBlend = true)");

    const { rows: blendOutputs } = await client.query<{
      id: string;
      batchNumber: string;
      status: string;
      orderItemId: string;
      roastedBeanQuantity: number;
      greenBeanQuantity: number;
    }>(`
      SELECT DISTINCT rb.id, rb."batchNumber", rb.status, rb."orderItemId",
                      rb."roastedBeanQuantity", rb."greenBeanQuantity"
      FROM "RoastingBatch" rb
      WHERE
        rb."isBlend" = false
        AND (
          rb."blendTiming" IS NOT NULL
          OR EXISTS (
            SELECT 1 FROM "RoastingBatch" src WHERE src."parentBatchId" = rb.id
          )
        )
    `);

    console.log(`  Found ${blendOutputs.length} historical blend output batch(es) to fix.`);

    if (blendOutputs.length > 0) {
      const ids = blendOutputs.map((b) => b.id);
      const { rowCount } = await client.query(
        `UPDATE "RoastingBatch" SET "isBlend" = true WHERE id = ANY($1)`,
        [ids]
      );
      console.log(`  ✓ Updated ${rowCount} batch(es) → isBlend = true`);
      for (const b of blendOutputs) {
        console.log(`    ${b.batchNumber} (${b.status})`);
      }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // STEP 2: Rebuild BlendIngredient records from parentBatchId lineage
    // ─────────────────────────────────────────────────────────────────────────
    console.log("\n▶ STEP 2 — Rebuilding BlendIngredient lineage records");

    // Find all source→output pairs via parentBatchId
    const { rows: sourcePairs } = await client.query<{
      sourceId: string;
      sourceBatchNumber: string;
      targetId: string;
      targetBatchNumber: string;
      quantityUsed: number;
    }>(`
      SELECT
        src.id             AS "sourceId",
        src."batchNumber"  AS "sourceBatchNumber",
        out.id             AS "targetId",
        out."batchNumber"  AS "targetBatchNumber",
        src."roastedBeanQuantity" AS "quantityUsed"
      FROM "RoastingBatch" src
      JOIN "RoastingBatch" out ON out.id = src."parentBatchId"
      WHERE src."parentBatchId" IS NOT NULL
    `);

    console.log(`  Found ${sourcePairs.length} source→output pair(s).`);

    let insertedCount = 0;
    let skippedCount = 0;

    for (const pair of sourcePairs) {
      // Idempotent: skip if this exact pair already exists
      const { rows: existing } = await client.query(
        `SELECT id FROM "BlendIngredient"
         WHERE "sourceBatchId" = $1 AND "targetBlendBatchId" = $2`,
        [pair.sourceId, pair.targetId]
      );
      if (existing.length > 0) {
        skippedCount++;
        continue;
      }
      await client.query(
        `INSERT INTO "BlendIngredient" (id, "sourceBatchId", "targetBlendBatchId", "quantityUsed", "createdAt")
         VALUES (gen_random_uuid()::text, $1, $2, $3, NOW())`,
        [pair.sourceId, pair.targetId, pair.quantityUsed]
      );
      insertedCount++;
      console.log(
        `    ✓ ${pair.sourceBatchNumber} (${pair.quantityUsed}kg) → ${pair.targetBatchNumber}`
      );
    }

    console.log(`  Inserted: ${insertedCount} | Already existed (skipped): ${skippedCount}`);

    // ─────────────────────────────────────────────────────────────────────────
    // STEP 3: Recalculate productionStatus for all affected OrderItems
    // ─────────────────────────────────────────────────────────────────────────
    console.log("\n▶ STEP 3 — Recalculating OrderItem.productionStatus");

    // Affected = order items that contain at least one blend batch
    const { rows: affectedItems } = await client.query<{
      id: string;
      beanTypeName: string;
      quantityKg: number;
      deliveredQty: number;
      productionStatus: string;
      orderNumber: number;
    }>(`
      SELECT DISTINCT oi.id, oi."beanTypeName", oi."quantityKg", oi."deliveredQty",
                      oi."productionStatus", o."orderNumber"
      FROM "OrderItem" oi
      JOIN "Order" o ON o.id = oi."orderId"
      WHERE EXISTS (
        SELECT 1 FROM "RoastingBatch" rb
        WHERE rb."orderItemId" = oi.id AND rb."isBlend" = true
      )
      ORDER BY o."orderNumber"
    `);

    console.log(`  Found ${affectedItems.length} affected order item(s).`);

    let fixedCount = 0;

    for (const item of affectedItems) {
      // Get all batches for this order item with updated isBlend
      const { rows: batches } = await client.query<{
        status: string;
        isBlend: boolean;
        roastedBeanQuantity: number;
        greenBeanQuantity: number;
      }>(`
        SELECT status, "isBlend", "roastedBeanQuantity", "greenBeanQuantity"
        FROM "RoastingBatch"
        WHERE "orderItemId" = $1
      `, [item.id]);

      const activeStatuses = new Set([
        "Pending QC", "Passed", "Partially Packaged", "Packaged", "Blended",
      ]);

      const hasActiveNonBlend = batches.some(
        (b) => activeStatuses.has(b.status) && !b.isBlend
      );

      // Sum only non-blend batches in completion statuses
      const completionTotal = batches
        .filter((b) => COMPLETION_STATUSES.has(b.status) && !b.isBlend)
        .reduce(
          (sum, b) => sum + (b.roastedBeanQuantity > 0 ? b.roastedBeanQuantity : b.greenBeanQuantity),
          0
        );

      let newStatus: string;
      if (!hasActiveNonBlend) {
        newStatus = "Pending";
      } else if (completionTotal >= item.quantityKg) {
        newStatus = "Completed";
      } else {
        newStatus = "In Production";
      }

      const oldStatus = item.productionStatus;

      // Physical remaining = actual roasted volume minus what has been shipped.
      // Floor to 0: a warehouse cannot hold negative coffee. If the result is
      // negative, the historical delivery records over-deducted; clamp to 0.
      const correctedRemainingQty = Math.max(0, completionTotal - item.deliveredQty);

      // Always write the corrected remainingQty; update productionStatus only if changed.
      await client.query(
        `UPDATE "OrderItem" SET "productionStatus" = $1, "remainingQty" = $2 WHERE id = $3`,
        [newStatus, correctedRemainingQty, item.id]
      );

      if (oldStatus !== newStatus) {
        fixedCount++;
        console.log(
          `    Order #${item.orderNumber} | ${item.beanTypeName} | ` +
          `${oldStatus} → ${newStatus} | ` +
          `roasted=${completionTotal.toFixed(2)}kg delivered=${item.deliveredQty}kg remainingQty=${correctedRemainingQty.toFixed(2)}kg`
        );
      } else {
        console.log(
          `    Order #${item.orderNumber} | ${item.beanTypeName} | ` +
          `status unchanged (${oldStatus}) | ` +
          `roasted=${completionTotal.toFixed(2)}kg delivered=${item.deliveredQty}kg remainingQty=${correctedRemainingQty.toFixed(2)}kg`
        );
      }
    }

    console.log(`  Fixed ${fixedCount} order item(s).`);

    await client.query("COMMIT");
    console.log("\n✅ Migration committed successfully.\n");

    // ─────────────────────────────────────────────────────────────────────────
    // VERIFICATION: Check for any remaining negative remainders
    // ─────────────────────────────────────────────────────────────────────────
    console.log("▶ VERIFICATION — Checking for negative remaining quantities");

    const { rows: verifyItems } = await client.query<{
      orderNumber: number;
      beanTypeName: string;
      quantityKg: number;
      deliveredQty: number;
      remainingQty: number;
    }>(`
      SELECT o."orderNumber", oi."beanTypeName", oi."quantityKg",
             oi."deliveredQty", oi."remainingQty"
      FROM "OrderItem" oi
      JOIN "Order" o ON o.id = oi."orderId"
      WHERE oi."remainingQty" < 0
      ORDER BY oi."remainingQty"
    `);

    if (verifyItems.length === 0) {
      console.log("  ✅ No negative remainingQty values in the database. All clean!\n");
    } else {
      console.log(`  ❌ ${verifyItems.length} item(s) still have remainingQty < 0 — DATA ANOMALY (delivery records over-deducted):`);
      for (const v of verifyItems) {
        console.log(
          `    Order #${v.orderNumber} | ${v.beanTypeName} | ` +
          `ordered=${v.quantityKg}kg delivered=${v.deliveredQty}kg remainingQty=${Number(v.remainingQty).toFixed(2)}kg`
        );
      }
    }

  } catch (err) {
    await client.query("ROLLBACK");
    console.error("\n❌ Migration ROLLED BACK due to error:", err);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
