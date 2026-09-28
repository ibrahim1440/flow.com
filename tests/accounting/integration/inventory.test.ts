// Stage 4 against real PostgreSQL: purchasing → receipt → bill match → landed cost → roasting →
// packing → sale (cost of sales) → customer return → transfer → café milk use and spoilage →
// bakery production → count → supplier return → calibration waste → invoice reversal. Every
// journal and balance is worked out by hand below. Loss bands (roasting 18%, packing 1%, baking
// 5%) and the milk yield are SYNTHETIC TEST ASSUMPTIONS, not company policy (DECISION_PACK §3
// proposes no percentage). Run: npm run test:accounting:db
//
// Hand workings (weighted average unless stated):
//   R1 01-10 green 100 kg @ 30 = 3,000 · bags 10 × pack100 @ 0.65/pc = 650 · labels 1,000 @ 0.15 = 150
//   R2 01-12 green 50 kg @ 36 = 1,800                         → green 150 kg, 4,800 (avg 32.00)
//   P1 01-20 roast 60 kg green (1,920.00) → 47 kg roasted; band 18%: expected 49.2 kg, abnormal 2.2 kg
//            = 1,920 × 2.2 / 49.2 = 85.85 (5300); roasted 1,834.15 (1173)      [DECISION_PACK §3 example]
//            green left: R1 60 kg / 1,800 · R2 30 kg / 1,080
//   L1 01-25 freight 480 (from the freight bill line) by value 3,000 : 1,800 = 300 : 180
//            R1 60/100 on hand → 180 to stock, 120 to COGS · R2 30/50 → 108 / 72
//   M1 01-28 bill 3,100 for R1 green (receipt 3,000) → +100; 60/100 on hand → 60 stock, 40 COGS
//            green 90 kg, 3,228.00 (R1 2,040 · R2 1,188)
//   R3 02-01 café: milk 3 × carton12 = 36 l @ 5.50 = 198 · flour 25 kg @ 4 = 100 · butter 5 kg @ 40 = 200
//   P2 02-05 pack: roasted 45.4 kg = 1,834.15 × 45.4/47 = 1,771.71 · 180 bags 117.00 · 180 labels 27.00
//            → 180 × 250 g; band 1%: expected 44.946 kg ≤ 45 kg made → no abnormal; SKU 1,915.71
//   S1 02-10 invoice 100 units → COGS 1,915.71 × 100/180 = 1,064.28
//   C1 02-12 customer return 5 units → 1,064.28 × 5/100 = 53.21
//   T1 02-15 transfer 10 units roastery → café (no journal): 904.64 × 10/85 = 106.43 moves
//   I1 02-20 café milk use 30 l → 165.00 COGS · I2 02-21 spoilage 2 l → 11.00 (5700)
//   P3 02-22 bakery: flour 4 kg 16.00 + butter 1 kg 40.00 + milk 1 l 5.50 = 61.50, yield in 6 kg
//            → 60 croissants × 0.08 kg = 4.8 kg; band 5%: expected 5.7, abnormal 0.9 = 61.50 × 0.9/5.7 = 9.71
//   K1 03-01 count green 89.5 kg (book 90) → shortage 0.5 = 3,228 × 0.5/90 = 17.93 (5700)
//   V1 03-05 return 100 bags (R1 layer 820 pc, 533.00) = 65.00 → Dr GRNI
//   W1 03-06 calibration 1 kg roasted (1.6 kg, 62.44) = 39.03 (5400)
//   today: invoice reversed → 95 units back at the rest of the sale's cost 1,064.28 − 53.21 = 1,011.07
import { test, describe, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { Prisma } from "../../../src/generated/prisma/client";
import { prisma, reset, makeUser, rejects } from "./support";
import { applyChartTemplate, updateSettings } from "../../../src/lib/accounting/setup-service";
import { createFiscalYear } from "../../../src/lib/accounting/fiscal-period-service";
import { draftPolicy, approvePolicy } from "../../../src/lib/accounting/policy-service";
import { processPendingEvents } from "../../../src/lib/accounting/event-processor";
import { createBill, submitBill, approveBill, postBill, reverseBill } from "../../../src/lib/accounting/payables-service";
import { createSalesDoc, submitSalesDoc, approveSalesDoc, postSalesDoc, reverseSalesDoc } from "../../../src/lib/accounting/receivables-service";
import { createItem, createLocation, createLossBand, approveLossBand, updateInventorySettings, createInvDoc, submitInvDoc, approveInvDoc, postInvDoc, saleIssueForInvoice, productionDraftFromRoastingBatch, receiptDraftFromPurchase, type InvDocInput } from "../../../src/lib/accounting/inventory-service";
import { inventoryValuation, grossMargin, grniStatus, stockCard } from "../../../src/lib/accounting/inventory-reports";
import { accountingDate, todayAccountingDate } from "../../../src/lib/accounting/dates";

import { YEAR, D, dec, world, journal, gl, type W } from "./inventory-world";
void YEAR;

const inv = (w: W, v: Awaited<ReturnType<typeof inventoryValuation>>, code: string) => v.lines.filter((l) => l.code === code).reduce((s, l) => s.add(l.value), dec("0")).toFixed(2);

beforeEach(reset);
after(async () => { await prisma.$disconnect(); });

describe("stage 4 — purchasing to production to sale", () => {
  test("the whole chain, journals by hand, valuation equals the ledger at every month end", async () => {
    const w = await world();
    const { I } = w;
    // Purchasing and receipt
    const R1 = await w.doc({ type: "RECEIPT", docDate: D("01-10"), locationId: w.rst, supplierId: w.S.green, lines: [
      { itemId: I.green.id, quantity: "100", unitCost: "30" }, { itemId: I.bag.id, quantity: "10", unit: "pack100", unitCost: "0.65" }, { itemId: I.label.id, quantity: "1000", unitCost: "0.15" }] });
    assert.deepEqual(await journal(R1.document.id), ["1171:3000.00:0.00", "1172:800.00:0.00", "2120:0.00:3800.00"]);
    const R2 = await w.doc({ type: "RECEIPT", docDate: D("01-12"), locationId: w.rst, supplierId: w.S.green, lines: [{ itemId: I.green.id, quantity: "50", unitCost: "36" }] });
    // Roasting (DECISION_PACK §3 example)
    const P1 = await w.doc({ type: "PRODUCTION", docDate: D("01-20"), locationId: w.rst, lossBandId: w.bands.roast, lines: [{ role: "INPUT", itemId: I.green.id, quantity: "60" }, { role: "OUTPUT", itemId: I.roasted.id, quantity: "47" }] });
    assert.deepEqual(await journal(P1.document.id), ["1171:0.00:1920.00", "1173:1834.15:0.00", "5300:85.85:0.00"]);
    // Supplier bills: the green coffee at 31/kg, and freight
    const bill = async (supplierId: string, no: string, date: string, d: string, q: string, p: string) => {
      const b = await createBill({ supplierId, supplierInvoiceNo: no, billDate: D(date), lines: [{ kind: "STOCK_RECEIPT", description: d, quantity: q, unitPrice: p, taxCategoryId: w.vat }] }, w.prep);
      await submitBill(b.id, w.prep); await approveBill(b.id, w.appr); await postBill(b.id, w.appr);
      return (await prisma.supplierBillLine.findFirstOrThrow({ where: { billId: b.id } })).id;
    };
    const greenBillLine = await bill(w.S.green, "G-1", "01-22", "بن إثيوبي 100 كغ", "100", "31");
    const freightLine = await bill(w.S.freight, "F-1", "01-22", "شحن من الميناء", "1", "480");
    const L1 = await w.doc({ type: "LANDED_COST", docDate: D("01-25"), locationId: w.rst, billLineId: freightLine, allocationBasis: "VALUE",
      lines: [{ itemId: I.green.id, targetLineId: R1.lineIds[0] }, { itemId: I.green.id, targetLineId: R2.lineIds[0] }] });
    assert.deepEqual(await journal(L1.document.id), ["1171:288.00:0.00", "2120:0.00:480.00", "5100:192.00:0.00"]);
    const M1 = await w.doc({ type: "BILL_MATCH", docDate: D("01-28"), locationId: w.rst, billLineId: greenBillLine, lines: [{ itemId: I.green.id, targetLineId: R1.lineIds[0] }] });
    assert.deepEqual(await journal(M1.document.id), ["1171:60.00:0.00", "2120:0.00:100.00", "5100:40.00:0.00"]);
    await processPendingEvents();

    const jan = await inventoryValuation(accountingDate(D("01-31")));
    assert.equal(inv(w, jan, "GRN-ETH"), "3228.00"); assert.equal(inv(w, jan, "RST-ETH"), "1834.15");
    assert.equal(jan.reconciled, true, JSON.stringify(jan.accounts));
    assert.equal(await gl(w, "2120", D("01-31")), "-2600.00", "GRNI = R2 green 1,800 + bags 650 + labels 150 not yet billed");

    // Café stock, packing, sale, return, transfer
    const R3 = await w.doc({ type: "RECEIPT", docDate: D("02-01"), locationId: w.cafe, supplierId: w.S.dairy, lines: [
      { itemId: I.milk.id, quantity: "3", unit: "carton12", unitCost: "5.50" }, { itemId: I.flour.id, quantity: "25", unitCost: "4" }, { itemId: I.butter.id, quantity: "5", unitCost: "40" }] });
    assert.deepEqual(await journal(R3.document.id), ["1171:498.00:0.00", "2120:0.00:498.00"]);
    const P2 = await w.doc({ type: "PRODUCTION", docDate: D("02-05"), locationId: w.rst, lossBandId: w.bands.pack, lines: [
      { role: "INPUT", itemId: I.roasted.id, quantity: "45.4" }, { role: "INPUT", itemId: I.bag.id, quantity: "180" }, { role: "INPUT", itemId: I.label.id, quantity: "180" },
      { role: "OUTPUT", itemId: I.sku.id, quantity: "180" }] });
    assert.deepEqual(await journal(P2.document.id), ["1172:0.00:144.00", "1173:0.00:1771.71", "1174:1915.71:0.00"]);
    const s1 = await createSalesDoc({ customerId: w.customer, issueDate: D("02-10"), lines: [{ productSkuId: "sku-eth-250", description: "إثيوبي 250 غ", quantity: "100", unitPrice: "25", taxCategoryId: w.vat }] }, w.prep);
    await submitSalesDoc(s1.id, w.prep); await approveSalesDoc(s1.id, w.appr);
    const posted = await postSalesDoc(s1.id, w.appr);
    assert.equal(posted.cogs?.posted, true, posted.cogs?.reason);
    assert.deepEqual(await journal(posted.cogs!.documentId!), ["1174:0.00:1064.28", "5100:1064.28:0.00"]);
    assert.deepEqual(await saleIssueForInvoice(s1.id), { documentId: posted.cogs!.documentId, posted: true }, "a retry finds the posted cost of sales");
    assert.equal(await prisma.invDocument.count({ where: { type: "SALE_ISSUE" } }), 1);
    const saleLine = (await prisma.invDocLine.findFirstOrThrow({ where: { documentId: posted.cogs!.documentId! } })).id;
    const C1 = await w.doc({ type: "CUSTOMER_RETURN", docDate: D("02-12"), locationId: w.rst, customerId: w.customer, lines: [{ itemId: I.sku.id, quantity: "5", targetLineId: saleLine }] });
    assert.deepEqual(await journal(C1.document.id), ["1174:53.21:0.00", "5100:0.00:53.21"]);
    const T1 = await w.doc({ type: "TRANSFER", docDate: D("02-15"), locationId: w.rst, toLocationId: w.cafe, lines: [{ itemId: I.sku.id, quantity: "10" }] });
    assert.deepEqual(await journal(T1.document.id), [], "a transfer has no ledger effect");
    const tot = (k: string) => T1.document.moves.filter((m) => m.kind === k).reduce((s, m) => [s[0].add(m.qty), s[1].add(m.value)], [dec("0"), dec("0")]).map((x) => x.toFixed(x === undefined ? 2 : 4));
    assert.deepEqual([tot("OUT")[0], T1.document.moves.filter((m) => m.kind === "OUT").reduce((s, m) => s.add(m.value), dec("0")).toFixed(2)], ["-10.0000", "-106.43"], "leaves the roastery at 106.43");
    assert.deepEqual([tot("IN")[0], T1.document.moves.filter((m) => m.kind === "IN").reduce((s, m) => s.add(m.value), dec("0")).toFixed(2)], ["10.0000", "106.43"], "arrives at the café at the same cost (one layer per source layer)");
    // Café: milk used in drinks, milk spoiled, croissants baked
    const I1 = await w.doc({ type: "ISSUE", issueReason: "INTERNAL_USE", docDate: D("02-20"), locationId: w.cafe, lines: [{ itemId: I.milk.id, quantity: "30" }] });
    assert.deepEqual(await journal(I1.document.id), ["1171:0.00:165.00", "5100:165.00:0.00"]);
    const I2 = await w.doc({ type: "ISSUE", issueReason: "SPOILAGE", docDate: D("02-21"), locationId: w.cafe, lines: [{ itemId: I.milk.id, quantity: "2" }] });
    assert.deepEqual(await journal(I2.document.id), ["1171:0.00:11.00", "5700:11.00:0.00"]);
    const P3 = await w.doc({ type: "PRODUCTION", docDate: D("02-22"), locationId: w.cafe, lossBandId: w.bands.bake, lines: [
      { role: "INPUT", itemId: I.flour.id, quantity: "4" }, { role: "INPUT", itemId: I.butter.id, quantity: "1" }, { role: "INPUT", itemId: I.milk.id, quantity: "1" },
      { role: "OUTPUT", itemId: I.croissant.id, quantity: "60" }] });
    assert.deepEqual(await journal(P3.document.id), ["1171:0.00:61.50", "1174:51.79:0.00", "5300:9.71:0.00"]);

    const feb = await inventoryValuation(accountingDate(D("02-28")));
    assert.equal(feb.reconciled, true, JSON.stringify(feb.accounts));
    for (const [code, v] of [["1171", "3488.50"], ["1172", "656.00"], ["1173", "62.44"], ["1174", "956.43"]]) assert.equal(await gl(w, code, D("02-28")), v, code);
    assert.equal(await gl(w, "5100", D("02-28")), "1408.07", "192 + 40 + 1,064.28 − 53.21 + 165");
    assert.equal(await gl(w, "5300", D("02-28")), "95.56");

    // March: count, return to supplier, calibration waste
    const K1 = await w.doc({ type: "COUNT", docDate: D("03-01"), locationId: w.rst, reason: "جرد نهاية الربع", lines: [{ itemId: I.green.id, countedQty: "89.5" }] });
    assert.deepEqual(await journal(K1.document.id), ["1171:0.00:17.93", "5700:17.93:0.00"]);
    const V1 = await w.doc({ type: "SUPPLIER_RETURN", docDate: D("03-05"), locationId: w.rst, supplierId: w.S.green, reason: "أكياس معيبة", lines: [{ itemId: I.bag.id, quantity: "100", targetLineId: R1.lineIds[1] }] });
    assert.deepEqual(await journal(V1.document.id), ["1172:0.00:65.00", "2120:65.00:0.00"]);
    const W1 = await w.doc({ type: "ISSUE", issueReason: "CALIBRATION", docDate: D("03-06"), locationId: w.rst, lines: [{ itemId: I.roasted.id, quantity: "1" }] });
    assert.deepEqual(await journal(W1.document.id), ["1173:0.00:39.03", "5400:39.03:0.00"]);

    const mar = await inventoryValuation(accountingDate(D("03-31")));
    assert.equal(mar.reconciled, true);
    assert.equal(mar.total, "5041.41", "3,470.57 + 591.00 + 23.41 + 956.43");
    for (const [code, v] of [["1171", "3470.57"], ["1172", "591.00"], ["1173", "23.41"], ["1174", "956.43"]]) assert.equal(await gl(w, code, D("03-31")), v, code);
    const g = await grniStatus(accountingDate(D("03-31")));
    assert.equal(g.receiptsTotal, "3098.00", "R2 green, bags, labels, milk, flour, butter"); assert.equal(g.returnsTotal, "65.00"); assert.equal(g.billsTotal, "0.00"); assert.equal(g.landedTotal, "0.00");
    assert.equal(g.ledger, "3033.00", "GRNI = open receipts − goods returned awaiting the supplier's credit");
    const margin = await grossMargin(accountingDate(D("02-01")), accountingDate(D("02-28")));
    assert.deepEqual([margin.totals.revenue, margin.totals.cogs, margin.totals.margin], ["2500.00", "1011.07", "1488.93"]);
    const card = await stockCard(I.sku.id, accountingDate(D("01-01")), accountingDate(D("03-31")), w.rst);
    assert.equal(card.closing.qty, "75.0000"); assert.equal(card.closing.value, "798.21", "904.64 − 106.43");

    // Later: the invoice is reversed; the 95 units still out come back at the rest of their cost.
    const rev = await reverseSalesDoc(s1.id, w.appr, "الفاتورة صدرت بالخطأ");
    assert.equal(rev.cogs?.posted, true, rev.cogs?.reason);
    assert.deepEqual(await journal(rev.cogs!.documentId!), ["1174:1011.07:0.00", "5100:0.00:1011.07"]);
    const febAgain = await grossMargin(accountingDate(D("02-01")), accountingDate(D("02-28")));
    assert.deepEqual([febAgain.totals.revenue, febAgain.totals.cogs, febAgain.totals.margin], ["2500.00", "1011.07", "1488.93"], "February's margin is unchanged by the later reversal");
    const marAgain = await inventoryValuation(accountingDate(D("03-31")));
    assert.deepEqual(marAgain.lines, mar.lines, "March is unchanged by the later reversal");
    const today = await inventoryValuation(todayAccountingDate());
    assert.equal(today.reconciled, true);
    assert.equal(inv(w, today, "SKU-ETH-250"), (dec("798.21").add("1011.07").add("106.43")).toFixed(2), "roastery 798.21 + returned 1,011.07 + café 106.43");
  });
});

describe("stage 4 — historical GRNI", () => {
  test("a bill reversed later still explains GRNI at earlier dates; the explanation agrees with the ledger at every cutoff", async () => {
    const w = await world();
    await w.doc({ type: "RECEIPT", docDate: D("01-10"), locationId: w.rst, supplierId: w.S.green, lines: [{ itemId: w.I.green.id, quantity: "100", unitCost: "30" }] });
    const b = await createBill({ supplierId: w.S.dairy, supplierInvoiceNo: "D-9", billDate: D("01-20"), lines: [{ kind: "STOCK_RECEIPT", description: "حليب لم يُستلم بعد", quantity: "1", unitPrice: "200", taxCategoryId: w.vat }] }, w.prep);
    await submitBill(b.id, w.prep); await approveBill(b.id, w.appr); await postBill(b.id, w.appr);
    await processPendingEvents();
    const explain = async (asOf: string) => {
      const g = await grniStatus(accountingDate(asOf));
      const explained = dec(g.receiptsTotal).sub(g.billsTotal).add(g.landedTotal).sub(g.returnsTotal);
      assert.equal(explained.neg().toFixed(2), await gl(w, "2120", asOf), `explanation = ledger at ${asOf}`);
      assert.equal(g.ledger, explained.toFixed(2));
      return [g.receiptsTotal, g.billsTotal, g.ledger];
    };
    assert.deepEqual(await explain(D("01-31")), ["3000.00", "200.00", "2800.00"]);
    // Later (today) the bill is reversed.
    await reverseBill(b.id, w.appr, "أُصدرت الفاتورة بالخطأ");
    await processPendingEvents();
    assert.deepEqual(await explain(D("01-31")), ["3000.00", "200.00", "2800.00"], "January is unchanged by the later reversal");
    const today = todayAccountingDate().toISOString().slice(0, 10);
    assert.deepEqual(await explain(today), ["3000.00", "0.00", "3000.00"]);
  });
});

describe("stage 4 — controls", () => {
  const receipt = (w: W, md: string, qty: string, cost: string) => w.doc({ type: "RECEIPT", docDate: D(md), locationId: w.rst, supplierId: w.S.green, lines: [{ itemId: w.I.green.id, quantity: qty, unitCost: cost }] });
  const approved = async (w: W, input: InvDocInput) => { const d = await createInvDoc(input, w.prep); await submitInvDoc(d.id, w.prep); await approveInvDoc(d.id, w.appr); return d.id; };

  test("FIFO: the oldest layer first, each at its own cost", async () => {
    const w = await world({ method: "FIFO" });
    await receipt(w, "01-10", "100", "30"); await receipt(w, "01-12", "50", "36");
    const x = await w.doc({ type: "ISSUE", issueReason: "QC", docDate: D("01-15"), locationId: w.rst, lines: [{ itemId: w.I.green.id, quantity: "120" }] });
    assert.deepEqual(await journal(x.document.id), ["1171:0.00:3720.00", "5500:3720.00:0.00"], "100 × 30 + 20 × 36");
  });

  test("D-1 undecided: posting is refused; in an isolated test database it posts provisionally, journal included", async () => {
    const w = await world({ method: null });
    const id = await approved(w, { type: "RECEIPT", docDate: D("01-10"), locationId: w.rst, supplierId: w.S.green, lines: [{ itemId: w.I.green.id, quantity: "10", unitCost: "30" }] });
    await rejects(postInvDoc(id, w.appr), /Waiting for decision D-1: the inventory costing method/);
    assert.equal((await prisma.invDocument.findUniqueOrThrow({ where: { id } })).status, "APPROVED", "nothing half-posted");
    process.env.ACCOUNTING_PROVISIONAL_POSTING = "isolated-test";
    const r = await postInvDoc(id, w.appr);
    assert.equal(r.document.provisional, true); assert.equal(r.document.costMethod, "WEIGHTED_AVERAGE");
    const entry = await prisma.journalEntry.findUniqueOrThrow({ where: { id: r.ledger!.journalEntryId! } });
    assert.equal(entry.isProvisional, true);
  });

  test("a production that loses weight needs an approved loss band; a draft band is not enough", async () => {
    const w = await world();
    await receipt(w, "01-10", "100", "30");
    const noBand = await approved(w, { type: "PRODUCTION", docDate: D("01-20"), locationId: w.rst, lines: [{ role: "INPUT", itemId: w.I.green.id, quantity: "10" }, { role: "OUTPUT", itemId: w.I.roasted.id, quantity: "8" }] });
    await rejects(postInvDoc(noBand, w.appr), /choose the approved loss band/);
    const draft = await createLossBand({ code: "ROAST-DRAFT", name: "draft", process: "ROASTING", maxLossPercent: "20" }, w.prep);
    await rejects(approveLossBand(draft.id, w.prep).then(() => prisma.invLossBand.update({ where: { id: draft.id }, data: { status: "APPROVED", approvedBy: w.prep } })), /someone other than its author/);
    const withDraft = await approved(w, { type: "PRODUCTION", docDate: D("01-20"), locationId: w.rst, lossBandId: draft.id, lines: [{ role: "INPUT", itemId: w.I.green.id, quantity: "10" }, { role: "OUTPUT", itemId: w.I.roasted.id, quantity: "8" }] });
    await rejects(postInvDoc(withDraft, w.appr), /loss band ROAST-DRAFT is not approved/);
    await rejects(prisma.invLossBand.update({ where: { id: w.bands.roast }, data: { maxLossPercent: dec("25") } }), /cannot change/);
  });

  test("no negative stock, no back-dating over posted movements, no second posting", async () => {
    const w = await world();
    await receipt(w, "01-10", "100", "30");
    const tooMuch = await approved(w, { type: "ISSUE", issueReason: "TRAINING", docDate: D("01-15"), locationId: w.rst, lines: [{ itemId: w.I.green.id, quantity: "100.0001" }] });
    await rejects(postInvDoc(tooMuch, w.appr), /Stock cannot go negative/);
    await receipt(w, "01-20", "10", "40");
    const back = await approved(w, { type: "ISSUE", issueReason: "TRAINING", docDate: D("01-15"), locationId: w.rst, lines: [{ itemId: w.I.green.id, quantity: "1" }] });
    await rejects(postInvDoc(back, w.appr), /already has a posted movement on .*-01-20/);
    const x = await approved(w, { type: "ISSUE", issueReason: "TRAINING", docDate: D("01-21"), locationId: w.rst, lines: [{ itemId: w.I.green.id, quantity: "1" }] });
    const [a, b] = await Promise.allSettled([postInvDoc(x, w.appr), postInvDoc(x, w.appr)]);
    assert.deepEqual([a.status, b.status].sort(), ["fulfilled", "rejected"], "two clicks: one posting");
    const moved = await prisma.invMove.aggregate({ where: { documentId: x }, _sum: { qty: true } });
    assert.equal(moved._sum.qty?.toFixed(4), "-1.0000", "the issue happened once (from both layers, in proportion)");
    assert.equal(await prisma.journalEntry.count({ where: { sourceModule: "inventory", sourceDocumentId: x } }), 1);
  });

  test("two issues racing for the same stock: one posts, the other finds too little", async () => {
    const w = await world();
    await receipt(w, "01-10", "100", "30");
    const a = await approved(w, { type: "ISSUE", issueReason: "QC", docDate: D("01-15"), locationId: w.rst, lines: [{ itemId: w.I.green.id, quantity: "70" }] });
    const b = await approved(w, { type: "ISSUE", issueReason: "QC", docDate: D("01-15"), locationId: w.rst, lines: [{ itemId: w.I.green.id, quantity: "70" }] });
    const r = await Promise.allSettled([postInvDoc(a, w.appr), postInvDoc(b, w.appr)]);
    assert.deepEqual(r.map((x) => x.status).sort(), ["fulfilled", "rejected"]);
    assert.match(String((r.find((x) => x.status === "rejected") as PromiseRejectedResult).reason), /Not enough GRN-ETH/);
    const left = await prisma.invLayer.aggregate({ _sum: { qtyLeft: true, valueLeft: true } });
    assert.deepEqual([left._sum.qtyLeft?.toFixed(4), left._sum.valueLeft?.toFixed(2)], ["30.0000", "900.00"]);
  });

  test("the database refuses tampering: posted documents, moves, layers, own approval", async () => {
    const w = await world();
    const r = await receipt(w, "01-10", "100", "30");
    const id = r.document.id;
    await rejects(prisma.invDocument.update({ where: { id }, data: { docDate: accountingDate(D("01-11")) } }), /posted inventory document cannot be changed/);
    await rejects(prisma.invDocLine.update({ where: { id: r.lineIds[0] }, data: { unitCost: dec("1") } }), /cannot change/);
    await rejects(prisma.invMove.deleteMany({ where: { documentId: id } }), /cannot be changed or deleted/);
    await rejects(prisma.invMove.create({ data: { documentId: id, itemId: w.I.green.id, locationId: w.rst, date: accountingDate(D("01-10")), kind: "IN", qty: dec("1"), value: dec("1") } }), /only while their document posts/);
    const layer = await prisma.invLayer.findFirstOrThrow({ where: { itemId: w.I.green.id } });
    await rejects(prisma.invLayer.update({ where: { id: layer.id }, data: { qtyLeft: dec("150") } }), /quantity only goes down|qtyLeft/);
    await rejects(prisma.invLayer.update({ where: { id: layer.id }, data: { valueLeft: dec("10") } }), /does not equal its moves/);
    const own = await createInvDoc({ type: "ISSUE", issueReason: "QC", docDate: D("01-15"), locationId: w.rst, lines: [{ itemId: w.I.green.id, quantity: "1" }] }, w.prep);
    await submitInvDoc(own.id, w.prep);
    await rejects(approveInvDoc(own.id, w.prep), /someone other than/);
    await rejects(prisma.invDocument.update({ where: { id: own.id }, data: { status: "APPROVED", approvedBy: w.prep, approvedAt: new Date() } }), /someone other than/);
    await rejects(updateInventorySettings({ inventoryCostMethod: "FIFO" }, w.prep), /cannot change once inventory documents have posted/);
  });

  test("drafts from operational records: a roasting batch and a green-coffee purchase, once each", async () => {
    const w = await world();
    const gb = await prisma.greenBean.create({ data: { serialNumber: `ACC-T-${Date.now()}`, beanType: "Yirgacheffe", country: "Ethiopia", quantityKg: 0 } });
    const cp = await prisma.coffeeProduct.create({ data: { productNameEn: "Ethiopia Yirgacheffe", countryEn: "Ethiopia" } });
    await prisma.invItem.update({ where: { id: w.I.green.id }, data: { greenBeanId: gb.id } });
    await prisma.invItem.update({ where: { id: w.I.roasted.id }, data: { coffeeProductId: cp.id } });
    const pr = await prisma.purchaseRecord.create({ data: { supplierId: w.S.green, type: "GREEN_BEAN", itemId: gb.id, quantity: 60, costPerUnit: 31.5, totalCost: 1890, purchaseDate: new Date(`${D("01-05")}T09:00:00Z`) } });
    const rd = await receiptDraftFromPurchase(pr.id, { locationId: w.rst }, w.prep);
    assert.deepEqual([rd.type, rd.status, rd.lines[0].baseQty.toFixed(4), rd.lines[0].unitCost?.toFixed(4)], ["RECEIPT", "DRAFT", "60.0000", "31.5000"]);
    await rejects(receiptDraftFromPurchase(pr.id, { locationId: w.rst }, w.prep), /already exists for that source/);
    const rb = await prisma.roastingBatch.create({ data: { batchNumber: "R-TEST-1", greenBeanId: gb.id, productId: cp.id, greenBeanQuantity: 12, roastedBeanQuantity: 10.2, wasteQuantity: 0 } });
    const pd = await productionDraftFromRoastingBatch(rb.id, { locationId: w.rst, lossBandId: w.bands.roast }, w.prep);
    assert.deepEqual(pd.lines.map((l) => [l.role, l.baseQty.toFixed(4)]), [["INPUT", "12.0000"], ["OUTPUT", "10.2000"]]);
    await rejects(productionDraftFromRoastingBatch(rb.id, { locationId: w.rst }, w.prep), /already exists/);
  });
});
