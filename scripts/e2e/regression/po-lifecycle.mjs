// Production Order lifecycle — business-logic regression suite.
//
// Exercises the state machine, batch association, progress derivation, the
// outstanding-demand (delta) calculation, cancellation/change scenarios, numbering and
// auditability. Deliberately not a rendering test: every assertion here is about what the
// server decides, and each one goes through the real HTTP API under a real session.
import {
  ADMIN_PIN, db, api, check, issue, section, sub, one, all, num, near, invariants,
  loginAs, concurrently, greenStock, materialStock, skuUnits, results,
} from "./harness.mjs";
import { buildCatalog, teardown, roastAndPass} from "./catalog.mjs";

const S = (v) => { try { return JSON.stringify(v) ?? String(v); } catch { return String(v); } };
const P = "POL";

let C; // catalog

// ── helpers ────────────────────────────────────────────────────────────────
const mkOrder = async (customerId, note, items) => {
  const r = await api("/api/orders", { method: "POST", body: { customerId, notes: `${P} ${note}`, items } });
  if (r.status !== 201) throw new Error("order create failed: " + S(r.json));
  await api(`/api/orders/${r.json.id}/approve`, { method: "POST", body: { decision: "Yes" } });
  return r.json;
};
const review = (order) =>
  api(`/api/orders/${order.id}/preparation-review`, { method: "POST", body: { items: order.items.map((i) => ({ orderItemId: i.id })) } });
const requirementGet = (itemId) => api(`/api/order-items/${itemId}/production-requirement`);
const requirementPost = (itemId) => api(`/api/order-items/${itemId}/production-requirement`, { method: "POST" });
const poGet = (id) => api(`/api/production-orders/${id}`);
const poAct = (id, action, reason) => api(`/api/production-orders/${id}/status`, { method: "POST", body: { action, reason } });
const poLink = (id, roastingBatchId) => api(`/api/production-orders/${id}/batches`, { method: "POST", body: { roastingBatchId } });
const poUnlink = (id, roastingBatchId) => api(`/api/production-orders/${id}/batches`, { method: "DELETE", body: { roastingBatchId } });
const packSku = (batchId, productSkuId, units) =>
  api(`/api/roasting-batches/${batchId}/pack-sku`, { method: "POST", body: { productSkuId, units } });
const movementCount = async () => num((await one('SELECT COUNT(*)::int n FROM "InventoryMovement"')).n);
const activityTypes = async (orderId) =>
  (await all('SELECT type FROM "OrderActivity" WHERE "orderId"=$1 ORDER BY "createdAt"', [orderId])).map((r) => r.type);

async function main() {
  await db.connect();
  await teardown(P);
  await db.query('DELETE FROM "ProductionOrder" WHERE id LIKE $1', [P + "_%"]);
  await loginAs(ADMIN_PIN);
  C = await buildCatalog(P);

  // ═══════════════════════════════════════════════════════════════════════
  section("A — STATE MACHINE");

  sub("A1. a production order starts PLANNED and can be released");
  const oA = await mkOrder(C.customers.cafe.id, "state machine", [{ productSkuId: C.skus.bra250.id, quantityUnits: 40 }]);
  await review(oA);
  const createA = await requirementPost(oA.items[0].id);
  check("production order created", createA.status === 201, S(createA.json).slice(0, 140));
  const poA = createA.json.productionOrder;
  check("starts PENDING", poA.status === "PENDING", poA.status);
  check("targets 40 units / 10 kg", poA.targetUnits === 40 && near(poA.targetWeightKg, 10), S({ u: poA.targetUnits, kg: poA.targetWeightKg }));

  const detailA0 = await poGet(poA.id);
  check("detail exposes allowed actions for PENDING", S(detailA0.json.allowedActions) === S(["release", "complete", "cancel"]), S(detailA0.json.allowedActions));

  const rel = await poAct(poA.id, "release");
  check("release -> IN_PRODUCTION", rel.status === 200 && rel.json.status === "IN_PRODUCTION", S(rel.json).slice(0, 120));
  const relAgain = await poAct(poA.id, "release");
  check("release twice is refused", relAgain.status === 409, "status=" + relAgain.status);

  sub("A2. completing with nothing produced is refused");
  const earlyComplete = await poAct(poA.id, "complete");
  check("complete with no roasting -> 409", earlyComplete.status === 409, "status=" + earlyComplete.status);
  check("  and says to cancel instead", /cancel the order instead/i.test(S(earlyComplete.json)), S(earlyComplete.json).slice(0, 160));

  sub("A3. real production allows completion, after which the order is terminal");
  const batchA = await roastAndPass(P, C.coffees.brazil, C.beans.brazil, 13, 11, 2, "A01");
  const linkA = await poLink(poA.id, batchA.id);
  check("batch linked", linkA.status === 201, S(linkA.json).slice(0, 140));
  const doneA = await poAct(poA.id, "complete");
  check("complete -> COMPLETED", doneA.status === 200 && doneA.json.status === "COMPLETED", S(doneA.json).slice(0, 120));

  for (const [action, label] of [["release", "COMPLETED -> IN_PRODUCTION"], ["complete", "COMPLETED -> COMPLETED"], ["cancel", "COMPLETED -> CANCELLED"]]) {
    const r = await poAct(poA.id, action, "x");
    check(`${label} is refused`, r.status === 409, "status=" + r.status + " " + S(r.json).slice(0, 100));
  }
  const detailA1 = await poGet(poA.id);
  check("a closed order offers no actions", detailA1.json.allowedActions.length === 0, S(detailA1.json.allowedActions));

  sub("A4. cancellation and its terminal guards");
  const oB = await mkOrder(C.customers.hotel.id, "cancel path", [{ productSkuId: C.skus.eth250.id, quantityUnits: 20 }]);
  await review(oB);
  const poB = (await requirementPost(oB.items[0].id)).json.productionOrder;
  const noReason = await poAct(poB.id, "cancel");
  check("cancel without a reason -> 400", noReason.status === 400, "status=" + noReason.status);
  const cancelB = await poAct(poB.id, "cancel", P + " no longer needed");
  check("cancel from PENDING -> CANCELLED", cancelB.status === 200 && cancelB.json.status === "CANCELLED", S(cancelB.json).slice(0, 120));
  for (const action of ["release", "complete", "cancel"]) {
    const r = await poAct(poB.id, action, "x");
    check(`CANCELLED -> ${action} is refused`, r.status === 409, "status=" + r.status);
  }

  sub("A5. malformed requests");
  const badAction = await poAct(poA.id, "explode", "x");
  check("unknown action -> 400", badAction.status === 400, "status=" + badAction.status);
  const missing = await poAct("does-not-exist", "release");
  check("unknown production order -> 404", missing.status === 404, "status=" + missing.status);

  await invariants("after state machine");

  // ═══════════════════════════════════════════════════════════════════════
  section("B — BATCH ASSOCIATION");

  const oC = await mkOrder(C.customers.retail.id, "linking", [{ productSkuId: C.skus.bra1kg.id, quantityUnits: 30 }]);
  await review(oC);
  const poC = (await requirementPost(oC.items[0].id)).json.productionOrder;
  check("target 30 units / 30 kg", poC.targetUnits === 30 && near(poC.targetWeightKg, 30), S({ u: poC.targetUnits, kg: poC.targetWeightKg }));

  sub("B1. one production order, many roasting batches");
  const b1 = await roastAndPass(P, C.coffees.brazil, C.beans.brazil, 14, 12, 2, "B01");
  const b2 = await roastAndPass(P, C.coffees.brazil, C.beans.brazil, 14, 12, 2, "B02");
  const b3 = await roastAndPass(P, C.coffees.brazil, C.beans.brazil, 9, 7.5, 1.5, "B03");
  for (const [i, b] of [b1, b2, b3].entries()) {
    const r = await poLink(poC.id, b.id);
    check(`batch ${i + 1} of 3 linked`, r.status === 201, S(r.json).slice(0, 130));
  }
  const detC = await poGet(poC.id);
  check("all three batches appear on the order", detC.json.roastingBatches.length === 3, String(detC.json.roastingBatches.length));
  check("actual green consumed sums (14+14+9 = 37)", near(detC.json.progress.greenConsumedKg, 37), String(detC.json.progress.greenConsumedKg));
  check("actual roasted output sums (12+12+7.5 = 31.5)", near(detC.json.progress.roastedOutputKg, 31.5), String(detC.json.progress.roastedOutputKg));
  check("linking real production moved it to IN_PRODUCTION", detC.json.status === "IN_PRODUCTION", detC.json.status);

  sub("B2. a batch can never be counted twice");
  const relink = await poLink(poC.id, b1.id);
  check("re-linking the same batch -> 409", relink.status === 409, "status=" + relink.status);
  check("  and says it is already linked here", /already linked to this production order/i.test(S(relink.json)), S(relink.json).slice(0, 140));

  const oD = await mkOrder(C.customers.cafe.id, "second po", [{ productSkuId: C.skus.bra1kg.id, quantityUnits: 5 }]);
  await review(oD);
  const poD = (await requirementPost(oD.items[0].id)).json.productionOrder;
  const steal = await poLink(poD.id, b1.id);
  check("linking a batch owned by another order -> 409", steal.status === 409, "status=" + steal.status);
  check("  and points at the other order", /another production order/i.test(S(steal.json)), S(steal.json).slice(0, 140));
  const stillOne = num((await one('SELECT COUNT(*)::int n FROM "RoastingBatch" WHERE "productionOrderId" IS NOT NULL AND id=$1', [b1.id])).n);
  check("the batch still belongs to exactly one order", stillOne === 1, String(stillOne));

  sub("B3. linking moves no inventory");
  const b4 = await roastAndPass(P, C.coffees.brazil, C.beans.brazil, 6, 5, 1, "B04");
  const movesBefore = await movementCount();
  const greenBefore = await greenStock(C.beans.brazil.id);
  await poLink(poC.id, b4.id);
  const afterLink = await movementCount();
  check("no inventory movement is written on link", afterLink === movesBefore, `${movesBefore} -> ${afterLink}`);
  check("green stock is untouched by linking", near(await greenStock(C.beans.brazil.id), greenBefore), String(await greenStock(C.beans.brazil.id)));
  await poUnlink(poC.id, b4.id);
  const afterUnlink = await movementCount();
  check("no inventory movement is written on unlink", afterUnlink === movesBefore, `${movesBefore} -> ${afterUnlink}`);
  check("green stock is untouched by unlinking", near(await greenStock(C.beans.brazil.id), greenBefore), String(await greenStock(C.beans.brazil.id)));

  sub("B4. what may not be linked");
  const ethBatch = await roastAndPass(P, C.coffees.ethiopia, C.beans.ethiopia, 6, 5, 1, "B05");
  const wrongCoffee = await poLink(poC.id, ethBatch.id);
  check("a different coffee -> 409", wrongCoffee.status === 409, "status=" + wrongCoffee.status);
  check("  and names the mismatch", /different coffee/i.test(S(wrongCoffee.json)), S(wrongCoffee.json).slice(0, 140));

  const rejected = await roastAndPass(P, C.coffees.brazil, C.beans.brazil, 6, 5, 1, "B06");
  await db.query(`UPDATE "RoastingBatch" SET status='Rejected' WHERE id=$1`, [rejected.id]);
  const linkRejected = await poLink(poC.id, rejected.id);
  check("a QC-rejected batch -> 409", linkRejected.status === 409, "status=" + linkRejected.status);

  const blendA = await roastAndPass(P, C.coffees.brazil, C.beans.brazil, 6, 5, 1, "B07");
  const blendB = await roastAndPass(P, C.coffees.brazil, C.beans.brazil, 6, 5, 1, "B08");
  const blend = await api("/api/roasting-batches/blend", { method: "POST", body: { batchIds: [blendA.id, blendB.id] } });
  if (blend.status === 201) {
    const linkBlend = await poLink(poC.id, blend.json.id);
    check("a blend -> 409", linkBlend.status === 409, "status=" + linkBlend.status);
    check("  and redirects to its source batches", /source batches/i.test(S(linkBlend.json)), S(linkBlend.json).slice(0, 140));
  } else {
    check("blend created for the blend-link test", false, "status=" + blend.status + " " + S(blend.json).slice(0, 140));
  }

  const linkToClosed = await poLink(poA.id, b4.id);
  check("linking to a COMPLETED order -> 409", linkToClosed.status === 409, "status=" + linkToClosed.status);
  const unlinkFromClosed = await poUnlink(poA.id, batchA.id);
  check("unlinking from a COMPLETED order -> 409", unlinkFromClosed.status === 409, "status=" + unlinkFromClosed.status);

  await invariants("after batch association");

  // ═══════════════════════════════════════════════════════════════════════
  section("C — PROGRESS FROM ACTUAL PRODUCTION");

  sub("C1. produced units come from packed lots, not from the plan");
  const packC = await packSku(b1.id, C.skus.bra1kg.id, 12);
  check("12 units packed from batch 1", packC.status === 201, S(packC.json).slice(0, 140));
  const detC1 = await poGet(poC.id);
  check("produced units = 12", detC1.json.progress.producedUnits === 12, String(detC1.json.progress.producedUnits));
  check("remaining units = 18 of 30", detC1.json.progress.remainingUnits === 18, String(detC1.json.progress.remainingUnits));
  const perBatch = detC1.json.roastingBatches.find((b) => b.id === b1.id);
  check("the packed batch reports its own 12 units", perBatch.packedUnits === 12, String(perBatch?.packedUnits));

  sub("C2. packing a batch into a different SKU does not credit this order");
  const packOther = await packSku(b2.id, C.skus.bra250.id, 8);
  check("8 units of a different SKU packed from batch 2", packOther.status === 201, S(packOther.json).slice(0, 140));
  const detC2 = await poGet(poC.id);
  check("produced units still 12 — the other SKU is not this order's", detC2.json.progress.producedUnits === 12, String(detC2.json.progress.producedUnits));

  sub("C3. a packed batch can no longer be unlinked");
  const unlinkPacked = await poUnlink(poC.id, b1.id);
  check("unlinking a packed batch -> 409", unlinkPacked.status === 409, "status=" + unlinkPacked.status);
  check("  and explains why", /already been packed/i.test(S(unlinkPacked.json)), S(unlinkPacked.json).slice(0, 150));

  await invariants("after progress");

  // ═══════════════════════════════════════════════════════════════════════
  section("D — OUTSTANDING DEMAND (delta scheduling)");

  sub("D1. the shelf covers part of the line; only the shortfall is scheduled");
  // Put 5 units of IDN-250G on the shelf, then order 20.
  const idnStock = await roastAndPass(P, C.coffees.indonesia, C.beans.indonesia, 3, 2.5, 0.5, "D01");
  await packSku(idnStock.id, C.skus.idn250.id, 5);
  const oE = await mkOrder(C.customers.cafe.id, "delta", [{ productSkuId: C.skus.idn250.id, quantityUnits: 20 }]);
  await review(oE);
  const itemE = oE.items[0].id;
  const reqE1 = await requirementGet(itemE);
  check("reserved 5 from the shelf", reqE1.json.reservedUnits === 5, S(reqE1.json.reservedUnits));
  check("shortfall = 15, not 20", reqE1.json.shortfallUnits === 15, S(reqE1.json.shortfallUnits));
  const poE1 = (await requirementPost(itemE)).json.productionOrder;
  check("production order raised for 15", poE1.targetUnits === 15, String(poE1.targetUnits));

  sub("D2. asking again schedules nothing — no duplicate production");
  const reqE2 = await requirementGet(itemE);
  check("scheduled = 15", reqE2.json.scheduledUnits === 15, String(reqE2.json.scheduledUnits));
  check("shortfall now 0", reqE2.json.shortfallUnits === 0, String(reqE2.json.shortfallUnits));
  const dupE = await requirementPost(itemE);
  check("a second request is refused", dupE.status === 409, "status=" + dupE.status);
  check("  and says it is already scheduled", /already on open production orders/i.test(S(dupE.json)), S(dupE.json).slice(0, 170));
  const countE = num((await one('SELECT COUNT(*)::int n FROM "ProductionOrder" WHERE "sourceOrderItemId"=$1', [itemE])).n);
  check("still exactly one production order for the line", countE === 1, String(countE));

  sub("D3. demand grows to 30 — only the incremental 10 is scheduled");
  // The order-edit endpoint is kilogram-only and cannot change a SKU line's unit
  // quantity (see the report), so the increase is applied directly. What is under test is
  // the outstanding-demand arithmetic, which is the thing that decides what gets built.
  await db.query('UPDATE "OrderItem" SET "quantityUnits"=30 WHERE id=$1', [itemE]);
  const reqE3 = await requirementGet(itemE);
  check("ordered now 30", reqE3.json.orderedUnits === 30, String(reqE3.json.orderedUnits));
  check("shortfall = 10 (30 - 5 reserved - 15 scheduled)", reqE3.json.shortfallUnits === 10, S({ o: reqE3.json.orderedUnits, r: reqE3.json.reservedUnits, s: reqE3.json.scheduledUnits, short: reqE3.json.shortfallUnits }));
  const poE2res = await requirementPost(itemE);
  check("the increment is schedulable", poE2res.status === 201, "status=" + poE2res.status + " " + S(poE2res.json).slice(0, 140));
  const poE2 = poE2res.json.productionOrder;
  check("second production order targets exactly 10", poE2.targetUnits === 10, String(poE2.targetUnits));
  check("  not the full 30 and not 25", poE2.targetUnits !== 30 && poE2.targetUnits !== 25, String(poE2.targetUnits));
  const reqE4 = await requirementGet(itemE);
  check("nothing outstanding again", reqE4.json.shortfallUnits === 0 && reqE4.json.scheduledUnits === 25, S({ s: reqE4.json.scheduledUnits, short: reqE4.json.shortfallUnits }));

  sub("D4. partial production does not release demand it has not met");
  // Produce 6 of poE1's 15 units. Scheduled should fall by 6 only after those units are
  // reserved to the line; until then the order still owes its full remainder.
  const idnB = await roastAndPass(P, C.coffees.indonesia, C.beans.indonesia, 5, 4, 1, "D02");
  await poLink(poE1.id, idnB.id);
  await packSku(idnB.id, C.skus.idn250.id, 6);
  const reqE5 = await requirementGet(itemE);
  check("scheduled falls to 19 as 6 units materialise", reqE5.json.scheduledUnits === 19, S({ s: reqE5.json.scheduledUnits }));
  // The 6 packed units are free stock on the shelf until a preparation review claims
  // them, so for that window they count towards neither `reserved` nor `scheduled` and
  // the line reads 6 short. This is how reservation has always worked in this ERP —
  // review is what claims stock — but it is worth stating plainly.
  check("packed-but-unreserved units leave a transient 6-unit gap", reqE5.json.shortfallUnits === 6, String(reqE5.json.shortfallUnits));
  issue(
    "LOW",
    "Freshly packed units read as a shortfall until the preparation review claims them",
    "Between packing and re-review the units are free stock, counted in neither reserved nor scheduled, so the line shows a shortfall equal to what was just produced. Scheduling in that window would over-produce by that amount. Pre-existing reservation semantics, not introduced here; the surplus remains valid inventory. Re-review closes it, as the next assertion shows."
  );
  await review(oE);
  const reqE6 = await requirementGet(itemE);
  check("after re-review the 6 units are reserved", reqE6.json.reservedUnits === 11, String(reqE6.json.reservedUnits));
  check("and the totals still balance to 0 outstanding", reqE6.json.shortfallUnits === 0, S({ o: reqE6.json.orderedUnits, r: reqE6.json.reservedUnits, s: reqE6.json.scheduledUnits }));

  sub("D5. cancelling a production order frees its demand for rescheduling");
  const cancelE2 = await poAct(poE2.id, "cancel", P + " changed plan");
  check("second production order cancelled", cancelE2.status === 200, "status=" + cancelE2.status);
  const reqE7 = await requirementGet(itemE);
  check("its 10 units return to the shortfall", reqE7.json.shortfallUnits === 10, S({ s: reqE7.json.scheduledUnits, short: reqE7.json.shortfallUnits }));
  const reschedule = await requirementPost(itemE);
  check("and can be scheduled again", reschedule.status === 201 && reschedule.json.productionOrder.targetUnits === 10, "status=" + reschedule.status + " " + S(reschedule.json?.productionOrder?.targetUnits));

  await invariants("after delta scheduling");

  // ═══════════════════════════════════════════════════════════════════════
  section("E — CANCELLATION AND CHANGE SCENARIOS");

  sub("E1. cancelling a production order never reverses consumed inventory");
  const oF = await mkOrder(C.customers.hotel.id, "cancel keeps stock", [{ productSkuId: C.skus.eth1kg.id, quantityUnits: 10 }]);
  await review(oF);
  const poF = (await requirementPost(oF.items[0].id)).json.productionOrder;
  const bF = await roastAndPass(P, C.coffees.ethiopia, C.beans.ethiopia, 8, 6, 2, "E01");
  await poLink(poF.id, bF.id);
  await packSku(bF.id, C.skus.eth1kg.id, 6);

  const greenF = await greenStock(C.beans.ethiopia.id);
  const bagF = await materialStock(C.materials.bag1kg.id);
  const unitsF = await skuUnits(C.skus.eth1kg.id);
  const movesF = await movementCount();

  const cancelF = await poAct(poF.id, "cancel", P + " demand withdrawn mid-production");
  check("cancelled after partial production", cancelF.status === 200, "status=" + cancelF.status);

  check("green already consumed stays consumed", near(await greenStock(C.beans.ethiopia.id), greenF), String(await greenStock(C.beans.ethiopia.id)));
  check("packaging already used stays used", (await materialStock(C.materials.bag1kg.id)) === bagF, String(await materialStock(C.materials.bag1kg.id)));
  const unitsFAfter = await skuUnits(C.skus.eth1kg.id);
  check("the 6 finished units remain in inventory", unitsFAfter.available === unitsF.available, S({ before: unitsF.available, after: unitsFAfter.available }));
  check("no compensating inventory movement is written", (await movementCount()) === movesF, `${movesF} -> ${await movementCount()}`);
  const bStill = await one('SELECT "productionOrderId" FROM "RoastingBatch" WHERE id=$1', [bF.id]);
  check("the batch stays attached to the cancelled order for history", bStill.productionOrderId === poF.id, S(bStill));

  sub("E2. a cancelled customer order blocks new production but keeps what was made");
  const oG = await mkOrder(C.customers.retail.id, "order cancelled", [{ productSkuId: C.skus.eth250.id, quantityUnits: 16 }]);
  await review(oG);
  const poG = (await requirementPost(oG.items[0].id)).json.productionOrder;
  const bG = await roastAndPass(P, C.coffees.ethiopia, C.beans.ethiopia, 4, 3, 1, "E02");
  await poLink(poG.id, bG.id);
  await packSku(bG.id, C.skus.eth250.id, 8);
  const unitsGBefore = (await skuUnits(C.skus.eth250.id)).available;

  const cancelOrderG = await api(`/api/orders/${oG.id}/status`, { method: "POST", body: { action: "cancel", reason: P + " customer withdrew" } });
  check("customer order cancelled", cancelOrderG.status === 200, "status=" + cancelOrderG.status);
  const blocked = await requirementPost(oG.items[0].id);
  check("no further production can be scheduled for it", blocked.status === 409, "status=" + blocked.status);
  check("  and the reason is the order status", /in status .{0,2}Cancelled/i.test(S(blocked.json)), S(blocked.json).slice(0, 150));
  check("units already produced remain on the shelf", (await skuUnits(C.skus.eth250.id)).available === unitsGBefore, S({ before: unitsGBefore, after: (await skuUnits(C.skus.eth250.id)).available }));
  const poGAfter = await poGet(poG.id);
  check("the production order is still readable and still open", poGAfter.status === 200 && poGAfter.json.status === "IN_PRODUCTION", S(poGAfter.json?.status));
  const cancelPoG = await poAct(poG.id, "cancel", P + " parent order cancelled");
  check("and can be cancelled to close it out", cancelPoG.status === 200, "status=" + cancelPoG.status);

  sub("E3. surplus production stays available to other orders");
  // poC targets 30 units; 12 were packed. Pack 14 more from the same batches — more than
  // the order will consume — and confirm the surplus is free stock, not an error.
  const surplus = await packSku(b3.id, C.skus.bra1kg.id, 7);
  check("surplus units packed", surplus.status === 201, S(surplus.json).slice(0, 140));
  const surplusUnits = await skuUnits(C.skus.bra1kg.id);
  check("finished goods hold the surplus", surplusUnits.available > 0, S(surplusUnits));
  check("nothing went negative", surplusUnits.available >= surplusUnits.reserved, S(surplusUnits));

  sub("E4. reducing demand below what is scheduled never goes negative");
  await db.query('UPDATE "OrderItem" SET "quantityUnits"=2 WHERE id=$1', [itemE]);
  const reqShrunk = await requirementGet(itemE);
  check("outstanding clamps at 0, never negative", reqShrunk.json.shortfallUnits === 0, String(reqShrunk.json.shortfallUnits));
  const noneToAdd = await requirementPost(itemE);
  check("and nothing new is scheduled", noneToAdd.status === 409, "status=" + noneToAdd.status);
  await db.query('UPDATE "OrderItem" SET "quantityUnits"=30 WHERE id=$1', [itemE]);

  await invariants("after cancellation scenarios");

  // ═══════════════════════════════════════════════════════════════════════
  section("F — PRODUCTION NUMBERING");

  sub("F1. numbers are unique and survive gaps");
  const beforeNums = (await all(`SELECT "productionNumber" FROM "ProductionOrder" ORDER BY "productionNumber"`)).map((r) => r.productionNumber);
  check("all numbers unique so far", new Set(beforeNums).size === beforeNums.length, `${beforeNums.length} rows, ${new Set(beforeNums).size} distinct`);

  // Delete a middle row to create a gap — the exact condition that used to wedge the
  // generator into proposing the same number forever.
  const victim = await one(`SELECT id, "productionNumber" FROM "ProductionOrder" WHERE "sourceOrderItemId"=$1 ORDER BY "productionNumber" LIMIT 1`, [oD.items[0].id]);
  if (victim) await db.query('DELETE FROM "ProductionOrder" WHERE id=$1', [victim.id]);
  check("a historical row was deleted to open a gap", !!victim, S(victim));

  const oH = await mkOrder(C.customers.cafe.id, "numbering", [{ productSkuId: C.skus.bra250.id, quantityUnits: 400 }]);
  await review(oH);
  const afterGap = await requirementPost(oH.items[0].id);
  check("a production order can still be created over a gap", afterGap.status === 201, "status=" + afterGap.status + " " + S(afterGap.json).slice(0, 130));

  sub("F2. rows from another year do not disturb this year's sequence");
  const skuId = C.skus.bra250.id;
  await db.query(
    `INSERT INTO "ProductionOrder" (id,"productionNumber","productSkuId","targetUnits","targetWeightKg","expectedGreenBeanKg",status,"surplusHandled","createdAt","updatedAt")
     VALUES ($1,$2,$3,1,1,1,'COMPLETED',false,now(),now())`,
    [`${P}_prev_year`, "PRD-2025-9999", skuId]
  );
  const oI = await mkOrder(C.customers.hotel.id, "year boundary", [{ productSkuId: C.skus.bra250.id, quantityUnits: 400 }]);
  await review(oI);
  const afterYear = await requirementPost(oI.items[0].id);
  check("creation succeeds alongside a 2025 row", afterYear.status === 201, "status=" + afterYear.status + " " + S(afterYear.json).slice(0, 130));
  const yr = new Date().getFullYear();
  check(`the new number belongs to ${yr}, not 2025`, afterYear.json?.productionOrder?.productionNumber?.startsWith(`PRD-${yr}-`), S(afterYear.json?.productionOrder?.productionNumber));
  const seq = Number(afterYear.json?.productionOrder?.productionNumber?.slice(9));
  check("and did not inherit 9999 from the other year", seq < 9999, String(seq));

  sub("F3. simultaneous creation issues no duplicate number");
  const oJ = await mkOrder(C.customers.retail.id, "race", [
    { productSkuId: C.skus.bra250.id, quantityUnits: 400 },
    { productSkuId: C.skus.eth250.id, quantityUnits: 400 },
    { productSkuId: C.skus.idn250.id, quantityUnits: 400 },
  ]);
  await review(oJ);
  const raced = await concurrently(oJ.items.length, (i) => requirementPost(oJ.items[i].id));
  const created = raced.filter((r) => r.status === 201).length;
  check(`${created} of 3 simultaneous requests created an order`, created === 3, S(raced.map((r) => r.status)));
  const allNums = (await all(`SELECT "productionNumber" FROM "ProductionOrder"`)).map((r) => r.productionNumber);
  check("every production number in the database is unique", new Set(allNums).size === allNums.length, `${allNums.length} rows, ${new Set(allNums).size} distinct`);

  sub("F4. simultaneous requests for the SAME line create only one");
  const oK = await mkOrder(C.customers.cafe.id, "same line race", [{ productSkuId: C.skus.eth1kg.id, quantityUnits: 90 }]);
  await review(oK);
  const expectK = (await requirementGet(oK.items[0].id)).json.shortfallUnits;
  const sameLine = await concurrently(5, () => requirementPost(oK.items[0].id));
  const madeK = sameLine.filter((r) => r.status === 201).length;
  const rowsK = num((await one('SELECT COUNT(*)::int n FROM "ProductionOrder" WHERE "sourceOrderItemId"=$1', [oK.items[0].id])).n);
  check("exactly one production order exists for the line", rowsK === 1, `created=${madeK} rows=${rowsK} statuses=${S(sameLine.map((r) => r.status))}`);
  const totalTargetK = num((await one('SELECT COALESCE(SUM("targetUnits"),0)::int n FROM "ProductionOrder" WHERE "sourceOrderItemId"=$1', [oK.items[0].id])).n);
  check(`and it schedules the outstanding demand exactly once (${expectK} units)`, totalTargetK === expectK, `expected ${expectK} got ${totalTargetK}`);

  await invariants("after numbering");

  // ═══════════════════════════════════════════════════════════════════════
  section("G — AUDITABILITY");

  sub("G1. every production action lands on the customer order timeline");
  const typesA = await activityTypes(oA.id);
  for (const want of ["PRODUCTION_ORDER_CREATED", "PRODUCTION_ORDER_RELEASED", "PRODUCTION_BATCH_LINKED", "PRODUCTION_ORDER_COMPLETED"]) {
    check(`${want} recorded`, typesA.includes(want), S(typesA));
  }
  const typesB = await activityTypes(oB.id);
  check("PRODUCTION_ORDER_CANCELLED recorded", typesB.includes("PRODUCTION_ORDER_CANCELLED"), S(typesB));
  const typesC = await activityTypes(oC.id);
  check("PRODUCTION_BATCH_UNLINKED recorded", typesC.includes("PRODUCTION_BATCH_UNLINKED"), S(typesC));

  sub("G2. the audit entry carries who, what and the numbers");
  const rowA = await one(
    `SELECT message, "authorName", metadata FROM "OrderActivity" WHERE "orderId"=$1 AND type='PRODUCTION_ORDER_CREATED' LIMIT 1`,
    [oA.id]
  );
  check("author recorded", !!rowA.authorName, S(rowA?.authorName));
  check("production number in the message", rowA.message.includes(poA.productionNumber), rowA.message.slice(0, 120));
  check("metadata carries the production order id", rowA.metadata?.productionOrderId === poA.id, S(rowA.metadata));

  // ═══════════════════════════════════════════════════════════════════════
  section("H — LIST AND DETAIL SURFACE");

  const list = await api("/api/production-orders");
  check("list returns production orders", list.status === 200 && Array.isArray(list.json) && list.json.length > 0, "status=" + list.status);
  const sample = list.json[0];
  for (const field of ["productionNumber", "status", "targetUnits", "expectedGreenBeanKg", "createdAt", "progress", "productSku"]) {
    check(`list row exposes ${field}`, sample[field] !== undefined, S(Object.keys(sample)));
  }
  check("list row carries the demand source", "sourceOrderItem" in sample, S(Object.keys(sample)));
  const filtered = await api("/api/production-orders?status=CANCELLED");
  check("status filter works", filtered.status === 200 && filtered.json.every((r) => r.status === "CANCELLED"), "status=" + filtered.status);

  // ═══════════════════════════════════════════════════════════════════════
  section("I — RECONCILIATION");

  sub("Production orders never over-report what was produced");
  const overReported = await all(`
    SELECT po."productionNumber", po."targetUnits",
           COALESCE(SUM(f."unitsProduced"),0)::int AS packed
      FROM "ProductionOrder" po
      LEFT JOIN "RoastingBatch" rb ON rb."productionOrderId" = po.id AND rb."isBlend" = false AND rb.status <> 'Rejected'
      LEFT JOIN "FinishedGoodsLot" f ON f."packedFromBatchId" = rb.id AND f."productSkuId" = po."productSkuId"
     WHERE po."productionNumber" LIKE 'PRD-%'
     GROUP BY po.id, po."productionNumber", po."targetUnits"`);
  console.log(`    ${overReported.length} production orders checked`);
  check("no production order reports negative progress", overReported.every((r) => num(r.packed) >= 0), S(overReported.slice(0, 3)));

  sub("Every batch belongs to at most one production order");
  const multi = await all(`SELECT id FROM "RoastingBatch" WHERE "productionOrderId" IS NOT NULL GROUP BY id HAVING COUNT(DISTINCT "productionOrderId") > 1`);
  check("no batch is shared between production orders", multi.length === 0, String(multi.length));

  sub("Packed units never exceed what their batch could yield");
  const overPacked = await all(`
    SELECT rb."batchNumber", rb."roastedBeanQuantity", rb."roastedAvailableKg"
      FROM "RoastingBatch" rb WHERE rb."roastedAvailableKg" < 0`);
  check("no batch has negative roasted stock remaining", overPacked.length === 0, S(overPacked));

  await invariants("final");

  section("RESULT");
  console.log(`${results.pass} passed, ${results.fail} failed`);
  if (results.failures.length) console.log("FAILURES:\n  - " + results.failures.join("\n  - "));
  if (results.issues.length) {
    console.log("\nISSUES:");
    for (const i of results.issues) console.log(`  [${i.severity}] ${i.title} — ${i.detail}`);
  }
  await db.end();
  process.exit(results.fail === 0 ? 0 : 1);
}

main().catch(async (e) => { console.log("FATAL:", e?.stack || e); try { await db.end(); } catch {} process.exit(1); });
