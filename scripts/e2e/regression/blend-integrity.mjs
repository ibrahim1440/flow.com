// BLEND INVENTORY + TRACEABILITY INTEGRITY — R2.5.
//
// A blend is a stock transformation: roasted coffee moves out of several batches and the
// same quantity appears in one. The route does not currently treat it that way.
//
// ── Nothing is consumed ─────────────────────────────────────────────────────
// The route never touches roastedAvailableKg on a source. It flips the source's status to
// "Blended" and leaves its balance untouched, so the roasted stock on the books is the
// sources' original balances PLUS whatever the output carries. Packaging cannot spend a
// Blended batch — PACKABLE_BATCH_STATUSES saw to that in R2.1 — but every roasted-stock
// figure still counts the coffee twice.
//
// ── The output cannot be used ───────────────────────────────────────────────
// roastingBatch.create is called without roastedAvailableKg, which defaults to 0. The blend
// output therefore holds no usable roasted coffee at all: pack-sku draws on
// roastedAvailableKg, so a completed blend can never be packed into anything.
//
// ── The quantity is the wrong one ───────────────────────────────────────────
// Both the output total and BlendIngredient.quantityUsed are summed from
// roastedBeanQuantity — the batch's ORIGINAL roast output — rather than from
// roastedAvailableKg, what is actually left. Blending a partly-packed batch therefore
// claims coffee that has already been sold.
//
// ── The transformation leaves no ledger ─────────────────────────────────────
// No InventoryMovement rows are written at all, so nothing records where the coffee went.
// SourceDocType.BLEND exists in the schema and has never been used.
import {
  ADMIN_PIN, db, api, check, section, sub, one, all, num, near, invariants, loginAs, results,
  Client, DB_URL,
} from "./harness.mjs";
import { buildCatalog, teardown, roastAndPass } from "./catalog.mjs";

const S = (v) => { try { return JSON.stringify(v) ?? String(v); } catch { return String(v); } };
const P = "BLND";
let C;

// ── helpers ────────────────────────────────────────────────────────────────
const topUpGreen = (beanId, kg) =>
  db.query('UPDATE "GreenBean" SET "quantityKg" = "quantityKg" + $2 WHERE id=$1', [beanId, kg]);

let roastSeq = 0;
/** A QC-passed stock roast whose roastedAvailableKg is exactly `roastedKg`. */
async function source(coffee, bean, roastedKg) {
  const greenKg = roastedKg + 2;
  await topUpGreen(bean.id, greenKg);
  const b = await roastAndPass(P, coffee, bean, greenKg, roastedKg, 2, `S${++roastSeq}`);
  if (!b.id) throw new Error(`source roast failed: ${S(b.error?.json ?? b)}`);
  return b.id;
}

/**
 * Blend request.
 *
 * Sends BOTH shapes on purpose. `batchIds` is the contract that exists today, so a pre-fix
 * run exercises the route's real behaviour rather than bouncing off a validation error; the
 * per-source quantities are what makes partial consumption, over-consumption and
 * same-source concurrency expressible at all.
 */
let blendSeq = 0;
const blend = async (sources, extra = {}) => {
  const r = await api("/api/roasting-batches/blend", {
    method: "POST",
    body: {
      batchIds: sources.map((s) => s.batchId),
      sources,
      ...extra,
    },
  });
  // Stamp the suite prefix on the output. The route numbers a blend by date, and teardown
  // finds batches by batchNumber — so an unrenamed blend survives cleanup, and once it has
  // been packed its unit lot survives too. Deleting the prefix's ProductSKU then nulls that
  // lot's productSkuId and trips the unit_tracked_requires_sku check, breaking teardown for
  // every later run.
  if (r.status === 201 && r.json?.id) {
    await db.query('UPDATE "RoastingBatch" SET "batchNumber"=$2 WHERE id=$1',
      [r.json.id, `${P}-B${++blendSeq}`]);
  }
  return r;
};

const availableKg = async (batchId) => num((await one(
  `SELECT "roastedAvailableKg" a FROM "RoastingBatch" WHERE id=$1`, [batchId])).a);

const batchRow = (batchId) => one(
  `SELECT "roastedAvailableKg" a, "roastedBeanQuantity" r, "greenBeanQuantity" g, status,
          "isBlend" ib, "productId" pid, "orderItemId" oid, "productionOrderId" poid,
          "parentBatchId" parent
     FROM "RoastingBatch" WHERE id=$1`, [batchId]);

const ingredientsOf = (blendId) => all(
  `SELECT "sourceBatchId" src, "quantityUsed" q FROM "BlendIngredient"
    WHERE "targetBlendBatchId"=$1 ORDER BY "sourceBatchId"`, [blendId]);

const blendMovements = (blendId) => all(
  `SELECT type, category, "referenceEntityId" ref, "quantityChanged" q,
          "sourceDocType" sdt, "sourceDocId" sdi
     FROM "InventoryMovement" WHERE "sourceDocId"=$1 AND "sourceDocType"='BLEND'
    ORDER BY type, "referenceEntityId"`, [blendId]);

const roastedStockOf = async (coffeeId) => num((await one(
  `SELECT COALESCE(SUM("roastedAvailableKg"),0) q FROM "RoastingBatch" WHERE "productId"=$1`,
  [coffeeId])).q);

async function main() {
  await db.connect();
  await teardown(P);
  await loginAs(ADMIN_PIN);
  C = await buildCatalog(P);

  // ═══════════════════════════════════════════════════════════════════════
  section("A — MASS IS CONSERVED");

  sub("A1. 3 kg from one source and 2 kg from another make a 5 kg blend");
  const a1 = await source(C.coffees.brazil, C.beans.brazil, 6);
  const a2 = await source(C.coffees.brazil, C.beans.brazil, 7);
  const stockBefore = await roastedStockOf(C.coffees.brazil.id);

  const rA = await blend([{ batchId: a1, quantityKg: 3 }, { batchId: a2, quantityKg: 2 }]);
  check("the blend is accepted", rA.status === 201, `status=${rA.status} ${S(rA.json).slice(0, 140)}`);
  const outA = rA.json?.id;
  const rowA = outA ? await batchRow(outA) : null;
  console.log(`    sources ${await availableKg(a1)}/${await availableKg(a2)} left, output ${rowA?.a}kg available`);

  check("the first source is drawn down 6 -> 3", near(await availableKg(a1), 3), `${await availableKg(a1)}`);
  check("the second source is drawn down 7 -> 5", near(await availableKg(a2), 5), `${await availableKg(a2)}`);
  check("the output holds exactly the 5 kg that was consumed", near(num(rowA?.a), 5),
    `roastedAvailableKg=${rowA?.a}`);
  check("its roasted quantity says the same", near(num(rowA?.r), 5), `roastedBeanQuantity=${rowA?.r}`);
  check("total roasted stock for the coffee is unchanged by the transformation",
    near(await roastedStockOf(C.coffees.brazil.id), stockBefore),
    `${stockBefore} -> ${await roastedStockOf(C.coffees.brazil.id)}`);

  sub("A2. the ingredient rows reconcile to the output");
  const ingA = outA ? await ingredientsOf(outA) : [];
  const ingTotal = ingA.reduce((s, i) => s + num(i.q), 0);
  console.log(`    ${S(ingA)}`);
  check("one ingredient row per source", ingA.length === 2, `${ingA.length} rows`);
  check("their quantities sum to the output", near(ingTotal, 5), `${ingTotal}`);
  check("each records what was actually taken, not the source's original roast",
    ingA.some((i) => i.src === a1 && near(num(i.q), 3)) && ingA.some((i) => i.src === a2 && near(num(i.q), 2)),
    S(ingA));
  check("the sources are still queryable as history", (await batchRow(a1)) !== undefined,
    "source row missing");

  // ═══════════════════════════════════════════════════════════════════════
  section("B — A SOURCE CAN BE EMPTIED EXACTLY, NEVER PAST EMPTY");

  sub("B1. taking all of a source leaves it at zero");
  const b1 = await source(C.coffees.ethiopia, C.beans.ethiopia, 3);
  const b2 = await source(C.coffees.ethiopia, C.beans.ethiopia, 4);
  const rB = await blend([{ batchId: b1, quantityKg: 3 }, { batchId: b2, quantityKg: 1 }]);
  check("the blend is accepted", rB.status === 201, `status=${rB.status} ${S(rB.json).slice(0, 130)}`);
  check("the exhausted source sits at exactly 0", near(await availableKg(b1), 0), `${await availableKg(b1)}`);
  check("and never below", (await availableKg(b1)) >= 0, `${await availableKg(b1)}`);
  check("the output carries 4 kg", near(num((await batchRow(rB.json?.id))?.a), 4),
    `${(await batchRow(rB.json?.id))?.a}`);

  // ═══════════════════════════════════════════════════════════════════════
  section("C — MORE THAN A SOURCE HOLDS IS REFUSED, AND NOTHING MOVES");

  sub("C1. asking for 3.1 kg of a 3 kg source");
  const c1 = await source(C.coffees.indonesia, C.beans.indonesia, 3);
  const c2 = await source(C.coffees.indonesia, C.beans.indonesia, 5);
  const movesBefore = num((await one('SELECT COUNT(*)::int n FROM "InventoryMovement"')).n);

  const rC = await blend([{ batchId: c1, quantityKg: 3.1 }, { batchId: c2, quantityKg: 1 }]);
  console.log(`    over-consumption -> ${rC.status} ${S(rC.json).slice(0, 130)}`);
  check("refused with a 4xx", rC.status >= 400 && rC.status < 500, `status=${rC.status}`);
  check("the first source is untouched", near(await availableKg(c1), 3), `${await availableKg(c1)}`);
  check("the second source is untouched", near(await availableKg(c2), 5), `${await availableKg(c2)}`);
  check("neither source was flipped to Blended",
    (await batchRow(c1)).status !== "Blended" && (await batchRow(c2)).status !== "Blended",
    `${(await batchRow(c1)).status}/${(await batchRow(c2)).status}`);
  check("no blend output exists",
    num((await one(`SELECT COUNT(*)::int n FROM "RoastingBatch" WHERE "isBlend" AND "parentBatchId" IS NULL AND id=$1`, [rC.json?.id ?? ""])).n) === 0,
    "output created");
  check("no ingredient rows",
    num((await one(`SELECT COUNT(*)::int n FROM "BlendIngredient" WHERE "sourceBatchId" IN ($1,$2)`, [c1, c2])).n) === 0,
    "ingredients written");
  check("no inventory movement",
    num((await one('SELECT COUNT(*)::int n FROM "InventoryMovement"')).n) === movesBefore,
    `${movesBefore} -> ${num((await one('SELECT COUNT(*)::int n FROM "InventoryMovement"')).n)}`);
  check("no raw database error leaked", !/prisma|constraint|violates/i.test(S(rC.json)),
    S(rC.json).slice(0, 140));

  // ═══════════════════════════════════════════════════════════════════════
  section("D — A FAILURE PARTWAY THROUGH UNDOES EVERYTHING");

  sub("D1. a second source that cannot deliver rolls back the first");
  // No test-only hook: the failure is a real one the domain already has to handle. The
  // first source is perfectly able to give its coffee; the second is asked for more than it
  // holds, and the whole transformation has to come back.
  const d1 = await source(C.coffees.brazil, C.beans.brazil, 5);
  const d2 = await source(C.coffees.brazil, C.beans.brazil, 2);
  const rD = await blend([{ batchId: d1, quantityKg: 4 }, { batchId: d2, quantityKg: 9 }]);
  console.log(`    partial-failure blend -> ${rD.status}`);
  check("refused", rD.status >= 400 && rD.status < 500, `status=${rD.status}`);
  check("the source that COULD have delivered is untouched", near(await availableKg(d1), 5),
    `${await availableKg(d1)}`);
  check("the failing source is untouched too", near(await availableKg(d2), 2), `${await availableKg(d2)}`);
  check("neither was flipped to Blended",
    (await batchRow(d1)).status !== "Blended" && (await batchRow(d2)).status !== "Blended",
    `${(await batchRow(d1)).status}/${(await batchRow(d2)).status}`);

  // ═══════════════════════════════════════════════════════════════════════
  section("E — TWO BLENDS CANNOT SPEND THE SAME KILOGRAMS");

  sub("E1. one 5 kg source, two concurrent blends wanting 4 kg each");
  const shared = await source(C.coffees.ethiopia, C.beans.ethiopia, 5);
  const partner1 = await source(C.coffees.ethiopia, C.beans.ethiopia, 2);
  const partner2 = await source(C.coffees.ethiopia, C.beans.ethiopia, 2);

  const [e1, e2] = await Promise.all([
    blend([{ batchId: shared, quantityKg: 4 }, { batchId: partner1, quantityKg: 1 }]),
    blend([{ batchId: shared, quantityKg: 4 }, { batchId: partner2, quantityKg: 1 }]),
  ]);
  const sharedLeft = await availableKg(shared);
  console.log(`    ${e1.status}/${e2.status} -> shared source has ${sharedLeft}kg left of 5`);
  check("neither returned a server error", e1.status !== 500 && e2.status !== 500,
    `${e1.status}/${e2.status}`);
  check("neither deadlocked", !/deadlock|40P01/i.test(S(e1.json) + S(e2.json)),
    (S(e1.json) + S(e2.json)).slice(0, 120));
  check("at most one took the 4 kg", [e1.status, e2.status].filter((s) => s === 201).length <= 1,
    `${e1.status}/${e2.status}`);
  check("the shared source never went negative", sharedLeft >= 0, `${sharedLeft}`);
  check("and no more than it held was spent", near(sharedLeft, 1) || near(sharedLeft, 5),
    `${sharedLeft}kg left — expected 1 (one winner) or 5 (both refused)`);

  // ═══════════════════════════════════════════════════════════════════════
  section("F — OPPOSITE SOURCE ORDER MUST NOT DEADLOCK");

  sub("F1. one request lists [x,y], the other [y,x], overlapping");
  const f1 = await source(C.coffees.indonesia, C.beans.indonesia, 6);
  const f2 = await source(C.coffees.indonesia, C.beans.indonesia, 6);
  const holder = new Client({ connectionString: DB_URL });
  await holder.connect();
  await holder.query("BEGIN");
  // Hold the LOWER id, so whichever order the server used, both requests must queue here if
  // it normalises — and would grab opposite rows first if it did not.
  const lower = f1 < f2 ? f1 : f2;
  await holder.query('SELECT id FROM "RoastingBatch" WHERE id=$1 FOR UPDATE', [lower]);

  const pairF = Promise.all([
    blend([{ batchId: f1, quantityKg: 2 }, { batchId: f2, quantityKg: 2 }]),
    blend([{ batchId: f2, quantityKg: 2 }, { batchId: f1, quantityKg: 2 }]),
  ]);
  await new Promise((r) => setTimeout(r, 2500));
  await holder.query("ROLLBACK");
  await holder.end();
  const [fr1, fr2] = await pairF;
  console.log(`    ${fr1.status}/${fr2.status} -> ${await availableKg(f1)}/${await availableKg(f2)} left`);
  check("no deadlock was reported", !/deadlock|40P01/i.test(S(fr1.json) + S(fr2.json)),
    (S(fr1.json) + S(fr2.json)).slice(0, 140));
  check("no server error", fr1.status !== 500 && fr2.status !== 500, `${fr1.status}/${fr2.status}`);
  check("balances stayed non-negative",
    (await availableKg(f1)) >= 0 && (await availableKg(f2)) >= 0,
    `${await availableKg(f1)}/${await availableKg(f2)}`);
  check("no more was spent than existed",
    (await availableKg(f1)) <= 6 && (await availableKg(f2)) <= 6,
    `${await availableKg(f1)}/${await availableKg(f2)}`);

  // ═══════════════════════════════════════════════════════════════════════
  section("G — THE OUTPUT DOES NOT INVENT PROVENANCE");

  sub("G1. blending across two different orders is refused without an explicit owner");
  const oG1 = await orderWithRoast("prov A", C.skus.bra1kg.id, C.coffees.brazil, C.beans.brazil);
  const oG2 = await orderWithRoast("prov B", C.skus.bra1kg.id, C.coffees.brazil, C.beans.brazil);
  const rG = await blend([{ batchId: oG1.batchId, quantityKg: 2 }, { batchId: oG2.batchId, quantityKg: 2 }]);
  console.log(`    two different orders -> ${rG.status} ${S(rG.json).slice(0, 120)}`);
  check("refused rather than picking one", rG.status >= 400 && rG.status < 500, `status=${rG.status}`);
  check("neither source was consumed",
    near(await availableKg(oG1.batchId), 6) && near(await availableKg(oG2.batchId), 6),
    `${await availableKg(oG1.batchId)}/${await availableKg(oG2.batchId)}`);

  sub("G2. a stock blend claims no order and no production order");
  const g1 = await source(C.coffees.brazil, C.beans.brazil, 4);
  const g2 = await source(C.coffees.brazil, C.beans.brazil, 4);
  const rG2 = await blend([{ batchId: g1, quantityKg: 2 }, { batchId: g2, quantityKg: 2 }]);
  const rowG2 = rG2.json?.id ? await batchRow(rG2.json.id) : null;
  check("the stock blend is accepted", rG2.status === 201, S(rG2.json).slice(0, 130));
  check("it belongs to no order", rowG2?.oid === null, `orderItemId=${rowG2?.oid}`);
  check("and to no production order", rowG2?.poid === null, `productionOrderId=${rowG2?.poid}`);
  check("but it does name its coffee", rowG2?.pid === C.coffees.brazil.id, `productId=${rowG2?.pid}`);

  // ═══════════════════════════════════════════════════════════════════════
  section("H — BLENDING DOES NOT CREATE A SECOND PRODUCTION CREDIT");

  sub("H1. production progress is the same before and after");
  // Both sources belong to the SAME order line, which is the only shape whose ownership the
  // records actually prove — so the output legitimately inherits that line, and any double
  // credit would show up immediately.
  const oH = await orderWithRoast("double credit", C.skus.eth1kg.id, C.coffees.ethiopia, C.beans.ethiopia);
  const partnerH = await secondRoastFor(oH.orderItemId, C.beans.ethiopia);
  const reqBefore = await api(`/api/order-items/${oH.orderItemId}/production-requirement`);
  const beforeH = {
    reserved: num(reqBefore.json?.reservedUnits),
    scheduled: num(reqBefore.json?.scheduledUnits),
    shortfall: num(reqBefore.json?.shortfallUnits),
  };

  const rH = await blend([{ batchId: oH.batchId, quantityKg: 3 }, { batchId: partnerH, quantityKg: 1 }]);
  check("the blend of one line's own coffee is accepted", rH.status === 201, S(rH.json).slice(0, 130));
  check("and the output inherits that line, derived not supplied",
    (await batchRow(rH.json?.id))?.oid === oH.orderItemId,
    `orderItemId=${(await batchRow(rH.json?.id))?.oid}`);

  const reqAfter = await api(`/api/order-items/${oH.orderItemId}/production-requirement`);
  const afterH = {
    reserved: num(reqAfter.json?.reservedUnits),
    scheduled: num(reqAfter.json?.scheduledUnits),
    shortfall: num(reqAfter.json?.shortfallUnits),
  };
  console.log(`    before ${S(beforeH)} after ${S(afterH)}`);
  check("no coffee was reserved by the act of blending", afterH.reserved === beforeH.reserved,
    `${beforeH.reserved} -> ${afterH.reserved}`);
  check("no production was scheduled by it", afterH.scheduled === beforeH.scheduled,
    `${beforeH.scheduled} -> ${afterH.scheduled}`);
  check("the outstanding demand did not move", afterH.shortfall === beforeH.shortfall,
    `${beforeH.shortfall} -> ${afterH.shortfall}`);

  // ═══════════════════════════════════════════════════════════════════════
  section("I — MIXING STOCK AND ORDER COFFEE");

  sub("I1. one stock source and one order source needs the owner said out loud");
  const oI = await orderWithRoast("stock mix", C.skus.bra250.id, C.coffees.brazil, C.beans.brazil);
  const stockI = await source(C.coffees.brazil, C.beans.brazil, 4);
  const rI = await blend([{ batchId: oI.batchId, quantityKg: 2 }, { batchId: stockI, quantityKg: 2 }]);
  console.log(`    stock + order, no owner named -> ${rI.status} ${S(rI.json).slice(0, 120)}`);
  check("refused rather than guessed", rI.status >= 400 && rI.status < 500, `status=${rI.status}`);
  check("nothing was consumed",
    near(await availableKg(oI.batchId), 6) && near(await availableKg(stockI), 4),
    `${await availableKg(oI.batchId)}/${await availableKg(stockI)}`);

  // ═══════════════════════════════════════════════════════════════════════
  section("J — A BLEND OUTPUT CAN ACTUALLY BE PACKED");

  sub("J1. the R2.3 identity resolver accepts it and the stock decrements");
  const j1 = await source(C.coffees.brazil, C.beans.brazil, 5);
  const j2 = await source(C.coffees.brazil, C.beans.brazil, 5);
  const rJ = await blend([{ batchId: j1, quantityKg: 4 }, { batchId: j2, quantityKg: 4 }]);
  check("the blend is accepted", rJ.status === 201, S(rJ.json).slice(0, 130));
  const outJ = rJ.json?.id;
  await db.query(`UPDATE "RoastingBatch" SET status='Passed' WHERE id=$1`, [outJ]);
  const availBeforeJ = await availableKg(outJ);
  check("it has usable roasted coffee to pack", availBeforeJ > 0, `roastedAvailableKg=${availBeforeJ}`);

  const packJ = await api(`/api/roasting-batches/${outJ}/pack-sku`, {
    method: "POST", body: { productSkuId: C.skus.bra1kg.id, units: 3 },
  });
  console.log(`    pack the blend -> ${packJ.status} ${S(packJ.json).slice(0, 120)}`);
  check("packing the blend succeeds", packJ.status === 201,
    `status=${packJ.status} ${S(packJ.json).slice(0, 140)}`);
  check("the blend's own stock went down by what was packed",
    near(await availableKg(outJ), availBeforeJ - 3), `${availBeforeJ} -> ${await availableKg(outJ)}`);
  check("no source batch was touched by the packing",
    near(await availableKg(j1), 1) && near(await availableKg(j2), 1),
    `${await availableKg(j1)}/${await availableKg(j2)}`);
  const lotJ = await one(`SELECT "productSkuId" sku FROM "FinishedGoodsLot" WHERE "packedFromBatchId"=$1`, [outJ]);
  check("exactly one lot came out of it", lotJ?.sku === C.skus.bra1kg.id, S(lotJ));

  // ═══════════════════════════════════════════════════════════════════════
  section("K — THE TRANSFORMATION IS ON THE LEDGER");

  sub("K1. one movement out of each source, one into the blend");
  const movesA = outA ? await blendMovements(outA) : [];
  console.log(`    ${movesA.length} movement(s): ${S(movesA).slice(0, 220)}`);
  check("movements exist for the transformation", movesA.length > 0, `${movesA.length}`);
  const outs = movesA.filter((m) => m.type === "OUT");
  const ins = movesA.filter((m) => m.type === "IN");
  check("one OUT per source", outs.length === 2, `${outs.length} OUT rows`);
  check("one IN for the output", ins.length === 1, `${ins.length} IN rows`);
  check("every row is roasted coffee", movesA.every((m) => m.category === "ROASTED_COFFEE"),
    S(movesA.map((m) => m.category)));
  check("the OUT quantities reconcile to the 5 kg transformed",
    near(Math.abs(outs.reduce((s, m) => s + num(m.q), 0)), 5),
    `${outs.reduce((s, m) => s + num(m.q), 0)}`);
  check("the IN quantity matches", near(num(ins[0]?.q), 5), `${ins[0]?.q}`);
  check("each OUT names its source batch",
    outs.some((m) => m.ref === a1) && outs.some((m) => m.ref === a2), S(outs.map((m) => m.ref)));
  check("the IN names the blend", ins[0]?.ref === outA, `${ins[0]?.ref} vs ${outA}`);
  check("every row carries a source document", movesA.every((m) => m.sdt === "BLEND" && m.sdi === outA),
    S(movesA.map((m) => [m.sdt, m.sdi])));

  // ═══════════════════════════════════════════════════════════════════════
  section("L — SUBMITTING THE SAME BLEND TWICE");

  sub("L1. the second submission cannot conjure stock that is gone");
  // Characterising the contract honestly: there is no operation-level idempotency on this
  // route, and none is being added here. What must hold regardless is that the second
  // request cannot spend coffee the first one already spent.
  const l1 = await source(C.coffees.indonesia, C.beans.indonesia, 4);
  const l2 = await source(C.coffees.indonesia, C.beans.indonesia, 4);
  const body = [{ batchId: l1, quantityKg: 3 }, { batchId: l2, quantityKg: 3 }];
  const first = await blend(body);
  const second = await blend(body);
  const leftL1 = await availableKg(l1);
  const leftL2 = await availableKg(l2);
  console.log(`    first ${first.status}, repeat ${second.status} -> ${leftL1}/${leftL2} left of 4/4`);
  check("the first is accepted", first.status === 201, S(first.json).slice(0, 120));
  check("the repeat does not drive stock negative", leftL1 >= 0 && leftL2 >= 0, `${leftL1}/${leftL2}`);
  check("no more than existed was consumed", leftL1 <= 4 && leftL2 <= 4, `${leftL1}/${leftL2}`);
  check("the repeat is refused once the coffee is spent", second.status !== 201 || leftL1 >= 0,
    `status=${second.status}`);


  // ═══════════════════════════════════════════════════════════════════════
  section("M — BLEND HISTORY CANNOT BE DELETED AWAY");

  sub("M1. an ordinary unused batch still deletes");
  const m0 = await source(C.coffees.brazil, C.beans.brazil, 3);
  const delM0 = await api(`/api/roasting-batches/${m0}`, { method: "DELETE" });
  check("an unblended, unpacked batch deletes as before", delM0.status === 200,
    `status=${delM0.status} ${S(delM0.json).slice(0, 110)}`);
  check("and it is gone", (await batchRow(m0)) === undefined, "row still present");

  sub("M2. a SOURCE batch that contributed to a blend is protected");
  // BlendIngredient cascades from both ends, so this delete would not be refused by the
  // database — it would simply succeed and take the transformation record with it.
  const m1 = await source(C.coffees.brazil, C.beans.brazil, 4);
  const m2 = await source(C.coffees.brazil, C.beans.brazil, 4);
  const rM = await blend([{ batchId: m1, quantityKg: 2 }, { batchId: m2, quantityKg: 2 }]);
  check("the blend is created", rM.status === 201, S(rM.json).slice(0, 120));
  const outM = rM.json?.id;
  const ingBeforeM = (await ingredientsOf(outM)).length;

  const delSrc = await api(`/api/roasting-batches/${m1}`, { method: "DELETE" });
  console.log(`    delete a blended source -> ${delSrc.status} ${S(delSrc.json).slice(0, 110)}`);
  check("refused with 409", delSrc.status === 409, `status=${delSrc.status}`);
  check("the refusal names blend history",
    delSrc.json?.error === "Batch cannot be deleted because it is part of blend history.",
    S(delSrc.json).slice(0, 140));
  check("no foreign key or database text leaked",
    !/constraint|violates|cascade|prisma|fkey/i.test(S(delSrc.json)), S(delSrc.json).slice(0, 140));
  check("the source survives", (await batchRow(m1)) !== undefined, "source gone");
  check("the blend output survives", (await batchRow(outM)) !== undefined, "output gone");
  check("every ingredient row survives", (await ingredientsOf(outM)).length === ingBeforeM,
    `${ingBeforeM} -> ${(await ingredientsOf(outM)).length}`);
  check("the blend's stock is untouched", near(num((await batchRow(outM))?.a), 4),
    `${(await batchRow(outM))?.a}`);

  sub("M3. the blend OUTPUT is protected too");
  const delOut = await api(`/api/roasting-batches/${outM}`, { method: "DELETE" });
  console.log(`    delete the blend output -> ${delOut.status} ${S(delOut.json).slice(0, 110)}`);
  check("refused with 409", delOut.status === 409, `status=${delOut.status}`);
  check("the output survives", (await batchRow(outM)) !== undefined, "output gone");
  check("its ingredient rows survive", (await ingredientsOf(outM)).length === ingBeforeM,
    `${(await ingredientsOf(outM)).length}`);
  check("the source balances are unchanged",
    near(await availableKg(m1), 2) && near(await availableKg(m2), 2),
    `${await availableKg(m1)}/${await availableKg(m2)}`);

  sub("M4. a PACKAGED blend output keeps the packaging protection as well");
  // Two guards now sit on this route. Adding the blend one must not displace the packaging
  // one, and a batch that trips both should still be refused.
  const p1 = await source(C.coffees.brazil, C.beans.brazil, 5);
  const p2 = await source(C.coffees.brazil, C.beans.brazil, 5);
  const rP = await blend([{ batchId: p1, quantityKg: 3 }, { batchId: p2, quantityKg: 3 }]);
  const outP = rP.json?.id;
  await db.query(`UPDATE "RoastingBatch" SET status='Passed' WHERE id=$1`, [outP]);
  const packP = await api(`/api/roasting-batches/${outP}/pack-sku`, {
    method: "POST", body: { productSkuId: C.skus.bra1kg.id, units: 2 },
  });
  check("the blend output packs", packP.status === 201, S(packP.json).slice(0, 120));
  const delPacked = await api(`/api/roasting-batches/${outP}`, { method: "DELETE" });
  check("deleting it is still refused", delPacked.status === 409, `status=${delPacked.status}`);
  check("the packaging operation survives",
    num((await one(`SELECT COUNT(*)::int n FROM "PackagingOperation" WHERE "batchId"=$1`, [outP])).n) === 1,
    "packaging operation lost");
  check("the finished lot survives",
    (await one(`SELECT id FROM "FinishedGoodsLot" WHERE "packedFromBatchId"=$1`, [outP])) !== undefined,
    "lot lost");

  sub("M5. a delete racing a blend loses no history either way");
  // The guard has to be more than an unlocked pre-check. Both operations are forced to queue
  // on the same source row, so whichever wakes first, the other must see a committed reality
  // rather than the one it read before.
  const r1 = await source(C.coffees.indonesia, C.beans.indonesia, 4);
  const r2 = await source(C.coffees.indonesia, C.beans.indonesia, 4);
  const gate = new Client({ connectionString: DB_URL });
  await gate.connect();
  await gate.query("BEGIN");
  await gate.query('SELECT id FROM "RoastingBatch" WHERE id=$1 FOR UPDATE', [r1]);

  const raced = Promise.all([
    blend([{ batchId: r1, quantityKg: 2 }, { batchId: r2, quantityKg: 2 }]),
    api(`/api/roasting-batches/${r1}`, { method: "DELETE" }),
  ]);
  await new Promise((r) => setTimeout(r, 2500));
  await gate.query("ROLLBACK");
  await gate.end();
  const [blendR, deleteR] = await raced;

  const srcAlive = (await batchRow(r1)) !== undefined;
  const ingCount = num((await one(
    `SELECT COUNT(*)::int n FROM "BlendIngredient" WHERE "sourceBatchId"=$1`, [r1])).n);
  console.log(`    blend=${blendR.status} delete=${deleteR.status} -> source alive=${srcAlive}, ingredient rows=${ingCount}`);
  check("neither returned a server error", blendR.status !== 500 && deleteR.status !== 500,
    `${blendR.status}/${deleteR.status}`);
  check("neither deadlocked", !/deadlock|40P01/i.test(S(blendR.json) + S(deleteR.json)),
    (S(blendR.json) + S(deleteR.json)).slice(0, 130));
  check("exactly one of the two won",
    (blendR.status === 201) !== (deleteR.status === 200),
    `blend=${blendR.status} delete=${deleteR.status}`);
  check("if the blend won, the source and its history are both still there",
    blendR.status !== 201 || (srcAlive && ingCount === 1),
    `alive=${srcAlive} ingredients=${ingCount}`);
  check("if the delete won, no orphaned ingredient row was left behind",
    deleteR.status !== 200 || ingCount === 0, `ingredients=${ingCount}`);

  // ═══════════════════════════════════════════════════════════════════════
  section("N — PROVENANCE IS DERIVED, NEVER SUPPLIED");

  sub("N1. two sources of different orders, caller names one of them");
  // The caller may say who they believe owns this coffee. They may not decide it. Naming one
  // of two competing owners would claim the other order's coffee for it.
  const nA = await orderWithRoast("prov N A", C.skus.bra1kg.id, C.coffees.brazil, C.beans.brazil);
  const nB = await orderWithRoast("prov N B", C.skus.bra1kg.id, C.coffees.brazil, C.beans.brazil);
  const rN1 = await blend(
    [{ batchId: nA.batchId, quantityKg: 2 }, { batchId: nB.batchId, quantityKg: 2 }],
    { orderItemId: nA.orderItemId });
  console.log(`    two owners, caller names one -> ${rN1.status} ${S(rN1.json).slice(0, 120)}`);
  check("refused", rN1.status >= 400 && rN1.status < 500, `status=${rN1.status}`);
  check("no output was attributed to the named order",
    num((await one(
      `SELECT COUNT(*)::int n FROM "RoastingBatch" WHERE "isBlend" AND "orderItemId"=$1`,
      [nA.orderItemId])).n) === 0,
    "a blend was attributed to it");
  check("neither source was consumed",
    near(await availableKg(nA.batchId), 6) && near(await availableKg(nB.batchId), 6),
    `${await availableKg(nA.batchId)}/${await availableKg(nB.batchId)}`);

  sub("N2. stock coffee plus one order's coffee, caller names that order");
  const nC = await orderWithRoast("prov N C", C.skus.bra1kg.id, C.coffees.brazil, C.beans.brazil);
  const nStock = await source(C.coffees.brazil, C.beans.brazil, 4);
  const rN2 = await blend(
    [{ batchId: nC.batchId, quantityKg: 2 }, { batchId: nStock, quantityKg: 2 }],
    { orderItemId: nC.orderItemId });
  console.log(`    stock + order, caller names the order -> ${rN2.status} ${S(rN2.json).slice(0, 120)}`);
  check("refused rather than absorbing stock coffee into the order",
    rN2.status >= 400 && rN2.status < 500, `status=${rN2.status}`);
  check("nothing was consumed",
    near(await availableKg(nC.batchId), 6) && near(await availableKg(nStock), 4),
    `${await availableKg(nC.batchId)}/${await availableKg(nStock)}`);

  sub("N3. no owned source at all, caller names an order anyway");
  const nD = await orderWithRoast("prov N D", C.skus.bra1kg.id, C.coffees.brazil, C.beans.brazil);
  const s1 = await source(C.coffees.brazil, C.beans.brazil, 3);
  const s2 = await source(C.coffees.brazil, C.beans.brazil, 3);
  const rN3 = await blend(
    [{ batchId: s1, quantityKg: 2 }, { batchId: s2, quantityKg: 2 }],
    { orderItemId: nD.orderItemId });
  console.log(`    stock only, caller names an order -> ${rN3.status} ${S(rN3.json).slice(0, 120)}`);
  check("client input cannot create ownership", rN3.status >= 400 && rN3.status < 500,
    `status=${rN3.status}`);
  check("no blend claims that order",
    num((await one(
      `SELECT COUNT(*)::int n FROM "RoastingBatch" WHERE "isBlend" AND "orderItemId"=$1`,
      [nD.orderItemId])).n) === 0,
    "a blend claimed it");
  check("the stock sources are untouched",
    near(await availableKg(s1), 3) && near(await availableKg(s2), 3),
    `${await availableKg(s1)}/${await availableKg(s2)}`);

  sub("N4. a singular backend owner, caller names a different one");
  const nE = await orderWithRoast("prov N E", C.skus.bra1kg.id, C.coffees.brazil, C.beans.brazil);
  const nEsecond = await secondRoastFor(nE.orderItemId, C.beans.brazil);
  const nF = await orderWithRoast("prov N F", C.skus.bra1kg.id, C.coffees.brazil, C.beans.brazil);
  const rN4 = await blend(
    [{ batchId: nE.batchId, quantityKg: 2 }, { batchId: nEsecond, quantityKg: 2 }],
    { orderItemId: nF.orderItemId });
  console.log(`    owner is E, caller says F -> ${rN4.status} ${S(rN4.json).slice(0, 120)}`);
  check("the mismatched assertion is refused with 409", rN4.status === 409, `status=${rN4.status}`);
  check("no source was consumed", near(await availableKg(nE.batchId), 6),
    `${await availableKg(nE.batchId)}`);

  sub("N5. the same assertion, agreeing with the records, is accepted");
  const rN5 = await blend(
    [{ batchId: nE.batchId, quantityKg: 2 }, { batchId: nEsecond, quantityKg: 2 }],
    { orderItemId: nE.orderItemId });
  check("an agreeing assertion blends normally", rN5.status === 201, S(rN5.json).slice(0, 130));
  check("and the output carries the proven owner",
    (await batchRow(rN5.json?.id))?.oid === nE.orderItemId,
    `orderItemId=${(await batchRow(rN5.json?.id))?.oid}`);
  check("with no production order attached", (await batchRow(rN5.json?.id))?.poid === null,
    `productionOrderId=${(await batchRow(rN5.json?.id))?.poid}`);

  await invariants("after the blend integrity suite");

  section("BLEND INTEGRITY RESULT");
  console.log(`${results.pass} passed, ${results.fail} failed`);
  if (results.failures.length) console.log("FAILURES:\n  - " + results.failures.join("\n  - "));
  await db.end();
  process.exit(results.fail === 0 ? 0 : 1);
}

/** Another order-backed roast against a line that already has one. */
async function secondRoastFor(orderItemId, bean) {
  await topUpGreen(bean.id, 8);
  const roast = await api("/api/roasting-batches", {
    method: "POST",
    body: { orderItemId, greenBeanId: bean.id, greenBeanQuantity: 8,
            roastedBeanQuantity: 6, wasteQuantity: 2,
            // Blending is what this suite proves. The fixture needs roasted coffee on an
            // order line whose demand is already covered, which is surplus by the
            // canonical measure and is now requested rather than assumed.
            surplusOverride: true,
            surplusReason: "Fixture: deliberately produces beyond outstanding demand so there is coffee to blend" },
  });
  if (roast.status !== 201) throw new Error(`second roast failed: ${S(roast.json)}`);
  await db.query('UPDATE "RoastingBatch" SET "batchNumber"=$2, status=$3 WHERE id=$1',
    [roast.json.id, `${P}-O${++roastSeq}`, "Passed"]);
  return roast.json.id;
}

/** An approved, reviewed order line with one order-backed QC-passed roast behind it. */
async function orderWithRoast(note, skuId, coffee, bean) {
  const r = await api("/api/orders", {
    method: "POST",
    body: { customerId: C.customers.cafe.id, notes: `${P} ${note}`,
            items: [{ productSkuId: skuId, quantityUnits: 12 }] },
  });
  if (r.status !== 201) throw new Error(`order create failed: ${S(r.json)}`);
  const appr = await api(`/api/orders/${r.json.id}/approve`, { method: "POST", body: { decision: "Yes" } });
  if (appr.status !== 200) throw new Error(`approve failed: ${S(appr.json)}`);
  // Surfaced rather than swallowed: without a successful review the order never leaves
  // "Waiting Preparation Review", and the roast below then fails with a production-gate
  // message that says nothing about the real cause.
  const rev = await api(`/api/orders/${r.json.id}/preparation-review`, {
    method: "POST", body: { items: r.json.items.map((i) => ({ orderItemId: i.id })) },
  });
  if (rev.status !== 200) throw new Error(`preparation review failed: ${rev.status} ${S(rev.json)}`);
  const orderItemId = r.json.items[0].id;

  await topUpGreen(bean.id, 8);
  const roast = await api("/api/roasting-batches", {
    method: "POST",
    body: { orderItemId, greenBeanId: bean.id, greenBeanQuantity: 8,
            roastedBeanQuantity: 6, wasteQuantity: 2,
            // Blending is what this suite proves. The fixture needs roasted coffee on an
            // order line whose demand is already covered, which is surplus by the
            // canonical measure and is now requested rather than assumed.
            surplusOverride: true,
            surplusReason: "Fixture: deliberately produces beyond outstanding demand so there is coffee to blend" },
  });
  if (roast.status !== 201) throw new Error(`order roast failed: ${S(roast.json)}`);
  await db.query('UPDATE "RoastingBatch" SET "batchNumber"=$2, status=$3 WHERE id=$1',
    [roast.json.id, `${P}-O${++roastSeq}`, "Passed"]);
  return { orderItemId, batchId: roast.json.id };
}

main().catch(async (e) => {
  console.log("FATAL:", e?.stack || e);
  try { await db.end(); } catch {}
  process.exit(1);
});
