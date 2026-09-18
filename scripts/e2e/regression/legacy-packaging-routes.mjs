// LEGACY PACKAGING WRITE PATHS — P0 GATE.
//
// Unified Packaging V2 is only an invariant if it is the ONLY way inventory can be written
// by packaging. Two older endpoints existed alongside it:
//
//   PUT  ../package    the kilogram path — bag counters, one kg-tracked lot per roast
//   POST ../pack-sku   whole units of one SKU
//
// Removing them from the screen proves nothing: both were reachable by any authenticated
// caller holding packaging rights, and both carried their own complete implementation of
// the coffee draw, the material draw and the finished-goods write. An alternate inventory
// write path is not a compatibility detail, it is a second source of truth.
//
// Their dispositions differ, and the difference is the point:
//
//   ../pack-sku  DELEGATES. "N whole units of this SKU" is exactly N packages filled to
//                that SKU's nominal weight, so the translation is lossless and every V2
//                rule applies to it. Callers speaking the old shape keep working.
//
//   ../package   IS REFUSED (410). Its inputs are bag SIZES, not SKUs, and its output is a
//                kg-tracked lot. There is no honest mapping — 8.45 kg is not a whole number
//                of 1 KG bags — so adapting it would have meant inventing unit stock.
//
// Every case below attacks the old endpoints as an authenticated operator and asserts that
// nothing reaches inventory except through V2.
import {
  ADMIN_PIN, db, api, check, section, sub, one, all, num, invariants, loginAs,
  results, freshIdempotencyKey, ensureUser,
} from "./harness.mjs";
import { buildCatalog, teardown, roastAndPass } from "./catalog.mjs";

const S = (v) => { try { return JSON.stringify(v) ?? String(v); } catch { return String(v); } };
const P = "LPR";
let C;

const PACKER_PIN = "781051";
const NOPERM_PIN = "781052";

const packSku = (batchId, body, opts = {}) =>
  api(`/api/roasting-batches/${batchId}/pack-sku`, {
    method: "POST",
    body,
    headers: opts.key === null ? {} : { "Idempotency-Key": opts.key ?? freshIdempotencyKey(P) },
  });

const packageKg = (batchId, body) =>
  api(`/api/roasting-batches/${batchId}/package`, { method: "PUT", body });

async function roast(label, coffee, bean, greenKg, roastedKg) {
  const b = await roastAndPass(P, coffee, bean, greenKg, roastedKg, greenKg - roastedKg, label);
  if (!b.id) throw new Error(`fixture roast failed: ${S(b.error?.json ?? b)}`);
  await db.query('UPDATE "RoastingBatch" SET "batchNumber"=$2 WHERE id=$1', [b.id, `${P}-${label}`]);
  return b.id;
}

const availableGrams = async (batchId) =>
  Math.round(num((await one('SELECT "roastedAvailableKg" q FROM "RoastingBatch" WHERE id=$1', [batchId])).q) * 1000);

const lotsFor = (batchId) => all(
  `SELECT id, status::text status, "isUnitTracked" ut, "unitsAvailable" ua, "unitsProduced" up,
          "actualContentGrams" actual, "nominalContentGrams" nominal, "materialsConsumed" mc,
          "availableQty" aq
     FROM "FinishedGoodsLot"
    WHERE "packedFromBatchId"=$1 OR "roastingBatchId"=$1
    ORDER BY "createdAt"`, [batchId]);

const materialOnHand = async (id) =>
  num((await one('SELECT "quantityOnHand" q FROM "MaterialItem" WHERE id=$1', [id])).q);

const legacyKgLotCount = async () =>
  num((await one(`SELECT COUNT(*)::int n FROM "FinishedGoodsLot" WHERE "isUnitTracked"=false`)).n);

async function main() {
  await db.connect();
  await loginAs(ADMIN_PIN);
  C = await buildCatalog(P);

  await ensureUser(`${P}_emp_packer`, `${P} Packer`, "custom", {
    dashboard: { access: "edit" },
    packaging: { access: "edit" },
  }, PACKER_PIN);
  await ensureUser(`${P}_emp_noperm`, `${P} NoPerm`, "custom", {
    dashboard: { access: "edit" },
  }, NOPERM_PIN);

  const KG1 = C.skus.bra1kg;   // nominal 1000 g, Brazil
  const ETH = C.skus.eth1kg;   // nominal 1000 g, Ethiopia — a different coffee

  // ═══════════════════════════════════════════════════════════════════════
  section("A — THE KILOGRAM PATH CANNOT WRITE INVENTORY AT ALL");

  sub("A1. an authenticated packaging operator is refused");
  const bA = await roast("A", C.coffees.brazil, C.beans.brazil, 5.0, 4.0);
  const legacyBefore = await legacyKgLotCount();
  await loginAs(PACKER_PIN);
  const rA = await packageKg(bA, { bags3kg: 1, bags1kg: 1, bags250g: 0, bags150g: 0, samplesGrams: 0 });
  check("refused with 410 Gone", rA.status === 410, `${rA.status} ${S(rA.json).slice(0, 180)}`);
  check("and it names the operation that replaced it", /\/pack\b/.test(S(rA.json)), S(rA.json).slice(0, 200));
  await loginAs(ADMIN_PIN);

  sub("A2. no legacy bulk stock was created");
  check("no lot of any kind was written for the batch", (await lotsFor(bA)).length === 0,
    S(await lotsFor(bA)).slice(0, 200));
  check("the system-wide count of kg-tracked lots is unchanged",
    (await legacyKgLotCount()) === legacyBefore, `${await legacyKgLotCount()} vs ${legacyBefore}`);

  sub("A3. no coffee was consumed and no bag counter moved");
  check("the roast still holds all 4000 g", (await availableGrams(bA)) === 4000, `${await availableGrams(bA)}`);
  const counters = await one(
    `SELECT "bags3kg" a, "bags1kg" b, "bags250g" c, "bags150g" d, "samplesGrams" e
       FROM "RoastingBatch" WHERE id=$1`, [bA]);
  check("every bag counter is still zero",
    num(counters.a) === 0 && num(counters.b) === 0 && num(counters.c) === 0 &&
    num(counters.d) === 0 && num(counters.e) === 0, S(counters));

  sub("A4. authorization is still decided before the refusal");
  await loginAs(NOPERM_PIN);
  const rA4 = await packageKg(bA, { bags1kg: 1 });
  check("a caller without packaging rights is refused for that reason, not told the route is gone",
    rA4.status === 401 || rA4.status === 403, `${rA4.status} ${S(rA4.json).slice(0, 140)}`);
  await loginAs(ADMIN_PIN);

  // ═══════════════════════════════════════════════════════════════════════
  section("B — THE UNIT PATH DELEGATES TO UNIFIED PACKAGING V2");

  sub("B1. packing through the old shape still works");
  const bB = await roast("B", C.coffees.brazil, C.beans.brazil, 5.0, 4.0);
  const rB = await packSku(bB, { productSkuId: KG1.id, units: 2 });
  check("accepted", rB.status === 201, `${rB.status} ${S(rB.json).slice(0, 180)}`);
  check("reporting the old response shape", rB.json?.unitsPacked === 2 && !!rB.json?.lotId, S(rB.json).slice(0, 200));
  check("and saying it went through V2", rB.json?.packagedVia === "unified-packaging-v2", S(rB.json?.packagedVia));

  sub("B2. the lot it produced carries the V2 shape, not the legacy one");
  const lotsB = await lotsFor(bB);
  check("exactly one lot", lotsB.length === 1, S(lotsB).slice(0, 220));
  const lotB = lotsB[0];
  check("unit-tracked and AVAILABLE", lotB?.ut === true && lotB?.status === "AVAILABLE", S(lotB));
  check("two sellable units", num(lotB?.ua) === 2 && num(lotB?.up) === 2, S(lotB));
  check("with its real contents recorded, at nominal", num(lotB?.actual) === 1000, S(lotB?.actual));
  check("and the nominal it was judged against", num(lotB?.nominal) === 1000, S(lotB?.nominal));
  check("and its materials marked drawn", lotB?.mc === true, S(lotB?.mc));

  sub("B3. lineage exists, which the legacy implementation never wrote");
  const srcB = await one(
    `SELECT COUNT(*)::int n, COALESCE(SUM("gramsContributed"),0)::int g
       FROM "PackagingSource" WHERE "roastingBatchId"=$1`, [bB]);
  check("a source row traces the coffee to this roast", num(srcB?.n) === 1, S(srcB));
  check("for exactly the 2000 g it drew", num(srcB?.g) === 2000, S(srcB?.g));

  sub("B4. the operation is recorded as a V2 operation");
  const opB = await one(
    `SELECT method::text m, "quantityUnits" q FROM "PackagingOperation"
      WHERE "batchId"=$1 ORDER BY "createdAt" DESC LIMIT 1`, [bB]);
  check("method PACK, not UNIT", opB?.m === "PACK", S(opB));
  check("for two units", num(opB?.q) === 2, S(opB));

  sub("B5. the gram ledger reconciles exactly");
  check("2000 g left the roast", (await availableGrams(bB)) === 2000, `${await availableGrams(bB)}`);
  const mvB = await all(
    `SELECT type::text t, category::text c FROM "InventoryMovement" WHERE "sourceDocId"=$1`, [bB]);
  check("roasted coffee out is recorded", mvB.some((r) => r.c === "ROASTED_COFFEE" && r.t === "OUT"), S(mvB).slice(0, 180));
  check("finished goods in is recorded", mvB.some((r) => r.c === "FINISHED_GOODS" && r.t === "IN"), S(mvB).slice(0, 180));
  check("materials out is recorded", mvB.some((r) => r.c === "PACKAGING_MATERIAL" && r.t === "OUT"), S(mvB).slice(0, 180));

  // ═══════════════════════════════════════════════════════════════════════
  section("C — THE OLD SHAPE CANNOT BYPASS A SINGLE V2 RULE");

  sub("C1. it cannot fabricate sellable goods from an under-weight bill of materials");
  // The fabrication vector the legacy implementation actually had: it drew coffee from the
  // BOM's per-unit figure rather than from what goes in a package. A BOM claiming 0.4 kg
  // for a 1 KG SKU produced fully sellable kilograms while drawing 400 g — 600 g of
  // finished goods per unit that never existed. V2 draws the weight the package holds.
  const thinSku = await api("/api/products", {
    method: "POST",
    body: { productId: C.coffees.brazil.id, skuCode: `${P}-THIN-1KG`, name: `${P} Thin 1 KG`, weightGrams: 1000, price: 99 },
  });
  check("a SKU for the test is created", thinSku.status === 201, `${thinSku.status} ${S(thinSku.json).slice(0, 140)}`);
  const thinId = thinSku.json.id;
  const bomR = await api(`/api/products/${thinId}/bom`, {
    method: "PUT",
    body: { components: [
      { type: "ROASTED_COFFEE", coffeeProductId: C.coffees.brazil.id, quantityPerUnit: 0.4 },
      { type: "MATERIAL", materialItemId: C.materials.bag1kg.id, quantityPerUnit: 1 },
    ] },
  });
  check("with a bill of materials claiming only 0.4 kg per 1 KG unit", bomR.status === 200, `${bomR.status}`);

  const bC = await roast("C", C.coffees.brazil, C.beans.brazil, 4.0, 3.0);
  const rC = await packSku(bC, { productSkuId: thinId, units: 2 });
  check("the pack is accepted", rC.status === 201, `${rC.status} ${S(rC.json).slice(0, 180)}`);
  check("but it drew the full 2000 g the packages hold, not the BOM's 800 g",
    (await availableGrams(bC)) === 1000, `${await availableGrams(bC)}`);
  check("and the response says so", rC.json?.roastedCoffeeConsumedKg === 2, S(rC.json?.roastedCoffeeConsumedKg));
  const lotC = (await lotsFor(bC))[0];
  check("the lot holds a real kilogram per unit", num(lotC?.actual) === 1000, S(lotC?.actual));

  sub("C2. it cannot reach into a partial package");
  const bC2 = await roast("C2", C.coffees.brazil, C.beans.brazil, 4.0, 3.2);
  const partial = await api(`/api/roasting-batches/${bC2}/pack`, {
    method: "POST",
    body: { lines: [{ kind: "pack", productSkuId: KG1.id, packages: 1, gramsEach: 300 }] },
    headers: { "Idempotency-Key": freshIdempotencyKey(P) },
  });
  check("a partial package exists", partial.status === 201, `${partial.status} ${S(partial.json).slice(0, 160)}`);
  const partialId = partial.json?.lots?.[0]?.id;
  const rC2 = await packSku(bC2, { productSkuId: KG1.id, units: 1 });
  check("the old shape packs into a lot of its own", rC2.status === 201, `${rC2.status} ${S(rC2.json).slice(0, 160)}`);
  const stillPartial = (await lotsFor(bC2)).find((l) => l.id === partialId);
  check("the partial package is untouched", stillPartial?.status === "PARTIAL", S(stillPartial));
  check("still holding 300 g and offering nothing sellable",
    num(stillPartial?.actual) === 300 && num(stillPartial?.ua) === 0, S(stillPartial));

  sub("C3. it cannot pack a coffee the roast is not");
  const bC3 = await roast("C3", C.coffees.brazil, C.beans.brazil, 4.0, 3.0);
  const rC3 = await packSku(bC3, { productSkuId: ETH.id, units: 1 });
  check("refused", rC3.status === 409, `${rC3.status} ${S(rC3.json).slice(0, 180)}`);
  check("because the coffee does not match", /not made from the coffee/i.test(S(rC3.json)), S(rC3.json).slice(0, 200));
  check("and nothing was drawn", (await availableGrams(bC3)) === 3000, `${await availableGrams(bC3)}`);

  sub("C4. it cannot bypass a material shortage");
  const bC4 = await roast("C4", C.coffees.brazil, C.beans.brazil, 4.0, 3.0);
  const had = await materialOnHand(C.materials.bag1kg.id);
  await db.query('UPDATE "MaterialItem" SET "quantityOnHand"=0 WHERE id=$1', [C.materials.bag1kg.id]);
  const rC4 = await packSku(bC4, { productSkuId: KG1.id, units: 1 });
  check("refused", rC4.status === 409, `${rC4.status} ${S(rC4.json).slice(0, 180)}`);
  check("nothing was drawn from the roast", (await availableGrams(bC4)) === 3000, `${await availableGrams(bC4)}`);
  check("and no lot was created", (await lotsFor(bC4)).length === 0, S((await lotsFor(bC4)).length));
  await db.query('UPDATE "MaterialItem" SET "quantityOnHand"=$2 WHERE id=$1', [C.materials.bag1kg.id, had]);

  sub("C5. it cannot bypass idempotency");
  const bC5 = await roast("C5", C.coffees.brazil, C.beans.brazil, 5.0, 4.0);
  const keyC5 = freshIdempotencyKey(P);
  const first = await packSku(bC5, { productSkuId: KG1.id, units: 1 }, { key: keyC5 });
  check("the first pack is accepted", first.status === 201, `${first.status}`);
  const replay = await packSku(bC5, { productSkuId: KG1.id, units: 1 }, { key: keyC5 });
  check("a retry replays rather than packing again", replay.status === 201, `${replay.status}`);
  check("drawing the coffee only once", (await availableGrams(bC5)) === 3000, `${await availableGrams(bC5)}`);
  const conflict = await packSku(bC5, { productSkuId: KG1.id, units: 2 }, { key: keyC5 });
  check("the same key for a different pack is a conflict", conflict.status === 422,
    `${conflict.status} ${S(conflict.json).slice(0, 160)}`);
  check("and still nothing more was drawn", (await availableGrams(bC5)) === 3000, `${await availableGrams(bC5)}`);

  sub("C6. it cannot bypass authorization");
  const bC6 = await roast("C6", C.coffees.brazil, C.beans.brazil, 4.0, 3.0);
  await loginAs(NOPERM_PIN);
  const rC6 = await packSku(bC6, { productSkuId: KG1.id, units: 1 });
  check("refused without packaging rights", rC6.status === 401 || rC6.status === 403,
    `${rC6.status} ${S(rC6.json).slice(0, 140)}`);
  check("and nothing was drawn", (await availableGrams(bC6)) === 3000, `${await availableGrams(bC6)}`);
  await loginAs(PACKER_PIN);
  const rC6b = await packSku(bC6, { productSkuId: KG1.id, units: 1 });
  check("but the packaging role may still use it", rC6b.status === 201, `${rC6b.status} ${S(rC6b.json).slice(0, 160)}`);
  await loginAs(ADMIN_PIN);

  sub("C7. it cannot consume stock outside the V2 reconciliation");
  // Every gram the old shape moved is accounted for by V2's own columns and lineage: what
  // the roast lost equals what the packages hold equals what PackagingSource records.
  const bC7 = await roast("C7", C.coffees.brazil, C.beans.brazil, 5.0, 4.0);
  await packSku(bC7, { productSkuId: KG1.id, units: 3 });
  const drawnC7 = 4000 - (await availableGrams(bC7));
  const heldC7 = (await lotsFor(bC7)).reduce((s, l) => s + num(l.actual) * num(l.up), 0);
  const tracedC7 = num((await one(
    `SELECT COALESCE(SUM("gramsContributed"),0)::int g FROM "PackagingSource" WHERE "roastingBatchId"=$1`, [bC7])).g);
  check("the roast lost 3000 g", drawnC7 === 3000, `${drawnC7}`);
  check("the packages hold exactly that", heldC7 === 3000, `${heldC7}`);
  check("and the lineage traces exactly that", tracedC7 === 3000, `${tracedC7}`);

  await invariants("after the legacy packaging routes suite");
  await teardown(P);

  section("LEGACY PACKAGING ROUTES RESULT");
  console.log(`${results.pass} passed, ${results.fail} failed`);
  if (results.failures.length) console.log("FAILURES:\n  - " + results.failures.join("\n  - "));
  await db.end();
  process.exit(results.fail === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.log("FATAL:", e?.stack || e);
  try { await db.end(); } catch {}
  process.exit(1);
});
