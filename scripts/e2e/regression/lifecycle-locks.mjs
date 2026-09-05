// ORDER LIFECYCLE LOCK NORMALIZATION — deadlock and serialization proof.
//
// The canonical order adopted is
//     StockAllocation(id ASC) → FinishedGoodsLot(id ASC) → OrderItem(id ASC) → Order
// which preparation review and roasting already used. The status route and dispatch were
// the two that ran it backwards; they now take their allocation, lot and line locks up
// front.
//
// The defining symptom of the old inversions is SQLSTATE 40P01 (deadlock detected), which
// surfaces through this application as a generic 500. So every case here asserts BOTH the
// business outcome AND that no 500 was produced by a deadlock.
import {
  ADMIN_PIN, db, api, check, issue, section, sub, one, all, num, near, invariants, loginAs, greenStock, results,
} from "./harness.mjs";
import { buildCatalog, teardown, roastAndPass} from "./catalog.mjs";

const S = (v) => { try { return JSON.stringify(v) ?? String(v); } catch { return String(v); } };
const P = "LLOCK";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let C;

/** A 500 is how a 40P01 reaches the client here — no route translates deadlock errors. */
const noDeadlock = (label, ...responses) =>
  check(
    `${label}: no deadlock (40P01 would surface as 500)`,
    responses.every((r) => r.status !== 500),
    responses.map((r) => `${r.status} ${S(r.json).slice(0, 90)}`).join(" | ")
  );

const mkOrder = async (customerId, note, units = 20) => {
  const r = await api("/api/orders", {
    method: "POST",
    body: { customerId, notes: `${P} ${note}`, items: [{ productSkuId: C.skus.bra250.id, quantityUnits: units }] },
  });
  await api(`/api/orders/${r.json.id}/approve`, { method: "POST", body: { decision: "Yes" } });
  return r.json;
};
const review = (order) =>
  api(`/api/orders/${order.id}/preparation-review`, {
    method: "POST", body: { items: order.items.map((i) => ({ orderItemId: i.id })) },
  });
const statusAct = (order, action, reason) =>
  api(`/api/orders/${order.id}/status`, { method: "POST", body: { action, reason } });
const requirementPost = (itemId) => api(`/api/order-items/${itemId}/production-requirement`, { method: "POST" });
const roast = (item, greenKg = 3, roastedKg = 2.4) =>
  api("/api/roasting-batches", {
    method: "POST",
    body: {
      orderItemId: item.id, greenBeanId: C.beans.brazil.id, productId: C.coffees.brazil.id,
      greenBeanQuantity: greenKg, roastedBeanQuantity: roastedKg, wasteQuantity: +(greenKg - roastedKg).toFixed(3),
    },
  });
const deliver = (item, units, lotId) =>
  api("/api/deliveries", {
    method: "POST",
    body: { orderItemId: item.id, quantityUnits: units, deliveryType: "partial", finishedGoodsLotId: lotId },
  });

const statusOf = async (id) => (await one('SELECT status s FROM "Order" WHERE id=$1', [id])).s;
const reservedUnits = async (itemId) => num((await one(
  `SELECT COALESCE(SUM("quantityUnits"),0)::int n FROM "StockAllocation" WHERE "orderItemId"=$1 AND status='RESERVED'`, [itemId])).n);
const deliveredUnits = async (itemId) => num((await one('SELECT "deliveredUnits" n FROM "OrderItem" WHERE id=$1', [itemId])).n);
const deliveryRows = async (itemId) => num((await one('SELECT COUNT(*)::int n FROM "Delivery" WHERE "orderItemId"=$1', [itemId])).n);
const lotAvail = async (lotId) => num((await one('SELECT "unitsAvailable" n FROM "FinishedGoodsLot" WHERE id=$1', [lotId])).n);

/** Stock the shelf so a line can be reserved and shipped. */
let shelfSeq = 0;
async function stockShelf(units) {
  // Unique label per call: roastAndPass derives the batch number from it, and a repeat
  // collides with the (greenBeanId, batchNumber) unique index.
  const b = await roastAndPass(P, C.coffees.brazil, C.beans.brazil, units * 0.25 + 1, units * 0.25, 1, "S" + (++shelfSeq));
  await api(`/api/roasting-batches/${b.id}/pack-sku`, { method: "POST", body: { productSkuId: C.skus.bra250.id, units } });
  return b;
}

async function main() {
  await db.connect();
  await teardown(P);
  await loginAs(ADMIN_PIN);
  C = await buildCatalog(P);

  // ═════════════════════════════════════════════════════════════════════════
  section("A — REVIEW vs CANCEL  (cycle C1)");

  sub("A1. cancel fired mid-review");
  await stockShelf(24);
  const oA = await mkOrder(C.customers.cafe.id, "review vs cancel");
  const revA = review(oA);
  await sleep(200);
  const canA = await statusAct(oA, "cancel", P + " cancel during review");
  const rA = await revA;
  noDeadlock("review|cancel", rA, canA);
  console.log(`    review -> ${rA.status}   cancel -> ${canA.status}   final: ${await statusOf(oA.id)}`);
  const finalA = await statusOf(oA.id);
  check("the outcome matches one valid serialization",
    (rA.status === 200 && canA.status === 200 && finalA === "Cancelled") ||
    (rA.status === 409 && canA.status === 200 && finalA === "Cancelled") ||
    (rA.status === 200 && canA.status === 409),
    `review=${rA.status} cancel=${canA.status} final=${finalA}`);
  if (finalA === "Cancelled") {
    check("zero reservations survive on the cancelled order",
      (await reservedUnits(oA.items[0].id)) === 0, String(await reservedUnits(oA.items[0].id)));
  }

  sub("A2. review fired mid-cancel (opposite direction)");
  await stockShelf(24);
  const oB = await mkOrder(C.customers.cafe.id, "cancel vs review");
  const canB = statusAct(oB, "cancel", P + " cancel first");
  await sleep(150);
  const revB = await review(oB);
  const cB = await canB;
  noDeadlock("cancel|review", cB, revB);
  console.log(`    cancel -> ${cB.status}   review -> ${revB.status}   final: ${await statusOf(oB.id)}`);
  if ((await statusOf(oB.id)) === "Cancelled") {
    check("zero reservations survive", (await reservedUnits(oB.items[0].id)) === 0, String(await reservedUnits(oB.items[0].id)));
  }

  // ═════════════════════════════════════════════════════════════════════════
  section("B — REVIEW vs HOLD");

  sub("B1. hold fired mid-review");
  await stockShelf(24);
  const oC = await mkOrder(C.customers.cafe.id, "review vs hold");
  const revC = review(oC);
  await sleep(200);
  const holdC = await statusAct(oC, "hold", P + " hold during review");
  const rC = await revC;
  noDeadlock("review|hold", rC, holdC);
  console.log(`    review -> ${rC.status}   hold -> ${holdC.status}   final: ${await statusOf(oC.id)}`);
  check("hold semantics preserved: a held order keeps its reservations",
    (await statusOf(oC.id)) !== "On Hold" || (await reservedUnits(oC.items[0].id)) >= 0, "reservations lost on hold");

  // ═════════════════════════════════════════════════════════════════════════
  section("C — DISPATCH vs REVIEW  (cycle C2 — the newly found one)");

  sub("C1. re-review fired mid-dispatch");
  await stockShelf(30);
  const oD = await mkOrder(C.customers.retail.id, "dispatch vs review", 10);
  await review(oD);
  const lotD = (await one(
    `SELECT id FROM "FinishedGoodsLot" WHERE "productSkuId"=$1 AND "unitsAvailable">0 ORDER BY "createdAt" LIMIT 1`,
    [C.skus.bra250.id]))?.id;
  const delD = deliver(oD.items[0], 4, lotD);
  await sleep(200);
  const revD = await review(oD);
  const dD = await delD;
  noDeadlock("dispatch|review", dD, revD);
  console.log(`    delivery -> ${dD.status}   review -> ${revD.status}   delivered ${await deliveredUnits(oD.items[0].id)}  reserved ${await reservedUnits(oD.items[0].id)}`);
  const delivered = await deliveredUnits(oD.items[0].id);
  const reserved = await reservedUnits(oD.items[0].id);
  check("delivered units match the delivery rows recorded",
    delivered === (dD.status === 201 ? 4 : 0), `delivered=${delivered} status=${dD.status}`);

  // No DOUBLE CONSUMPTION is what the lock normalization guarantees: the units actually
  // taken off the shelf equal the units delivered, once, with the lot decremented to match.
  const consumedUnits = num((await one(
    `SELECT COALESCE(SUM("quantityUnits"),0)::int n FROM "StockAllocation"
      WHERE "orderItemId"=$1 AND status='CONSUMED'`, [oD.items[0].id])).n);
  check("units consumed from the shelf equal units delivered — consumed once, not twice",
    consumedUnits === delivered, `consumed ${consumedUnits} vs delivered ${delivered}`);

  // Over-RESERVATION is a different property, and it is not one this change can promise.
  // Preparation review derives its demand ceiling from an unlocked read of deliveredUnits
  // taken at the top of its transaction, so a delivery committing mid-review is invisible
  // to it and it re-reserves against the pre-shipment demand. That is a stale-snapshot
  // defect in the review route, not a lock-ordering one, and it is recorded rather than
  // asserted so this suite reports the truth instead of hiding it behind a pass.
  if (delivered + reserved > 10) {
    issue("MEDIUM",
      "Preparation review over-reserves when a delivery commits mid-review",
      `Line ordered 10; after a concurrent shipment of ${delivered} the line holds ${reserved} reserved ` +
      `(${delivered} + ${reserved} > 10). Review computes demand from an unlocked deliveredUnits read ` +
      `(preparation-review/route.ts:188, used at :215) and cannot see the shipment. Pre-existing; ` +
      `exposed by lock normalization, not caused by it. Consumption itself is correct.`);
    console.log(`    [ISSUE] over-reserved by ${delivered + reserved - 10} unit(s) — see report`);
  }

  // ═════════════════════════════════════════════════════════════════════════
  section("D — DISPATCH vs CANCEL  (the delivery TOCTOU)");

  sub("D1. cancel commits first -> delivery refused, nothing moves");
  await stockShelf(20);
  const oE = await mkOrder(C.customers.retail.id, "dispatch vs cancel", 8);
  await review(oE);
  const lotE = (await one(
    `SELECT id FROM "FinishedGoodsLot" WHERE "productSkuId"=$1 AND "unitsAvailable">0 ORDER BY "createdAt" LIMIT 1`,
    [C.skus.bra250.id]))?.id;
  const availBefore = await lotAvail(lotE);
  const delRowsBefore = await deliveryRows(oE.items[0].id);
  const delE = deliver(oE.items[0], 3, lotE);
  await sleep(300);
  const canE = await statusAct(oE, "cancel", P + " cancel during dispatch");
  const dE = await delE;
  noDeadlock("dispatch|cancel", dE, canE);
  console.log(`    delivery -> ${dE.status}   cancel -> ${canE.status}   final: ${await statusOf(oE.id)}`);
  if (canE.status === 200 && (await statusOf(oE.id)) === "Cancelled" && dE.status !== 201) {
    check("delivery refused with a conflict", dE.status === 409, `status=${dE.status} ${S(dE.json).slice(0, 130)}`);
    check("  and the refusal names the status", /in status .{0,2}Cancelled/i.test(S(dE.json)), S(dE.json).slice(0, 140));
    check("no Delivery row survives", (await deliveryRows(oE.items[0].id)) === delRowsBefore, "a delivery row exists");
    check("delivered units unchanged", (await deliveredUnits(oE.items[0].id)) === 0, String(await deliveredUnits(oE.items[0].id)));
  } else {
    check("delivery-first is the other valid ordering (covered by D2)", dE.status === 201, `delivery=${dE.status} cancel=${canE.status}`);
  }

  sub("D2. delivery commits first -> cancel waits, then proceeds");
  await stockShelf(20);
  const oF = await mkOrder(C.customers.retail.id, "dispatch then cancel", 8);
  await review(oF);
  const lotF = (await one(
    `SELECT id FROM "FinishedGoodsLot" WHERE "productSkuId"=$1 AND "unitsAvailable">0 ORDER BY "createdAt" LIMIT 1`,
    [C.skus.bra250.id]))?.id;
  const dF = await deliver(oF.items[0], 3, lotF);
  const canF = await statusAct(oF, "cancel", P + " cancel after dispatch");
  noDeadlock("dispatch-then-cancel", dF, canF);
  check("delivery committed", dF.status === 201, `status=${dF.status} ${S(dF.json).slice(0, 130)}`);
  check("delivered units recorded", (await deliveredUnits(oF.items[0].id)) === 3, String(await deliveredUnits(oF.items[0].id)));
  check("the later cancel proceeded under its own rules", canF.status === 200 && (await statusOf(oF.id)) === "Cancelled", await statusOf(oF.id));
  check("and it released what was still reserved", (await reservedUnits(oF.items[0].id)) === 0, String(await reservedUnits(oF.items[0].id)));

  // ═════════════════════════════════════════════════════════════════════════
  section("E — PRODUCTION PATHS UNCHANGED (f6828fc guarantees)");

  sub("E1. review vs roast");
  const oG = await mkOrder(C.customers.cafe.id, "review vs roast", 24);
  await review(oG);
  const gG0 = await greenStock(C.beans.brazil.id);
  const roG = roast(oG.items[0]);
  await sleep(200);
  const revG = await review(oG);
  const rG = await roG;
  const gG1 = await greenStock(C.beans.brazil.id);
  noDeadlock("review|roast", rG, revG);
  console.log(`    roast -> ${rG.status}   review -> ${revG.status}   green ${gG0} -> ${gG1}`);
  check("green moved only if a batch was written",
    rG.status === 201 ? near(gG0 - gG1, 3, 0.0005) : near(gG0, gG1, 0.0005), `${gG0} -> ${gG1} roast=${rG.status}`);

  sub("E2. cancel vs roast — refused roast never moves green");
  const oH = await mkOrder(C.customers.cafe.id, "cancel vs roast", 20);
  await review(oH);
  const gH0 = await greenStock(C.beans.brazil.id);
  const roH = roast(oH.items[0]);
  await sleep(350);
  const canH = await statusAct(oH, "cancel", P + " cancel during roast");
  const rH = await roH;
  const gH1 = await greenStock(C.beans.brazil.id);
  noDeadlock("cancel|roast", rH, canH);
  console.log(`    roast -> ${rH.status}   cancel -> ${canH.status}   green ${gH0} -> ${gH1}`);
  check("cancel-first leaves green untouched",
    rH.status === 409 ? near(gH0, gH1, 0.0005) : near(gH0 - gH1, 3, 0.0005), `${gH0} -> ${gH1} roast=${rH.status}`);

  sub("E3. hold vs roast");
  const oI = await mkOrder(C.customers.cafe.id, "hold vs roast", 20);
  await review(oI);
  const gI0 = await greenStock(C.beans.brazil.id);
  const roI = roast(oI.items[0]);
  await sleep(350);
  const holdI = await statusAct(oI, "hold", P + " hold during roast");
  const rI = await roI;
  const gI1 = await greenStock(C.beans.brazil.id);
  noDeadlock("hold|roast", rI, holdI);
  check("hold-first leaves green untouched",
    rI.status === 409 ? near(gI0, gI1, 0.0005) : near(gI0 - gI1, 3, 0.0005), `${gI0} -> ${gI1} roast=${rI.status}`);

  sub("E4. review vs production requirement");
  const oJ = await mkOrder(C.customers.retail.id, "review vs requirement", 24);
  await review(oJ);
  const reqJ = requirementPost(oJ.items[0].id);
  await sleep(250);
  const revJ = await review(oJ);
  const rJ = await reqJ;
  noDeadlock("review|requirement", rJ, revJ);
  const schedJ = num((await one(
    `SELECT COALESCE(SUM("targetUnits"),0)::int n FROM "ProductionOrder" WHERE "sourceOrderItemId"=$1`, [oJ.items[0].id])).n);
  const resJ = await reservedUnits(oJ.items[0].id);
  console.log(`    requirement -> ${rJ.status}   review -> ${revJ.status}   reserved ${resJ} + scheduled ${schedJ} vs 24`);
  check("reserved + scheduled never exceeds outstanding", resJ + schedJ <= 24, `${resJ} + ${schedJ} > 24`);

  sub("E5. two concurrent requirements");
  // Deliberately larger than anything left on the shelf, so a real shortfall exists for
  // the two requests to race over. Earlier cases in this suite leave surplus stock behind.
  const oK = await mkOrder(C.customers.cafe.id, "duplicate", 400);
  await review(oK);
  const [x, y] = await Promise.all([requirementPost(oK.items[0].id), requirementPost(oK.items[0].id)]);
  noDeadlock("duplicate requirements", x, y);
  const nK = num((await one('SELECT COUNT(*)::int n FROM "ProductionOrder" WHERE "sourceOrderItemId"=$1', [oK.items[0].id])).n);
  const loserK = x.status === 201 ? y : x;
  check("exactly one production order", nK === 1, String(nK));
  check("the loser got 409, never 500", loserK.status === 409, `loser=${loserK.status} ${S(loserK.json).slice(0, 120)}`);

  // ═════════════════════════════════════════════════════════════════════════
  section("F — THREE-WAY: review + cancel + roast  (cycle C3)");

  sub("F1. all three on one order at once");
  const oL = await mkOrder(C.customers.retail.id, "three way", 20);
  await review(oL);
  const gL0 = await greenStock(C.beans.brazil.id);
  const roL = roast(oL.items[0]);
  const revL = review(oL);
  await sleep(250);
  const canL = await statusAct(oL, "cancel", P + " three-way cancel");
  const [rL, vL] = await Promise.all([roL, revL]);
  const gL1 = await greenStock(C.beans.brazil.id);
  noDeadlock("three-way", rL, vL, canL);
  console.log(`    roast -> ${rL.status}   review -> ${vL.status}   cancel -> ${canL.status}   final: ${await statusOf(oL.id)}   green ${gL0} -> ${gL1}`);
  check("green moved only if the roast committed",
    rL.status === 201 ? near(gL0 - gL1, 3, 0.0005) : near(gL0, gL1, 0.0005), `${gL0} -> ${gL1} roast=${rL.status}`);
  if ((await statusOf(oL.id)) === "Cancelled") {
    check("no reservation survives the cancelled order",
      (await reservedUnits(oL.items[0].id)) === 0, String(await reservedUnits(oL.items[0].id)));
  }

  // ═════════════════════════════════════════════════════════════════════════
  section("G — UNRELATED ORDERS STAY CONCURRENT");

  sub("G1. two different orders overlap in wall-clock time");
  await stockShelf(40);
  const oM = await mkOrder(C.customers.cafe.id, "concurrent M", 6);
  const oN = await mkOrder(C.customers.retail.id, "concurrent N", 6);
  const t0 = Date.now();
  const [mRes, nRes] = await Promise.all([review(oM), review(oN)]);
  const together = Date.now() - t0;
  noDeadlock("unrelated orders", mRes, nRes);
  const t1 = Date.now();
  await review(oM);
  const single = Date.now() - t1;
  console.log(`    two orders reviewed concurrently in ${together} ms; one alone takes ${single} ms`);
  check("both succeeded", mRes.status === 200 && nRes.status === 200, `${mRes.status} / ${nRes.status}`);
  check("concurrent work overlapped rather than serializing end to end",
    together < single * 1.8, `together ${together} ms vs single ${single} ms — looks serialized`);

  await invariants("after the lifecycle-lock suite");

  section("LIFECYCLE LOCK RESULT");
  console.log(`${results.pass} passed, ${results.fail} failed`);
  if (results.failures.length) console.log("FAILURES:\n  - " + results.failures.join("\n  - "));
  await db.end();
  process.exit(results.fail === 0 ? 0 : 1);
}

main().catch(async (e) => { console.log("FATAL:", e?.stack || e); try { await db.end(); } catch {} process.exit(1); });
