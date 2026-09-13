// HISTORICAL DRIFT DETECTOR — READ ONLY.
//
// The R2.1 code fix stops the packaging path writing wrong balances from now on. It does
// nothing about rows that were already written wrongly. This reports candidates; it
// repairs nothing, writes nothing, and is deliberately NOT registered in run-all.mjs
// because it is a diagnostic, not an assertion suite.
//
// Run it with the same environment the suites use:
//   node scripts/e2e/regression/drift-detect.mjs
//
// ── What it can and cannot tell you ─────────────────────────────────────────
// Two of the three checks below are exact. The third is not, and says so per row rather
// than guessing:
//
//   * a batch consumed into a blend had its coffee moved into the blend output, but the
//     blend path records no movement and decrements no balance (R2.0 finding K-1). What
//     its roastedAvailableKg SHOULD be is therefore unknowable from the data alone.
//   * roastedAvailableKg was seeded by migration 20260828120100 as "roasted minus already
//     packed at migration time". For a batch that existed then, the bag counters describe
//     packing that the seed had already subtracted, so re-subtracting them double-counts.
//
// Both cases are reported as UNDETERMINED, never as drift.
//
// ── A third limitation, observed in practice ────────────────────────────────
// Check 3 reconstructs "what was packed" from the batch's own bag counters and from the
// unit lots still pointing at it. On a database the regression suites have run against,
// those suites delete their finished-goods lots during teardown but leave behind batches
// whose auto-generated numbers their prefix filter never matched. Such a batch keeps a
// drawn-down roastedAvailableKg with nothing left to account for it, and shows up here as
// a NEGATIVE difference. A negative difference therefore means "packing evidence is
// missing", not "the balance is too high" — the direction matters when reading this
// report, and only POSITIVE differences are candidates for the B-1 drift this was
// written to find.
import { db, all, one, num } from "./harness.mjs";

const KG_SEEDED_AT = "2026-08-28T12:01:00Z"; // migration 20260828120100_add_finished_products_and_bom
const TOL = 0.002;

const fmt = (n) => Number(n).toFixed(3);

async function main() {
  await db.connect();

  const dbName = (await one("SELECT current_database() d")).d;
  console.log("=".repeat(78));
  console.log(`  HISTORICAL DRIFT DETECTOR — READ ONLY   (database: ${dbName})`);
  console.log("=".repeat(78));
  console.log("  No row is modified by this script. Findings are candidates for review,");
  console.log("  not instructions to repair.\n");

  // ── 1. Kilogram lots: shelf balance vs the finished-goods ledger ──────────
  // A kilogram lot's availableQty should equal the net of every FINISHED_GOODS movement
  // written against it: packing adds, delivery subtracts. A-1 assigned the cumulative
  // packed weight instead of adding a delta, so a lot that had shipped and was then
  // packed again ends up ABOVE its ledger.
  console.log("─".repeat(78));
  console.log(" 1. Kilogram lots whose shelf balance disagrees with their ledger");
  console.log("─".repeat(78));
  const lotRows = await all(`
    SELECT f.id, f."batchNumber" batch, f."availableQty" avail, f."reservedQty" reserved,
           f."createdAt" created,
           COALESCE((SELECT SUM(m."quantityChanged") FROM "InventoryMovement" m
                      WHERE m."referenceEntityId" = f.id AND m.category = 'FINISHED_GOODS'),0)::float8 ledger,
           (SELECT COUNT(*) FROM "InventoryMovement" m
             WHERE m."referenceEntityId" = f.id AND m.category = 'FINISHED_GOODS')::int moves
      FROM "FinishedGoodsLot" f
     WHERE f."isUnitTracked" = false
     ORDER BY f."createdAt"`);

  const lotDrift = [];
  let lotUndetermined = 0;
  for (const r of lotRows) {
    // A lot with no ledger rows at all predates the movement conventions (or was written
    // by a fixture). There is nothing to compare it against.
    if (num(r.moves) === 0) { lotUndetermined++; continue; }
    const diff = num(r.avail) - num(r.ledger);
    if (Math.abs(diff) > TOL) lotDrift.push({ ...r, diff });
  }
  console.log(`  kilogram lots examined      : ${lotRows.length}`);
  console.log(`  no ledger to compare against: ${lotUndetermined}  (UNDETERMINED)`);
  console.log(`  disagreeing with the ledger : ${lotDrift.length}`);
  for (const r of lotDrift.slice(0, 20)) {
    console.log(`    ${r.id}  batch ${r.batch}  shelf ${fmt(r.avail)}  ledger ${fmt(r.ledger)}  diff ${fmt(r.diff)}`);
  }
  if (lotDrift.length > 20) console.log(`    ... and ${lotDrift.length - 20} more`);

  // ── 2. Lots whose reservations exceed what is on the shelf ────────────────
  console.log("");
  console.log("─".repeat(78));
  console.log(" 2. Lots promising more than they hold");
  console.log("─".repeat(78));
  const overRes = await all(`
    SELECT id, "batchNumber" batch, "availableQty" avail, "reservedQty" reserved
      FROM "FinishedGoodsLot"
     WHERE "isUnitTracked" = false AND ("reservedQty" > "availableQty" + ${TOL} OR "availableQty" < -${TOL})`);
  console.log(`  over-reserved or negative kilogram lots: ${overRes.length}`);
  for (const r of overRes.slice(0, 20)) {
    console.log(`    ${r.id}  batch ${r.batch}  shelf ${fmt(r.avail)}  reserved ${fmt(r.reserved)}`);
  }

  const overUnits = await all(`
    SELECT id, "batchNumber" batch, "unitsAvailable" a, "unitsReserved" r, "unitsProduced" p
      FROM "FinishedGoodsLot"
     WHERE "isUnitTracked" = true AND ("unitsReserved" > "unitsAvailable" OR "unitsAvailable" > "unitsProduced" OR "unitsReserved" < 0)`);
  console.log(`  unit lots with impossible balances     : ${overUnits.length}`);
  for (const r of overUnits.slice(0, 20)) {
    console.log(`    ${r.id}  batch ${r.batch}  produced ${r.p} available ${r.a} reserved ${r.r}`);
  }

  // ── 3. Roasted balance vs what was packed out of the batch ────────────────
  // Expected = roasted output − kilograms packed as bags − kilograms packed as units.
  // B-1 meant the kilogram half was never subtracted, so a KG-packed batch still shows
  // its whole roast as unpacked.
  console.log("");
  console.log("─".repeat(78));
  console.log(" 3. Roasting batches whose unpacked balance disagrees with their packing");
  console.log("─".repeat(78));
  const batchRows = await all(`
    SELECT rb.id, rb."batchNumber" batch, rb.status, rb."isBlend",
           rb."createdAt" created,
           rb."roastedBeanQuantity" roasted, rb."roastedAvailableKg" avail,
           (rb."bags3kg"*3 + rb."bags1kg"*1 + rb."bags250g"*0.25 + rb."bags150g"*0.15
              + rb."samplesGrams"/1000.0)::float8 bagkg,
           COALESCE((SELECT SUM(f."unitsProduced" * s."weightGrams" / 1000.0)
                       FROM "FinishedGoodsLot" f JOIN "ProductSKU" s ON s.id = f."productSkuId"
                      WHERE f."packedFromBatchId" = rb.id),0)::float8 unitkg
      FROM "RoastingBatch" rb
     ORDER BY rb."createdAt"`);

  const batchDrift = [];
  const undetermined = [];
  for (const r of batchRows) {
    const blendSource = r.status === "Blended";
    const preSeed = new Date(r.created) < new Date(KG_SEEDED_AT);
    if (blendSource || preSeed) {
      undetermined.push({ ...r, why: blendSource ? "consumed into a blend (no ledger for it)" : "predates the roastedAvailableKg seed" });
      continue;
    }
    const expected = num(r.roasted) - num(r.bagkg) - num(r.unitkg);
    const diff = num(r.avail) - expected;
    if (Math.abs(diff) > TOL) batchDrift.push({ ...r, expected, diff });
  }
  console.log(`  batches examined  : ${batchRows.length}`);
  console.log(`  UNDETERMINED      : ${undetermined.length}  (blend sources, and rows older than the seed)`);
  console.log(`  disagreeing       : ${batchDrift.length}`);
  for (const r of batchDrift.slice(0, 25)) {
    console.log(`    ${r.batch.padEnd(16)} status ${String(r.status).padEnd(19)} roasted ${fmt(r.roasted)}  bags ${fmt(r.bagkg)}  units ${fmt(r.unitkg)}  unpacked ${fmt(r.avail)}  expected ${fmt(r.expected)}  diff ${fmt(r.diff)}`);
  }
  if (batchDrift.length > 25) console.log(`    ... and ${batchDrift.length - 25} more`);

  console.log("");
  console.log("=".repeat(78));
  console.log(`  SUMMARY  lots-vs-ledger ${lotDrift.length} | over-reserved ${overRes.length + overUnits.length} | batches ${batchDrift.length} | undetermined ${lotUndetermined + undetermined.length}`);
  console.log("  Nothing was modified. Any repair is a separate, explicitly approved step.");
  console.log("=".repeat(78));

  await db.end();
}

main().catch(async (e) => { console.log("FATAL:", e?.stack || e); try { await db.end(); } catch {} process.exit(1); });
