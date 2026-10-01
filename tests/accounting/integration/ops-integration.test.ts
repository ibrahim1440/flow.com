// Operational stock → inventory accounting (stage 4b), against real PostgreSQL. Events are
// recorded exactly as the operational routes record them (recordStockEvent in the operational
// transaction, same payloads); the HTTP suite drives the routes themselves. Loss bands and the
// inventory.operations approval here are SYNTHETIC TEST ASSUMPTIONS.
//
// Hand workings (weighted average; RST is the sales-default location):
//   P1 purchase 100 kg green @ 30 (policy not yet approved → held; accountant posts) Dr 1171 3,000 / Cr 2120
//   P2 purchase bags 1,000 @ 0.65 = 650 · P3 labels 1,000 @ 0.15 = 150            Dr 1172 800 / Cr 2120
//   R1 roast 60 kg → 50 kg (loss 16.67% ≤ band 18%)                               Dr 1173 1,800 / Cr 1171 1,800 (36.00/kg)
//   K1 pack 10,280 g drawn = 40 × 250 g + a partial 180 g + 100 g loss; 41 bags, 41 labels
//      outputs 40 + 180/250 = 40.72 units (10.18 kg); loss 0.10/10.28 = 0.97% ≤ 1%
//      roasted 10.28 × 36 = 370.08 · bags 26.65 · labels 6.15                    Dr 1174 402.88 / Cr 1173 370.08, 1172 32.80
//   K2 top-up of the partial +70 g → a full unit: 1 − 0.72 = 0.28 unit, 0.07 kg × 36 Dr 1174 2.52 / Cr 1173 2.52
//      SKU: 41 units, 405.40
//   D1 dispatch 10 units for order line oi-1 → delivered, not invoiced: 405.40 × 10/41 = 98.88   Dr 1176 / Cr 1174
//   S1 invoice for oi-1, 10 units → cost from that line's dispatched goods          Dr 5100 98.88 / Cr 1176
//   A1 count: green −0.5 kg at 1,200/40 = 30.00                                    Dr 5700 15.00 / Cr 1171
import { test, describe, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { prisma, reset, makeUser, rejects } from "./support";
import { draftPolicy, approvePolicy } from "../../../src/lib/accounting/policy-service";
import { approveInvDoc, postInvDoc } from "../../../src/lib/accounting/inventory-service";
import { createSalesDoc, submitSalesDoc, approveSalesDoc, postSalesDoc } from "../../../src/lib/accounting/receivables-service";
import { lockFiscalPeriod } from "../../../src/lib/accounting/fiscal-period-service";
import * as Ops from "../../../src/lib/accounting/ops-integration";
import { todayAccountingDate } from "../../../src/lib/accounting/dates";
import { world, journal, gl, type W } from "./inventory-world";

beforeEach(reset);
after(async () => { await prisma.$disconnect(); });

const TODAY = todayAccountingDate().toISOString().slice(0, 10);

/** Operational masters linked to the world's inventory items (as inventory setup would link them). */
async function ops(w: W) {
  const bean = await prisma.greenBean.create({ data: { serialNumber: "GB-SYN-1", beanType: "Ethiopia Guji (synthetic)", country: "Ethiopia", quantityKg: 0 } });
  const product = await prisma.coffeeProduct.create({ data: { productNameEn: "Guji roast (synthetic)", countryEn: "Ethiopia" } as never });
  const sku = await prisma.productSKU.create({ data: { id: "sku-eth-250", productId: product.id, skuCode: "GUJI-250-SYN", weightGrams: 250 } });
  const bag = await prisma.materialItem.create({ data: { code: "BAG-SYN", name: "Bag 250 g (synthetic)" } });
  const label = await prisma.materialItem.create({ data: { code: "LBL-SYN", name: "Label (synthetic)" } });
  await prisma.invItem.update({ where: { id: w.I.green.id }, data: { greenBeanId: bean.id } });
  await prisma.invItem.update({ where: { id: w.I.roasted.id }, data: { coffeeProductId: product.id } });
  await prisma.invItem.update({ where: { id: w.I.bag.id }, data: { materialItemId: bag.id } });
  await prisma.invItem.update({ where: { id: w.I.label.id }, data: { materialItemId: label.id } });
  return { bean: bean.id, product: product.id, sku: sku.id, bag: bag.id, label: label.id };
}
const record = (e: Ops.StockEvent) => prisma.$transaction((tx) => Ops.recordStockEvent(tx, e));
const approveOpsPolicy = async (w: W) => { const p = await draftPolicy("inventory.operations", {}, w.prep); await approvePolicy(p.id, w.appr); };
const docOf = async (eventId: string) => (await prisma.invOpsEvent.findUniqueOrThrow({ where: { id: eventId } })).documentId!;

describe("stage 4b — operational stock events become inventory documents", () => {
  test("purchase → roast → pack (standard, partial, top-up) → dispatch → invoice, with held approval, a count and reconciliation", async () => {
    const w = await world();
    const O = await ops(w);
    const clerk = await makeUser("Roastery clerk", []);

    // Without the operations policy an accountant approves each document; the event waits.
    const p1 = await record({ kind: "PURCHASE", sourceId: "pur-1", userId: clerk, payload: { purchaseId: "pur-1", greenBeanId: O.bean, quantity: 100, costPerUnit: 30, supplierId: w.S.green } });
    const held = await Ops.processOpsEvent(p1.id);
    assert.equal(held.status, "HELD"); assert.match(held.reason ?? "", /inventory\.operations policy is not approved/);
    const d1 = await prisma.invDocument.findUniqueOrThrow({ where: { id: held.documentId! } });
    assert.equal(d1.status, "SUBMITTED"); assert.equal(d1.createdBy, clerk, "prepared in the name of whoever recorded the purchase");
    await rejects(approveInvDoc(d1.id, clerk), /someone other|four-eyes|approve/i);
    await approveInvDoc(d1.id, w.appr); await postInvDoc(d1.id, w.appr);
    assert.equal((await prisma.invOpsEvent.findUniqueOrThrow({ where: { id: p1.id } })).status, "POSTED", "posting the held document completes the event");
    assert.deepEqual(await journal(d1.id), ["1171:3000.00:0.00", "2120:0.00:3000.00"]);

    await approveOpsPolicy(w);
    const run = async (e: Ops.StockEvent) => { const ev = await record(e); const r = await Ops.processOpsEvent(ev.id); assert.equal(r.status, "POSTED", `${e.kind}: ${r.reason}`); return r.documentId!; };
    await run({ kind: "PURCHASE", sourceId: "pur-2", payload: { purchaseId: "pur-2", materialItemId: O.bag, quantity: 1000, costPerUnit: 0.65, supplierId: w.S.green } });
    await run({ kind: "PURCHASE", sourceId: "pur-3", payload: { purchaseId: "pur-3", materialItemId: O.label, quantity: 1000, costPerUnit: 0.15, supplierId: w.S.green } });
    const r1 = await run({ kind: "ROAST", sourceId: "rb-1", payload: { batchId: "rb-1", batchNumber: "R-001", greenBeanId: O.bean, productId: O.product, greenKg: 60, roastedKg: 50, wasteKg: 10 } });
    assert.deepEqual(await journal(r1), ["1171:0.00:1800.00", "1173:1800.00:0.00"]);
    const k1 = await run({ kind: "PACK", sourceId: "op-1", payload: { batchId: "rb-1", batchNumber: "R-001", productId: O.product, gramsConsumed: 10280, lossGrams: 100,
      materials: [{ materialItemId: O.bag, quantity: 41 }, { materialItemId: O.label, quantity: 41 }],
      lots: [{ lotId: "lot-std", productSkuId: O.sku, kind: "STANDARD", units: 40, actualGrams: 250, nominalGrams: 250 }, { lotId: "lot-part", productSkuId: O.sku, kind: "PARTIAL", units: 0, actualGrams: 180, nominalGrams: 250 }] } });
    assert.deepEqual(await journal(k1), ["1172:0.00:32.80", "1173:0.00:370.08", "1174:402.88:0.00"]);
    const outs = await prisma.invDocLine.findMany({ where: { documentId: k1, role: "OUTPUT" }, orderBy: { lineNo: "asc" } });
    assert.deepEqual(outs.map((l) => [l.lotId, l.quantity.toFixed(4)]), [["lot-std", "40.0000"], ["lot-part", "0.7200"]]);
    const k2 = await run({ kind: "PACK", sourceId: "op-2", payload: { batchId: "rb-1", batchNumber: "R-001", productId: O.product, gramsConsumed: 70, lossGrams: 0, materials: [],
      lots: [{ lotId: "lot-part", productSkuId: O.sku, kind: "TOP_UP", units: 1, actualGrams: 250, nominalGrams: 250, gramsAdded: 70, becomesStandard: true }] } });
    assert.deepEqual(await journal(k2), ["1173:0.00:2.52", "1174:2.52:0.00"]);
    const d = await run({ kind: "DISPATCH", sourceId: "del-1", payload: { mode: "UNITS", deliveryId: "del-1", orderItemId: "oi-1", lotId: "lot-std", productSkuId: O.sku, units: 10 } });
    assert.deepEqual(await journal(d), ["1174:0.00:98.88", "1176:98.88:0.00"], "dispatched goods wait at cost in delivered, not invoiced");

    const inv = await createSalesDoc({ customerId: w.customer, issueDate: TODAY, lines: [{ productSkuId: O.sku, orderItemId: "oi-1", description: "Guji 250 g", quantity: "10", unitPrice: "25", taxCategoryId: w.vat }] }, w.prep);
    await submitSalesDoc(inv.id, w.prep); await approveSalesDoc(inv.id, w.appr);
    const posted = await postSalesDoc(inv.id, w.appr);
    assert.equal(posted.costing?.status, "COSTED", posted.costing?.reason ?? "");
    const issue = await prisma.invDocument.findFirstOrThrow({ where: { type: "SALE_ISSUE", salesInvoiceId: inv.id } });
    assert.deepEqual(await journal(issue.id), ["1176:0.00:98.88", "5100:98.88:0.00"], "the invoice takes the cost of the goods dispatched for its order line");

    const a1 = await run({ kind: "ADJUST", sourceId: "adj-1", payload: { greenBeanId: O.bean, quantityChanged: -0.5, previousQuantity: 40, newQuantity: 39.5, reason: "جرد شهري" } });
    assert.deepEqual(await journal(a1), ["1171:0.00:15.00", "5700:15.00:0.00"]);

    // Reconciliation compares, it does not re-enter: operational 39.5 kg = accounts 39.5 kg.
    await prisma.greenBean.update({ where: { id: O.bean }, data: { quantityKg: 39.5 } });
    await prisma.materialItem.update({ where: { id: O.bag }, data: { quantityOnHand: 950 } });   // one bag short of the accounts' 959
    const rec = await Ops.opsReconciliation();
    const row = (code: string) => rec.rows.find((r) => r.code === code)!;
    assert.deepEqual([row("GRN-ETH").ops, row("GRN-ETH").accounts, row("GRN-ETH").state], ["39.5000", "39.5000", "MATCHED"]);
    assert.deepEqual([row("BAG-250").difference, row("BAG-250").state], ["-9.0000", "EXCEPTION"], "a difference nothing explains is an exception");
    assert.equal(await gl(w, "1176", TODAY), "0.00");
    assert.equal(await prisma.invDocument.count({ where: { sourceType: "OPS" } }), 8, "one document per event");
  });

  test("robustness: missing mapping, stock not there yet, retries, a crashed worker, loss above the band, a closed period, an unknown writer", async () => {
    const w = await world();
    const O = await ops(w);
    await approveOpsPolicy(w);
    const buy = await record({ kind: "PURCHASE", sourceId: "pur-1", payload: { purchaseId: "pur-1", greenBeanId: O.bean, quantity: 100, costPerUnit: 30, supplierId: w.S.green } });
    assert.equal((await Ops.processOpsEvent(buy.id)).status, "POSTED");

    // A product nobody linked: the roast stops with the reason, nothing is guessed.
    const other = await prisma.coffeeProduct.create({ data: { productNameEn: "Unlinked roast (synthetic)", countryEn: "Brazil" } as never });
    const roast = await record({ kind: "ROAST", sourceId: "rb-2", payload: { batchId: "rb-2", batchNumber: "R-002", greenBeanId: O.bean, productId: other.id, greenKg: 20, roastedKg: 17, wasteKg: 3 } });
    const b = await Ops.processOpsEvent(roast.id);
    assert.equal(b.status, "BLOCKED"); assert.match(b.reason ?? "", /not linked to an inventory item/);
    // It is linked; packing that roast before the roast is retried: the roasted coffee is not in the accounts yet → fails and backs off.
    const bra = await prisma.invItem.create({ data: { code: "RST-BRA", name: "Roasted Brazil (synthetic)", kind: "ROASTED_COFFEE", baseUnit: "kg", coffeeProductId: other.id, createdBy: w.prep } });
    void bra;
    const pack = await record({ kind: "PACK", sourceId: "op-9", payload: { batchId: "rb-2", batchNumber: "R-002", productId: other.id, gramsConsumed: 1000, lossGrams: 0, materials: [], lots: [{ lotId: "l9", productSkuId: O.sku, kind: "STANDARD", units: 4, actualGrams: 250, nominalGrams: 250 }] } });
    const f = await Ops.processOpsEvent(pack.id);
    assert.equal(f.status, "FAILED"); assert.match(f.reason ?? "", /Not enough|stock/i);
    const failed = await prisma.invOpsEvent.findUniqueOrThrow({ where: { id: pack.id } });
    assert.ok(failed.nextAttemptAt > new Date(), "a failure backs off");
    assert.equal((await Ops.processPendingOpsEvents()).length, 0, "nothing is due while backing off, and a blocked event is not retried by itself");
    // The roast is retried from the queue (its product is linked now); then the packing.
    assert.equal((await Ops.retryOpsEvent(roast.id, w.appr)).status, "POSTED");
    assert.equal((await Ops.retryOpsEvent(pack.id, w.appr)).status, "POSTED");

    // A worker that died mid-way: a live lease is respected, an expired one is taken over; one document only.
    const again = await record({ kind: "ADJUST", sourceId: "adj-9", payload: { greenBeanId: O.bean, quantityChanged: 1, reason: "وجدنا كيساً إضافياً" } });
    await prisma.invOpsEvent.update({ where: { id: again.id }, data: { status: "PROCESSING", leaseUntil: new Date(Date.now() + 60_000) } });
    assert.equal((await Ops.processOpsEvent(again.id)).status, "PROCESSING", "a live lease is respected");
    assert.equal((await Ops.processPendingOpsEvents()).length, 0);
    await prisma.invOpsEvent.update({ where: { id: again.id }, data: { leaseUntil: new Date(Date.now() - 1000) } });
    const taken = await Ops.processPendingOpsEvents();
    assert.deepEqual(taken.map((r) => r.status), ["POSTED"]);
    assert.equal((await Ops.processOpsEvent(again.id, { force: false })).status, "POSTED");
    assert.equal(await prisma.invDocument.count({ where: { sourceType: "OPS", sourceId: again.id } }), 1);
    assert.deepEqual(await journal(await docOf(again.id)), ["1171:30.00:0.00", "5700:0.00:30.00"], "a surplus comes in at the average cost (3,000 − 600) / 80 = 30.00");

    // Loss above the approved band: prepared, but an accountant approves the abnormal loss.
    const bad = await record({ kind: "ROAST", sourceId: "rb-3", payload: { batchId: "rb-3", batchNumber: "R-003", greenBeanId: O.bean, productId: other.id, greenKg: 10, roastedKg: 7, wasteKg: 3 } });
    const h = await Ops.processOpsEvent(bad.id);
    assert.equal(h.status, "HELD"); assert.match(h.reason ?? "", /Loss 30\.00% is above the approved band ROAST-SYN \(18\.00%\)/);
    await approveInvDoc(h.documentId!, w.appr); await postInvDoc(h.documentId!, w.appr);
    assert.equal((await prisma.invOpsEvent.findUniqueOrThrow({ where: { id: bad.id } })).status, "POSTED");

    // An event dated in a locked period is booked on the first open day, its date kept.
    const lastMonth = new Date(todayAccountingDate()); lastMonth.setUTCDate(0);
    const period = await prisma.fiscalPeriod.findFirstOrThrow({ where: { startDate: { lte: lastMonth }, endDate: { gte: lastMonth } } });
    const lateBuy = await record({ kind: "PURCHASE", sourceId: "pur-late", occurredOn: lastMonth, payload: { purchaseId: "pur-late", greenBeanId: O.bean, quantity: 5, costPerUnit: 30, supplierId: w.S.green } });
    await lockFiscalPeriod(period.id, w.appr);
    assert.equal((await Ops.processOpsEvent(lateBuy.id)).status, "POSTED");
    const late = await prisma.invDocument.findUniqueOrThrow({ where: { id: await docOf(lateBuy.id) } });
    assert.equal(late.originalDate?.toISOString().slice(0, 10), lastMonth.toISOString().slice(0, 10)); assert.ok(late.docDate > lastMonth); assert.match(late.lateReason ?? "", /not open/);

    // A stock movement written by a path the integration does not know: an exception, never silent.
    await prisma.inventoryMovement.create({ data: { type: "ADJUSTMENT", category: "RAW_MATERIAL", referenceEntityId: O.bean, quantityChanged: -2, previousQuantity: 10, newQuantity: 8, sourceDocType: "MANUAL_ADJUSTMENT" } });
    const u = await prisma.invOpsEvent.findFirstOrThrow({ where: { kind: "UNINTEGRATED" } });
    assert.equal(u.status, "BLOCKED");
    await rejects(Ops.retryOpsEvent(u.id, w.appr), /linking the document/);
    await rejects(Ops.ignoreOpsEvent(u.id, w.appr, "no"), /reason/);
    const manual = await w.doc({ type: "ISSUE", issueReason: "SPOILAGE", docDate: TODAY, locationId: w.rst, lines: [{ itemId: w.I.green.id, quantity: "2" }] });
    await Ops.linkOpsEvent(u.id, manual.document.id, w.appr, "Posted manually after checking the warehouse log");
    assert.equal((await prisma.invOpsEvent.findUniqueOrThrow({ where: { id: u.id } })).status, "POSTED");
    // Movements written WITH their event are not flagged.
    await prisma.$transaction(async (tx) => {
      await tx.inventoryMovement.create({ data: { type: "IN", category: "RAW_MATERIAL", referenceEntityId: O.bean, quantityChanged: 1, previousQuantity: 8, newQuantity: 9, sourceDocType: "PURCHASE" } });
      await Ops.recordStockEvent(tx, { kind: "PURCHASE", sourceId: "pur-x", payload: { purchaseId: "pur-x", greenBeanId: O.bean, quantity: 1, costPerUnit: 30, supplierId: w.S.green } });
    });
    assert.equal(await prisma.invOpsEvent.count({ where: { kind: "UNINTEGRATED" } }), 1);
  });

  test("a late event whose first open day already has a movement posts on that day (regression: refused when the first open day was the 1st of the month)", async (t) => {
    const first = new Date(todayAccountingDate()); first.setUTCDate(1);
    const prevDay = new Date(first); prevDay.setUTCDate(0);
    if (first.getUTCMonth() === 0) { t.skip("in January the previous day is in the previous fiscal year, before the test's cutover"); return; }
    const w = await world();
    const O = await ops(w);
    await approveOpsPolicy(w);
    const buy = (sourceId: string, occurredOn: Date) => record({ kind: "PURCHASE", sourceId, occurredOn, payload: { purchaseId: sourceId, greenBeanId: O.bean, quantity: 10, costPerUnit: 30, supplierId: w.S.green } });
    const onFirst = await buy("pur-first", first);
    assert.equal((await Ops.processOpsEvent(onFirst.id)).status, "POSTED");
    const late = await buy("pur-prev", prevDay);
    const period = await prisma.fiscalPeriod.findFirstOrThrow({ where: { startDate: { lte: prevDay }, endDate: { gte: prevDay } } });
    await lockFiscalPeriod(period.id, w.appr);
    const r = await Ops.processOpsEvent(late.id);
    assert.equal(r.status, "POSTED", r.reason ?? undefined);
    const doc = await prisma.invDocument.findUniqueOrThrow({ where: { id: await docOf(late.id) } });
    assert.deepEqual([doc.docDate.toISOString().slice(0, 10), doc.originalDate?.toISOString().slice(0, 10)], [first.toISOString().slice(0, 10), prevDay.toISOString().slice(0, 10)]);
    assert.match(doc.lateReason ?? "", /not open/);
  });

  test("roast cancellation, opening quantities, a blend, and dispatch of an unintegrated kilogram lot", async () => {
    const w = await world();
    const O = await ops(w);
    await approveOpsPolicy(w);
    const go = async (e: Ops.StockEvent) => Ops.processOpsEvent((await record(e)).id);
    await go({ kind: "PURCHASE", sourceId: "pur-1", payload: { purchaseId: "pur-1", greenBeanId: O.bean, quantity: 100, costPerUnit: 30, supplierId: w.S.green } });
    const r = await go({ kind: "ROAST", sourceId: "rb-1", payload: { batchId: "rb-1", batchNumber: "R-001", greenBeanId: O.bean, productId: O.product, greenKg: 60, roastedKg: 50, wasteKg: 10 } });
    assert.equal(r.status, "POSTED");
    // Cancelled with restock: roasted out (50 kg at 36.00), green back (60 kg at the 30.00 it left at).
    const c = await go({ kind: "ROAST_CANCEL", sourceId: "rb-1", payload: { batchId: "rb-1", batchNumber: "R-001", greenBeanId: O.bean, productId: O.product, greenKg: 60, roastedKg: 50, restock: true } });
    assert.equal(c.status, "POSTED", c.reason ?? "");
    assert.deepEqual(await journal(c.documentId!), ["1171:1800.00:0.00", "1173:0.00:1800.00"]);
    // A batch cancelled before its roast reached the accounts: the roast is dismissed; restocked → no effect.
    const rb2 = await record({ kind: "ROAST", sourceId: "rb-2", payload: { batchId: "rb-2", batchNumber: "R-002", greenBeanId: O.bean, productId: O.product, greenKg: 10, roastedKg: 8.5, wasteKg: 1.5 } });
    const c2 = await go({ kind: "ROAST_CANCEL", sourceId: "rb-2", payload: { batchId: "rb-2", batchNumber: "R-002", greenBeanId: O.bean, productId: O.product, greenKg: 10, roastedKg: 8.5, restock: true } });
    assert.equal(c2.status, "IGNORED");
    assert.equal((await prisma.invOpsEvent.findUniqueOrThrow({ where: { id: rb2.id } })).status, "IGNORED");
    // An opening quantity has no cost and its counter-entry is an accounting decision: it waits.
    const o = await go({ kind: "OPENING", sourceId: "material:x", payload: { materialItemId: O.bag, quantity: 200 } });
    assert.equal(o.status, "HELD"); assert.match(o.reason ?? "", /without a cost.*opening-balance procedure/);
    assert.equal(o.documentId, null, "no document is guessed");
    await Ops.ignoreOpsEvent(o.id, w.appr, "Opening balances are loaded by the migration, not here");
    // A kilogram lot from the old packing path was never in the accounts: stop, with the reason.
    const k = await go({ kind: "DISPATCH", sourceId: "del-kg", payload: { mode: "KG", deliveryId: "del-kg", orderItemId: "oi-9", lotId: "lot-kg", kg: 5 } });
    assert.equal(k.status, "BLOCKED"); assert.match(k.reason ?? "", /kilogram lot/);
    await Ops.ignoreOpsEvent(k.id, w.appr, "Legacy lot, cost already written off in 2025 migration");
    // A blend: roasted coffee taken from two source batches (products resolved from the batches), the
    // blend made; no weight lost, so no band is needed. The restock above emptied the roasted coffee:
    // roast 20 kg → 17 kg (green at 30.00 → 600.00, 35.2941/kg), then blend 3 + 2 kg = 5 kg → 176.47.
    await go({ kind: "ROAST", sourceId: "rb-3", payload: { batchId: "rb-3", batchNumber: "R-003", greenBeanId: O.bean, productId: O.product, greenKg: 20, roastedKg: 17, wasteKg: 3 } });
    const blendProduct = await prisma.coffeeProduct.create({ data: { productNameEn: "House blend (synthetic)", countryEn: "Blend" } as never });
    const blendItem = await prisma.invItem.create({ data: { code: "BLEND-SYN", name: "House blend (synthetic)", kind: "ROASTED_COFFEE", baseUnit: "kg", coffeeProductId: blendProduct.id, createdBy: w.prep } });
    const s1 = await prisma.roastingBatch.create({ data: { batchNumber: "R-S1", greenBeanQuantity: 10, roastedBeanQuantity: 8.5, productId: O.product } });
    const s2 = await prisma.roastingBatch.create({ data: { batchNumber: "R-S2", greenBeanQuantity: 10, roastedBeanQuantity: 8.5, productId: O.product } });
    const bl = await go({ kind: "BLEND", sourceId: "rb-blend", payload: { batchId: "rb-blend", batchNumber: "B-001", productId: blendProduct.id, totalKg: 5, sources: [{ batchId: s1.id, kg: 3 }, { batchId: s2.id, kg: 2 }] } });
    assert.equal(bl.status, "POSTED", bl.reason ?? "");
    const blLines = await prisma.invDocLine.findMany({ where: { documentId: bl.documentId! }, orderBy: { lineNo: "asc" } });
    assert.deepEqual(blLines.map((l) => [l.role, l.itemId === blendItem.id ? "BLEND" : "RST", l.quantity.toFixed(4)]), [["INPUT", "RST", "5.0000"], ["OUTPUT", "BLEND", "5.0000"]], "one input per source product, one output");
    const blIn = await prisma.invMove.findFirstOrThrow({ where: { documentId: bl.documentId!, kind: "IN" } });
    assert.deepEqual([blIn.itemId === blendItem.id, blIn.qty.toFixed(4), blIn.value.toFixed(2)], [true, "5.0000", "176.47"]);

    // QC rejects a batch (terminal): the roasted coffee left on it is written off as QC waste,
    // 2 kg at the average 35.2941 → 70.59 (Dr 5500). A second finalisation adds nothing.
    const rej = await prisma.roastingBatch.create({ data: { batchNumber: "R-REJ", greenBeanQuantity: 3, roastedBeanQuantity: 2.5, roastedAvailableKg: 2, productId: O.product, status: "Rejected" } });
    const qcIds = await prisma.$transaction((tx) => Ops.recordQcRejections(tx, [rej.id, s1.id], w.appr));
    assert.equal(qcIds.length, 1, "only the rejected batch");
    assert.deepEqual(await prisma.$transaction((tx) => Ops.recordQcRejections(tx, [rej.id], w.appr)), [], "once per batch");
    const q = await Ops.processOpsEvent(qcIds[0]);
    assert.equal(q.status, "POSTED", q.reason ?? "");
    assert.deepEqual(await journal(q.documentId!), ["1173:0.00:70.59", "5500:70.59:0.00"]);

    const list = await Ops.listOpsEvents({ status: "IGNORED" });
    assert.equal(list.rows.length, 4, "the dismissed roast, the no-effect cancellation, the opening quantity and the kilogram lot");
  });

  test("an accountant links an unlinked item to its operational record; a blocked event then posts on retry", async () => {
    const w = await world();
    await approveOpsPolicy(w);
    const { linkItem } = await import("../../../src/lib/accounting/inventory-service");
    const p = await prisma.coffeeProduct.create({ data: { productNameEn: "Kenya AA (synthetic)", countryEn: "Kenya" } as never });
    const bean = await prisma.greenBean.create({ data: { serialNumber: "GB-SYN-9", beanType: "Kenya (synthetic)", country: "Kenya", quantityKg: 0 } });
    await prisma.invItem.update({ where: { id: w.I.green.id }, data: { greenBeanId: bean.id } });
    const buy = await record({ kind: "PURCHASE", sourceId: "pur-k", payload: { purchaseId: "pur-k", greenBeanId: bean.id, quantity: 50, costPerUnit: 40, supplierId: w.S.green } });
    assert.equal((await Ops.processOpsEvent(buy.id)).status, "POSTED");
    const roast = await record({ kind: "ROAST", sourceId: "rb-k", payload: { batchId: "rb-k", batchNumber: "R-K", greenBeanId: bean.id, productId: p.id, greenKg: 10, roastedKg: 8.5, wasteKg: 1.5 } });
    assert.equal((await Ops.processOpsEvent(roast.id)).status, "BLOCKED");
    await rejects(linkItem(w.I.green.id, { field: "coffeeProductId", targetId: p.id }, w.prep), /already linked/);
    await rejects(linkItem(w.I.bag.id, { field: "coffeeProductId", targetId: p.id }, w.prep), /cannot be linked to that kind/);
    await linkItem(w.I.roasted.id, { field: "coffeeProductId", targetId: p.id }, w.prep);
    const other = await prisma.invItem.create({ data: { code: "RST-KEN-2", name: "second", kind: "ROASTED_COFFEE", baseUnit: "kg", createdBy: w.prep } });
    await rejects(linkItem(other.id, { field: "coffeeProductId", targetId: p.id }, w.prep), /already linked to RST-ETH/);
    assert.equal((await Ops.retryOpsEvent(roast.id, w.appr)).status, "POSTED", "the blocked roast posts once the item is linked");
    assert.equal(await prisma.finAuditLog.count({ where: { action: { contains: "inventory.item.link" } } }), 1, "the link is audited");
  });
});
