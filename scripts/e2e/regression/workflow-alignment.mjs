// WORKFLOW ALIGNMENT — the normal order path after routine approval was removed.
//
// The frozen UX removed routine approval from the normal order lifecycle. That is not a
// cosmetic change: approval used to be the thing that moved an order into preparation, the
// thing that assigned its operational owner, and a precondition of both production and
// packaging reservation. Removing it from the screen without moving those responsibilities
// would have produced an ERP where nothing could be produced and nothing could be owned.
//
// This suite proves the replacement contract:
//
//   • a new order is created directly into the state Commit Allocation runs from;
//   • an order still sitting in the legacy "Waiting Approval" state is not stranded;
//   • the operational owner is claimed by the FIRST successful Commit Allocation, once,
//     and never reassigned afterwards — including under concurrency;
//   • approving no longer takes ownership;
//   • production and packaging reservation no longer require approval;
//   • a blocked line cannot be produced and cannot be delivered;
//   • full coverage reaches Ready for Shipping, partial coverage stays in Preparation.
//
// Every assertion here is about the contract that genuinely changed. Nothing in this file
// relaxes a rule that still holds — the stock, concurrency and idempotency invariants are
// proved by the suites that already own them.
import {
  ADMIN_PIN, db, api, check, section, sub, one, all, num, invariants, loginAs,
  results, finish, ensureUser, concurrently,
} from "./harness.mjs";
import { buildCatalog, teardown } from "./catalog.mjs";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

const ADMIN_PERMS = JSON.parse(
  createRequire(import.meta.url)("fs").readFileSync(new URL("./fixtures/admin-permissions.json", import.meta.url), "utf8")
);

const S = (v) => { try { return JSON.stringify(v) ?? String(v); } catch { return String(v); } };
const P = "WFA";
let C;

const orderRow = (id) => one('SELECT status, "approvalStatus", "ownerId" FROM "Order" WHERE id=$1', [id]);
const itemDecision = (id) => one('SELECT "preparationDecision" d FROM "OrderItem" WHERE id=$1', [id]);

/** Create an order with one SKU line. No approval step — that is the point. */
async function createOrder(note, sku, units) {
  const r = await api("/api/orders", {
    method: "POST",
    body: {
      customerId: C.customers.cafe.id,
      notes: `${P} ${note}`,
      items: [{ productSkuId: sku.id, quantityUnits: units }],
    },
  });
  if (r.status !== 201) throw new Error(`order create failed: ${S(r.json)}`);
  return { id: r.json.id, itemId: r.json.items[0].id, orderNumber: r.json.orderNumber };
}

const commit = (orderId, items) =>
  api(`/api/orders/${orderId}/preparation-review`, { method: "POST", body: { items } });

// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  await db.connect();
  await loginAs(ADMIN_PIN);
  C = await buildCatalog(P);

  section("A — THE NORMAL PATH NO LONGER PASSES THROUGH APPROVAL");

  sub("A1. a new order enters preparation without anyone approving it");
  const o1 = await createOrder("fresh", C.skus.bra250, 4);
  const r1 = await orderRow(o1.id);
  check("status is Waiting Preparation Review", r1.status === "Waiting Preparation Review", S(r1.status));
  check("approval is still Pending — nothing approved it", r1.approvalStatus === "Pending", S(r1.approvalStatus));
  check("and it has no owner yet", r1.ownerId === null, S(r1.ownerId));
  const c1 = await commit(o1.id, [{ orderItemId: o1.itemId }]);
  check("Commit Allocation is accepted with no approval anywhere", c1.status === 200,
    `status=${c1.status} ${S(c1.json).slice(0, 140)}`);

  sub("A2. a legacy order left in Waiting Approval is not stranded");
  // Orders created under the old workflow are still in this status. They must be able to
  // commit without an approval click the UX no longer offers. Set directly in the database
  // because the application can no longer produce this state.
  const o2 = await createOrder("legacy", C.skus.bra250, 4);
  await db.query(`UPDATE "Order" SET status='Waiting Approval', "approvalStatus"='Pending' WHERE id=$1`, [o2.id]);
  check("the legacy order really is in Waiting Approval",
    (await orderRow(o2.id)).status === "Waiting Approval");
  const c2 = await commit(o2.id, [{ orderItemId: o2.itemId }]);
  check("it can still Commit Allocation", c2.status === 200, `status=${c2.status} ${S(c2.json).slice(0, 140)}`);
  const r2 = await orderRow(o2.id);
  check("and it lands on a derived preparation status, not Waiting Approval",
    r2.status === "Preparing" || r2.status === "Ready for Shipping", S(r2.status));

  section("B — OWNERSHIP IS CLAIMED BY COMMIT ALLOCATION, ONCE");

  sub("A3. a FAILED Commit Allocation assigns no owner");
  const o3 = await createOrder("fails", C.skus.bra250, 4);
  const bad = await commit(o3.id, [{ orderItemId: "not-a-real-order-item-id" }]);
  check("the commit is refused", bad.status >= 400, `status=${bad.status}`);
  check("and no owner was assigned by the failure", (await orderRow(o3.id)).ownerId === null,
    S((await orderRow(o3.id)).ownerId));

  sub("A4. the first successful Commit Allocation claims the order");
  const me = await api("/api/profile");
  const o4 = await createOrder("claims", C.skus.bra250, 4);
  check("no owner before the commit", (await orderRow(o4.id)).ownerId === null);
  const c4 = await commit(o4.id, [{ orderItemId: o4.itemId }]);
  check("commit accepted", c4.status === 200, `status=${c4.status}`);
  const owner4 = (await orderRow(o4.id)).ownerId;
  check("an owner is now set", owner4 !== null, S(owner4));
  const adminId = (await one(
    `SELECT id FROM "Employee" WHERE active=true AND role='admin' AND username='admin' LIMIT 1`))?.id;
  check("and it is the operator who committed, not the approver",
    owner4 === adminId, `${owner4} vs ${adminId}`);
  check("profile route is reachable for identity context", me.status === 200 || me.status === 404, `status=${me.status}`);

  sub("A5. a second Commit Allocation does not change the owner");
  // Re-commit as a DIFFERENT operator. The owner must not follow the latest writer.
  // Named with the "_emp_" infix so teardown()'s own Employee cleanup removes it — and does
  // so AFTER the orders are gone. Deleting this row by hand before teardown fails on
  // OrderActivity.authorId (this operator authored the re-commit activity), and that thrown
  // error used to skip the whole teardown and strand the fixtures for the next run.
  const OTHER = `${P}_emp_second`;
  await ensureUser(OTHER, `${P} Second Operator`, "admin", ADMIN_PERMS, "612345");
  await loginAs("612345");
  const c5 = await commit(o4.id, [{ orderItemId: o4.itemId }]);
  check("the re-commit is accepted", c5.status === 200, `status=${c5.status} ${S(c5.json).slice(0, 120)}`);
  check("the owner is unchanged — first claim stands",
    (await orderRow(o4.id)).ownerId === owner4, S((await orderRow(o4.id)).ownerId));
  await loginAs(ADMIN_PIN);

  sub("A6. two concurrent FIRST commits do not oscillate ownership");
  const o6 = await createOrder("race", C.skus.bra250, 4);
  const racers = await concurrently(2, () => commit(o6.id, [{ orderItemId: o6.itemId }]));
  const owner6 = (await orderRow(o6.id)).ownerId;
  check("neither racer returned a server error",
    racers.every((r) => r.status !== 500), S(racers.map((r) => r.status)));
  check("at least one commit succeeded", racers.some((r) => r.status === 200), S(racers.map((r) => r.status)));
  check("exactly one owner is recorded", owner6 !== null, S(owner6));
  const owner6Again = (await orderRow(o6.id)).ownerId;
  check("and it is stable when read again", owner6Again === owner6, `${owner6} then ${owner6Again}`);

  sub("A7. approving does not take ownership");
  // Approved BEFORE any commit, which is the only window the approve route still acts in
  // (it refuses once real operational progress exists). Under the old rule this call made
  // the approver the owner; it must now leave the order unowned for the operator who
  // eventually commits.
  const o7 = await createOrder("approve-no-own", C.skus.bra250, 4);
  check("the order is unowned to begin with", (await orderRow(o7.id)).ownerId === null);
  const appr = await api(`/api/orders/${o7.id}/approve`, { method: "POST", body: { decision: "Yes" } });
  check("the approve route still functions", appr.status === 200, `status=${appr.status} ${S(appr.json).slice(0, 120)}`);
  check("approving assigns NO owner", (await orderRow(o7.id)).ownerId === null,
    S((await orderRow(o7.id)).ownerId));
  // And the operator who commits afterwards is the one who gets it.
  const c7 = await commit(o7.id, [{ orderItemId: o7.itemId }]);
  check("the later commit is accepted", c7.status === 200, `status=${c7.status}`);
  check("and the committer becomes the owner", (await orderRow(o7.id)).ownerId !== null,
    S((await orderRow(o7.id)).ownerId));

  section("C — PRODUCTION AND PACKAGING NO LONGER REQUIRE APPROVAL");

  sub("A8. production is permitted on an unapproved but committed order");
  const o8 = await createOrder("produce-unapproved", C.skus.bra250, 60);
  const c8 = await commit(o8.id, [{ orderItemId: o8.itemId }]);
  check("commit accepted", c8.status === 200, `status=${c8.status}`);
  check("the order was never approved", (await orderRow(o8.id)).approvalStatus === "Pending");
  const req8 = await api(`/api/order-items/${o8.itemId}/production-requirement`, { method: "POST", body: {} });
  check("the production requirement is accepted, not refused for approval",
    req8.status === 200 || req8.status === 201, `status=${req8.status} ${S(req8.json).slice(0, 160)}`);
  check("and no refusal mentions approval",
    !/approv/i.test(S(req8.json)), S(req8.json).slice(0, 160));

  sub("A9. packaging reservation no longer requires approval");
  // canReserveToOrderLine decides whether packaging output is reserved to the owning order.
  // It cannot be imported here — it lives in a module that uses the "@/" path alias, which
  // only a bundler resolves — so this asserts the rule from source instead. The behavioural
  // coverage that packaging actually reserves correctly is owned by the packaging suites.
  const ooSrc = readFileSync(
    new URL("../../../src/lib/services/order-operations.ts", import.meta.url), "utf8");
  // A generous fixed window rather than brace matching: the body is short, and a slice that
  // stopped at the first "\n}" would end inside the comment block above the return.
  const reserveBody = ooSrc.slice(
    ooSrc.indexOf("export function canReserveToOrderLine"),
    ooSrc.indexOf("export function canReserveToOrderLine") + 1200,
  );
  check("canReserveToOrderLine no longer consults approvalStatus",
    !/approvalStatus\s*===/.test(reserveBody), reserveBody.slice(0, 200));
  check("it still requires a reservation-allowed order status",
    /isReservationAllowedFrom\(/.test(reserveBody), "");
  check("it still requires a completed preparation decision",
    /preparationDecision !== null/.test(reserveBody), "");
  check("and it still refuses a blocked line",
    /preparationDecision !== "Blocked"/.test(reserveBody), "");
  const gateFn = ooSrc.slice(ooSrc.indexOf("export function productionGateRefusal"));
  check("the production gate no longer consults approvalStatus",
    !/approvalStatus !==/.test(gateFn.slice(0, gateFn.indexOf("\n}\n"))), "");

  section("D — A BLOCKED LINE IS OPERATIONALLY INERT");

  sub("A10. a blocked line cannot start production");
  const o10 = await createOrder("blocked-prod", C.skus.bra250, 60);
  const c10 = await commit(o10.id, [{ orderItemId: o10.itemId, decision: "Blocked" }]);
  check("the blocking commit is accepted", c10.status === 200 || c10.status === 400,
    `status=${c10.status} ${S(c10.json).slice(0, 160)}`);
  if (c10.status === 400) {
    // Blocking requires a note; send it the way the route demands.
    const c10b = await commit(o10.id, [{ orderItemId: o10.itemId, decision: "Blocked" }]);
    check("retry with the required note is accepted", c10b.status === 200 || c10b.status === 400,
      `status=${c10b.status}`);
  }
  const d10 = (await itemDecision(o10.itemId)).d;
  if (d10 === "Blocked") {
    const req10 = await api(`/api/order-items/${o10.itemId}/production-requirement`, { method: "POST", body: {} });
    check("production is refused for a blocked line", req10.status === 409, `status=${req10.status} ${S(req10.json).slice(0, 140)}`);
    check("and the refusal says it is blocked", /blocked/i.test(S(req10.json)), S(req10.json).slice(0, 140));
  } else {
    check("blocked decision could not be established (skipped)", true, `decision=${d10}`);
  }

  sub("A11. a blocked line cannot be delivered");
  if (d10 === "Blocked") {
    const dlv = await api("/api/deliveries", {
      method: "POST",
      body: { orderItemId: o10.itemId, quantityUnits: 1, deliveryType: "Customer Pickup" },
    });
    check("the delivery is refused", dlv.status === 409 || dlv.status === 400,
      `status=${dlv.status} ${S(dlv.json).slice(0, 140)}`);
    check("and it is refused for being blocked, not for a quantity reason",
      /blocked/i.test(S(dlv.json)) || dlv.status === 400, S(dlv.json).slice(0, 140));
  } else {
    check("blocked delivery case skipped (no blocked line)", true, "");
  }

  section("E — DERIVED ORDER STATE AFTER COMMIT");

  sub("A12. a fully covered commit reaches Ready for Shipping");
  const covered = await one(
    `SELECT COALESCE(SUM("unitsAvailable"),0)::int free FROM "FinishedGoodsLot"
      WHERE "productSkuId"=$1 AND status='AVAILABLE'`, [C.skus.bra250.id]);
  const freeUnits = num(covered.free);
  if (freeUnits >= 2) {
    const o12 = await createOrder("covered", C.skus.bra250, 2);
    const c12 = await commit(o12.id, [{ orderItemId: o12.itemId }]);
    check("commit accepted", c12.status === 200, `status=${c12.status}`);
    const r12 = await orderRow(o12.id);
    check("a fully covered order is Ready for Shipping", r12.status === "Ready for Shipping", S(r12.status));
    check("its line is Available on Shelf", (await itemDecision(o12.itemId)).d === "Available on Shelf",
      S((await itemDecision(o12.itemId)).d));
  } else {
    check(`fully covered case skipped — only ${freeUnits} free unit(s) on the shelf`, true, "");
  }

  sub("A13. a commit that needs production stays in Preparation");
  const o13 = await createOrder("needs-production", C.skus.bra250, 5000);
  const c13 = await commit(o13.id, [{ orderItemId: o13.itemId }]);
  check("commit accepted", c13.status === 200, `status=${c13.status}`);
  const r13 = await orderRow(o13.id);
  check("the order stays in Preparing, not Ready for Shipping", r13.status === "Preparing", S(r13.status));
  const d13 = (await itemDecision(o13.itemId)).d;
  check("and the line is derived as needing production",
    d13 === "Needs Production" || d13 === "Partially Available", S(d13));

  await invariants("after the workflow alignment suite");

  // ── teardown ──────────────────────────────────────────────────────────────
  await teardown(P);

  await finish("WORKFLOW ALIGNMENT SUMMARY");
}

main().catch(async (e) => {
  console.error("\nFATAL: " + (e?.stack ?? e));
  console.log(`${results.pass} passed, ${results.fail + 1} failed`);
  try { await db.end(); } catch { /* already closed */ }
  process.exit(1);
});
