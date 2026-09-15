// PRODUCTION & DEMAND INTEGRITY — R2.4.
//
// The canonical demand calculation is already correct. outstandingDemandForItem is
//
//     max(0, orderedUnits − deliveredUnits − reservedUnits − scheduledUnits)
//
// in UNITS, with CANCELLED production orders excluded and a completed one contributing only
// max(0, targetUnits − producedUnits). Nothing here rewrites that, and sections A–F exist to
// pin it down so a later wave cannot quietly drift away from it.
//
// What this suite is really about is everything that DOES NOT use it.
//
// ── The roasting surplus gate keeps its own arithmetic ──────────────────────
// roasting-batches/route.ts computes ceiling = OrderItem.quantityKg − reservedForItem(...)
// and compares it against the sum of roastedBeanQuantity. Three things are wrong with that
// as a coverage test: it never subtracts delivered, it never subtracts production already
// scheduled, and reservedForItem only sums allocations whose quantityUnits IS NULL — so for
// a SKU line, whose allocations are all unit-denominated, the reserved term is always zero.
// A line that is fully covered by reservations still reads as needing its whole order
// roasted again.
//
// ── The production screen mixes green with finished ─────────────────────────
// production/page.tsx sums greenBeanQuantity and subtracts it from quantityKg in three
// places, and one of them feeds the result straight back into the green-weight input. Green
// is the coffee that goes into the roaster and finished is what comes out; roasting always
// loses weight, so these are never the same number.
//
// ── Batches lose their production order ─────────────────────────────────────
// The same screen never sends productionOrderId — the identifier appears nowhere in the
// file — so a roast started against a production order is stored with no link back to it.
import {
  ADMIN_PIN, db, api, check, section, sub, one, all, num, near, invariants, loginAs, results,
  ensureUser, Client, DB_URL,
} from "./harness.mjs";
import { buildCatalog, teardown, roastAndPass } from "./catalog.mjs";

const S = (v) => { try { return JSON.stringify(v) ?? String(v); } catch { return String(v); } };
const P = "PRD2";
let C;

// The surplus gate ends in "Only an admin can authorize surplus production", so an admin is
// deliberately allowed through it. Testing the gate as the seeded administrator would
// therefore prove nothing at all — it has to be exercised by an ordinary roaster.
const ROASTER_PIN = "770031";
const asRoaster = () => loginAs(ROASTER_PIN);
const asAdmin = () => loginAs(ADMIN_PIN);

// ── helpers ────────────────────────────────────────────────────────────────
const topUpGreen = (beanId, kg) =>
  db.query('UPDATE "GreenBean" SET "quantityKg" = "quantityKg" + $2 WHERE id=$1', [beanId, kg]);

async function orderFor(skuId, units, note, { review = true } = {}) {
  const r = await api("/api/orders", {
    method: "POST",
    body: { customerId: C.customers.cafe.id, notes: `${P} ${note}`,
            items: [{ productSkuId: skuId, quantityUnits: units }] },
  });
  if (r.status !== 201) throw new Error(`order create failed: ${S(r.json)}`);
  await api(`/api/orders/${r.json.id}/approve`, { method: "POST", body: { decision: "Yes" } });
  if (review) {
    await api(`/api/orders/${r.json.id}/preparation-review`, {
      method: "POST", body: { items: r.json.items.map((i) => ({ orderItemId: i.id })) },
    });
  }
  return r.json;
}

const requirement = (itemId) => api(`/api/order-items/${itemId}/production-requirement`);
const scheduleProduction = (itemId) =>
  api(`/api/order-items/${itemId}/production-requirement`, { method: "POST" });

async function stockRoast(coffee, bean, label, greenKg = 12, roastedKg = 10) {
  await topUpGreen(bean.id, greenKg);
  const b = await roastAndPass(P, coffee, bean, greenKg, roastedKg, greenKg - roastedKg, label);
  if (!b.id) throw new Error(`stock roast failed: ${S(b.error?.json ?? b)}`);
  return b.id;
}

const packSku = (batchId, skuId, units) =>
  api(`/api/roasting-batches/${batchId}/pack-sku`, { method: "POST", body: { productSkuId: skuId, units } });

/**
 * Raise a roast against an order line, exactly as the production screen does.
 *
 * Deliberately does NOT top the green lot up itself. A refused roast would otherwise leave
 * the top-up behind, and a "no green was consumed" assertion would then be comparing
 * against a baseline taken before it — reporting a consumption that never happened.
 * Callers top up first, then take their baseline.
 */
let roastSeq = 0;
const roastFor = async (orderItem, bean, greenKg, roastedKg, extra = {}) => {
  const r = await api("/api/roasting-batches", {
    method: "POST",
    body: {
      orderItemId: orderItem.id, greenBeanId: bean.id,
      greenBeanQuantity: greenKg, roastedBeanQuantity: roastedKg,
      wasteQuantity: greenKg - roastedKg,
      ...extra,
    },
  });
  // Stamp the suite prefix on anything that was actually created. The API numbers batches by
  // date, and teardown finds them by batchNumber — without this an order-backed batch is
  // reachable only through the OrderItem cascade, which then runs into the PackagingOperation
  // RESTRICT the moment the batch has been packed. Every other helper here renames for the
  // same reason.
  if (r.status === 201 && r.json?.id) {
    await db.query('UPDATE "RoastingBatch" SET "batchNumber"=$2 WHERE id=$1',
      [r.json.id, `${P}-R${++roastSeq}`]);
  }
  return r;
};

const greenStockOf = async (beanId) =>
  num((await one('SELECT "quantityKg" q FROM "GreenBean" WHERE id=$1', [beanId])).q);

const batchesFor = (orderItemId) => all(
  `SELECT id, "productionOrderId" poid, "greenBeanQuantity" g, "roastedBeanQuantity" r
     FROM "RoastingBatch" WHERE "orderItemId"=$1`, [orderItemId]);

async function main() {
  await db.connect();
  await teardown(P);
  await db.query('DELETE FROM "ProductionOrder" WHERE id LIKE $1', [P + "_%"]);
  await loginAs(ADMIN_PIN);
  C = await buildCatalog(P);

  await ensureUser(`${P}_emp_roaster`, `${P} Roaster`, "production", {
    dashboard: { access: "edit" },
    production: { access: "edit", sub: { start_batch: true, cancel_batch: true } },
  }, ROASTER_PIN);

  // ═══════════════════════════════════════════════════════════════════════
  section("A — RESERVED STOCK REDUCES WHAT STILL HAS TO BE PRODUCED");

  sub("A1. the canonical calculation subtracts reservations");
  const preA = await stockRoast(C.coffees.brazil, C.beans.brazil, "A00");
  await packSku(preA, C.skus.bra1kg.id, 4);
  const oA = await orderFor(C.skus.bra1kg.id, 10, "reserved reduces need");
  const reqA = await requirement(oA.items[0].id);
  console.log(`    ${S(reqA.json).slice(0, 170)}`);
  check("4 units are reserved from the shelf", num(reqA.json?.reservedUnits) === 4,
    `reservedUnits=${reqA.json?.reservedUnits}`);
  check("nothing is scheduled yet", num(reqA.json?.scheduledUnits) === 0,
    `scheduledUnits=${reqA.json?.scheduledUnits}`);
  check("the shortfall is 6, not 10", num(reqA.json?.shortfallUnits) === 6,
    `shortfallUnits=${reqA.json?.shortfallUnits}`);

  sub("A2. and the ROASTING GATE must respect the same coverage");
  // The gate is the defect. Its ceiling is quantityKg minus reservedForItem(), and
  // reservedForItem only counts allocations with quantityUnits IS NULL — every allocation
  // on a SKU line is unit-denominated, so the reserved term silently evaluates to zero and
  // the gate believes the whole order still has to be roasted.
  const skuKgA = C.skus.bra1kg.grams / 1000;              // finished kg per unit
  const coveredKg = 4 * skuKgA;                            // 4 units already reserved
  const orderedKg = 10 * skuKgA;
  const overRoast = +(orderedKg - coveredKg + 1).toFixed(3); // 1 kg beyond the real shortfall
  await topUpGreen(C.beans.brazil.id, overRoast + 3);
  await asRoaster();
  const gateA = await roastFor(oA.items[0], C.beans.brazil, overRoast + 3, overRoast);
  await asAdmin();
  console.log(`    roast ${overRoast}kg roasted against a ${orderedKg}kg order with ${coveredKg}kg reserved -> ${gateA.status} ${S(gateA.json).slice(0, 120)}`);
  check("roasting past the covered shortfall is refused", gateA.status === 422,
    `status=${gateA.status} ${S(gateA.json).slice(0, 140)}`);
  check("and no batch was created for the line", (await batchesFor(oA.items[0].id)).length === 0,
    `${(await batchesFor(oA.items[0].id)).length} batches`);

  // ═══════════════════════════════════════════════════════════════════════
  section("B — SCHEDULED PRODUCTION REDUCES WHAT STILL HAS TO BE PRODUCED");

  sub("B1. an open production order counts as coverage");
  const oB = await orderFor(C.skus.eth250.id, 10, "scheduled reduces need");
  const schedB = await scheduleProduction(oB.items[0].id);
  check("a production order is raised", schedB.status === 201, S(schedB.json).slice(0, 130));
  check("it targets the full 10", num(schedB.json?.productionOrder?.targetUnits) === 10,
    `targetUnits=${schedB.json?.productionOrder?.targetUnits}`);

  const reqB = await requirement(oB.items[0].id);
  check("10 units now read as scheduled", num(reqB.json?.scheduledUnits) === 10,
    `scheduledUnits=${reqB.json?.scheduledUnits}`);
  check("and the shortfall is nil", num(reqB.json?.shortfallUnits) === 0,
    `shortfallUnits=${reqB.json?.shortfallUnits}`);

  sub("B2. a second attempt cannot schedule the same demand again");
  const schedB2 = await scheduleProduction(oB.items[0].id);
  check("refused with 409", schedB2.status === 409, `status=${schedB2.status} ${S(schedB2.json).slice(0, 130)}`);
  const posB = await all('SELECT id FROM "ProductionOrder" WHERE "sourceOrderItemId"=$1', [oB.items[0].id]);
  check("still exactly one production order", posB.length === 1, `${posB.length} orders`);

  sub("B3. the ROASTING GATE must not ignore scheduled production either");
  const skuKgB = C.skus.eth250.grams / 1000;
  await topUpGreen(C.beans.ethiopia.id, 10 * skuKgB + 3);
  await asRoaster();
  const gateB = await roastFor(oB.items[0], C.beans.ethiopia, 10 * skuKgB + 3, 10 * skuKgB);
  await asAdmin();
  console.log(`    roast the whole order again while 10 units are on an open PO -> ${gateB.status} ${S(gateB.json).slice(0, 120)}`);
  check("roasting a fully scheduled line again is refused", gateB.status === 422,
    `status=${gateB.status} ${S(gateB.json).slice(0, 140)}`);

  // ═══════════════════════════════════════════════════════════════════════
  section("C — A CANCELLED PRODUCTION ORDER COVERS NOTHING");

  sub("C1. cancelling returns the demand");
  const poB = schedB.json.productionOrder;
  const cancelB = await api(`/api/production-orders/${poB.id}/status`,
    { method: "POST", body: { action: "cancel", reason: `${P} test` } });
  check("the production order is cancelled", cancelB.status === 200, S(cancelB.json).slice(0, 120));
  const reqC = await requirement(oB.items[0].id);
  check("scheduled drops back to 0", num(reqC.json?.scheduledUnits) === 0,
    `scheduledUnits=${reqC.json?.scheduledUnits}`);
  check("the full 10 are outstanding again", num(reqC.json?.shortfallUnits) === 10,
    `shortfallUnits=${reqC.json?.shortfallUnits}`);

  // ═══════════════════════════════════════════════════════════════════════
  section("D — PRODUCED UNITS ARE NOT COUNTED TWICE");

  sub("D1. a production order that has produced part of its target covers only the rest");
  const oD = await orderFor(C.skus.idn250.id, 12, "no double count");
  const schedD = await scheduleProduction(oD.items[0].id);
  const poD = schedD.json.productionOrder;
  check("12 scheduled", num((await requirement(oD.items[0].id)).json?.scheduledUnits) === 12,
    S((await requirement(oD.items[0].id)).json?.scheduledUnits));

  // Produce 5 of the 12 through the production order.
  const batchD = await stockRoast(C.coffees.indonesia, C.beans.indonesia, "D01", 6, 5);
  await api(`/api/production-orders/${poD.id}/batches`, { method: "POST", body: { roastingBatchId: batchD } });
  await packSku(batchD, C.skus.idn250.id, 5);

  const reqD = await requirement(oD.items[0].id);
  console.log(`    ${S(reqD.json).slice(0, 190)}`);
  const covered = num(reqD.json?.reservedUnits) + num(reqD.json?.scheduledUnits);
  check("the 5 produced units are counted once, not as both stock and schedule",
    covered === 12,
    `reserved=${reqD.json?.reservedUnits} + scheduled=${reqD.json?.scheduledUnits} = ${covered}, expected 12`);
  check("so the line is fully covered and nothing more is outstanding",
    num(reqD.json?.shortfallUnits) === 0, `shortfallUnits=${reqD.json?.shortfallUnits}`);

  // ═══════════════════════════════════════════════════════════════════════
  section("E — A UNIT LINE FULLY COVERED BY RESERVATIONS NEEDS NO PRODUCTION");

  sub("E1. no kg comparison may invent demand for a covered unit line");
  const preE = await stockRoast(C.coffees.brazil, C.beans.brazil, "E00");
  await packSku(preE, C.skus.bra250.id, 10);
  const oE = await orderFor(C.skus.bra250.id, 10, "fully covered");
  const reqE = await requirement(oE.items[0].id);
  check("all 10 units are reserved", num(reqE.json?.reservedUnits) === 10,
    `reservedUnits=${reqE.json?.reservedUnits}`);
  check("there is no unit shortfall", num(reqE.json?.shortfallUnits) === 0,
    `shortfallUnits=${reqE.json?.shortfallUnits}`);
  const schedE = await scheduleProduction(oE.items[0].id);
  check("scheduling production is refused as unnecessary", schedE.status === 409,
    `status=${schedE.status} ${S(schedE.json).slice(0, 130)}`);

  sub("E2. and the fulfilment state is read in units, not kilograms");
  // A unit line must not be called "In Production" or "Completed" on the strength of some
  // roasted kilograms existing. Its truth is ordered/delivered/reserved units.
  const fulfilE = await one(
    `SELECT "productionStatus" ps, "quantityUnits" qu, "deliveredUnits" du
       FROM "OrderItem" WHERE id=$1`, [oE.items[0].id]);
  check("a fully reserved line with no roasting is not 'In Production'",
    fulfilE.ps !== "In Production", `productionStatus=${fulfilE.ps}`);

  // ═══════════════════════════════════════════════════════════════════════
  section("F — PARTIAL COVERAGE RESOLVES IN UNITS");

  sub("F1. 10 ordered, 3 delivered, 4 reserved -> 3 outstanding");
  const preF = await stockRoast(C.coffees.ethiopia, C.beans.ethiopia, "F00");
  await packSku(preF, C.skus.eth1kg.id, 7);
  const oF = await orderFor(C.skus.eth1kg.id, 10, "partial coverage");
  const lotF = await one(
    `SELECT id FROM "FinishedGoodsLot" WHERE "packedFromBatchId"=$1`, [preF]);
  const shipF = await api("/api/deliveries", {
    method: "POST",
    body: { orderItemId: oF.items[0].id, quantityUnits: 3, deliveryType: "partial",
            finishedGoodsLotId: lotF.id },
  });
  check("3 units are delivered", shipF.status === 201, `status=${shipF.status} ${S(shipF.json).slice(0, 120)}`);

  const reqF = await requirement(oF.items[0].id);
  console.log(`    ${S(reqF.json).slice(0, 190)}`);
  check("delivered is 3", num(reqF.json?.deliveredUnits) === 3, `deliveredUnits=${reqF.json?.deliveredUnits}`);
  check("reserved is 4", num(reqF.json?.reservedUnits) === 4, `reservedUnits=${reqF.json?.reservedUnits}`);
  check("outstanding is 3", num(reqF.json?.shortfallUnits) === 3, `shortfallUnits=${reqF.json?.shortfallUnits}`);

  // ═══════════════════════════════════════════════════════════════════════
  section("G — A ROAST RAISED FROM A PRODUCTION ORDER REMEMBERS IT");

  sub("G1. productionOrderId is persisted on the batch");
  const oG = await orderFor(C.skus.bra250.id, 20, "traceability");
  const schedG = await scheduleProduction(oG.items[0].id);
  const poG = schedG.json.productionOrder;
  check("a production order exists to roast against", schedG.status === 201, S(schedG.json).slice(0, 120));

  await topUpGreen(C.beans.brazil.id, 8);
  const roastG = await roastFor(oG.items[0], C.beans.brazil, 8, 6, { surplusOverride: true, surplusReason: "Fixture: deliberately produces beyond outstanding demand", productionOrderId: poG.id });
  check("the roast is accepted", roastG.status === 201, `status=${roastG.status} ${S(roastG.json).slice(0, 140)}`);
  const rowG = await one('SELECT "productionOrderId" poid FROM "RoastingBatch" WHERE id=$1', [roastG.json?.id]);
  console.log(`    batch.productionOrderId = ${rowG?.poid}`);
  check("the batch is linked to the production order it came from", rowG?.poid === poG.id,
    `${rowG?.poid} vs ${poG.id}`);

  sub("G2. a roast that names no production order is still attributed to the obvious one");
  // The production screen sent no productionOrderId at all, so a roast started from a plan
  // was stored unlinked and the plan could never account for it. Relying on a screen to
  // remember an id is the fragile half of the fix; deriving it when exactly one live plan
  // exists for the line is the half that holds regardless of caller.
  const oG2 = await orderFor(C.skus.idn250.id, 20, "derived traceability");
  const schedG2 = await scheduleProduction(oG2.items[0].id);
  const poG2 = schedG2.json?.productionOrder;
  check("the line has exactly one live production order", schedG2.status === 201,
    S(schedG2.json).slice(0, 120));

  await topUpGreen(C.beans.indonesia.id, 8);
  const roastG2 = await roastFor(oG2.items[0], C.beans.indonesia, 8, 6, { surplusOverride: true, surplusReason: "Fixture: deliberately produces beyond outstanding demand" });   // no productionOrderId
  check("the roast is accepted", roastG2.status === 201,
    `status=${roastG2.status} ${S(roastG2.json).slice(0, 140)}`);
  const rowG2 = await one('SELECT "productionOrderId" poid FROM "RoastingBatch" WHERE id=$1',
    [roastG2.json?.id]);
  console.log(`    no id sent -> batch.productionOrderId = ${rowG2?.poid}`);
  check("the batch is linked to it anyway", rowG2?.poid === poG2?.id,
    `${rowG2?.poid} vs ${poG2?.id}`);

  // ═══════════════════════════════════════════════════════════════════════
  section("H — A FOREIGN PRODUCTION ORDER IS REFUSED");

  sub("H1. a production order for another coffee cannot absorb this roast");
  const oH = await orderFor(C.skus.eth250.id, 20, "foreign po");
  const schedH = await scheduleProduction(oH.items[0].id);
  const poH = schedH.json.productionOrder;              // Ethiopian
  const oH2 = await orderFor(C.skus.bra250.id, 20, "foreign po target");

  await topUpGreen(C.beans.brazil.id, 8);
  const greenBefore = await greenStockOf(C.beans.brazil.id);
  const batchesBefore = (await batchesFor(oH2.items[0].id)).length;
  const foreign = await roastFor(oH2.items[0], C.beans.brazil, 8, 6, { surplusOverride: true, surplusReason: "Fixture: deliberately produces beyond outstanding demand", productionOrderId: poH.id });
  console.log(`    Brazilian roast against an Ethiopian PO -> ${foreign.status} ${S(foreign.json).slice(0, 130)}`);
  check("refused with a 4xx", foreign.status >= 400 && foreign.status < 500, `status=${foreign.status}`);
  check("no batch was created", (await batchesFor(oH2.items[0].id)).length === batchesBefore,
    `${batchesBefore} -> ${(await batchesFor(oH2.items[0].id)).length}`);
  check("no green coffee was consumed", near(await greenStockOf(C.beans.brazil.id), greenBefore),
    `${greenBefore} -> ${await greenStockOf(C.beans.brazil.id)}`);
  check("no raw database error leaked", !/prisma|constraint|violates/i.test(S(foreign.json)),
    S(foreign.json).slice(0, 140));

  // ═══════════════════════════════════════════════════════════════════════
  section("I — A PRODUCTION ORDER AND AN ORDER LINE THAT DISAGREE");

  sub("I1. PO points at line A, the request supplies line B");
  // Both are order attribution and the server has no basis for preferring either. Picking
  // one would put the roast on an order nobody asked for.
  const oI = await orderFor(C.skus.bra250.id, 20, "conflict A");
  const schedI = await scheduleProduction(oI.items[0].id);
  const poI = schedI.json.productionOrder;               // sourceOrderItemId = oI line
  const oI2 = await orderFor(C.skus.bra250.id, 20, "conflict B");

  await topUpGreen(C.beans.brazil.id, 8);
  const greenBeforeI = await greenStockOf(C.beans.brazil.id);
  const conflict = await roastFor(oI2.items[0], C.beans.brazil, 8, 6, { surplusOverride: true, surplusReason: "Fixture: deliberately produces beyond outstanding demand", productionOrderId: poI.id });
  console.log(`    PO of line A + orderItemId of line B -> ${conflict.status} ${S(conflict.json).slice(0, 130)}`);
  check("refused with a 4xx", conflict.status >= 400 && conflict.status < 500, `status=${conflict.status}`);
  check("no batch on either line",
    (await batchesFor(oI2.items[0].id)).length === 0 && (await batchesFor(oI.items[0].id)).length === 0,
    `B=${(await batchesFor(oI2.items[0].id)).length} A=${(await batchesFor(oI.items[0].id)).length}`);
  check("no green coffee was consumed", near(await greenStockOf(C.beans.brazil.id), greenBeforeI),
    `${greenBeforeI} -> ${await greenStockOf(C.beans.brazil.id)}`);

  // ═══════════════════════════════════════════════════════════════════════
  section("J — ROASTING TO STOCK IS UNAFFECTED");

  sub("J1. a manual stock roast with no production order still works");
  const beforeJ = await greenStockOf(C.beans.indonesia.id);
  await topUpGreen(C.beans.indonesia.id, 10);
  const stockJ = await api("/api/roasting-batches", {
    method: "POST",
    body: { productId: C.coffees.indonesia.id, greenBeanId: C.beans.indonesia.id,
            greenBeanQuantity: 8, roastedBeanQuantity: 6, wasteQuantity: 2 },
  });
  check("the stock roast is accepted", stockJ.status === 201,
    `status=${stockJ.status} ${S(stockJ.json).slice(0, 140)}`);
  const rowJ = await one(
    'SELECT "productionOrderId" poid, "orderItemId" oid, "productId" pid FROM "RoastingBatch" WHERE id=$1',
    [stockJ.json?.id]);
  check("it has no production order and no order line", rowJ?.poid === null && rowJ?.oid === null,
    `poid=${rowJ?.poid} oid=${rowJ?.oid}`);
  check("and it carries its own coffee", rowJ?.pid === C.coffees.indonesia.id, `productId=${rowJ?.pid}`);
  check("green stock moved by the green amount, not the roasted one",
    near(await greenStockOf(C.beans.indonesia.id), beforeJ + 10 - 8),
    `${beforeJ} +10 -8 -> ${await greenStockOf(C.beans.indonesia.id)}`);

  // ═══════════════════════════════════════════════════════════════════════
  section("K — GREEN INPUT IS NOT FINISHED OUTPUT");

  sub("K1. the production order states both, and they differ by the roast loss");
  // The canonical conversion already exists: expectedGreenBeanKg = targetWeightKg divided by
  // (1 − expectedRoastLoss/100). Anything that suggests a green weight must go through it
  // rather than reusing a finished figure.
  const oK = await orderFor(C.skus.bra1kg.id, 10, "green vs finished");
  const schedK = await scheduleProduction(oK.items[0].id);
  const poK = await one(
    `SELECT "targetWeightKg" t, "expectedGreenBeanKg" g FROM "ProductionOrder" WHERE id=$1`,
    [schedK.json?.productionOrder?.id]);
  const loss = C.coffees.brazil.roastLoss;
  const expectedGreen = +(num(poK.t) / (1 - loss / 100)).toFixed(3);
  console.log(`    target ${poK.t} kg finished -> ${poK.g} kg green at ${loss}% loss (expected ${expectedGreen})`);
  check("green required is strictly greater than finished target", num(poK.g) > num(poK.t),
    `green=${poK.g} finished=${poK.t}`);
  check("and it follows the canonical loss conversion", near(num(poK.g), expectedGreen, 0.002),
    `${poK.g} vs ${expectedGreen}`);

  sub("K2. a batch's own green and roasted figures are never interchangeable");
  const batchK = await batchesFor(oG.items[0].id);
  check("the roast recorded distinct green and roasted weights",
    batchK.length > 0 && num(batchK[0].g) !== num(batchK[0].r),
    S(batchK[0]));

  // ═══════════════════════════════════════════════════════════════════════
  section("L — TWO SCHEDULING ATTEMPTS DO NOT BOTH WIN");

  sub("L1. concurrent production-requirement posts schedule the demand once");
  const oL = await orderFor(C.skus.eth250.id, 16, "concurrent schedule");
  const [l1, l2] = await Promise.all([
    scheduleProduction(oL.items[0].id),
    scheduleProduction(oL.items[0].id),
  ]);
  const posL = await all(
    'SELECT id, "targetUnits" t FROM "ProductionOrder" WHERE "sourceOrderItemId"=$1', [oL.items[0].id]);
  const totalL = posL.reduce((s, p) => s + num(p.t), 0);
  console.log(`    ${l1.status}/${l2.status} -> ${posL.length} production order(s), ${totalL} units scheduled`);
  check("neither attempt returned a server error", l1.status !== 500 && l2.status !== 500,
    `${l1.status}/${l2.status}`);
  check("the ordered quantity is not over-scheduled", totalL <= 16, `${totalL} units for a 16-unit line`);
  const reqL = await requirement(oL.items[0].id);
  check("and the line is not left over-covered",
    num(reqL.json?.scheduledUnits) <= 16, `scheduledUnits=${reqL.json?.scheduledUnits}`);


  // ═══════════════════════════════════════════════════════════════════════
  section("M — TWO ROASTS CANNOT BOTH CONSUME THE LAST OF THE DEMAND");

  sub("M1. concurrent roast creation against one order line");
  // The ceiling used to be read before the transaction opened and never looked at again, so
  // two operators starting a roast at the same moment both read the same remaining demand
  // and both passed. Nothing inside the transaction serialised them: the only advisory lock
  // taken there is keyed on the DATE, for batch-number allocation, and it re-checks nothing.
  //
  // The overlap is forced rather than hoped for. A side connection holds the green-bean row,
  // so both requests reach their green-stock claim and stop there — which proves both got
  // past the ceiling check before either could commit. Releasing the row lets them finish.
  const oM = await orderFor(C.skus.bra1kg.id, 4, "concurrent roast");
  const skuKgM = C.skus.bra1kg.grams / 1000;
  const wholeOrderKg = 4 * skuKgM;
  // Plenty of green, so green stock can never be the thing that stops the second roast —
  // the demand ceiling has to be.
  await topUpGreen(C.beans.brazil.id, 200);

  const holder = new Client({ connectionString: DB_URL });
  await holder.connect();
  await holder.query("BEGIN");
  await holder.query('SELECT id FROM "GreenBean" WHERE id=$1 FOR UPDATE', [C.beans.brazil.id]);

  await asRoaster();
  const pair = Promise.all([
    roastFor(oM.items[0], C.beans.brazil, wholeOrderKg + 4, wholeOrderKg),
    roastFor(oM.items[0], C.beans.brazil, wholeOrderKg + 4, wholeOrderKg),
  ]);
  // Long enough for both requests to have opened their transactions and queued on the row.
  await new Promise((r) => setTimeout(r, 2500));
  await holder.query("ROLLBACK");
  await holder.end();
  const [m1, m2] = await pair;
  await asAdmin();

  const batchesM = await batchesFor(oM.items[0].id);
  const roastedM = batchesM.reduce((s, b) => s + num(b.r), 0);
  console.log(`    ${m1.status}/${m2.status} -> ${batchesM.length} batch(es), ${roastedM}kg roasted against a ${wholeOrderKg}kg demand`);

  check("neither request returned a server error", m1.status !== 500 && m2.status !== 500,
    `${m1.status}/${m2.status}`);
  check("neither deadlocked", !/deadlock|40P01/i.test(S(m1.json) + S(m2.json)),
    (S(m1.json) + S(m2.json)).slice(0, 120));
  check("exactly one roast was accepted", [m1.status, m2.status].filter((s) => s === 201).length === 1,
    `${m1.status}/${m2.status}`);
  check("the loser is refused with a domain 4xx",
    [m1, m2].some((r) => r.status >= 400 && r.status < 500),
    `${m1.status}/${m2.status}`);
  check("only one batch exists for the line", batchesM.length === 1, `${batchesM.length} batches`);
  check("the line was not over-produced", near(roastedM, wholeOrderKg),
    `${roastedM}kg vs a ${wholeOrderKg}kg demand`);
  check("green coffee was consumed once", near(num(batchesM[0]?.g), wholeOrderKg + 4),
    `${batchesM[0]?.g}kg`);

  // ═══════════════════════════════════════════════════════════════════════
  section("N — AN AMBIGUOUS PRODUCTION PLAN IS NOT GUESSED AT");

  sub("N1. two live production orders and no id given -> refused, nothing consumed");
  // Leaving the batch unlinked would be a silent choice too: the roast really was made for
  // one of these plans, and storing it against neither loses the attribution just as surely
  // as picking the wrong one.
  const oN = await orderFor(C.skus.eth1kg.id, 20, "ambiguous plan");
  const sched1 = await scheduleProduction(oN.items[0].id);
  check("first production order raised", sched1.status === 201, S(sched1.json).slice(0, 110));
  // A second live plan for the same line, created directly so the demand guard cannot
  // collapse it into the first.
  const po2 = await one(
    `INSERT INTO "ProductionOrder" (id,"productionNumber","productSkuId","targetUnits","targetWeightKg","expectedGreenBeanKg",status,"sourceOrderItemId","createdAt","updatedAt")
     VALUES ($1,$2,$3,5,5,6,'PENDING',$4,now(),now()) RETURNING id`,
    [`${P}_po_second`, `PRD-AMB-${Date.now() % 100000}`, C.skus.eth1kg.id, oN.items[0].id]);
  const liveN = await all(
    `SELECT id FROM "ProductionOrder" WHERE "sourceOrderItemId"=$1 AND status IN ('PENDING','IN_PRODUCTION')`,
    [oN.items[0].id]);
  check("the line really has two live production orders", liveN.length === 2, `${liveN.length}`);

  await topUpGreen(C.beans.ethiopia.id, 10);
  const greenBeforeN = await greenStockOf(C.beans.ethiopia.id);
  const ambiguous = await roastFor(oN.items[0], C.beans.ethiopia, 8, 6, { surplusOverride: true, surplusReason: "Fixture: deliberately produces beyond outstanding demand" });   // no productionOrderId
  console.log(`    two live plans, no id -> ${ambiguous.status} ${S(ambiguous.json).slice(0, 130)}`);
  check("the roast is refused with 409", ambiguous.status === 409, `status=${ambiguous.status}`);
  check("no batch was created", (await batchesFor(oN.items[0].id)).length === 0,
    `${(await batchesFor(oN.items[0].id)).length} batches`);
  check("no green coffee was consumed", near(await greenStockOf(C.beans.ethiopia.id), greenBeforeN),
    `${greenBeforeN} -> ${await greenStockOf(C.beans.ethiopia.id)}`);
  check("no raw database error leaked", !/prisma|constraint|violates/i.test(S(ambiguous.json)),
    S(ambiguous.json).slice(0, 140));

  sub("N2. naming one of them explicitly succeeds and links exactly that one");
  const chosen = po2.id;
  await topUpGreen(C.beans.ethiopia.id, 10);
  const explicit = await roastFor(oN.items[0], C.beans.ethiopia, 8, 6, { surplusOverride: true, surplusReason: "Fixture: deliberately produces beyond outstanding demand", productionOrderId: chosen });
  check("the explicit roast is accepted", explicit.status === 201,
    `status=${explicit.status} ${S(explicit.json).slice(0, 140)}`);
  const rowN = await one('SELECT "productionOrderId" poid FROM "RoastingBatch" WHERE id=$1',
    [explicit.json?.id]);
  check("and it is linked to the plan that was named, not the other one", rowN?.poid === chosen,
    `${rowN?.poid} vs ${chosen}`);

  sub("N3. naming a plan belonging to a different line is still refused");
  const oN2 = await orderFor(C.skus.eth1kg.id, 10, "ambiguous foreign");
  await topUpGreen(C.beans.ethiopia.id, 10);
  const greenBeforeN3 = await greenStockOf(C.beans.ethiopia.id);
  const wrongPo = await roastFor(oN2.items[0], C.beans.ethiopia, 8, 6, { surplusOverride: true, surplusReason: "Fixture: deliberately produces beyond outstanding demand", productionOrderId: chosen });
  check("refused with a 4xx", wrongPo.status >= 400 && wrongPo.status < 500, `status=${wrongPo.status}`);
  check("no batch created", (await batchesFor(oN2.items[0].id)).length === 0,
    `${(await batchesFor(oN2.items[0].id)).length} batches`);
  check("no green consumed", near(await greenStockOf(C.beans.ethiopia.id), greenBeforeN3),
    `${greenBeforeN3} -> ${await greenStockOf(C.beans.ethiopia.id)}`);

  // ═══════════════════════════════════════════════════════════════════════
  section("O — PRODUCTION STATUS MEANS PRODUCTION, NOT DELIVERY");

  sub("O1. 10 ordered, 10 produced and packed, 0 delivered -> Completed");
  // The system's own dashboards settle what this field means. analytics and dashboard/stats
  // both count { productionStatus: "Completed", deliveryStatus: { not: "Delivered" } } — a
  // ready-to-ship metric that can only ever return rows if production can complete BEFORE
  // delivery. The production worklist likewise drops a line at "Completed". So the measure
  // has to be what was produced, never what was shipped.
  const oO = await orderFor(C.skus.idn250.id, 10, "status semantics");
  await topUpGreen(C.beans.indonesia.id, 10);
  const roastO = await roastFor(oO.items[0], C.beans.indonesia, 8, 6, { surplusOverride: true, surplusReason: "Fixture: deliberately produces beyond outstanding demand" });
  check("a roast exists for the line", roastO.status === 201, S(roastO.json).slice(0, 130));
  await db.query(`UPDATE "RoastingBatch" SET status='Passed' WHERE id=$1`, [roastO.json.id]);
  const packO = await packSku(roastO.json.id, C.skus.idn250.id, 10);
  check("10 units are packed from it", packO.status === 201, S(packO.json).slice(0, 130));

  const statusO = await one(
    `SELECT "productionStatus" ps, "deliveredUnits" du, "quantityUnits" qu FROM "OrderItem" WHERE id=$1`,
    [oO.items[0].id]);
  console.log(`    produced 10, delivered ${statusO.du} -> productionStatus=${statusO.ps}`);
  check("nothing has been delivered", num(statusO.du) === 0, `deliveredUnits=${statusO.du}`);
  check("production reads as Completed", statusO.ps === "Completed", `productionStatus=${statusO.ps}`);
  check("which is what the ready-to-ship dashboards count",
    statusO.ps === "Completed" && num(statusO.du) < num(statusO.qu),
    `${statusO.ps} / ${statusO.du} of ${statusO.qu}`);

  sub("O2. a line that has only been partly produced is still In Production");
  const oO2 = await orderFor(C.skus.idn250.id, 10, "status partial");
  await topUpGreen(C.beans.indonesia.id, 10);
  const roastO2 = await roastFor(oO2.items[0], C.beans.indonesia, 6, 4, { surplusOverride: true, surplusReason: "Fixture: deliberately produces beyond outstanding demand" });
  await db.query(`UPDATE "RoastingBatch" SET status='Passed' WHERE id=$1`, [roastO2.json.id]);
  await packSku(roastO2.json.id, C.skus.idn250.id, 4);
  const statusO2 = await one(
    `SELECT "productionStatus" ps FROM "OrderItem" WHERE id=$1`, [oO2.items[0].id]);
  check("4 of 10 produced reads as In Production", statusO2.ps === "In Production",
    `productionStatus=${statusO2.ps}`);

  await invariants("after the production demand suite");

  section("PRODUCTION DEMAND RESULT");
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
