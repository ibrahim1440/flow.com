// PACKAGING OPERATION IDEMPOTENCY — R2.2B.
//
// Packaging is not naturally idempotent and never can be: partial packing is a legitimate,
// repeatable act, so "the same request twice" is indistinguishable from "two genuine
// partial packs" unless the client says which it meant. That is what the request key is
// for — it names the OPERATION, not the payload.
//
// The existing suites look like they already cover this and do not. hardening B3 replays a
// pack that consumed the whole roast, so the replay is refused because the coffee is spent,
// not because it was recognised as a replay. Replay a PARTIAL pack and it simply executes
// again: more bags, more finished stock, another ledger row, the roasted balance drawn down
// twice. Every case below is a partial pack for exactly that reason.
//
// Written against the request-key contract before the server implements it, so the failures
// it records are the defect rather than a description of it.
import {
  ADMIN_PIN, BASE, db, api, check, section, sub, one, all, num, near, invariants, loginAs, results,
  getCookie, materialStock,
} from "./harness.mjs";
import { buildCatalog, teardown, roastAndPass } from "./catalog.mjs";

const S = (v) => { try { return JSON.stringify(v) ?? String(v); } catch { return String(v); } };
const P = "PKI";
let C;

/**
 * A request carrying an Idempotency-Key.
 *
 * Deliberately not routed through harness.api(): that helper is shared by every certified
 * suite and has no header parameter, and widening it to serve one suite would put a change
 * into the middle of the R1 floor for no benefit. The session cookie is borrowed from the
 * harness so the two stay logged in as the same user.
 */
async function keyed(path, { method = "POST", body, key } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      "content-type": "application/json",
      ...(getCookie() ? { cookie: getCookie() } : {}),
      ...(key === undefined ? {} : { "Idempotency-Key": key }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "manual",
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, json, replay: res.headers.get("x-idempotent-replay") };
}

/**
 * Pack N one-kilogram packages under a named key.
 *
 * Written against the kilogram route when this suite was first certified. That route is
 * retired — it was a second implementation of inventory mutation — but the idempotency
 * contract it was proving is not kilogram-specific: it is the same guardIdempotency, the
 * same batch-row lock and the same PackagingOperation row that V2 uses. So the cases are
 * driven through V2 rather than deleted, and `bags1kg: N` becomes N packages of the 1 KG
 * SKU at nominal weight.
 *
 * Bodies are still passed in the old shape so the key-identity cases keep their point:
 * two objects written with their properties in a different order must still hash alike.
 */
const packKg = (batchId, body, key) =>
  keyed(`/api/roasting-batches/${batchId}/pack`, {
    method: "POST",
    body: { lines: [{ kind: "pack", productSkuId: C.skus.bra1kg.id, packages: body.bags1kg }] },
    key,
  });

/** Accepted, whichever success code the route answers with. */
const packed = (r) => r.status === 200 || r.status === 201;
const packSku = (batchId, body, key) =>
  keyed(`/api/roasting-batches/${batchId}/pack-sku`, { method: "POST", body, key });

/**
 * A QC-passed stock roast of this suite's Brazil coffee, with its green lot topped up
 * first.
 *
 * Every case here needs a roast of its own, and the catalog opens with 120 kg — ten
 * batches, which this suite passed somewhere in section E. Running out of green coffee
 * would fail a packaging assertion for a reason that has nothing to do with packaging, so
 * the fixture keeps its own input stocked. It also refuses to return a half-built batch:
 * roastAndPass answers with an error object rather than throwing, and letting that through
 * turns a fixture problem into a puzzling 404 from the route under test.
 */
const stockBatch = async (label, greenKg, roastedKg, wasteKg) => {
  await db.query('UPDATE "GreenBean" SET "quantityKg" = "quantityKg" + $2 WHERE id = $1',
    [C.beans.brazil.id, greenKg]);
  const b = await roastAndPass(P, C.coffees.brazil, C.beans.brazil, greenKg, roastedKg, wasteKg, label);
  if (!b.id) throw new Error(`fixture roast ${label} failed: ${S(b.error?.json ?? b)}`);
  return b;
};

/**
 * `b1` used to be the kilogram path's bag counter. V2 does not write it, so it is derived
 * from what the roast actually gave up — which is what every assertion on it meant: how
 * many kilograms this batch has been packed out into.
 */
const batchRow = async (id) => {
  const r = await one(
    `SELECT "roastedAvailableKg" rak, "roastedBeanQuantity" rbq, status FROM "RoastingBatch" WHERE id=$1`, [id]);
  return { ...r, b1: Math.round((num(r.rbq) - num(r.rak)) * 1000) / 1000 };
};
/**
 * What the roast put on the shelf, in kilograms.
 *
 * Summed across lots: V2 writes one per packaging line rather than keeping a single row per
 * roast and moving its balance. The figure is the kg-equivalent of the units produced, so
 * the assertions below still read in kilograms and still mean "what this pack produced".
 */
const kgLot = async (batchId) => {
  const r = await one(
    `SELECT COALESCE(SUM("unitsProduced" * COALESCE("nominalContentGrams", 0)) / 1000.0, 0)::float8 a,
            COUNT(*)::int n
       FROM "FinishedGoodsLot" WHERE "packedFromBatchId"=$1 AND status <> 'PARTIAL'`, [batchId]);
  if (!r || num(r.n) === 0) return undefined;
  const newest = await one(
    `SELECT id FROM "FinishedGoodsLot" WHERE "packedFromBatchId"=$1 AND status <> 'PARTIAL'
      ORDER BY "createdAt" DESC LIMIT 1`, [batchId]);
  return { id: newest?.id, a: r.a };
};
const unitLot = async (batchId) => await one(
  `SELECT id, "unitsProduced" p, "unitsAvailable" a FROM "FinishedGoodsLot" WHERE "packedFromBatchId"=$1`, [batchId]);
const finishedMoves = async (batchId) => num((await one(
  `SELECT COUNT(*)::int n FROM "InventoryMovement"
     WHERE "sourceDocId"=$1 AND category='FINISHED_GOODS'`, [batchId])).n);

/** Every packaging operation recorded against a batch, oldest first. */
const operations = async (batchId) => await all(
  `SELECT "requestKey" k, "requestHash" h, method, "quantityKg" qkg, "quantityUnits" qu,
          "productSkuId" sku, "finishedGoodsLotId" lot, "responseStatus" rs, "userId" uid
     FROM "PackagingOperation" WHERE "batchId"=$1 ORDER BY "createdAt"`, [batchId]);

let keySeq = 0;
const newKey = (tag) => `${P}-${tag}-${++keySeq}`;

async function main() {
  await db.connect();
  await teardown(P);
  await loginAs(ADMIN_PIN);
  C = await buildCatalog(P);

  // ═══════════════════════════════════════════════════════════════════════
  section("A — KILOGRAM PACKING, SAME KEY, REPLAYED IN SEQUENCE");

  sub("A1. a partial pack replayed with the same key must not pack twice");
  const bA = await stockBatch("A01", 12, 10, 2);
  const keyA = newKey("kg-seq");
  const bodyA = { bags1kg: 3 };

  const a1 = await packKg(bA.id, bodyA, keyA);
  const afterFirst = await batchRow(bA.id);
  const lotFirst = await kgLot(bA.id);
  const movesFirst = await finishedMoves(bA.id);
  check("the first pack is accepted", packed(a1), `status=${a1.status} ${S(a1.json).slice(0, 100)}`);
  check("it is not marked as a replay", a1.replay !== "true", `x-idempotent-replay=${a1.replay}`);

  const a2 = await packKg(bA.id, bodyA, keyA);
  const afterReplay = await batchRow(bA.id);
  const lotReplay = await kgLot(bA.id);
  const movesReplay = await finishedMoves(bA.id);
  console.log(`    first: bags ${afterFirst.b1}, shelf ${lotFirst?.a}, roasted ${afterFirst.rak}, movements ${movesFirst}`);
  console.log(`    replay(${a2.status}): bags ${afterReplay.b1}, shelf ${lotReplay?.a}, roasted ${afterReplay.rak}, movements ${movesReplay}`);

  check("the replay is answered without packing again",
    packed(a2) && a2.replay === "true",
    `status=${a2.status} replay=${a2.replay} ${S(a2.json).slice(0, 90)}`);
  check("bag counters did not move on replay", num(afterReplay.b1) === num(afterFirst.b1),
    `${afterFirst.b1} -> ${afterReplay.b1}`);
  check("the shelf did not grow on replay", near(num(lotReplay?.a), num(lotFirst?.a)),
    `${lotFirst?.a} -> ${lotReplay?.a}`);
  check("roasted coffee was consumed once, not twice", near(num(afterReplay.rak), 7),
    `roastedAvailableKg ${afterReplay.rak} (10 - 3 = 7)`);
  check("no second ledger row", movesReplay === movesFirst, `${movesFirst} -> ${movesReplay}`);

  // ═══════════════════════════════════════════════════════════════════════
  section("B — UNIT PACKING, SAME KEY, REPLAYED IN SEQUENCE");

  sub("B1. a partial unit pack replayed with the same key must not pack twice");
  const bB = await stockBatch("B01", 12, 10, 2);
  const keyB = newKey("sku-seq");
  const bodyB = { productSkuId: C.skus.bra1kg.id, units: 3 };
  const bagsBefore = await materialStock(C.materials.bag1kg.id);

  const b1 = await packSku(bB.id, bodyB, keyB);
  const bFirst = await batchRow(bB.id);
  const lotB1 = await unitLot(bB.id);
  const movesB1 = await finishedMoves(bB.id);
  check("the first unit pack is accepted", b1.status === 201, `status=${b1.status} ${S(b1.json).slice(0, 100)}`);

  const b2 = await packSku(bB.id, bodyB, keyB);
  const bReplay = await batchRow(bB.id);
  const lotB2 = await unitLot(bB.id);
  const movesB2 = await finishedMoves(bB.id);
  const bagsAfter = await materialStock(C.materials.bag1kg.id);
  console.log(`    first: units ${lotB1?.p}, roasted ${bFirst.rak}, movements ${movesB1}`);
  console.log(`    replay(${b2.status}): units ${lotB2?.p}, roasted ${bReplay.rak}, movements ${movesB2}, bags ${bagsBefore} -> ${bagsAfter}`);

  check("the replay is answered without packing again",
    b2.status === 201 && b2.replay === "true",
    `status=${b2.status} replay=${b2.replay} ${S(b2.json).slice(0, 90)}`);
  check("units produced did not grow on replay", num(lotB2?.p) === num(lotB1?.p),
    `${lotB1?.p} -> ${lotB2?.p}`);
  check("roasted coffee was consumed once", near(num(bReplay.rak), 7), `roastedAvailableKg ${bReplay.rak}`);
  check("packaging materials were consumed once", near(bagsBefore - bagsAfter, 3),
    `consumed ${bagsBefore - bagsAfter}, expected 3`);
  check("no second ledger row", movesB2 === movesB1, `${movesB1} -> ${movesB2}`);

  // ═══════════════════════════════════════════════════════════════════════
  section("C — CONCURRENT RETRIES OF ONE SUBMIT");

  sub("C1. two identical kilogram requests with one key execute once");
  const bC = await stockBatch("C01", 12, 10, 2);
  const keyC = newKey("kg-conc");
  const [c1, c2] = await Promise.all([
    packKg(bC.id, { bags1kg: 4 }, keyC),
    packKg(bC.id, { bags1kg: 4 }, keyC),
  ]);
  const cRow = await batchRow(bC.id);
  const cLot = await kgLot(bC.id);
  const cMoves = await finishedMoves(bC.id);
  console.log(`    statuses ${c1.status}/${c2.status} (replay ${c1.replay}/${c2.replay}) -> bags ${cRow.b1}, shelf ${cLot?.a}, roasted ${cRow.rak}, movements ${cMoves}`);
  check("neither request failed with a server error", c1.status !== 500 && c2.status !== 500,
    `${c1.status}/${c2.status}`);
  check("the stock moved exactly once (4 kg of 10)", near(num(cRow.rak), 6) && num(cRow.b1) === 4,
    `roastedAvailableKg ${cRow.rak}, bags1kg ${cRow.b1}`);
  check("one shelf balance, not two", near(num(cLot?.a), 4), `availableQty ${cLot?.a}`);
  check("one ledger row, not two", cMoves === 1, `${cMoves} movements`);

  sub("C2. two identical unit requests with one key execute once");
  const bD = await stockBatch("D01", 12, 10, 2);
  const keyD = newKey("sku-conc");
  const bodyD = { productSkuId: C.skus.bra1kg.id, units: 4 };
  const bagsD0 = await materialStock(C.materials.bag1kg.id);
  const [d1, d2] = await Promise.all([
    packSku(bD.id, bodyD, keyD),
    packSku(bD.id, bodyD, keyD),
  ]);
  const dRow = await batchRow(bD.id);
  const dLot = await unitLot(bD.id);
  const dMoves = await finishedMoves(bD.id);
  const bagsD1 = await materialStock(C.materials.bag1kg.id);
  console.log(`    statuses ${d1.status}/${d2.status} (replay ${d1.replay}/${d2.replay}) -> units ${dLot?.p}, roasted ${dRow.rak}, movements ${dMoves}, bags consumed ${bagsD0 - bagsD1}`);
  check("neither request failed with a server error", d1.status !== 500 && d2.status !== 500,
    `${d1.status}/${d2.status}`);
  check("units were produced exactly once", num(dLot?.p) === 4, `unitsProduced ${dLot?.p}`);
  check("roasted coffee was drawn exactly once", near(num(dRow.rak), 6), `roastedAvailableKg ${dRow.rak}`);
  check("materials were drawn exactly once", near(bagsD0 - bagsD1, 4), `consumed ${bagsD0 - bagsD1}`);
  check("one ledger row, not two", dMoves === 1, `${dMoves} movements`);

  // ═══════════════════════════════════════════════════════════════════════
  section("D — KEY IDENTITY: DIFFERENT PAYLOAD, AND GENUINE PARTIALS");

  sub("D1. the same key with a different kilogram payload is refused");
  const bE = await stockBatch("E01", 12, 10, 2);
  const keyE = newKey("kg-mismatch");
  const e1 = await packKg(bE.id, { bags1kg: 2 }, keyE);
  const eBefore = await batchRow(bE.id);
  const e2 = await packKg(bE.id, { bags1kg: 5 }, keyE);
  const eAfter = await batchRow(bE.id);
  console.log(`    first ${e1.status}, same key different payload -> ${e2.status}`);
  check("the mismatched replay is refused with 422", e2.status === 422,
    `status=${e2.status} ${S(e2.json).slice(0, 100)}`);
  check("and nothing was packaged by it", num(eAfter.b1) === num(eBefore.b1) && near(num(eAfter.rak), num(eBefore.rak)),
    `bags ${eBefore.b1}->${eAfter.b1}, roasted ${eBefore.rak}->${eAfter.rak}`);

  sub("D2. the same key with a different unit payload is refused");
  const bF = await stockBatch("F01", 12, 10, 2);
  const keyF = newKey("sku-mismatch");
  const f1 = await packSku(bF.id, { productSkuId: C.skus.bra1kg.id, units: 2 }, keyF);
  const fBefore = await batchRow(bF.id);
  const f2 = await packSku(bF.id, { productSkuId: C.skus.bra1kg.id, units: 5 }, keyF);
  const fAfter = await batchRow(bF.id);
  console.log(`    first ${f1.status}, same key different units -> ${f2.status}`);
  check("the mismatched replay is refused with 422", f2.status === 422,
    `status=${f2.status} ${S(f2.json).slice(0, 100)}`);
  check("and nothing was packaged by it", near(num(fAfter.rak), num(fBefore.rak)),
    `roasted ${fBefore.rak} -> ${fAfter.rak}`);

  sub("D3. a NEW key with an identical payload is a second, genuine partial pack");
  // This is the case a naive payload-hash cache gets wrong. Two 2 kg packs of the same
  // roast are ordinary operational reality, and the only thing separating them from a
  // retry is the key the client chose.
  const bG = await stockBatch("G01", 12, 10, 2);
  const g1 = await packKg(bG.id, { bags1kg: 2 }, newKey("kg-partial"));
  const g2 = await packKg(bG.id, { bags1kg: 2 }, newKey("kg-partial"));
  const gRow = await batchRow(bG.id);
  const gLot = await kgLot(bG.id);
  const gMoves = await finishedMoves(bG.id);
  console.log(`    ${g1.status} then ${g2.status} -> bags ${gRow.b1}, shelf ${gLot?.a}, roasted ${gRow.rak}, movements ${gMoves}`);
  check("both partial packs were accepted", packed(g1) && packed(g2),
    `${g1.status}/${g2.status}`);
  check("neither was treated as a replay", g1.replay !== "true" && g2.replay !== "true",
    `${g1.replay}/${g2.replay}`);
  check("the shelf holds both packs (2 + 2)", near(num(gLot?.a), 4), `availableQty ${gLot?.a}`);
  check("roasted coffee was drawn twice, once per operation", near(num(gRow.rak), 6),
    `roastedAvailableKg ${gRow.rak}`);
  check("two ledger rows, one per operation", gMoves === 2, `${gMoves} movements`);

  // ═══════════════════════════════════════════════════════════════════════
  section("E — THE REQUEST-KEY CONTRACT");

  sub("E1. a key outside the accepted charset is refused before anything is packed");
  // CR and LF — the characters that would actually break a log line — cannot be tested
  // through here at all: the HTTP client refuses to put them in a header value, so the
  // transport is the first line of defence. The charset guard is the second, and it is
  // what stops everything that does get through: spaces, quotes, angle brackets, and any
  // other punctuation that has no business in an identifier.
  const bH = await stockBatch("H01", 12, 10, 2);
  const h1 = await packKg(bH.id, { bags1kg: 2 }, `${P} bad "key" <x>`);
  const hRow = await batchRow(bH.id);
  check("a malformed key is a 400", h1.status === 400, `status=${h1.status} ${S(h1.json).slice(0, 90)}`);
  check("and the pack did not happen", num(hRow.b1) === 0 && near(num(hRow.rak), 10),
    `bags1kg ${hRow.b1}, roastedAvailableKg ${hRow.rak}`);
  check("no operation row was written for a refused key", (await operations(bH.id)).length === 0,
    `${(await operations(bH.id)).length} rows`);

  sub("E2. an unbounded key is refused");
  const h2 = await packKg(bH.id, { bags1kg: 2 }, "x".repeat(300));
  check("an over-long key is a 400", h2.status === 400, `status=${h2.status} ${S(h2.json).slice(0, 90)}`);
  check("and still nothing was packed", num((await batchRow(bH.id)).b1) === 0,
    `bags1kg ${(await batchRow(bH.id)).b1}`);

  sub("E3. the same intent serialised in a different property order is still a replay");
  // The hash is taken over the normalised intent, never over the raw JSON text. If it were
  // taken over the body as sent, a client that reordered its own fields between attempts
  // would get a 422 on a retry of the identical operation.
  const bI = await stockBatch("I01", 12, 10, 2);
  const keyI = newKey("kg-order");
  const i1 = await packKg(bI.id, { bags1kg: 2, bags250g: 0, samplesGrams: 0 }, keyI);
  const i2 = await packKg(bI.id, { samplesGrams: 0, bags250g: 0, bags1kg: 2 }, keyI);
  const iRow = await batchRow(bI.id);
  console.log(`    ${i1.status} then reordered ${i2.status} (replay ${i2.replay}) -> bags ${iRow.b1}`);
  check("the reordered resend is recognised as a replay, not a mismatch",
    packed(i2) && i2.replay === "true", `status=${i2.status} replay=${i2.replay}`);
  check("and it packed once, not twice", num(iRow.b1) === 2 && near(num(iRow.rak), 8),
    `bags1kg ${iRow.b1}, roastedAvailableKg ${iRow.rak}`);

  sub("E4. a caller that sends no key still gets an audit row, but no retry protection");
  // TRANSITIONAL, and asserted here rather than left implicit. A keyless caller is given a
  // server-generated key so the operation is still on the record, but a retry arrives
  // without the original key and therefore cannot be recognised. This assertion exists to
  // make that gap visible, and it is the one that has to change when keys become mandatory.
  const bJ = await stockBatch("J01", 12, 10, 2);
  const j1 = await packKg(bJ.id, { bags1kg: 2 }, undefined);
  const j2 = await packKg(bJ.id, { bags1kg: 2 }, undefined);
  const jOps = await operations(bJ.id);
  const jRow = await batchRow(bJ.id);
  console.log(`    ${j1.status}/${j2.status} -> bags ${jRow.b1}, ${jOps.length} operation rows`);
  check("a keyless pack is accepted", packed(j1) && packed(j2),
    `${j1.status}/${j2.status}`);
  check("it is recorded under a server-generated key",
    jOps.length === 2 && jOps.every((o) => o.k.startsWith("srv-")),
    jOps.map((o) => o.k.slice(0, 12)).join(", "));
  check("but the second keyless request executed again — no deduplication without a key",
    num(jRow.b1) === 4, `bags1kg ${jRow.b1} (2 + 2: this is the transitional gap)`);

  // ═══════════════════════════════════════════════════════════════════════
  section("F — A FAILED OPERATION LEAVES NO TRACE, AND MAY BE RETRIED");

  sub("F1. a pack that fails mid-transaction records no operation and frees its key");
  // The operation row is written inside the same transaction as the stock it describes, so
  // a failure after the idempotency check rolls both back. If it were written first, or in
  // its own transaction, this key would be burned: the retry would replay a success that
  // never happened and the coffee would never be packed.
  const bK = await stockBatch("K01", 12, 10, 2);
  const keyK = newKey("sku-fail");
  const bodyK = { productSkuId: C.skus.bra1kg.id, units: 3 };

  const bagsHeld = await materialStock(C.materials.bag1kg.id);
  await db.query('UPDATE "MaterialItem" SET "quantityOnHand"=0 WHERE id=$1', [C.materials.bag1kg.id]);

  const k1 = await packSku(bK.id, bodyK, keyK);
  const kRowFail = await batchRow(bK.id);
  const kOpsFail = await operations(bK.id);
  console.log(`    with no bags: ${k1.status} ${S(k1.json).slice(0, 80)}`);
  check("the pack is refused for want of materials", k1.status === 409, `status=${k1.status}`);
  check("the roasted balance was rolled back with it", near(num(kRowFail.rak), 10),
    `roastedAvailableKg ${kRowFail.rak}`);
  check("and no operation row survived the rollback", kOpsFail.length === 0, `${kOpsFail.length} rows`);

  await db.query('UPDATE "MaterialItem" SET "quantityOnHand"=$2 WHERE id=$1',
    [C.materials.bag1kg.id, bagsHeld]);

  const k2 = await packSku(bK.id, bodyK, keyK);
  const kRowOk = await batchRow(bK.id);
  const kOpsOk = await operations(bK.id);
  console.log(`    retried with the SAME key once materials returned: ${k2.status} (replay ${k2.replay})`);
  check("the same key may be retried after a rollback", k2.status === 201,
    `status=${k2.status} ${S(k2.json).slice(0, 80)}`);
  check("the retry really executed rather than replaying a failure", k2.replay !== "true",
    `x-idempotent-replay=${k2.replay}`);
  check("the coffee was packed on the retry", near(num(kRowOk.rak), 7), `roastedAvailableKg ${kRowOk.rak}`);
  check("exactly one operation row now exists", kOpsOk.length === 1, `${kOpsOk.length} rows`);

  // ═══════════════════════════════════════════════════════════════════════
  section("G — WHAT THE OPERATION RECORD HOLDS");

  sub("G1. the record identifies the operation, its quantity, its lot and its actor");
  const opsA = await operations(bA.id);
  const movementActor = (await one(
    `SELECT "userId" uid FROM "InventoryMovement"
       WHERE "sourceDocId"=$1 AND category='FINISHED_GOODS' LIMIT 1`, [bA.id]))?.uid;
  console.log(`    ${S(opsA[0]).slice(0, 190)}`);
  check("one row for one operation, despite the replay", opsA.length === 1, `${opsA.length} rows`);
  check("it names the method and the quantity that moved",
    // PACK, and a unit count: the operation record describes what V2 committed rather
    // than the retired kilogram shape. quantityKg stays null because grams, not kilograms,
    // are what this model moves.
    opsA[0]?.method === "PACK" && num(opsA[0]?.qu) === 3 && opsA[0]?.qkg === null,
    `method=${opsA[0]?.method} kg=${opsA[0]?.qkg} units=${opsA[0]?.qu}`);
  check("it points at the lot the stock landed on", opsA[0]?.lot === lotFirst?.id,
    `${opsA[0]?.lot} vs lot ${lotFirst?.id}`);
  check("it stores the status the caller was answered with", num(opsA[0]?.rs) === 201, `${opsA[0]?.rs}`);
  check("it attributes the operation to the same actor as the ledger",
    Boolean(opsA[0]?.uid) && opsA[0]?.uid === movementActor,
    `operation ${opsA[0]?.uid} vs movement ${movementActor}`);

  sub("G2. a key is scoped to its batch, not global");
  // UNIQUE(batchId, requestKey), deliberately not UNIQUE(requestKey). A client that reuses
  // a counter or a per-session id across two roasts is doing something ordinary, and the
  // second roast must not be answered with the first roast's result.
  const bL = await stockBatch("L01", 12, 10, 2);
  const sharedKey = newKey("shared");
  const l1 = await packKg(bA.id, { bags1kg: 1 }, sharedKey);
  const l2 = await packKg(bL.id, { bags1kg: 1 }, sharedKey);
  const lRow = await batchRow(bL.id);
  console.log(`    same key on two batches: ${l1.status} / ${l2.status} (replay ${l2.replay})`);
  check("the second batch is packed, not answered with the first batch's result",
    packed(l2) && l2.replay !== "true", `status=${l2.status} replay=${l2.replay}`);
  check("and its own stock actually moved", num(lRow.b1) === 1 && near(num(lRow.rak), 9),
    `bags1kg ${lRow.b1}, roastedAvailableKg ${lRow.rak}`);

  // ═══════════════════════════════════════════════════════════════════════
  section("H — A PACKED ROAST CANNOT BE DELETED");

  sub("H1. a batch with no packaging history still deletes under the existing rules");
  const bM = await stockBatch("M01", 12, 10, 2);
  const m1 = await api(`/api/roasting-batches/${bM.id}`, { method: "DELETE" });
  const mGone = await one('SELECT id FROM "RoastingBatch" WHERE id=$1', [bM.id]);
  check("an unpacked batch is deleted as before", m1.status === 200,
    `status=${m1.status} ${S(m1.json).slice(0, 90)}`);
  check("and it is really gone", mGone === undefined, `row ${S(mGone)}`);

  sub("H2. a batch with packaging history is refused in the language of the domain");
  // The foreign key is RESTRICT and would stop this on its own, but it would stop it with
  // "a related record is still referenced", which tells an operator nothing. Deletion is
  // refused because the roast is now part of the audit trail — undoing a pack is a
  // reversal, which this wave deliberately does not implement.
  const nOpsBefore = (await operations(bA.id)).length;
  const nLotBefore = await kgLot(bA.id);
  const n1 = await api(`/api/roasting-batches/${bA.id}`, { method: "DELETE" });
  const nStill = await one('SELECT id FROM "RoastingBatch" WHERE id=$1', [bA.id]);
  const nOpsAfter = await operations(bA.id);
  const nLotAfter = await kgLot(bA.id);
  console.log(`    ${n1.status} ${S(n1.json).slice(0, 100)}`);
  check("a packed batch cannot be deleted", n1.status === 409, `status=${n1.status}`);
  check("the refusal names the reason, not a foreign key",
    n1.json?.error === "Batch cannot be deleted because packaging operations exist.",
    S(n1.json).slice(0, 140));
  check("the batch survives the attempt", nStill !== undefined, `row ${S(nStill)}`);
  check("the packaging history is intact", nOpsAfter.length === nOpsBefore,
    `${nOpsBefore} -> ${nOpsAfter.length}`);
  check("the finished stock is untouched", near(num(nLotAfter?.a), num(nLotBefore?.a)),
    `availableQty ${nLotBefore?.a} -> ${nLotAfter?.a}`);

  await invariants("after the idempotency suite");

  section("PACKAGING IDEMPOTENCY RESULT");
  console.log(`${results.pass} passed, ${results.fail} failed`);
  if (results.failures.length) console.log("FAILURES:\n  - " + results.failures.join("\n  - "));
  await db.end();
  process.exit(results.fail === 0 ? 0 : 1);
}

main().catch(async (e) => { console.log("FATAL:", e?.stack || e); try { await db.end(); } catch {} process.exit(1); });
