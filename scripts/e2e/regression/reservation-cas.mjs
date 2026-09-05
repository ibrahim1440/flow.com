// RESERVATION COMPARE-AND-SWAP — deterministic proof.
//
// The defect: preparation review and the legacy packaging auto-reservation both derived
// their demand ceiling from a snapshot taken before anything was locked, then released and
// reserved against transaction-current allocation state. Measured on dd14506 at 4 delivered
// + 10 reserved on a line ordered 10, and 24 reserved on a line ordered 12.
//
// Review ↔ Review is forced with a REAL BARRIER rather than sleeps: this suite opens its
// own transaction and takes FOR UPDATE on the line's allocations. Both reviews get past
// their unlocked demand read and then block at releaseFinishedUnits, which is the first
// thing either of them locks. Releasing the barrier starts them from a provably identical
// snapshot, which is the only way to be sure the CAS is what decided the outcome.
import {
  ADMIN_PIN, db, api, check, section, sub, one, all, num, near, invariants, loginAs, results, DB_URL, Client,
} from "./harness.mjs";
import { buildCatalog, teardown, roastAndPass} from "./catalog.mjs";

const S = (v) => { try { return JSON.stringify(v) ?? String(v); } catch { return String(v); } };
const P = "RCAS";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let C;

const mkOrder = async (customerId, note, units) => {
  const r = await api("/api/orders", {
    method: "POST",
    body: { customerId, notes: `${P} ${note}`, items: [{ productSkuId: C.skus.bra250.id, quantityUnits: units }] },
  });
  await api(`/api/orders/${r.json.id}/approve`, { method: "POST", body: { decision: "Yes" } });
  return r.json;
};
const review = (o) => api(`/api/orders/${o.id}/preparation-review`, {
  method: "POST", body: { items: o.items.map((i) => ({ orderItemId: i.id })) } });
const statusAct = (o, action, reason) => api(`/api/orders/${o.id}/status`, { method: "POST", body: { action, reason } });
const deliver = (item, units, lotId) => api("/api/deliveries", {
  method: "POST", body: { orderItemId: item.id, quantityUnits: units, deliveryType: "partial", finishedGoodsLotId: lotId } });

let seq = 0;
async function stockShelf(units) {
  const b = await roastAndPass(P, C.coffees.brazil, C.beans.brazil, units * 0.25 + 1, units * 0.25, 1, "S" + (++seq));
  await api(`/api/roasting-batches/${b.id}/pack-sku`, { method: "POST", body: { productSkuId: C.skus.bra250.id, units } });
  return b;
}
const freeLot = async () => (await one(
  `SELECT id FROM "FinishedGoodsLot" WHERE "productSkuId"=$1 AND "unitsAvailable" > "unitsReserved" ORDER BY "createdAt" LIMIT 1`,
  [C.skus.bra250.id]))?.id;

const line = async (itemId) => await one(
  `SELECT "quantityUnits" q, "deliveredUnits" d, "updatedAt" u,
          COALESCE((SELECT SUM(sa."quantityUnits") FROM "StockAllocation" sa
                     WHERE sa."orderItemId"=$1 AND sa.status='RESERVED'),0)::int r,
          COALESCE((SELECT COUNT(*) FROM "StockAllocation" sa
                     WHERE sa."orderItemId"=$1 AND sa.status='RESERVED'),0)::int rows
     FROM "OrderItem" WHERE id=$1`, [itemId]);
const lotUnits = async (lotId) => await one(
  `SELECT "unitsAvailable" a, "unitsReserved" res FROM "FinishedGoodsLot" WHERE id=$1`, [lotId]);

const noDeadlock = (label, ...rs) =>
  check(`${label}: no 40P01`, rs.every((r) => r.status !== 500), rs.map((r) => `${r.status} ${S(r.json).slice(0, 70)}`).join(" | "));

/**
 * Hold the line's reserved allocations so both reviews stall at the same point.
 * Returns a release function. Uses its own connection — the shared harness client is busy.
 */
async function barrier(orderItemId) {
  const c = new Client({ connectionString: DB_URL });
  await c.connect();
  await c.query("BEGIN");
  await c.query(
    `SELECT id FROM "StockAllocation" WHERE "orderItemId"=$1 AND status='RESERVED' ORDER BY id FOR UPDATE`,
    [orderItemId]);
  return async () => { await c.query("COMMIT"); await c.end(); };
}

async function main() {
  await db.connect();
  await teardown(P);
  await loginAs(ADMIN_PIN);
  C = await buildCatalog(P);

  // ═══════════════════════════════════════════════════════════════════════
  section("A — REVIEW ↔ REVIEW  (deterministic barrier)");

  sub("A1. two reviews from a provably identical snapshot");
  await stockShelf(40);
  const oA = await mkOrder(C.customers.retail.id, "cas review", 12);
  await review(oA);                                   // creates the allocations the barrier holds
  const itemA = oA.items[0];
  const beforeA = await line(itemA.id);
  const lotA = await freeLot();
  const lotBeforeA = await lotUnits(lotA);
  console.log(`    before: ordered ${beforeA.q}, reserved ${beforeA.r}, updatedAt ${new Date(beforeA.u).toISOString()}`);

  const releaseA = await barrier(itemA.id);
  const p1 = review(oA), p2 = review(oA);
  await sleep(900);                                   // both are now parked on the barrier
  await releaseA();
  const [r1, r2] = await Promise.all([p1, p2]);

  const afterA = await line(itemA.id);
  const codes = [r1.status, r2.status].sort().join("+");
  console.log(`    codes ${codes}   reserved ${afterA.r}   rows ${afterA.rows}   updatedAt ${new Date(afterA.u).toISOString()}`);
  noDeadlock("review|review", r1, r2);
  check("exactly one review succeeded, the other got 409", codes === "200+409", `codes=${codes} ${S(r2.json).slice(0, 110)}`);
  check(`reserved is the demand ceiling once, not twice (${afterA.r} of ${afterA.q})`,
    num(afterA.r) === num(afterA.q), `reserved=${afterA.r} ordered=${afterA.q}`);
  check("delivered + reserved <= ordered", num(afterA.d) + num(afterA.r) <= num(afterA.q),
    `${afterA.d} + ${afterA.r} > ${afterA.q}`);

  sub("A2. the winner advanced the CAS token by at least 1 ms");
  const advanced = new Date(afterA.u).getTime() - new Date(beforeA.u).getTime();
  console.log(`    updatedAt advanced ${advanced} ms`);
  check("updatedAt_after > updatedAt_seen", advanced >= 1, `advanced ${advanced} ms`);

  sub("A3. the loser rolled back completely — lot reservation restored exactly");
  const lotAfterA = await lotUnits(lotA);
  console.log(`    lot unitsReserved ${lotBeforeA.res} -> ${lotAfterA.res}, available ${lotBeforeA.a} -> ${lotAfterA.a}`);
  const totalRes = num((await one(
    `SELECT COALESCE(SUM("unitsReserved"),0)::int n FROM "FinishedGoodsLot" WHERE "productSkuId"=$1`,
    [C.skus.bra250.id])).n);
  const totalAlloc = num((await one(
    `SELECT COALESCE(SUM("quantityUnits"),0)::int n FROM "StockAllocation" sa
      WHERE sa.status='RESERVED' AND sa."finishedGoodsLotId" IN
        (SELECT id FROM "FinishedGoodsLot" WHERE "productSkuId"=$1)`, [C.skus.bra250.id])).n);
  check("lot unitsReserved equals the sum of live allocations — no orphaned increment",
    totalRes === totalAlloc, `lots hold ${totalRes}, allocations sum ${totalAlloc}`);

  // ═══════════════════════════════════════════════════════════════════════
  section("B — REVIEW ↔ DELIVERY, both serializations");

  sub("B1. delivery commits first -> review CAS fails, nothing reserved by it");
  await stockShelf(40);
  const oB = await mkOrder(C.customers.retail.id, "delivery first", 10);
  await review(oB);
  const itemB = oB.items[0];
  const lotB = await freeLot();
  const pRev = review(oB);
  await sleep(180);
  const dB = await deliver(itemB, 4, lotB);
  const rB = await pRev;
  const afterB = await line(itemB.id);
  console.log(`    review -> ${rB.status}   delivery -> ${dB.status}   ordered ${afterB.q} delivered ${afterB.d} reserved ${afterB.r}`);
  noDeadlock("review|delivery", rB, dB);
  check("delivered + reserved <= ordered",
    num(afterB.d) + num(afterB.r) <= num(afterB.q), `${afterB.d} + ${afterB.r} > ${afterB.q}`);
  if (dB.status === 201 && rB.status !== 200) {
    check("  the review was refused with 409, not a 500", rB.status === 409, `review=${rB.status}`);
  }

  sub("B2. review commits first -> delivery's own claim/trim runs");
  await stockShelf(40);
  const oC = await mkOrder(C.customers.retail.id, "review first", 10);
  await review(oC);
  const itemC = oC.items[0];
  const lotC = await freeLot();
  const rC = await review(oC);
  const dC = await deliver(itemC, 4, lotC);
  const afterC = await line(itemC.id);
  console.log(`    review -> ${rC.status}   delivery -> ${dC.status}   ordered ${afterC.q} delivered ${afterC.d} reserved ${afterC.r}`);
  noDeadlock("review-then-delivery", rC, dC);
  check("review committed", rC.status === 200, `status=${rC.status}`);
  check("delivery committed", dC.status === 201, `status=${dC.status} ${S(dC.json).slice(0, 110)}`);
  check("delivered + reserved <= ordered",
    num(afterC.d) + num(afterC.r) <= num(afterC.q), `${afterC.d} + ${afterC.r} > ${afterC.q}`);

  // ═══════════════════════════════════════════════════════════════════════
  section("C — LEGACY KILOGRAM PACKAGING  (the only shape that reaches that code)");

  // A kg line cannot be created through the order API any more, so one is written directly.
  // This is fixture construction, not a workflow step.
  sub("C1. packaging auto-reservation is refused on an invalid order lifecycle");
  const kgOrder = await mkOrder(C.customers.cafe.id, "legacy holder", 4);
  await db.query(
    `UPDATE "OrderItem" SET "quantityUnits"=NULL, "quantityKg"=5, "deliveredQty"=0,
        "preparationDecision"='Needs Production' WHERE id=$1`, [kgOrder.items[0].id]);
  await db.query(`UPDATE "Order" SET status='On Hold' WHERE id=$1`, [kgOrder.id]);
  const batchHold = await roastAndPass(P, C.coffees.brazil, C.beans.brazil, 6, 5, 1, "PKGH");
  await db.query(`UPDATE "RoastingBatch" SET "orderItemId"=$1 WHERE id=$2`, [kgOrder.items[0].id, batchHold.id]);
  const packHold = await api(`/api/roasting-batches/${batchHold.id}/package`, {
    method: "PUT", body: { bags1kg: 5 } });
  const resHold = num((await one(
    `SELECT COALESCE(SUM("quantityKg"),0)::numeric(12,3) n FROM "StockAllocation"
      WHERE "orderItemId"=$1 AND status='RESERVED'`, [kgOrder.items[0].id])).n);
  console.log(`    package -> ${packHold.status}   order On Hold   reserved kg ${resHold}`);
  check("packaging itself still succeeded", packHold.status === 200 || packHold.status === 201,
    `status=${packHold.status} ${S(packHold.json).slice(0, 120)}`);
  check("but nothing was reserved to the On Hold order", num(resHold) === 0, `reserved ${resHold} kg`);

  sub("C2. packaging-to-stock with no owner order is unaffected");
  const stockBatch = await roastAndPass(P, C.coffees.brazil, C.beans.brazil, 4, 3, 1, "PKGS");
  const packStock = await api(`/api/roasting-batches/${stockBatch.id}/package`, {
    method: "PUT", body: { bags1kg: 3 } });
  console.log(`    package-to-stock -> ${packStock.status}`);
  check("a batch with no order item still packages", packStock.status === 200 || packStock.status === 201,
    `status=${packStock.status} ${S(packStock.json).slice(0, 120)}`);

  sub("C3. packaging on a valid kg order reserves, and concurrent packaging cannot double it");
  const kgOk = await mkOrder(C.customers.cafe.id, "legacy valid", 4);
  await db.query(
    `UPDATE "OrderItem" SET "quantityUnits"=NULL, "quantityKg"=5, "deliveredQty"=0,
        "preparationDecision"='Needs Production' WHERE id=$1`, [kgOk.items[0].id]);
  await db.query(`UPDATE "Order" SET status='Preparing', "approvalStatus"='Yes' WHERE id=$1`, [kgOk.id]);
  const b1 = await roastAndPass(P, C.coffees.brazil, C.beans.brazil, 4, 3, 1, "PKGA");
  const b2 = await roastAndPass(P, C.coffees.brazil, C.beans.brazil, 4, 3, 1, "PKGB");
  await db.query(`UPDATE "RoastingBatch" SET "orderItemId"=$1 WHERE id IN ($2,$3)`, [kgOk.items[0].id, b1.id, b2.id]);
  const [pa, pb] = await Promise.all([
    api(`/api/roasting-batches/${b1.id}/package`, { method: "PUT", body: { bags1kg: 3 } }),
    api(`/api/roasting-batches/${b2.id}/package`, { method: "PUT", body: { bags1kg: 3 } }),
  ]);
  const resOk = num((await one(
    `SELECT COALESCE(SUM("quantityKg"),0)::numeric(12,3) n FROM "StockAllocation"
      WHERE "orderItemId"=$1 AND status='RESERVED'`, [kgOk.items[0].id])).n);
  console.log(`    package A -> ${pa.status}   package B -> ${pb.status}   reserved kg ${resOk} of 5 demanded`);
  noDeadlock("package|package", pa, pb);
  check("reserved never exceeds the line's outstanding demand", num(resOk) <= 5.0005, `reserved ${resOk} kg vs 5 kg`);

  await invariants("after the reservation CAS suite");

  section("RESERVATION CAS RESULT");
  console.log(`${results.pass} passed, ${results.fail} failed`);
  if (results.failures.length) console.log("FAILURES:\n  - " + results.failures.join("\n  - "));
  await db.end();
  process.exit(results.fail === 0 ? 0 : 1);
}

main().catch(async (e) => { console.log("FATAL:", e?.stack || e); try { await db.end(); } catch {} process.exit(1); });
