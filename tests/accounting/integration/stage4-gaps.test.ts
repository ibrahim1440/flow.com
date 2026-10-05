// Stage 4 gaps raised in review (2026-09-28), written BEFORE the fixes so each one fails first
// (evidence/test-runs/stage4-gaps-before-fix.txt). Synthetic data; loss bands and D-1 values are
// test assumptions from inventory-world.ts. Run: npm run test:accounting:db
import { test, describe, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { prisma, reset } from "./support";
import { processPendingEvents } from "../../../src/lib/accounting/event-processor";
import { createSalesDoc, submitSalesDoc, approveSalesDoc, postSalesDoc, reverseSalesDoc } from "../../../src/lib/accounting/receivables-service";
import { onHand } from "../../../src/lib/accounting/inventory-service";
import { grossMargin } from "../../../src/lib/accounting/inventory-reports";
import { accountingDate } from "../../../src/lib/accounting/dates";
import { D, dec, world, gl, type W } from "./inventory-world";

beforeEach(reset);
after(async () => { await prisma.$disconnect(); });

type Line = { productSkuId?: string; description: string; quantity: string; unitPrice: string; stockTreatment?: string; accountCode?: string };
async function sale(w: W, date: string, lines: Line[], extra: Record<string, unknown> = {}) {
  const d = await createSalesDoc({ customerId: w.customer, issueDate: D(date), ...extra,
    lines: lines.map((l) => ({ ...l, accountId: l.accountCode ? w.acc[l.accountCode] : undefined, taxCategoryId: w.vat })) } as never, w.prep);
  await submitSalesDoc(d.id, w.prep); await approveSalesDoc(d.id, w.appr);
  await postSalesDoc(d.id, w.appr);
  await processPendingEvents();
  return d.id;
}
/** 100 finished units at 10.00 in the sales location. */
const stock = (w: W, md = "01-05", qty = "100") => w.doc({ type: "RECEIPT", docDate: D(md), locationId: w.rst, supplierId: w.S.green, lines: [{ itemId: w.I.sku.id, quantity: qty, unitCost: "10" }] });
const feb = () => grossMargin(accountingDate(D("02-01")), accountingDate(D("02-28")));
void dec;

describe("stage 4 gaps — cost of sales is never silently incomplete", () => {
  test("a goods line whose product has no inventory item is an exception, not skipped", async () => {
    const w = await world();
    await stock(w);
    const inv = await sale(w, "02-10", [{ productSkuId: "sku-with-no-item", description: "بن غير مربوط", quantity: "3", unitPrice: "20" }]);
    const row = (await feb()).rows.find((r) => r.invoiceId === inv);
    assert.ok(row, "the invoice appears in the margin report");
    assert.notEqual((row as { costStatus?: string }).costStatus, "COSTED");
    // The costing state lives in its own record (a posted invoice row is immutable).
    const status = (await prisma.invCosting.findUnique({ where: { invoiceId: inv } }))?.status;
    assert.equal(status, "BLOCKED", "missing mapping blocks costing visibly");
  });

  test("not enough stock: the invoice posts, its costing is a visible exception and the margin is marked incomplete", async () => {
    const w = await world();
    await stock(w, "01-05", "5");
    const inv = await sale(w, "02-10", [{ productSkuId: "sku-eth-250", description: "إثيوبي 250 غ", quantity: "8", unitPrice: "25" }]);
    const m = await feb();
    const row = m.rows.find((r) => r.invoiceId === inv) as { costStatus?: string } | undefined;
    assert.ok(row, "the invoice appears");
    assert.notEqual(row.costStatus, "COSTED");
    assert.equal((m as { complete?: boolean }).complete, false, "the report says it is incomplete");
  });

  test("service lines are explicitly non-stock; price credits appear in the margin", async () => {
    const w = await world();
    await stock(w);
    const inv = await sale(w, "02-10", [{ description: "تدريب باريستا", quantity: "1", unitPrice: "300", stockTreatment: "NON_STOCK", accountCode: "4200" }]);
    const cn = await sale(w, "02-15", [{ description: "خصم على التدريب", quantity: "1", unitPrice: "50", stockTreatment: "NON_STOCK", accountCode: "4200" }], { kind: "CREDIT_NOTE", originalInvoiceId: inv, reason: "خصم لاحق دون إرجاع بضاعة", creditType: "PRICE_ADJUSTMENT" });
    const m = await feb();
    const r1 = m.rows.find((r) => r.invoiceId === inv) as { costStatus?: string; revenue: string } | undefined;
    assert.ok(r1, "a service invoice is in the report"); assert.equal(r1.costStatus, "NOT_REQUIRED");
    assert.ok(m.rows.find((r) => r.invoiceId === cn), "the credit note is in the report");
    assert.equal(m.totals.revenue, "250.00", "300 − 50");
  });

  test("the margin report reconciles to the revenue, returns and COGS accounts", async () => {
    const w = await world();
    await stock(w);
    await sale(w, "02-10", [{ productSkuId: "sku-eth-250", description: "إثيوبي 250 غ", quantity: "10", unitPrice: "25" }]);
    const m = await feb() as unknown as { reconciliation?: { cogs: { report: string; ledger: string; difference: string } ; revenue: { report: string; ledger: string } } };
    assert.ok(m.reconciliation, "a reconciliation block");
    assert.equal(m.reconciliation.cogs.ledger, await gl(w, "5100", D("02-28")));
    assert.equal(m.reconciliation.cogs.report, "100.00");
  });
});

describe("stage 4 gaps — an invoice reversal is not a physical return", () => {
  test("reversing an invoice leaves the goods out until a confirmed return brings them back", async () => {
    const w = await world();
    await stock(w);
    const inv = await sale(w, "02-10", [{ productSkuId: "sku-eth-250", description: "إثيوبي 250 غ", quantity: "10", unitPrice: "25" }]);
    assert.equal((await onHand(prisma, w.I.sku.id, w.rst)).qty.toFixed(4), "90.0000");
    await reverseSalesDoc(inv, w.appr, "الفاتورة صدرت باسم عميل خاطئ");
    await processPendingEvents();
    assert.equal((await onHand(prisma, w.I.sku.id, w.rst)).qty.toFixed(4), "90.0000", "no stock comes back without a warehouse-confirmed return");
    assert.equal(await prisma.invDocument.count({ where: { type: "CUSTOMER_RETURN" } }), 0);
  });
});

describe("stage 4 gaps — later cost adjustments follow the goods", () => {
  test("a landed cost on green coffee already roasted goes to the roasted coffee still on hand, not to COGS", async () => {
    const w = await world();
    const r = await w.doc({ type: "RECEIPT", docDate: D("01-10"), locationId: w.rst, supplierId: w.S.green, lines: [{ itemId: w.I.green.id, quantity: "100", unitCost: "30" }] });
    await w.doc({ type: "PRODUCTION", docDate: D("01-20"), locationId: w.rst, lossBandId: w.bands.roast, lines: [{ role: "INPUT", itemId: w.I.green.id, quantity: "100" }, { role: "OUTPUT", itemId: w.I.roasted.id, quantity: "82" }] });
    await w.doc({ type: "LANDED_COST", docDate: D("01-25"), locationId: w.rst, amount: "100", allocationBasis: "VALUE", lines: [{ itemId: w.I.green.id, targetLineId: r.lineIds[0] }] });
    await processPendingEvents();
    assert.equal(await gl(w, "5100", D("01-31")), "0.00", "nothing was sold");
    assert.equal(await gl(w, "1173", D("01-31")), "3100.00", "3,000 roasted + 100 freight that belongs to it");
  });
});
