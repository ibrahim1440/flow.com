// PACKAGING STOCK INTEGRITY — R2.1.
//
// The kilogram packaging path writes finished stock, and every defect below is a way it
// wrote the wrong number. They are proved here against the running application rather than
// argued about, because all four are arithmetic that only shows up once something else has
// already moved the balance — a dispatch, a second pack, or another packer.
//
//   A-1  the lot's availableQty was ASSIGNED the cumulative packed weight instead of being
//        incremented by this pack's delta. Once anything had shipped off the lot, the next
//        pack silently resurrected it: 10 kg roasted, 6 packed, 4 dispatched, 4 more packed
//        left 10 kg on the shelf where 6 were physically present.
//   A-2  the batch was read, and every quantity derived from it, OUTSIDE the transaction,
//        so two packers on one batch each computed from the same stale bag counters and the
//        last writer won — losing the other's bags while the ledger still recorded both.
//   B-1  the kilogram path never drew down RoastingBatch.roastedAvailableKg, so the same
//        roasted coffee stayed on the books as packable after it had been packed.
//   L-1  explodeBom counted roasted stock that cannot be packed at all — batches still
//        awaiting QC, rejected batches, and batches consumed into a blend.
//   N-1  the auto-reservation decided eligibility from an unlocked read. A cancellation
//        committing in the same window never touches OrderItem, so the compare-and-swap
//        still matched and the reservation landed on a dead order.
//   SEC-1 body.productSkuId was written onto the lot with no validation at all.
//
// Every assertion is on state read back from the database, never on the response body.
import {
  ADMIN_PIN, db, api, check, section, sub, one, num, near, invariants, loginAs, results, concurrently,
  DB_URL, Client,
} from "./harness.mjs";
import { buildCatalog, teardown, roastAndPass } from "./catalog.mjs";

const S = (v) => { try { return JSON.stringify(v) ?? String(v); } catch { return String(v); } };
const P = "PKS";
let C;

// ── fixtures ────────────────────────────────────────────────────────────────

/** A stock batch: no order item, so packaging reserves to nobody and the lot is pure. */
const stockBatch = (label, greenKg, roastedKg, wasteKg) =>
  roastAndPass(P, C.coffees.brazil, C.beans.brazil, greenKg, roastedKg, wasteKg, label);

/** A batch parked in an arbitrary lifecycle status, for the availability filter. */
async function batchInStatus(label, roastedKg, status) {
  const r = await api("/api/roasting-batches", { method: "POST", body: {
    greenBeanId: C.beans.brazil.id, productId: C.coffees.brazil.id,
    greenBeanQuantity: roastedKg + 1, roastedBeanQuantity: roastedKg, wasteQuantity: 1,
  }});
  if (r.status !== 201) throw new Error(`batchInStatus ${label}: ${r.status} ${S(r.json)}`);
  await db.query('UPDATE "RoastingBatch" SET "batchNumber"=$2, status=$3 WHERE id=$1',
    [r.json.id, `${P}-${label}`, status]);
  return r.json.id;
}

/**
 * A legacy kilogram order line.
 *
 * Orders can only be created as SKU/unit lines now, so the line is created that way and
 * then rewritten into the kilogram shape the kg packaging path actually serves. This is
 * fixture construction, not a workflow step — the same approach reservation-cas uses.
 */
async function kgOrderLine(note, kg, coffeeId) {
  const r = await api("/api/orders", { method: "POST", body: {
    customerId: C.customers.cafe.id, notes: `${P} ${note}`,
    items: [{ productSkuId: C.skus.bra250.id, quantityUnits: 4 }],
  }});
  if (r.status !== 201) throw new Error(`kgOrderLine: ${r.status} ${S(r.json)}`);
  await api(`/api/orders/${r.json.id}/approve`, { method: "POST", body: { decision: "Yes" } });
  const itemId = r.json.items[0].id;
  await db.query(
    `UPDATE "OrderItem" SET "quantityUnits"=NULL, "deliveredUnits"=0, "quantityKg"=$2,
        "deliveredQty"=0, "productSkuId"=NULL, "productId"=$3,
        "preparationDecision"='Needs Production' WHERE id=$1`,
    [itemId, kg, coffeeId]);
  await db.query(`UPDATE "Order" SET status='Preparing', "approvalStatus"='Yes' WHERE id=$1`, [r.json.id]);
  return { orderId: r.json.id, itemId };
}

const pack = (batchId, body) => api(`/api/roasting-batches/${batchId}/package`, { method: "PUT", body });

/**
 * Hold one row so both racers are forced to meet on it.
 *
 * Promise.all alone proves nothing about lock order: whichever request happens to reach
 * the database first usually finishes before the other starts contending. This opens its
 * own connection, takes FOR UPDATE on a named row, and hands back a release function —
 * so both sides can be started, provably blocked on the same resource, and then let go
 * together. The same technique reservation-cas uses for its review/review barrier.
 */
async function holdRow(table, id) {
  const c = new Client({ connectionString: DB_URL });
  await c.connect();
  await c.query("BEGIN");
  await c.query(`SELECT "id" FROM "${table}" WHERE "id" = $1 FOR UPDATE`, [id]);
  return async () => { await c.query("COMMIT"); await c.end(); };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 40P01 is Postgres's deadlock code; the app surfaces it as a 500. */
const deadlocked = (...rs) => rs.some((r) => r.status === 500);

// ── readers ─────────────────────────────────────────────────────────────────

const kgLot = async (batchId) => await one(
  `SELECT id, "availableQty" a, "reservedQty" r, "productSkuId" sku, "quantityKg" q
     FROM "FinishedGoodsLot" WHERE "roastingBatchId"=$1`, [batchId]);

const batchRow = async (id) => await one(
  `SELECT status, "roastedAvailableKg" rak, "roastedBeanQuantity" rbq,
          "bags3kg" b3, "bags1kg" b1, "bags250g" b250, "bags150g" b150, "samplesGrams" sg
     FROM "RoastingBatch" WHERE id=$1`, [id]);

/** Net of every finished-goods movement against this lot — what the ledger says it holds. */
const ledgerNet = async (lotId) => num((await one(
  `SELECT COALESCE(SUM("quantityChanged"),0)::float8 n FROM "InventoryMovement"
     WHERE "referenceEntityId"=$1 AND category='FINISHED_GOODS'`, [lotId])).n);

const packingIn = async (lotId) => num((await one(
  `SELECT COALESCE(SUM("quantityChanged"),0)::float8 n FROM "InventoryMovement"
     WHERE "referenceEntityId"=$1 AND category='FINISHED_GOODS' AND "sourceDocType"='PACKING'`, [lotId])).n);

const reservedKg = async (itemId) => num((await one(
  `SELECT COALESCE(SUM("quantityKg"),0)::float8 n FROM "StockAllocation"
     WHERE "orderItemId"=$1 AND status='RESERVED'`, [itemId])).n);

/** The roasted-coffee availability explodeBom reports, read through the shipped API. */
async function bomRoastedAvailable() {
  const r = await api(`/api/products/${C.skus.bra1kg.id}/bom`);
  const line = (r.json?.perUnit ?? []).find((x) => x.type === "ROASTED_COFFEE");
  return num(line?.quantityAvailable ?? NaN);
}

async function main() {
  await db.connect();
  await teardown(P);
  await loginAs(ADMIN_PIN);
  C = await buildCatalog(P);

  // ═══════════════════════════════════════════════════════════════════════
  section("A — DISPATCHED STOCK MUST NOT COME BACK  (A-1)");

  sub("A1. roast 10, pack 6, dispatch 4, pack 4 more — the shelf holds 6, not 10");
  const bA = await stockBatch("A01", 12, 10, 2);
  const p1 = await pack(bA.id, { bags1kg: 6 });
  check("first pack accepted", p1.status === 200, `status=${p1.status} ${S(p1.json).slice(0, 110)}`);

  const lotA = await kgLot(bA.id);
  check("lot holds the 6 kg just packed", near(num(lotA.a), 6), `availableQty ${lotA.a}`);

  // Ship 4 kg off that lot through a legacy kilogram line.
  const lineA = await kgOrderLine("dispatch then repack", 4, C.coffees.brazil.id);
  const ship = await api("/api/deliveries", { method: "POST", body: {
    orderItemId: lineA.itemId, quantityKg: 4, deliveryType: "partial", finishedGoodsLotId: lotA.id,
  }});
  check("4 kg dispatched", ship.status === 201, `status=${ship.status} ${S(ship.json).slice(0, 110)}`);
  const afterShip = await kgLot(bA.id);
  check("shelf is down to 2 kg after the shipment", near(num(afterShip.a), 2), `availableQty ${afterShip.a}`);

  const p2 = await pack(bA.id, { bags1kg: 4 });
  check("second pack accepted", p2.status === 200, `status=${p2.status} ${S(p2.json).slice(0, 110)}`);

  const finalA = await kgLot(bA.id);
  console.log(`    packed 6 + 4 = 10, dispatched 4  ->  shelf ${finalA.a} kg`);
  check("THE DEFECT: shelf holds 6 kg, not the 10 kg ever packed",
    near(num(finalA.a), 6), `availableQty ${finalA.a} (10 means dispatched stock was resurrected)`);

  const netA = await ledgerNet(finalA.id);
  const inA = await packingIn(finalA.id);
  console.log(`    ledger: packed in ${inA}, net ${netA}`);
  check("ledger records 10 kg packed in", near(inA, 10), `packing IN ${inA}`);
  check("ledger net equals the lot balance", near(netA, num(finalA.a)), `net ${netA} vs lot ${finalA.a}`);

  // ═══════════════════════════════════════════════════════════════════════
  section("B — REPEATED PARTIAL PACKING ADDS DELTAS  (A-1)");

  sub("B1. roast 10; pack 2, then 3, then 1 — the lot tracks the running sum");
  const bB = await stockBatch("B01", 12, 10, 2);
  const steps = [2, 3, 1];
  let expected = 0;
  let okB = true;
  for (const step of steps) {
    const r = await pack(bB.id, { bags1kg: step });
    expected += step;
    const lot = await kgLot(bB.id);
    const ok = r.status === 200 && near(num(lot.a), expected);
    if (!ok) okB = false;
    console.log(`    +${step} kg -> status ${r.status}, shelf ${lot?.a} (expected ${expected})`);
  }
  check("every pack moved the shelf by exactly its own delta", okB, `expected ${expected}`);
  const lotB = await kgLot(bB.id);
  check("lot balance equals the sum of the deltas, not a re-derived total",
    near(num(lotB.a), 6), `availableQty ${lotB.a}`);
  check("ledger net agrees with the lot", near(await ledgerNet(lotB.id), num(lotB.a)), `net vs lot`);

  // ═══════════════════════════════════════════════════════════════════════
  section("C — TWO PACKERS, ONE BATCH  (A-2)");

  sub("C1. three concurrent 2 kg packs on the same roast");
  const bC = await stockBatch("C01", 12, 10, 2);
  const race = await concurrently(3, () => pack(bC.id, { bags1kg: 2 }));
  const okCount = race.filter((r) => r.status === 200).length;
  const codes = race.map((r) => r.status);
  console.log(`    statuses ${S(codes)}  ->  ${okCount} accepted`);

  check("no request died with a 500", race.every((r) => r.status !== 500), S(codes));

  const rowC = await batchRow(bC.id);
  const lotC = await kgLot(bC.id);
  const expectedKg = okCount * 2;
  console.log(`    bags1kg ${rowC.b1}, shelf ${lotC?.a}, roasted left ${rowC.rak}`);

  check(`bag counters record every accepted pack (${okCount} x 2 = ${expectedKg})`,
    num(rowC.b1) === okCount * 2, `bags1kg ${rowC.b1}, expected ${okCount * 2}`);
  check("shelf balance equals the accepted packs, with nothing lost",
    near(num(lotC.a), expectedKg), `availableQty ${lotC.a}, expected ${expectedKg}`);
  check("ledger net equals the shelf balance",
    near(await ledgerNet(lotC.id), num(lotC.a)), `net ${await ledgerNet(lotC.id)} vs lot ${lotC.a}`);
  check("roasted stock never went negative", num(rowC.rak) >= -0.0005, `roastedAvailableKg ${rowC.rak}`);
  check("coffee consumed never exceeded what was roasted",
    num(rowC.rak) <= num(rowC.rbq) + 0.0005 && expectedKg <= num(rowC.rbq) + 0.0005,
    `consumed ${expectedKg} of ${rowC.rbq}`);

  // ═══════════════════════════════════════════════════════════════════════
  section("D — PACKAGING CONSUMES ROASTED COFFEE  (B-1)");

  sub("D1. each pack draws its own weight out of the roasted balance");
  const bD = await stockBatch("D01", 12, 10, 2);
  const d0 = await batchRow(bD.id);
  check("a fresh roast starts with its whole output unpacked",
    near(num(d0.rak), 10), `roastedAvailableKg ${d0.rak}`);

  await pack(bD.id, { bags1kg: 4 });
  const d1 = await batchRow(bD.id);
  check("packing 4 kg leaves 6 kg of roasted coffee", near(num(d1.rak), 6), `roastedAvailableKg ${d1.rak}`);

  await pack(bD.id, { bags1kg: 3 });
  const d2 = await batchRow(bD.id);
  check("packing 3 kg more leaves 3 kg — partial packing preserves the remainder",
    near(num(d2.rak), 3), `roastedAvailableKg ${d2.rak}`);

  sub("D2. packing beyond the remaining roasted balance is refused, atomically");
  const lotDBefore = await kgLot(bD.id);
  const netDBefore = await ledgerNet(lotDBefore.id);
  const over = await pack(bD.id, { bags1kg: 5 });
  const d3 = await batchRow(bD.id);
  const lotDAfter = await kgLot(bD.id);
  console.log(`    over-pack -> ${over.status}; roasted left ${d3.rak}, shelf ${lotDAfter.a}`);
  check("the over-pack is refused with a 4xx", over.status >= 400 && over.status < 500,
    `status=${over.status} ${S(over.json).slice(0, 110)}`);
  check("roasted balance is untouched by the refused pack", near(num(d3.rak), 3), `roastedAvailableKg ${d3.rak}`);
  check("shelf is untouched by the refused pack",
    near(num(lotDAfter.a), num(lotDBefore.a)), `${lotDBefore.a} -> ${lotDAfter.a}`);
  check("no ledger row was left behind by the refused pack",
    near(await ledgerNet(lotDAfter.id), netDBefore), `net ${netDBefore} -> ${await ledgerNet(lotDAfter.id)}`);

  await invariants("after packaging arithmetic");

  // ═══════════════════════════════════════════════════════════════════════
  section("E — ONLY PACKABLE COFFEE COUNTS AS AVAILABLE  (L-1)");

  // Packability is the packaging domain's own rule, not a new one invented here: both
  // packaging routes admit exactly "Passed" and "Partially Packaged". Everything else is
  // either not yet cleared by QC, refused by it, or already consumed into a blend.
  sub("E1. a batch still awaiting QC is not packable stock");
  const e0 = await bomRoastedAvailable();
  await batchInStatus("E-PENDING", 5, "Pending QC");
  const e1 = await bomRoastedAvailable();
  console.log(`    availability ${e0} -> ${e1} after a 5 kg Pending QC batch`);
  check("Pending QC roasted coffee is not counted", near(e1, e0), `${e0} -> ${e1}`);

  sub("E2. a rejected batch is not packable stock");
  await batchInStatus("E-REJECTED", 5, "Rejected");
  const e2 = await bomRoastedAvailable();
  check("Rejected roasted coffee is not counted", near(e2, e0), `${e0} -> ${e2}`);

  sub("E3. a batch consumed into a blend is not packable stock");
  await batchInStatus("E-BLENDED", 5, "Blended");
  const e3 = await bomRoastedAvailable();
  check("Blended source coffee is not counted", near(e3, e0), `${e0} -> ${e3}`);

  sub("E4. a QC-passed batch IS packable stock");
  const ePass = await batchInStatus("E-PASSED", 5, "Passed");
  const e4 = await bomRoastedAvailable();
  console.log(`    availability ${e0} -> ${e4} after a 5 kg Passed batch`);
  check("Passed roasted coffee is counted", near(e4, e0 + 5), `${e0} -> ${e4}, expected ${e0 + 5}`);

  sub("E5. once packed out, it stops counting");
  const ePack = await pack(ePass, { bags1kg: 5 });
  const e5 = await bomRoastedAvailable();
  const ePassRow = await batchRow(ePass);
  console.log(`    pack -> ${ePack.status}; roasted left ${ePassRow.rak}; availability ${e4} -> ${e5}`);
  check("packing it out returns availability to the baseline", near(e5, e0), `${e4} -> ${e5}, expected ${e0}`);

  // ═══════════════════════════════════════════════════════════════════════
  section("F — PACKAGING VS A CONCURRENT CANCELLATION  (N-1)");

  sub("F1. a reservation must never survive on a cancelled order");
  let f5xx = 0;
  let cancelledRounds = 0;
  let violations = 0;
  for (let round = 1; round <= 4; round++) {
    const ln = await kgOrderLine(`cancel race ${round}`, 5, C.coffees.brazil.id);
    const b = await stockBatch(`F0${round}`, 7, 5, 2);
    await db.query('UPDATE "RoastingBatch" SET "orderItemId"=$1 WHERE id=$2', [ln.itemId, b.id]);

    const [packRes, cancelRes] = await Promise.all([
      pack(b.id, { bags1kg: 5 }),
      api(`/api/orders/${ln.orderId}/status`, { method: "POST", body: { action: "cancel", reason: `${P} race ${round}` } }),
    ]);
    if (packRes.status === 500 || cancelRes.status === 500) f5xx++;

    const status = (await one('SELECT status FROM "Order" WHERE id=$1', [ln.orderId])).status;
    const held = await reservedKg(ln.itemId);
    if (status === "Cancelled") {
      cancelledRounds++;
      if (!near(held, 0)) violations++;
    }
    console.log(`    round ${round}: pack ${packRes.status}, cancel ${cancelRes.status}, order ${status}, reserved ${held} kg`);
  }
  check("no request died with a 500 in the race", f5xx === 0, `${f5xx} server errors`);
  check(`no reservation survived on a cancelled order (${cancelledRounds} cancelled round(s))`,
    violations === 0, `${violations} round(s) left stock promised to a dead order`);

  // ═══════════════════════════════════════════════════════════════════════
  section("G — THE LOT'S SKU IS NOT CLIENT-CONTROLLED  (SEC-1)");

  sub("G1. a SKU belonging to another coffee is refused");
  const bG = await stockBatch("G01", 5, 3, 2);
  const wrong = await pack(bG.id, { bags1kg: 1, productSkuId: C.skus.eth1kg.id });
  console.log(`    Brazilian roast + Ethiopian SKU -> ${wrong.status}`);
  check("a mismatched SKU is refused with a 4xx", wrong.status >= 400 && wrong.status < 500,
    `status=${wrong.status} ${S(wrong.json).slice(0, 110)}`);
  check("nothing was packed by the refused request", (await kgLot(bG.id)) === undefined,
    "a lot was created for a refused pack");

  sub("G2. a SKU that does not exist is refused");
  const ghost = await pack(bG.id, { bags1kg: 1, productSkuId: `${P}-no-such-sku` });
  check("an unknown SKU is refused with a 4xx", ghost.status >= 400 && ghost.status < 500,
    `status=${ghost.status} ${S(ghost.json).slice(0, 110)}`);

  sub("G3. the batch's own SKU is accepted and recorded");
  const right = await pack(bG.id, { bags1kg: 3, productSkuId: C.skus.bra1kg.id });
  const lotG = await kgLot(bG.id);
  check("a matching SKU is accepted", right.status === 200, `status=${right.status} ${S(right.json).slice(0, 110)}`);
  check("the lot carries that SKU", lotG?.sku === C.skus.bra1kg.id, `productSkuId ${lotG?.sku}`);

  // ═══════════════════════════════════════════════════════════════════════
  section("H — LOCK ORDER, PROVED WITH BARRIERS  (not Promise.all timing)");

  // The kilogram packaging transaction inserts StockAllocation rows. An INSERT is not
  // lock-free: PostgreSQL's referential-integrity check takes FOR KEY SHARE on each
  // referenced parent row, and StockAllocation has foreign keys to OrderItem and to
  // FinishedGoodsLot. FOR KEY SHARE conflicts with FOR UPDATE — which is exactly what a
  // cancellation takes on both of those rows. So the edge is real, and what matters is
  // that packaging acquires them in the same direction cancellation does.
  // Sections A-G have already roasted their way through most of the fixture's green
  // coffee. Top it up before the barrier tests: a roast that fails for want of raw stock
  // would make every assertion below pass without the contended path ever being reached.
  await db.query('UPDATE "GreenBean" SET "quantityKg" = "quantityKg" + 300 WHERE id=$1', [C.beans.brazil.id]);

  sub("H1. packaging's allocation INSERT really does wait on an OrderItem FOR UPDATE");
  const h1 = await kgOrderLine("barrier oi", 5, C.coffees.brazil.id);
  const bH1 = await stockBatch("H01", 7, 5, 2);
  await db.query('UPDATE "RoastingBatch" SET "orderItemId"=$1 WHERE id=$2', [h1.itemId, bH1.id]);

  const releaseOi = await holdRow("OrderItem", h1.itemId);
  const packH1 = pack(bH1.id, { bags1kg: 5 });
  await sleep(700); // long enough that an unblocked request would already have answered
  const settledEarly = await Promise.race([packH1.then(() => true), sleep(120).then(() => false)]);
  check("packaging blocks while the order line is held — the FK wait edge is real",
    settledEarly === false, "packaging answered while the OrderItem row was locked");
  await releaseOi();
  const packH1Res = await packH1;
  console.log(`    after release -> pack ${packH1Res.status}`);
  check("and completes cleanly once the line is released, with no deadlock",
    packH1Res.status === 200, `status=${packH1Res.status} ${S(packH1Res.json).slice(0, 110)}`);

  sub("H2. packaging vs cancellation, both released from the same held row");
  const h2 = await kgOrderLine("barrier cancel", 5, C.coffees.brazil.id);
  const bH2 = await stockBatch("H02", 7, 5, 2);
  await db.query('UPDATE "RoastingBatch" SET "orderItemId"=$1 WHERE id=$2', [h2.itemId, bH2.id]);

  const releaseOi2 = await holdRow("OrderItem", h2.itemId);
  const packH2 = pack(bH2.id, { bags1kg: 5 });
  const cancelH2 = api(`/api/orders/${h2.orderId}/status`, {
    method: "POST", body: { action: "cancel", reason: `${P} barrier cancel` } });
  await sleep(700);           // both are now provably contending on the same OrderItem row
  await releaseOi2();
  const [pH2, cH2] = await Promise.all([packH2, cancelH2]);
  const stH2 = (await one('SELECT status FROM "Order" WHERE id=$1', [h2.orderId])).status;
  const heldH2 = await reservedKg(h2.itemId);
  console.log(`    pack ${pH2.status}, cancel ${cH2.status}, order ${stH2}, reserved ${heldH2} kg`);
  check("neither side deadlocked or timed out", !deadlocked(pH2, cH2),
    `pack ${pH2.status} ${S(pH2.json).slice(0, 80)} | cancel ${cH2.status}`);
  check("no reservation survived on the cancelled order",
    stH2 !== "Cancelled" || near(heldH2, 0), `order ${stH2}, reserved ${heldH2} kg`);
  const bH2row = await batchRow(bH2.id);
  const lotH2 = await kgLot(bH2.id);
  const packedH2 = pH2.status === 200;
  check("packaging was applied in full or not at all — never half",
    packedH2
      ? near(num(bH2row.rak), 0) && near(num(lotH2?.a ?? -1), 5)
      : near(num(bH2row.rak), 5) && lotH2 === undefined,
    `pack ${pH2.status}, roasted left ${bH2row.rak}, lot ${lotH2?.a}`);

  // The inversion this section exists for. Packaging takes the Order row last; roasting
  // takes the production order and only then the Order row. If packaging took Order BEFORE
  // the production order, these two would hold exactly what the other is waiting for.
  sub("H3. packaging vs a roast on the same production order — the PO/Order pair");
  const h3 = await api("/api/orders", { method: "POST", body: {
    customerId: C.customers.cafe.id, notes: `${P} po inversion`,
    items: [{ productSkuId: C.skus.bra1kg.id, quantityUnits: 6 },
            { productSkuId: C.skus.bra250.id, quantityUnits: 4 }],
  }});
  await api(`/api/orders/${h3.json.id}/approve`, { method: "POST", body: { decision: "Yes" } });
  await api(`/api/orders/${h3.json.id}/preparation-review`, { method: "POST", body: {
    items: h3.json.items.map((i) => ({ orderItemId: i.id })) } });
  const unitItem = h3.json.items[0].id;   // stays a SKU line — the roast targets this one
  const kgItem   = h3.json.items[1].id;   // becomes the kilogram line the packaging owns
  await db.query(
    `UPDATE "OrderItem" SET "quantityUnits"=NULL, "deliveredUnits"=0, "quantityKg"=5,
        "deliveredQty"=0, "productSkuId"=NULL, "productId"=$2,
        "preparationDecision"='Needs Production' WHERE id=$1`, [kgItem, C.coffees.brazil.id]);
  await db.query(`UPDATE "Order" SET status='Preparing', "approvalStatus"='Yes' WHERE id=$1`, [h3.json.id]);

  const poRes = await api(`/api/order-items/${unitItem}/production-requirement`, { method: "POST" });
  const poId = poRes.json?.productionOrder?.id;

  if (!poId) {
    check("H3 fixture: a production order was raised", false, S(poRes.json).slice(0, 160));
  } else {
    const bH3 = await stockBatch("H03", 7, 5, 2);
    await db.query('UPDATE "RoastingBatch" SET "orderItemId"=$1, "productionOrderId"=$2 WHERE id=$3',
      [kgItem, poId, bH3.id]);

    // Hold the production order: packaging must reach it BEFORE it takes the Order row,
    // and the roast reaches it before its own Order barrier. Both stall here.
    const releasePo = await holdRow("ProductionOrder", poId);
    const packH3 = pack(bH3.id, { bags1kg: 5 });
    const roastH3 = api("/api/roasting-batches", { method: "POST", body: {
      orderItemId: unitItem, greenBeanId: C.beans.brazil.id,
      greenBeanQuantity: 4, roastedBeanQuantity: 3, wasteQuantity: 1,
      productionOrderId: poId,
    }});
    await sleep(900);
    await releasePo();
    const [pH3, rH3] = await Promise.all([packH3, roastH3]);
    console.log(`    pack ${pH3.status}, roast ${rH3.status}`);
    // Both sides must actually SUCCEED. If either fails for an unrelated reason — no green
    // coffee, a rejected production order — then neither ever reached the contended pair
    // and the deadlock assertion below would pass without testing anything.
    check("the packaging actually ran (so the contended path was reached)",
      pH3.status === 200, `status=${pH3.status} ${S(pH3.json).slice(0, 120)}`);
    check("the competing roast actually ran (so the contended path was reached)",
      rH3.status === 201, `status=${rH3.status} ${S(rH3.json).slice(0, 120)}`);
    check("no deadlock between packaging and a roast on the same production order",
      !deadlocked(pH3, rH3),
      `pack ${pH3.status} ${S(pH3.json).slice(0, 90)} | roast ${rH3.status} ${S(rH3.json).slice(0, 90)}`);
    // Both transactions touched the production order; it must still reconcile.
    const poAfter = await one('SELECT status FROM "ProductionOrder" WHERE id=$1', [poId]);
    check("the production order survived both transactions in a legal state",
      ["PENDING", "IN_PRODUCTION", "COMPLETED", "CANCELLED"].includes(poAfter?.status),
      `status ${poAfter?.status}`);
  }

  await invariants("after the lock-order barriers");

  await invariants("after the packaging stock suite");

  section("PACKAGING STOCK RESULT");
  console.log(`${results.pass} passed, ${results.fail} failed`);
  if (results.failures.length) console.log("FAILURES:\n  - " + results.failures.join("\n  - "));
  await db.end();
  process.exit(results.fail === 0 ? 0 : 1);
}

main().catch(async (e) => { console.log("FATAL:", e?.stack || e); try { await db.end(); } catch {} process.exit(1); });
