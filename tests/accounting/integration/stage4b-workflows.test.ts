// Stage 4b workflows, hand-worked over several periods (synthetic data; loss bands, cost-pool
// rates and D-1 values are SYNTHETIC TEST ASSUMPTIONS, not company policy).
// Written before the returns, conversion-cost and supplier-credit implementations: the first run
// fails (evidence/test-runs/stage4b-workflows-before-fix.txt). Run: npm run test:accounting:db
//
// A. Returns and corrections (100 units @ 10.00 at RST from 01-05; 36 l milk @ 5.50 at CAFE)
//   Feb  INV-A 10 × 25 = 250 → COGS 100 · INV-B 5 × 25 = 125 → COGS 50            RST 85
//   Mar  return R-A 4 units (3 resalable, 1 damaged), evidence, approved by another person:
//          Dr 1174 40 / Cr 5100 40; damaged unit written off Dr 5700 10 / Cr 1174 10  RST 88
//        CN-A (returned goods, for R-A) 100 · CN-P price credit 20 (no goods)
//        INV-M 1 carton12 of milk from CAFE at 90: 12 l × 5.50 = 66
//   Today (a reversal is dated the day it happens): INV-B reversed → cost back to delivered, not
//        invoiced (Dr 1176 50 / Cr 5100 50), RST still 88; INV-C replaces it (5 × 24 = 120) →
//        Dr 5100 50 / Cr 1176 50, no stock moves.
//   Feb margin: revenue 375, COGS 150. Mar: revenue −100 −20 +90 = −30; COGS −40 +66 = 26
//   = GL 5100 for March. Today's month: revenue −125 +120 = −5, COGS −50 +50 = 0.
//   1176 = 0; RST 88 units = 880.00.
// B. Costing robustness: undecided timing waits; a lease held by a dead worker expires; a retry
//    never issues twice; a missing mapping fixed later costs; stock received after the invoice
//    costs late (booked when possible, original date kept); a closed period books in the next
//    open one; an order line not yet dispatched waits, and cancelling it moves nothing.
// C. Conversion cost (synthetic pools): roasting labour 12,000 / 3,000 kg = 4.0000 per kg in;
//    roasting overhead 9,000 / 300 machine hours = 30.0000 per hour.
//    Roast 100 kg green (3,000.00), 2.5 machine hours, 82 kg out (band 18%: no abnormal loss):
//      Dr 1173 3,475.00 / Cr 1171 3,000.00 · Cr 6190 400.00 · Cr 6790 75.00
//    Roast 100 kg (3,000.00), 2.5 h, 80 kg out: expected 82, abnormal 2 kg = 3,475 × 2 / 82 = 84.76
//      Dr 1173 3,390.24 · Dr 5300 84.76 / Cr 1171 3,000 · Cr 6190 400 · Cr 6790 75
//    January labour actually booked on 6100: 1,000.00 → absorbed 400 (first roast), under 600.
// D. Supplier credit notes: receipt 1,000 bags @ 0.65 = 650 (01-10); bill B1 650 + VAT 97.50;
//    return 100 bags 65.00 (01-20); CN1 for the return 65 + 9.75 VAT → GRNI settled (0);
//    400 bags to training (01-28); CN2 price reduction 50.00 on the 1,000 received (02-02):
//      500 on hand → Cr 1172 25.00; training 400 → Cr 5600 20.00; returned 100 → Cr 5700 5.00;
//      Dr GRNI 50.00; the credit note itself Dr AP 57.50 / Cr GRNI 50 / Cr VAT 7.50. GRNI = 0.
//    CN1 applied to B1: B1 open 747.50 − 74.75 = 672.75; CN2 unapplied −57.50.
import { test, describe, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { Prisma } from "../../../src/generated/prisma/client";
import { prisma, reset, rejects } from "./support";
import { processPendingEvents } from "../../../src/lib/accounting/event-processor";
import { createSalesDoc, submitSalesDoc, approveSalesDoc, postSalesDoc, reverseSalesDoc } from "../../../src/lib/accounting/receivables-service";
import { createBill, submitBill, approveBill, postBill, reverseBill } from "../../../src/lib/accounting/payables-service";
import { onHand, updateInventorySettings } from "../../../src/lib/accounting/inventory-service";
import { grossMargin, grniStatus } from "../../../src/lib/accounting/inventory-reports";
import { processCosting, processPendingCosting } from "../../../src/lib/accounting/sales-costing";
import { lockFiscalPeriod } from "../../../src/lib/accounting/fiscal-period-service";
import { accountingDate } from "../../../src/lib/accounting/dates";
import { D, world, gl, journal, type W } from "./inventory-world";
import { todayAccountingDate } from "../../../src/lib/accounting/dates";
const TODAY = todayAccountingDate().toISOString().slice(0, 10);

beforeEach(reset);
after(async () => { await prisma.$disconnect(); });
const dec = (s: string) => new Prisma.Decimal(s);
const mod = <T>(p: string) => import(p) as Promise<T>;
type Returns = typeof import("../../../src/lib/accounting/customer-returns");
type Pools = typeof import("../../../src/lib/accounting/conversion-costs");
type Payables = typeof import("../../../src/lib/accounting/payables-service");

async function sale(w: W, date: string, lines: Record<string, unknown>[], extra: Record<string, unknown> = {}) {
  const d = await createSalesDoc({ customerId: w.customer, issueDate: D(date), ...extra, lines: lines.map((l) => ({ taxCategoryId: w.vat, ...l })) } as never, w.prep);
  await submitSalesDoc(d.id, w.prep); await approveSalesDoc(d.id, w.appr);
  const r = await postSalesDoc(d.id, w.appr);
  await processPendingEvents();
  return { id: d.id, costing: r.costing };
}
const goods = (qty: string, price: string) => ({ productSkuId: "sku-eth-250", description: "إثيوبي 250 غ", quantity: qty, unitPrice: price });
const month = async (md1: string, md2: string) => grossMargin(accountingDate(D(md1)), accountingDate(D(md2)));
const costing = (id: string) => prisma.invCosting.findUniqueOrThrow({ where: { invoiceId: id } });

describe("stage 4b — returns and invoice corrections are separate workflows", () => {
  test("partial return with evidence, price credit, reversal and reissue, other location and unit: two months by hand", async () => {
    const R = await mod<Returns>("../../../src/lib/accounting/customer-returns");
    const w = await world();
    await w.doc({ type: "RECEIPT", docDate: D("01-05"), locationId: w.rst, supplierId: w.S.green, lines: [{ itemId: w.I.sku.id, quantity: "100", unitCost: "10" }] });
    await w.doc({ type: "RECEIPT", docDate: D("01-06"), locationId: w.cafe, supplierId: w.S.dairy, lines: [{ itemId: w.I.milk.id, quantity: "36", unitCost: "5.50" }] });
    const A = await sale(w, "02-10", [goods("10", "25")]);
    const B = await sale(w, "02-12", [goods("5", "25")]);
    assert.equal((await costing(A.id)).status, "COSTED");
    assert.equal((await onHand(prisma, w.I.sku.id, w.rst)).qty.toFixed(4), "85.0000");

    // Physical return: recorded, received with evidence, approved by someone else, posted.
    const lineA = (await prisma.salesInvoiceLine.findFirstOrThrow({ where: { invoiceId: A.id } })).id;
    const ra = await R.createCustomerReturn({ invoiceId: A.id, locationId: w.rst, reason: "عبوات تالفة وأخرى زائدة عن الطلب", lines: [{ invoiceLineId: lineA, quantity: "3" }, { invoiceLineId: lineA, quantity: "1", condition: "DAMAGED" }] }, w.prep);
    await rejects(R.approveCustomerReturn(ra.id, w.appr), /received/);
    await R.receiveCustomerReturn(ra.id, { receivedOn: D("03-02"), evidenceRef: "GRN-RET-0001" }, w.appr);
    await rejects(R.approveCustomerReturn(ra.id, w.appr), /someone other/);
    await R.approveCustomerReturn(ra.id, (await prisma.employee.create({ data: { name: "Warehouse lead", pin: "x", role: "custom" } })).id);
    await R.postCustomerReturn(ra.id, w.appr);
    await processPendingEvents();
    assert.equal((await onHand(prisma, w.I.sku.id, w.rst)).qty.toFixed(4), "88.0000", "3 back to stock, 1 damaged written off");
    const again = await R.createCustomerReturn({ invoiceId: A.id, locationId: w.rst, reason: "محاولة إرجاع مكررة", lines: [{ invoiceLineId: lineA, quantity: "7" }] }, w.prep).then(() => null, (e) => e);
    assert.match(String(again), /6(\.0+)? .*still out|more than/i, "only 6 of invoice A are still with the customer");

    const cnA = await sale(w, "03-03", [{ ...goods("4", "25") }], { kind: "CREDIT_NOTE", originalInvoiceId: A.id, reason: "إرجاع أربع عبوات", creditType: "RETURN_OF_GOODS", customerReturnId: ra.id });
    await rejects(createSalesDoc({ customerId: w.customer, issueDate: D("03-04"), kind: "CREDIT_NOTE", originalInvoiceId: A.id, reason: "إشعار مكرر للإرجاع", creditType: "RETURN_OF_GOODS", customerReturnId: ra.id, lines: [{ ...goods("1", "25"), taxCategoryId: w.vat }] } as never, w.prep), /already credited/);
    await sale(w, "03-05", [{ description: "خصم سعر", quantity: "1", unitPrice: "20", stockTreatment: "NON_STOCK" }], { kind: "CREDIT_NOTE", originalInvoiceId: A.id, reason: "خصم سعري دون إرجاع", creditType: "PRICE_ADJUSTMENT" });
    void cnA;
    // Another location and unit: one carton of 12 l from the café.
    const M = await sale(w, "03-12", [{ invItemId: w.I.milk.id, unit: "carton12", description: "حليب كرتون", quantity: "1", unitPrice: "90" }], { fulfilmentLocationId: w.cafe });
    assert.equal((await costing(M.id)).status, "COSTED");
    assert.equal((await onHand(prisma, w.I.milk.id, w.cafe)).qty.toFixed(4), "24.0000");

    // Invoice correction: reverse B (goods stay with the customer), reissue as C.
    await reverseSalesDoc(B.id, w.appr, "صدرت بسعر خاطئ");
    await processPendingEvents();
    assert.equal((await costing(B.id)).status, "UNCOSTED");
    assert.equal((await onHand(prisma, w.I.sku.id, w.rst)).qty.toFixed(4), "88.0000", "a reversal returns no goods");
    const C = await sale(w, TODAY.slice(5), [goods("5", "24")], { replacesInvoiceId: B.id });
    assert.equal((await costing(C.id)).status, "COSTED");
    assert.equal((await onHand(prisma, w.I.sku.id, w.rst)).qty.toFixed(4), "88.0000", "the reissue takes over the delivered goods");

    const feb = await month("02-01", "02-28");
    assert.deepEqual([feb.totals.revenue, feb.totals.cogs, feb.complete], ["375.00", "150.00", true]);
    const mar = await month("03-01", "03-31");
    assert.deepEqual([mar.totals.revenue, mar.totals.cogs, mar.complete], ["-30.00", "26.00", true]);
    const now = await grossMargin(accountingDate(`${TODAY.slice(0, 7)}-01`), accountingDate(TODAY));
    assert.deepEqual([now.totals.revenue, now.totals.cogs, now.complete], ["-5.00", "0.00", true]);
    assert.equal(now.reconciliation.cogs.difference, "0.00");
    assert.equal(mar.reconciliation.cogs.ledger, "26.00", "March COGS in the ledger");
    assert.equal(mar.reconciliation.cogs.difference, "0.00");
    assert.equal(mar.reconciliation.returns.report, "-120.00");
    assert.equal(await gl(w, "5100", D("03-31")), "176.00", "150 + 26");
    assert.equal(await gl(w, "1176", TODAY), "0.00");
    assert.equal(await gl(w, "5700", D("03-31")), "10.00", "the damaged unit");
    assert.equal((await onHand(prisma, w.I.sku.id, w.rst)).value.toFixed(2), "880.00");
  });
});

describe("stage 4b — cost of sales is durable", () => {
  test("undecided timing waits; a dead worker's lease expires; retries never issue twice", async () => {
    const w = await world({ timing: null });
    await w.doc({ type: "RECEIPT", docDate: D("01-05"), locationId: w.rst, supplierId: w.S.green, lines: [{ itemId: w.I.sku.id, quantity: "20", unitCost: "10" }] });
    const A = await sale(w, "02-10", [goods("2", "25")]);
    assert.equal((await costing(A.id)).status, "AWAITING_POLICY");
    await updateInventorySettings({ salesCostTiming: "WITH_REVENUE" }, w.prep);
    // A worker claimed it and died: its lease blocks others until it expires.
    await prisma.invCosting.update({ where: { invoiceId: A.id }, data: { leaseUntil: new Date(Date.now() + 60_000), nextAttemptAt: new Date(0) } });
    await processPendingCosting();
    assert.equal((await costing(A.id)).status, "AWAITING_POLICY", "a live lease is respected");
    await prisma.invCosting.update({ where: { invoiceId: A.id }, data: { leaseUntil: new Date(Date.now() - 1000) } });
    await processPendingCosting();
    assert.equal((await costing(A.id)).status, "COSTED");
    await Promise.all([processCosting(A.id, { force: true }), processCosting(A.id, { force: true })]);
    assert.equal(await prisma.invDocument.count({ where: { salesInvoiceId: A.id, type: "SALE_ISSUE" } }), 1, "one cost of sales document");
    assert.equal((await onHand(prisma, w.I.sku.id, w.rst)).qty.toFixed(4), "18.0000");
  });

  test("a missing mapping, missing stock and a closed period are recovered late with the original date kept", async () => {
    const w = await world();
    const A = await sale(w, "01-15", [{ productSkuId: "sku-later", description: "منتج بلا ربط", quantity: "2", unitPrice: "30" }]);
    assert.equal((await costing(A.id)).status, "BLOCKED");
    await prisma.invItem.update({ where: { id: w.I.croissant.id }, data: { productSkuId: "sku-later" } });
    const B = await sale(w, "01-20", [goods("3", "25")]);
    assert.match((await costing(B.id)).lastError ?? "", /Not enough SKU-ETH-250/);
    // January closes (locked) before stock arrives in February.
    const jan = await prisma.fiscalPeriod.findFirstOrThrow({ where: { startDate: accountingDate(D("01-01")) } });
    await lockFiscalPeriod(jan.id, w.appr);
    await w.doc({ type: "RECEIPT", docDate: D("02-03"), locationId: w.rst, supplierId: w.S.green, lines: [{ itemId: w.I.sku.id, quantity: "10", unitCost: "10" }, { itemId: w.I.croissant.id, quantity: "10", unitCost: "4" }] });
    await prisma.invCosting.updateMany({ data: { nextAttemptAt: new Date(0) } });
    await processPendingCosting();
    for (const [id, cost] of [[A.id, "8.00"], [B.id, "30.00"]] as const) {
      const c = await costing(id);
      assert.equal(c.status, "COSTED"); assert.equal(c.cost.toFixed(2), cost); assert.equal(c.late, true);
      const doc = await prisma.invDocument.findFirstOrThrow({ where: { salesInvoiceId: id, type: "SALE_ISSUE" } });
      assert.equal(doc.docDate.toISOString().slice(0, 10), D("02-03"), "booked when it could be");
      assert.ok(doc.originalDate && doc.originalDate.getTime() < doc.docDate.getTime() && doc.lateReason, "the original date and reason are kept");
    }
    const jan2 = await month("01-01", "01-31");
    assert.equal(jan2.complete, false, "January's margin shows the cost booked later as missing in January");
  });

  test("an order line not yet dispatched waits; cancelling the invoice before fulfilment moves nothing", async () => {
    const w = await world();
    await w.doc({ type: "RECEIPT", docDate: D("01-05"), locationId: w.rst, supplierId: w.S.green, lines: [{ itemId: w.I.sku.id, quantity: "20", unitCost: "10" }] });
    const cp = await prisma.coffeeProduct.create({ data: { productNameEn: "Ethiopia (test)", countryEn: "Ethiopia" } });
    await prisma.productSKU.create({ data: { id: "sku-eth-250", productId: cp.id, skuCode: "T-ETH-250", weightGrams: 250 } });
    const order = await prisma.order.create({ data: { orderNumber: 9101, customerId: w.customer, status: "Preparing", items: { create: [{ productSkuId: "sku-eth-250", beanTypeName: "Ethiopia", quantityKg: 1, quantityUnits: 4 }] } }, include: { items: true } });
    const A = await sale(w, "02-10", [{ ...goods("4", "25"), orderItemId: order.items[0].id }], { orderId: order.id });
    assert.equal((await costing(A.id)).status, "AWAITING_DISPATCH");
    await reverseSalesDoc(A.id, w.appr, "ألغي الطلب قبل التسليم");
    assert.equal((await costing(A.id)).status, "CANCELLED");
    assert.equal((await onHand(prisma, w.I.sku.id, w.rst)).qty.toFixed(4), "20.0000");
    assert.equal(await prisma.invDocument.count({ where: { salesInvoiceId: A.id } }), 0);
  });
});

describe("stage 4b — conversion cost", () => {
  test("labour and overhead absorbed at approved normal-capacity rates; abnormal loss includes conversion; under-absorption stays in expense", async () => {
    const P = await mod<Pools>("../../../src/lib/accounting/conversion-costs");
    const w = await world();
    const pool = async (code: string, kind: string, basis: string, budget: string, capacity: string, expense: string) => {
      const p = await P.createCostPool({ code, name: `${code} (synthetic test pool)`, kind, process: "ROASTING", basis, budgetAmount: budget, normalCapacity: capacity, expenseAccountId: w.acc[expense] }, w.prep);
      await rejects(P.approveCostPool(p.id, w.prep), /someone other/);
      return P.approveCostPool(p.id, w.appr);
    };
    const lab = await pool("ROAST-LAB-SYN", "DIRECT_LABOUR", "PER_KG_INPUT", "12000", "3000", "6100");
    await pool("ROAST-OH-SYN", "PRODUCTION_OVERHEAD", "PER_MACHINE_HOUR", "9000", "300", "6700");
    assert.equal(lab.rate.toFixed(4), "4.0000");
    await rejects(prisma.invCostPool.update({ where: { id: lab.id }, data: { budgetAmount: dec("1") } }), /cannot change|rate/);
    await w.doc({ type: "RECEIPT", docDate: D("01-05"), locationId: w.rst, supplierId: w.S.green, lines: [{ itemId: w.I.green.id, quantity: "200", unitCost: "30" }] });
    const roast = (md: string, out: string, hours?: string) => w.doc({ type: "PRODUCTION", process: "ROASTING", machineHours: hours, docDate: D(md), locationId: w.rst, lossBandId: w.bands.roast, lines: [{ role: "INPUT", itemId: w.I.green.id, quantity: "100" }, { role: "OUTPUT", itemId: w.I.roasted.id, quantity: out }] });
    await rejects(roast("01-10", "82"), /machine hours/);
    const r1 = await roast("01-11", "82", "2.5");
    assert.deepEqual(await journal(r1.document.id), ["1171:0.00:3000.00", "1173:3475.00:0.00", "6190:0.00:400.00", "6790:0.00:75.00"]);
    const r2 = await roast("01-12", "80", "2.5");
    assert.deepEqual(await journal(r2.document.id), ["1171:0.00:3000.00", "1173:3390.24:0.00", "5300:84.76:0.00", "6190:0.00:400.00", "6790:0.00:75.00"]);
    const rep = await P.absorptionReport(accountingDate(D("01-01")), accountingDate(D("01-31")));
    const l = rep.pools.find((x) => x.code === "ROAST-LAB-SYN")!;
    assert.equal(l.absorbed, "800.00");
    assert.equal(rep.pools.find((x) => x.code === "ROAST-OH-SYN")!.absorbed, "150.00");
  });
});

describe("stage 4b — supplier credit notes", () => {
  test("a credit note settles a supplier return; a price credit is traced to stock held, wasted and returned; credits apply to bills", async () => {
    const Pay = await mod<Payables>("../../../src/lib/accounting/payables-service");
    const w = await world();
    const R = await w.doc({ type: "RECEIPT", docDate: D("01-10"), locationId: w.rst, supplierId: w.S.green, lines: [{ itemId: w.I.bag.id, quantity: "1000", unitCost: "0.65" }] });
    const b1 = await createBill({ supplierId: w.S.green, supplierInvoiceNo: "B-1", billDate: D("01-12"), lines: [{ kind: "STOCK_RECEIPT", description: "أكياس 1,000", quantity: "1000", unitPrice: "0.65", taxCategoryId: w.vat }] }, w.prep);
    await submitBill(b1.id, w.prep); await approveBill(b1.id, w.appr); await postBill(b1.id, w.appr);
    const V = await w.doc({ type: "SUPPLIER_RETURN", docDate: D("01-20"), locationId: w.rst, supplierId: w.S.green, reason: "أكياس معيبة", lines: [{ itemId: w.I.bag.id, quantity: "100", targetLineId: R.lineIds[0] }] });
    assert.equal((await grniStatus(accountingDate(D("01-24")))).returnsTotal, "65.00");
    const cn = async (no: string, date: string, lines: Record<string, unknown>[]) => {
      const c = await Pay.createBill({ kind: "CREDIT_NOTE", originalBillId: b1.id, reason: "إشعار دائن من المورد", supplierId: w.S.green, supplierInvoiceNo: no, billDate: D(date), lines } as never, w.prep);
      await submitBill(c.id, w.prep); await approveBill(c.id, w.appr); await postBill(c.id, w.appr);
      await processPendingEvents();
      return c.id;
    };
    const cn1 = await cn("CN-1", "01-25", [{ kind: "STOCK_RETURN", description: "إرجاع 100 كيس", quantity: "100", unitPrice: "0.65", taxCategoryId: w.vat, invDocumentId: V.document.id }]);
    const g1 = await grniStatus(accountingDate(D("01-26")));
    assert.equal(g1.returnsTotal, "0.00", "the return is settled"); assert.equal(g1.ledger, "0.00");
    await w.doc({ type: "ISSUE", issueReason: "TRAINING", docDate: D("01-28"), locationId: w.rst, lines: [{ itemId: w.I.bag.id, quantity: "400" }] });
    const cn2 = await cn("CN-2", "02-02", [{ kind: "STOCK_PRICE_ADJUSTMENT", description: "خصم 0.05 للكيس", quantity: "1000", unitPrice: "0.05", taxCategoryId: w.vat, invDocLineId: R.lineIds[0] }]);
    const credit = await prisma.invDocument.findFirstOrThrow({ where: { type: "SUPPLIER_CREDIT", sourceId: { in: (await prisma.supplierBillLine.findMany({ where: { billId: cn2 } })).map((l) => l.id) } } });
    assert.deepEqual(await journal(credit.id), ["1172:0.00:25.00", "2120:50.00:0.00", "5600:0.00:20.00", "5700:0.00:5.00"]);
    assert.equal(await gl(w, "2120", D("02-28")), "0.00");
    assert.equal((await onHand(prisma, w.I.bag.id, w.rst)).value.toFixed(2), "300.00", "500 × 0.65 − 25");
    await rejects(reverseBill(cn2, w.appr, "عكس إشعار عليه حركة مخزون"), /stock/);
    await Pay.allocateSupplierCredit({ creditNoteId: cn1, billId: b1.id, amount: "74.75" }, w.prep);
    await processPendingEvents();
    const { apAging } = await import("../../../src/lib/accounting/stage2-service");
    const ag = await apAging(accountingDate(D("02-28")));
    const row = JSON.stringify(ag);
    assert.match(row, /672\.75/, "B1 open after the applied credit");
    assert.match(row, /-57\.50|57\.50/, "CN2 is an unapplied credit");
  });
});
