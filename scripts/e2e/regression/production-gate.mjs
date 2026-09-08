// PRODUCTION ENTRY GATE — negative-case regression suite.
//
// The defect this covers: an order that was neither approved nor reviewed appeared in the
// Production queue with an enabled Start Production action, and BOTH backend routes
// accepted the work — the roasting route drew green coffee for an order that might never
// be agreed. Every earlier suite drove the workflow in order, so the missing gate was
// never exercised.
//
// These assertions are deliberately written against the API directly rather than through
// the UI. The UI filter is defence in depth; the server is the authority, and the server is
// what has to refuse a hand-rolled request.
import {
  ADMIN_PIN, db, api, check, section, sub, one, all, num, near, invariants,
  loginAs, greenStock, results,
} from "./harness.mjs";
import { buildCatalog, teardown, roastAndPass} from "./catalog.mjs";

const S = (v) => { try { return JSON.stringify(v) ?? String(v); } catch { return String(v); } };
const P = "PGATE";
let C;

const createOrder = async (customerId, note, items) => {
  const r = await api("/api/orders", { method: "POST", body: { customerId, notes: `${P} ${note}`, items } });
  if (r.status !== 201) throw new Error("order create failed: " + S(r.json));
  return r.json;
};
const approve = (order, decision = "Yes", reason) =>
  api(`/api/orders/${order.id}/approve`, { method: "POST", body: { decision, ...(reason ? { reason } : {}) } });
const review = (order) =>
  api(`/api/orders/${order.id}/preparation-review`, {
    method: "POST",
    body: { items: order.items.map((i) => ({ orderItemId: i.id })) },
  });
const statusAct = (order, action, reason) =>
  api(`/api/orders/${order.id}/status`, { method: "POST", body: { action, reason } });
const requirementPost = (itemId) => api(`/api/order-items/${itemId}/production-requirement`, { method: "POST" });

const roast = (item, greenKg = 2, roastedKg = 1.6) =>
  api("/api/roasting-batches", {
    method: "POST",
    body: {
      orderItemId: item.id,
      greenBeanId: C.beans.brazil.id,
      productId: C.coffees.brazil.id,
      greenBeanQuantity: greenKg,
      roastedBeanQuantity: roastedKg,
      wasteQuantity: +(greenKg - roastedKg).toFixed(3),
    },
  });

const orderStatus = async (id) => (await one('SELECT status s FROM "Order" WHERE id=$1', [id])).s;
const batchCount = async (itemId) =>
  num((await one('SELECT COUNT(*)::int n FROM "RoastingBatch" WHERE "orderItemId"=$1', [itemId])).n);
const movementCount = async () => num((await one('SELECT COUNT(*)::int n FROM "InventoryMovement"')).n);

/**
 * Assert that a roast is refused AND that it moved nothing.
 *
 * The status code alone is not the interesting part. The gate exists because the roasting
 * route decrements green coffee inside its transaction, so what has to be proved is that a
 * refusal happens before that: same green balance, no batch row, no ledger movement.
 */
async function refusedRoastMovesNothing(label, item, expectPattern) {
  const greenBefore = await greenStock(C.beans.brazil.id);
  const movesBefore = await movementCount();
  const batchesBefore = await batchCount(item.id);

  const r = await roast(item);

  check(`${label}: roast refused with 409`, r.status === 409, `status=${r.status} ${S(r.json).slice(0, 140)}`);
  if (expectPattern) {
    check(`${label}: and says why`, expectPattern.test(S(r.json)), S(r.json).slice(0, 160));
  }
  const greenAfter = await greenStock(C.beans.brazil.id);
  check(`${label}: green coffee unchanged (${greenBefore} -> ${greenAfter})`, near(greenBefore, greenAfter, 0.0005), `${greenBefore} -> ${greenAfter}`);
  check(`${label}: no roasting batch written`, (await batchCount(item.id)) === batchesBefore, "batch count moved");
  check(`${label}: no inventory movement written`, (await movementCount()) === movesBefore, "movement count moved");
}

async function main() {
  await db.connect();
  await teardown(P);
  await loginAs(ADMIN_PIN);
  C = await buildCatalog(P);

  const line = (units = 20) => [{ productSkuId: C.skus.bra250.id, quantityUnits: units }];

  // ═══════════════════════════════════════════════════════════════════════
  section("A — UNAPPROVED ORDER (the reported defect)");

  sub("A1. Waiting Approval — production requirement must be refused");
  const oA = await createOrder(C.customers.cafe.id, "waiting approval", line());
  check("order starts in Waiting Approval", (await orderStatus(oA.id)) === "Waiting Approval", await orderStatus(oA.id));
  const reqA = await requirementPost(oA.items[0].id);
  check("requirement refused with 409", reqA.status === 409, `status=${reqA.status} ${S(reqA.json).slice(0, 140)}`);
  check("  and names the status", /in status .{0,2}Waiting Approval/i.test(S(reqA.json)), S(reqA.json).slice(0, 160));
  check("no production order was created", (await all(
    'SELECT id FROM "ProductionOrder" WHERE "sourceOrderItemId"=$1', [oA.items[0].id])).length === 0, "a production order exists");

  sub("A2. Waiting Approval — roast must be refused, and must move nothing");
  await refusedRoastMovesNothing("unapproved", oA.items[0], /in status .{0,2}Waiting Approval/i);

  // ═══════════════════════════════════════════════════════════════════════
  section("B — APPROVED BUT NOT REVIEWED");

  sub("B1. approved, preparation review not submitted");
  const oB = await createOrder(C.customers.cafe.id, "approved unreviewed", line());
  await approve(oB);
  check("status advanced to Waiting Preparation Review",
    (await orderStatus(oB.id)) === "Waiting Preparation Review", await orderStatus(oB.id));
  const reqB = await requirementPost(oB.items[0].id);
  check("requirement refused with 409", reqB.status === 409, `status=${reqB.status} ${S(reqB.json).slice(0, 140)}`);
  check("  and names the status", /in status .{0,2}Waiting Preparation Review/i.test(S(reqB.json)), S(reqB.json).slice(0, 160));
  await refusedRoastMovesNothing("unreviewed", oB.items[0], /in status .{0,2}Waiting Preparation Review/i);

  // ═══════════════════════════════════════════════════════════════════════
  section("C — HOLD AND RESUME");

  sub("C1. On Hold — both paths refused");
  const oC = await createOrder(C.customers.cafe.id, "hold resume", line());
  await approve(oC);
  await review(oC);
  const heldFrom = await orderStatus(oC.id);
  const holdRes = await statusAct(oC, "hold", P + " paused by customer");
  check(`held from ${heldFrom}`, holdRes.status === 200 && (await orderStatus(oC.id)) === "On Hold", `status=${holdRes.status}`);
  const reqC = await requirementPost(oC.items[0].id);
  check("requirement refused while On Hold", reqC.status === 409, `status=${reqC.status} ${S(reqC.json).slice(0, 140)}`);
  check("  and names the status", /in status .{0,2}On Hold/i.test(S(reqC.json)), S(reqC.json).slice(0, 160));
  await refusedRoastMovesNothing("on hold", oC.items[0], /in status .{0,2}On Hold/i);

  sub("C2. resumed — production is permitted again");
  const resumeRes = await statusAct(oC, "resume");
  check("resumed", resumeRes.status === 200, `status=${resumeRes.status}`);
  check("  back to a production-entry status",
    ["Preparing", "Ready for Shipping"].includes(await orderStatus(oC.id)), await orderStatus(oC.id));
  const reqC2 = await requirementPost(oC.items[0].id);
  check("requirement now accepted (201)", reqC2.status === 201, `status=${reqC2.status} ${S(reqC2.json).slice(0, 160)}`);
  const roastC = await roast(oC.items[0]);
  check("roast now accepted (201)", roastC.status === 201, `status=${roastC.status} ${S(roastC.json).slice(0, 140)}`);

  // ═══════════════════════════════════════════════════════════════════════
  section("D — TERMINAL STATUSES");

  sub("D1. Cancelled — refused (regression: wording the lifecycle suite asserts)");
  const oD = await createOrder(C.customers.cafe.id, "cancelled", line());
  await approve(oD);
  await review(oD);
  await statusAct(oD, "cancel", P + " customer withdrew");
  check("order cancelled", (await orderStatus(oD.id)) === "Cancelled", await orderStatus(oD.id));
  const reqD = await requirementPost(oD.items[0].id);
  check("requirement refused", reqD.status === 409, `status=${reqD.status}`);
  check("  and the message still names the status the old test expects",
    /in status .{0,2}Cancelled/i.test(S(reqD.json)), S(reqD.json).slice(0, 160));
  await refusedRoastMovesNothing("cancelled", oD.items[0], /in status .{0,2}Cancelled/i);

  sub("D2. Rejected — refused explicitly");
  const oE = await createOrder(C.customers.cafe.id, "rejected", line());
  const rej = await approve(oE, "No", P + " credit refused");
  check("order rejected", rej.status === 200 && (await orderStatus(oE.id)) === "Rejected", await orderStatus(oE.id));
  const reqE = await requirementPost(oE.items[0].id);
  check("requirement refused", reqE.status === 409, `status=${reqE.status}`);
  check("  and names the status", /in status .{0,2}Rejected/i.test(S(reqE.json)), S(reqE.json).slice(0, 160));
  await refusedRoastMovesNothing("rejected", oE.items[0], /in status .{0,2}Rejected/i);

  sub("D3. Completed — refused");
  // "complete" is only legal from Ready for Shipping, and aggregatePreparationStatus only
  // returns that when EVERY line reviewed as "Available on Shelf". So the shelf has to be
  // stocked first — an order reviewed against an empty shelf lands on Preparing instead.
  const stockBatch = await roastAndPass(P, C.coffees.brazil, C.beans.brazil, 2, 1.2, 0.8, "D3");
  const packed = await api(`/api/roasting-batches/${stockBatch.id}/pack-sku`, {
    method: "POST",
    body: { productSkuId: C.skus.bra250.id, units: 4 },
  });
  check("shelf stocked with 4 units so the order can be fully covered", packed.status === 201 || packed.status === 200,
    `status=${packed.status} ${S(packed.json).slice(0, 140)}`);

  const oF = await createOrder(C.customers.cafe.id, "completed", line(4));
  await approve(oF);
  await review(oF);
  const statusF = await orderStatus(oF.id);
  check(`order reached Ready for Shipping (was ${statusF})`, statusF === "Ready for Shipping", statusF);

  // DEF-001: completion now requires every line delivered in full, so this fixture has to
  // ship its 4 units through the real delivery route before it can reach Completed. That
  // is a precondition of what D3 tests, not the subject of it — the assertions below are
  // unchanged and still measure the production entry gate against a Completed order.
  const lotF = await one(
    'SELECT id FROM "FinishedGoodsLot" WHERE "packedFromBatchId"=$1 AND "productSkuId"=$2',
    [stockBatch.id, C.skus.bra250.id]);
  const shipF = await api("/api/deliveries", {
    method: "POST",
    body: { orderItemId: oF.items[0].id, quantityUnits: 4, deliveryType: "full", finishedGoodsLotId: lotF.id },
  });
  check("all 4 ordered units delivered in full -> 201", shipF.status === 201,
    `status=${shipF.status} ${S(shipF.json).slice(0, 140)}`);

  const done = await statusAct(oF, "complete", P + " done");
  check("order completed", done.status === 200 && (await orderStatus(oF.id)) === "Completed",
    `status=${done.status} ${await orderStatus(oF.id)}`);
  const reqF = await requirementPost(oF.items[0].id);
  check("requirement refused", reqF.status === 409, `status=${reqF.status}`);
  check("  and names the status", /in status .{0,2}Completed/i.test(S(reqF.json)), S(reqF.json).slice(0, 160));
  await refusedRoastMovesNothing("completed", oF.items[0], /in status .{0,2}Completed/i);

  // ═══════════════════════════════════════════════════════════════════════
  section("E — THE POSITIVE CASES MUST STILL WORK");

  sub("E1. approved + reviewed with a real shortfall — permitted");
  const oG = await createOrder(C.customers.retail.id, "valid shortfall", line(24));
  await approve(oG);
  await review(oG);
  check("in a production-entry status",
    ["Preparing", "Ready for Shipping"].includes(await orderStatus(oG.id)), await orderStatus(oG.id));
  const reqG = await requirementPost(oG.items[0].id);
  check("requirement accepted (201)", reqG.status === 201, `status=${reqG.status} ${S(reqG.json).slice(0, 160)}`);
  const greenBeforeG = await greenStock(C.beans.brazil.id);
  const roastG = await roast(oG.items[0], 3, 2.4);
  check("roast accepted (201)", roastG.status === 201, `status=${roastG.status} ${S(roastG.json).slice(0, 140)}`);
  const greenAfterG = await greenStock(C.beans.brazil.id);
  check(`and it did draw green (${greenBeforeG} -> ${greenAfterG})`, near(greenBeforeG - greenAfterG, 3, 0.0005),
    `drew ${(greenBeforeG - greenAfterG).toFixed(3)}`);

  sub("E2. roast-to-stock without any customer order — still permitted");
  const greenBeforeS = await greenStock(C.beans.brazil.id);
  const stock = await api("/api/roasting-batches", {
    method: "POST",
    body: {
      greenBeanId: C.beans.brazil.id,
      productId: C.coffees.brazil.id,
      greenBeanQuantity: 2,
      roastedBeanQuantity: 1.7,
      wasteQuantity: 0.3,
    },
  });
  check("stock batch accepted (201)", stock.status === 201, `status=${stock.status} ${S(stock.json).slice(0, 160)}`);
  const greenAfterS = await greenStock(C.beans.brazil.id);
  check(`and drew its green (${greenBeforeS} -> ${greenAfterS})`, near(greenBeforeS - greenAfterS, 2, 0.0005),
    `drew ${(greenBeforeS - greenAfterS).toFixed(3)}`);
  check("the stock batch carries no order item",
    (await one('SELECT "orderItemId" oi FROM "RoastingBatch" WHERE id=$1', [stock.json?.id]))?.oi === null,
    "stock batch is attached to an order");

  // ═══════════════════════════════════════════════════════════════════════
  section("F — THE UI QUEUE MUST AGREE WITH THE SERVER");

  sub("F1. an unapproved order is not in the actionable production queue");
  // Mirrors canStartProduction in order-operations-client against the very payload the
  // Production screen loads, so the filter cannot drift from the gate without failing here.
  const listed = await api("/api/orders");
  check("orders list readable", listed.status === 200, `status=${listed.status}`);
  const actionable = (listed.json ?? []).flatMap((o) =>
    !["Preparing", "Ready for Shipping"].includes(o.status) || o.approvalStatus !== "Yes"
      ? []
      : (o.items ?? []).filter((i) => i.preparationDecision != null).map((i) => ({ n: o.orderNumber, id: i.id }))
  );
  check("the unapproved order (A) is absent from the queue",
    !actionable.some((x) => x.n === oA.orderNumber), `#${oA.orderNumber} is listed`);
  check("the approved-but-unreviewed order (B) is absent",
    !actionable.some((x) => x.n === oB.orderNumber), `#${oB.orderNumber} is listed`);
  check("the cancelled order (D) is absent",
    !actionable.some((x) => x.n === oD.orderNumber), `#${oD.orderNumber} is listed`);
  check("the rejected order (E) is absent",
    !actionable.some((x) => x.n === oE.orderNumber), `#${oE.orderNumber} is listed`);
  check("the valid order (G) IS present",
    actionable.some((x) => x.n === oG.orderNumber), `#${oG.orderNumber} is missing from the queue`);

  await invariants("after the production gate suite");

  section("PRODUCTION GATE RESULT");
  console.log(`${results.pass} passed, ${results.fail} failed`);
  if (results.failures.length) console.log("FAILURES:\n  - " + results.failures.join("\n  - "));
  await db.end();
  process.exit(results.fail === 0 ? 0 : 1);
}

main().catch(async (e) => { console.log("FATAL:", e?.stack || e); try { await db.end(); } catch {} process.exit(1); });
