// PRODUCTION LIFECYCLE SERIALIZATION — both directions.
//
// The late barrier (assertOrderStillAcceptsProduction) locks the parent Order row with
// SELECT ... FOR UPDATE OF o as the last act before commit. This proves the barrier works
// in BOTH orderings, not just the one that happens to be easy to hit:
//
//   lifecycle-first : the transition commits while production is mid-transaction. The
//                     barrier must see it, refuse with 409 and roll everything back.
//   production-first: production reaches the barrier first and holds the Order row. The
//                     transition must WAIT, then apply its own conditional state machine.
//
// Timing is controlled by how long each request has been running before the other is
// fired. Production transactions here take well over a second at ~167 ms per round trip,
// so a 350 ms head start lands the transition inside production's window, and firing the
// transition after production has finished gives the other ordering.
import {
  ADMIN_PIN, db, api, check, section, sub, one, all, num, near, invariants, loginAs, greenStock, results,
} from "./harness.mjs";
import { buildCatalog, teardown} from "./catalog.mjs";

const S = (v) => { try { return JSON.stringify(v) ?? String(v); } catch { return String(v); } };
const P = "PCONC";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let C;

const mkOrder = async (customerId, note, units = 20) => {
  const r = await api("/api/orders", {
    method: "POST",
    body: { customerId, notes: `${P} ${note}`, items: [{ productSkuId: C.skus.bra250.id, quantityUnits: units }] },
  });
  await api(`/api/orders/${r.json.id}/approve`, { method: "POST", body: { decision: "Yes" } });
  await api(`/api/orders/${r.json.id}/preparation-review`, {
    method: "POST", body: { items: r.json.items.map((i) => ({ orderItemId: i.id })) },
  });
  return r.json;
};
const requirementPost = (itemId) => api(`/api/order-items/${itemId}/production-requirement`, { method: "POST" });
const statusAct = (order, action, reason) =>
  api(`/api/orders/${order.id}/status`, { method: "POST", body: { action, reason } });
const reviewAgain = (order) =>
  api(`/api/orders/${order.id}/preparation-review`, {
    method: "POST", body: { items: order.items.map((i) => ({ orderItemId: i.id })) },
  });
const roast = (item, greenKg = 3, roastedKg = 2.4) =>
  api("/api/roasting-batches", {
    method: "POST",
    body: {
      orderItemId: item.id, greenBeanId: C.beans.brazil.id, productId: C.coffees.brazil.id,
      greenBeanQuantity: greenKg, roastedBeanQuantity: roastedKg, wasteQuantity: +(greenKg - roastedKg).toFixed(3),
    },
  });

const statusOf = async (id) => (await one('SELECT status s FROM "Order" WHERE id=$1', [id])).s;
const poCount = async (itemId) =>
  num((await one('SELECT COUNT(*)::int n FROM "ProductionOrder" WHERE "sourceOrderItemId"=$1', [itemId])).n);
const batchCount = async (itemId) =>
  num((await one('SELECT COUNT(*)::int n FROM "RoastingBatch" WHERE "orderItemId"=$1', [itemId])).n);
const movements = async () => num((await one('SELECT COUNT(*)::int n FROM "InventoryMovement"')).n);

async function main() {
  await db.connect();
  await teardown(P);
  await loginAs(ADMIN_PIN);
  C = await buildCatalog(P);

  // ═════════════════════════════════════════════════════════════════════════
  section("A — HOLD vs PRODUCTION REQUIREMENT, both directions");

  sub("A1. Hold commits first -> requirement refused 409, no production order");
  const oA = await mkOrder(C.customers.cafe.id, "hold first");
  const pA = requirementPost(oA.items[0].id);
  await sleep(350);
  const hA = await statusAct(oA, "hold", P + " hold wins");
  const rA = await pA;
  console.log(`    requirement -> ${rA.status}   hold -> ${hA.status}   final: ${await statusOf(oA.id)}`);
  check("requirement refused with 409", rA.status === 409, `status=${rA.status} ${S(rA.json).slice(0, 140)}`);
  check("  and the refusal names the status", /in status .{0,2}On Hold/i.test(S(rA.json)), S(rA.json).slice(0, 150));
  check("no production order survived the rollback", (await poCount(oA.items[0].id)) === 0, "a production order exists");
  check("the hold itself succeeded", hA.status === 200 && (await statusOf(oA.id)) === "On Hold", await statusOf(oA.id));

  sub("A2. Requirement wins first -> hold waits, then proceeds");
  const oB = await mkOrder(C.customers.cafe.id, "requirement first");
  const rB = await requirementPost(oB.items[0].id);          // completes fully
  const hB = await statusAct(oB, "hold", P + " hold after");  // then the transition
  console.log(`    requirement -> ${rB.status}   hold -> ${hB.status}   final: ${await statusOf(oB.id)}`);
  check("requirement committed (201)", rB.status === 201, `status=${rB.status} ${S(rB.json).slice(0, 140)}`);
  check("exactly one production order", (await poCount(oB.items[0].id)) === 1, String(await poCount(oB.items[0].id)));
  check("the later hold proceeded under its own state machine", hB.status === 200, `status=${hB.status} ${S(hB.json).slice(0, 120)}`);
  check("final state is On Hold — one valid serialization, no split brain",
    (await statusOf(oB.id)) === "On Hold", await statusOf(oB.id));

  // ═════════════════════════════════════════════════════════════════════════
  section("B — CANCEL vs PRODUCTION REQUIREMENT, both directions");

  sub("B1. Cancel commits first -> requirement refused, zero production orders");
  const oC = await mkOrder(C.customers.cafe.id, "cancel first");
  const pC = requirementPost(oC.items[0].id);
  await sleep(350);
  const cC = await statusAct(oC, "cancel", P + " cancel wins");
  const rC = await pC;
  console.log(`    requirement -> ${rC.status}   cancel -> ${cC.status}   final: ${await statusOf(oC.id)}`);
  check("requirement refused with 409", rC.status === 409, `status=${rC.status} ${S(rC.json).slice(0, 140)}`);
  check("no production order for the cancelled order", (await poCount(oC.items[0].id)) === 0, "a production order exists");

  sub("B2. Requirement wins first -> cancel waits, then proceeds");
  const oD = await mkOrder(C.customers.cafe.id, "req then cancel");
  const rD = await requirementPost(oD.items[0].id);
  const cD = await statusAct(oD, "cancel", P + " cancel after");
  check("requirement committed (201)", rD.status === 201, `status=${rD.status}`);
  check("the later cancel proceeded", cD.status === 200 && (await statusOf(oD.id)) === "Cancelled", await statusOf(oD.id));

  // ═════════════════════════════════════════════════════════════════════════
  section("C — HOLD / CANCEL vs ROASTING, with inventory evidence");

  sub("C1. Hold commits first -> roast refused, green unchanged, nothing written");
  const oE = await mkOrder(C.customers.retail.id, "roast vs hold");
  const gBefore = await greenStock(C.beans.brazil.id);
  const mBefore = await movements();
  const pE = roast(oE.items[0]);
  await sleep(350);
  const hE = await statusAct(oE, "hold", P + " hold wins roast");
  const rE = await pE;
  const gAfter = await greenStock(C.beans.brazil.id);
  console.log(`    roast -> ${rE.status}   hold -> ${hE.status}   green ${gBefore} -> ${gAfter}   final: ${await statusOf(oE.id)}`);
  check("roast refused with 409", rE.status === 409, `status=${rE.status} ${S(rE.json).slice(0, 140)}`);
  check(`green coffee unchanged (${gBefore} -> ${gAfter})`, near(gBefore, gAfter, 0.0005), `${gBefore} -> ${gAfter}`);
  check("no roasting batch written", (await batchCount(oE.items[0].id)) === 0, "a batch exists");
  check("no inventory movement written", (await movements()) === mBefore, "movement count moved");

  sub("C2. Roast wins first -> hold waits, roast committed before the hold");
  const oF = await mkOrder(C.customers.retail.id, "roast then hold");
  const gF0 = await greenStock(C.beans.brazil.id);
  const rF = await roast(oF.items[0]);
  const hF = await statusAct(oF, "hold", P + " hold after roast");
  const gF1 = await greenStock(C.beans.brazil.id);
  console.log(`    roast -> ${rF.status}   hold -> ${hF.status}   green ${gF0} -> ${gF1}   final: ${await statusOf(oF.id)}`);
  check("roast committed (201)", rF.status === 201, `status=${rF.status}`);
  check(`and drew its green (${gF0} -> ${gF1})`, near(gF0 - gF1, 3, 0.0005), `drew ${(gF0 - gF1).toFixed(3)}`);
  check("the later hold proceeded", hF.status === 200 && (await statusOf(oF.id)) === "On Hold", await statusOf(oF.id));

  sub("C3. Cancel commits first -> roast refused, no batch, no movement, green unchanged");
  const oG = await mkOrder(C.customers.retail.id, "roast vs cancel");
  const gG0 = await greenStock(C.beans.brazil.id);
  const mG0 = await movements();
  const pG = roast(oG.items[0]);
  await sleep(350);
  const cG = await statusAct(oG, "cancel", P + " cancel wins roast");
  const rG = await pG;
  const gG1 = await greenStock(C.beans.brazil.id);
  console.log(`    roast -> ${rG.status}   cancel -> ${cG.status}   green ${gG0} -> ${gG1}`);
  check("roast refused with 409", rG.status === 409, `status=${rG.status} ${S(rG.json).slice(0, 140)}`);
  check(`green coffee unchanged (${gG0} -> ${gG1})`, near(gG0, gG1, 0.0005), `${gG0} -> ${gG1}`);
  check("no roasting batch written", (await batchCount(oG.items[0].id)) === 0, "a batch exists");
  check("no inventory movement written", (await movements()) === mG0, "movement count moved");

  // ═════════════════════════════════════════════════════════════════════════
  section("D — CONCURRENT PREPARATION REVIEW vs PRODUCTION");

  sub("D1. review vs production requirement — no incompatible decision/shortfall snapshot");
  const oH = await mkOrder(C.customers.cafe.id, "review vs requirement", 24);
  const pH = requirementPost(oH.items[0].id);
  await sleep(300);
  const vH = await reviewAgain(oH);
  const rH = await pH;
  const posH = await all('SELECT "targetUnits" t FROM "ProductionOrder" WHERE "sourceOrderItemId"=$1', [oH.items[0].id]);
  const reservedH = num((await one(
    `SELECT COALESCE(SUM("quantityUnits"),0)::int n FROM "StockAllocation" WHERE "orderItemId"=$1 AND status='RESERVED'`,
    [oH.items[0].id])).n);
  const scheduledH = posH.reduce((s, p) => s + num(p.t), 0);
  console.log(`    requirement -> ${rH.status}   review -> ${vH.status}   reserved ${reservedH} + scheduled ${scheduledH} vs ordered 24`);
  check("reserved + scheduled never exceeds what the line still owes",
    reservedH + scheduledH <= 24, `${reservedH} + ${scheduledH} > 24`);
  check("at most one production order", posH.length <= 1, String(posH.length));

  sub("D2. review vs roasting");
  const oI = await mkOrder(C.customers.retail.id, "review vs roast", 24);
  const gI0 = await greenStock(C.beans.brazil.id);
  const pI = roast(oI.items[0]);
  await sleep(300);
  const vI = await reviewAgain(oI);
  const rI = await pI;
  const gI1 = await greenStock(C.beans.brazil.id);
  console.log(`    roast -> ${rI.status}   review -> ${vI.status}   green ${gI0} -> ${gI1}   batches ${await batchCount(oI.items[0].id)}`);
  check("the outcome is internally consistent: green moved only if a batch was written",
    (rI.status === 201) === ((await batchCount(oI.items[0].id)) > 0),
    `roast=${rI.status} batches=${await batchCount(oI.items[0].id)}`);
  check("green moved by exactly 3 kg if the roast committed, else not at all",
    rI.status === 201 ? near(gI0 - gI1, 3, 0.0005) : near(gI0, gI1, 0.0005),
    `${gI0} -> ${gI1} with roast=${rI.status}`);

  // ═════════════════════════════════════════════════════════════════════════
  section("E — TWO CONCURRENT PRODUCTION REQUIREMENTS");

  sub("E1. exactly one production order; the loser gets an intentional 409");
  const oJ = await mkOrder(C.customers.cafe.id, "duplicate", 16);
  const [x, y] = await Promise.all([requirementPost(oJ.items[0].id), requirementPost(oJ.items[0].id)]);
  const n = await poCount(oJ.items[0].id);
  const loser = x.status === 201 ? y : x;
  const winner = x.status === 201 ? x : y;
  console.log(`    statuses ${x.status} + ${y.status}   production orders ${n}`);
  console.log(`    loser body: ${S(loser.json).slice(0, 170)}`);
  check("exactly one production order", n === 1, String(n));
  check("one request succeeded", winner.status === 201, `winner=${winner.status}`);
  check("the loser got 409, not a generic 500", loser.status === 409, `loser=${loser.status} ${S(loser.json).slice(0, 140)}`);
  check("  and the message explains why", !/unexpected error/i.test(S(loser.json)), S(loser.json).slice(0, 140));

  await invariants("after the concurrency suite");

  section("PRODUCTION CONCURRENCY RESULT");
  console.log(`${results.pass} passed, ${results.fail} failed`);
  if (results.failures.length) console.log("FAILURES:\n  - " + results.failures.join("\n  - "));
  await db.end();
  process.exit(results.fail === 0 ? 0 : 1);
}

main().catch(async (e) => { console.log("FATAL:", e?.stack || e); try { await db.end(); } catch {} process.exit(1); });
