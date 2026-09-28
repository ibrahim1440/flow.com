// Stage 3 against real PostgreSQL: sales invoices and credit notes (four-eyes, immutability,
// journals), customer receipts assigned from bank lines (receivables part + advance with VAT per
// D-2), advance application, credit allocation, refunds, AR aging and customer statement tie-outs,
// integration with sales collections and commissions (no duplicate postings), policy gates,
// concurrency. Every expected journal is written out by hand. Run: npm run test:accounting:db
import { test, describe, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { Prisma } from "../../../src/generated/prisma/client";
import { prisma, reset, makeUser, rejects } from "./support";
import { applyChartTemplate, updateSettings } from "../../../src/lib/accounting/setup-service";
import { createFiscalYear } from "../../../src/lib/accounting/fiscal-period-service";
import { draftPolicy, approvePolicy, approveCommissionPlanVersion } from "../../../src/lib/accounting/policy-service";
import { processPendingEvents } from "../../../src/lib/accounting/event-processor";
import { setCashAccountGl } from "../../../src/lib/accounting/stage2-service";
import { createSalesDoc, submitSalesDoc, approveSalesDoc, postSalesDoc, reverseSalesDoc, assignReceipt, applyAdvance, allocateCredit, invoiceOpen, type SalesLineInput } from "../../../src/lib/accounting/receivables-service";
import { arAging, customerStatement } from "../../../src/lib/accounting/receivables-reports";
import { requestBankCorrection, approveBankCorrection } from "../../../src/lib/accounting/bank-correction-service";
import { computeSalesLine, vatInside } from "../../../src/lib/accounting/sales-rules";
import { accountingDate, todayAccountingDate } from "../../../src/lib/accounting/dates";

const YEAR = Number(todayAccountingDate().toISOString().slice(0, 4));
const D = (m: number, d: number) => `${YEAR}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
const dec = (s: string) => new Prisma.Decimal(s);

async function world(opts: { policies?: boolean; advanceVat?: "AT_RECEIPT" | "NOT_AT_RECEIPT" | null } = {}) {
  const prep = await makeUser("Sales accountant");
  const appr = await makeUser("Controller");
  await applyChartTemplate(prep);
  await createFiscalYear(YEAR, 1, prep);
  await updateSettings({ ledgerCutoverDate: accountingDate(D(1, 1)), setupComplete: true }, prep);
  await updateSettings({ bankPostingFrom: accountingDate(D(2, 1)) }, prep);
  if (opts.policies !== false) for (const key of ["receivables.recognition", "receivables.advances", "bank.posting"]) { const p = await draftPolicy(key, {}, prep); await approvePolicy(p.id, appr); }
  const advanceVat = opts.advanceVat === undefined ? "AT_RECEIPT" : opts.advanceVat;
  if (advanceVat) await prisma.accountingSettings.update({ where: { id: "singleton" }, data: { advanceVatTreatment: advanceVat } });
  const acc = Object.fromEntries((await prisma.account.findMany()).map((a) => [a.code, a.id]));
  const vat15 = await prisma.taxCategory.create({ data: { code: "VAT15", nameEn: "Standard 15%", nameAr: "قياسية 15%", rate: dec("15.00"), isDefault: true } });
  const customer = await prisma.customer.create({ data: { name: "Najd Specialty Cafés", nameAr: "مقاهي نجد المختصة", vatNumber: "310998877600003", paymentTermsDays: 30 } });
  const other = await prisma.customer.create({ data: { name: "Other Co", nameAr: "شركة أخرى" } });
  const bank = await prisma.cashAccount.create({ data: { code: "BANK1", nameEn: "Main bank", type: "BANK", openingBalance: dec("0"), openingBalanceDate: accountingDate(D(1, 1)) } });
  await setCashAccountGl(bank.id, acc["1120"], prep);
  const salesCat = await prisma.finCategory.create({ data: { code: "SALES", nameEn: "Sales receipts", kind: "RECEIPT" } });
  return { prep, appr, acc, vat15: vat15.id, customer: customer.id, other: other.id, bank: bank.id, salesCat: salesCat.id };
}
type W = Awaited<ReturnType<typeof world>>;

async function postedDoc(w: W, lines: SalesLineInput[], over: Partial<Parameters<typeof createSalesDoc>[0]> = {}) {
  const d = await createSalesDoc({ customerId: w.customer, issueDate: D(3, 1), lines, ...over }, w.prep);
  await submitSalesDoc(d.id, w.prep);
  await approveSalesDoc(d.id, w.appr);
  const r = await postSalesDoc(d.id, w.appr);
  assert.equal(r.ledger?.status, "TRANSLATED", r.ledger?.message ?? "");
  return d.id;
}
async function bankLine(w: W, date: string, amount: string, cls = "CUSTOMER_RECEIPT", collectionId?: string) {
  const t = await prisma.bankTransaction.create({ data: {
    cashAccountId: w.bank, branchKey: "COMPANY", txnDate: accountingDate(date), amount: dec(amount), status: "CONFIRMED", classification: cls as never, reviewStatus: "NEEDS_REVIEW",
    bankReference: `DEP-${Math.random().toString(36).slice(2, 7)}`, splits: { create: [{ finCategoryId: w.salesCat, amount: dec(amount) }] },
    matches: collectionId ? { create: [{ targetType: "SALES_COLLECTION", targetId: collectionId, amount: dec(amount).abs() }] } : undefined,
  } });
  await prisma.bankTransaction.update({ where: { id: t.id }, data: { reviewStatus: "REVIEWED" } });
  return t.id;
}
async function journal(key: string) {
  const ev = await prisma.accountingEvent.findUnique({ where: { idempotencyKey: key } });
  assert.equal(ev?.status, "TRANSLATED", `${key}: ${ev?.status} ${ev?.errorMessage ?? ""}`);
  const ls = await prisma.journalEntryLine.findMany({ where: { journalEntryId: ev!.journalEntryId! }, include: { account: true }, orderBy: { lineNo: "asc" } });
  return ls.map((l) => `${l.account.code}:${l.debit.toFixed(2)}:${l.credit.toFixed(2)}${l.partyId ? ":P" : ""}`).sort();
}
const eventOf = (key: string) => prisma.accountingEvent.findUnique({ where: { idempotencyKey: key } });
const L1 = (w: W): SalesLineInput => ({ description: "إثيوبي يرغاتشيفي محمص — 10 كغ", quantity: "10", unitPrice: "120", discountPercent: "5", taxCategoryId: w.vat15 });
const L2 = (w: W): SalesLineInput => ({ accountId: w.acc["4200"], description: "تدريب باريستا", quantity: "1", unitPrice: "200", taxCategoryId: w.vat15 });

beforeEach(reset);
after(async () => { await prisma.$disconnect(); });

describe("stage 3 — sales invoices and credit notes", () => {
  test("line arithmetic: discount then VAT, half-up at each step; VAT inside an inclusive advance", () => {
    assert.deepEqual(Object.values(computeSalesLine(dec("10"), dec("120"), dec("5"), dec("15"))).map((d) => d.toFixed(2)), ["1140.00", "171.00", "1311.00"]);
    assert.deepEqual(Object.values(computeSalesLine(dec("3"), dec("0.335"), dec("0"), dec("15"))).map((d) => d.toFixed(2)), ["1.01", "0.15", "1.16"]);
    assert.equal(vatInside(dec("459"), dec("15")).toFixed(2), "59.87");
    assert.equal(vatInside(dec("115"), dec("15")).toFixed(2), "15.00");
  });

  test("create → submit → four-eyes approve → post: journal by hand; posted document immutable", async () => {
    const w = await world();
    const d = await createSalesDoc({ customerId: w.customer, issueDate: D(3, 1), lines: [L1(w), L2(w)] }, w.prep);
    assert.deepEqual([d.totalNet, d.totalVat, d.totalGross].map((x) => x.toFixed(2)), ["1340.00", "201.00", "1541.00"]);
    assert.equal(d.dueDate.toISOString().slice(0, 10), D(3, 31), "30 days' terms");
    await submitSalesDoc(d.id, w.prep);
    await rejects(approveSalesDoc(d.id, w.prep), /someone else must approve/);
    await rejects(prisma.salesInvoice.update({ where: { id: d.id }, data: { status: "APPROVED", approvedBy: w.prep, approvedAt: new Date() } }), /someone other than/);
    await approveSalesDoc(d.id, w.appr);
    await postSalesDoc(d.id, w.appr);
    assert.deepEqual(await journal(`receivables:${d.id}:ar.invoice.posted`), ["1130:1541.00:0.00:P", "2170:0.00:201.00", "4100:0.00:1140.00", "4200:0.00:200.00"].sort());
    await rejects(prisma.salesInvoice.update({ where: { id: d.id }, data: { totalGross: dec("1") } }), /cannot be changed/);
    await rejects(prisma.salesInvoiceLine.updateMany({ where: { invoiceId: d.id }, data: { unitPrice: dec("1") } }), /cannot change/);
    await rejects(prisma.salesInvoice.delete({ where: { id: d.id } }), /Only a draft/);
    // reversal mirrors, and frees nothing that is allocated (nothing is here)
    const r = await reverseSalesDoc(d.id, w.appr, "إصدار مكرر بالخطأ");
    assert.equal(r.ledger?.status, "TRANSLATED");
    assert.deepEqual(await journal(`receivables:${d.id}:ar.invoice.reversed`), ["1130:0.00:1541.00:P", "2170:201.00:0.00", "4100:1140.00:0.00", "4200:200.00:0.00"].sort());
  });

  test("credit notes: against a posted invoice of the same customer, never beyond it; auto-settle the invoice; reversal blocked while allocated", async () => {
    const w = await world();
    const inv = await postedDoc(w, [{ description: "بن", quantity: "1", unitPrice: "1000", taxCategoryId: w.vat15 }]);
    await rejects(createSalesDoc({ kind: "CREDIT_NOTE", originalInvoiceId: inv, customerId: w.customer, issueDate: D(3, 5), reason: "مرتجع", lines: [{ description: "x", quantity: "1", unitPrice: "1001", taxCategoryId: w.vat15 }] }, w.prep), /exceeds/);
    await rejects(createSalesDoc({ kind: "CREDIT_NOTE", originalInvoiceId: inv, customerId: w.other, issueDate: D(3, 5), reason: "مرتجع", lines: [{ description: "x", quantity: "1", unitPrice: "10" }] }, w.prep), /invoice's customer/);
    const cn = await createSalesDoc({ kind: "CREDIT_NOTE", originalInvoiceId: inv, customerId: w.customer, issueDate: D(3, 5), reason: "مرتجع كيس تالف", lines: [{ description: "مرتجع", quantity: "1", unitPrice: "200", taxCategoryId: w.vat15 }] }, w.prep);
    await submitSalesDoc(cn.id, w.prep); await approveSalesDoc(cn.id, w.appr); await postSalesDoc(cn.id, w.appr);
    assert.deepEqual(await journal(`receivables:${cn.id}:ar.credit_note.posted`), ["1130:0.00:230.00:P", "2170:30.00:0.00", "4900:200.00:0.00"].sort());
    assert.equal((await invoiceOpen(prisma, inv)).toFixed(2), "920.00", "1,150 − 230");
    await rejects(reverseSalesDoc(inv, w.appr, "خطأ في الفاتورة"), /allocated/);
    // a direct over-credit is refused by the database at posting
    const cn2 = await createSalesDoc({ kind: "CREDIT_NOTE", originalInvoiceId: inv, customerId: w.customer, issueDate: D(3, 6), reason: "خصم إضافي", lines: [{ description: "خصم", quantity: "1", unitPrice: "800", taxCategoryId: w.vat15 }] }, w.prep);
    await submitSalesDoc(cn2.id, w.prep); await approveSalesDoc(cn2.id, w.appr);
    await rejects(prisma.salesInvoice.update({ where: { id: cn2.id }, data: { totalGross: dec("921") } }), /cannot be edited/);
    await postSalesDoc(cn2.id, w.appr);   // 920 of 920 creditable: allowed, exactly
    assert.equal((await invoiceOpen(prisma, inv)).toFixed(2), "0.00");
  });

  test("an order is invoiced once while its invoice is live", async () => {
    const w = await world();
    const order = await prisma.order.create({ data: { orderNumber: 7001, customerId: w.customer, status: "Completed" } });
    await postedDoc(w, [L1(w)], { orderId: order.id });
    assert.equal((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).vatInvoiceStatus, "Sent");
    await rejects(createSalesDoc({ customerId: w.customer, issueDate: D(3, 2), orderId: order.id, lines: [L1(w)] }, w.prep), /already has an invoice/);
    await rejects(createSalesDoc({ customerId: w.other, issueDate: D(3, 2), orderId: order.id, lines: [L1(w)] }, w.prep), /another customer/);
  });
});

describe("stage 3 — receipts, advances, statements", () => {
  test("the whole cycle, tied out: receipt with allocation and advance, advance applied, credit note, refund", async () => {
    const w = await world();
    const inv1 = await postedDoc(w, [L1(w), L2(w)]);                                                             // 1,541.00
    const t1 = await bankLine(w, D(3, 10), "2000.00");
    await processPendingEvents();
    assert.match((await eventOf(`bank:${t1}:confirmed`))!.errorMessage ?? "", /Assign this line to a customer/);
    await rejects(assignReceipt(t1, { customerId: w.customer, allocations: [{ invoiceId: inv1, amount: "1541.01" }] }, w.prep), /owed only/);
    const a1 = await assignReceipt(t1, { customerId: w.customer, allocations: [{ invoiceId: inv1, amount: "1541.00" }] }, w.prep);
    assert.equal(a1.ledger?.status, "TRANSLATED", a1.ledger?.message ?? "");
    assert.deepEqual([a1.receipt.arAmount, a1.receipt.advanceAmount, a1.receipt.advanceVat].map((x) => x.toFixed(2)), ["1541.00", "459.00", "59.87"]);
    assert.deepEqual(await journal(`bank:${t1}:confirmed`), ["1120:2000.00:0.00", "1130:0.00:1541.00:P", "2410:0.00:399.13:P", "2170:0.00:59.87:P"].sort());
    await rejects(prisma.customerReceipt.update({ where: { id: a1.receipt.id }, data: { arAmount: dec("1000"), advanceAmount: dec("1000") } }), /has posted/);
    await rejects(assignReceipt(t1, { customerId: w.customer, allocations: [] }, w.prep), /has posted/);

    const inv2 = await postedDoc(w, [{ description: "بن", quantity: "1", unitPrice: "1000", taxCategoryId: w.vat15 }], { issueDate: D(3, 12) });   // 1,150.00
    const ap = await applyAdvance({ invoiceId: inv2, amount: "459.00", appliedOn: D(3, 15) }, w.prep);
    assert.equal(ap.application.vatPortion.toFixed(2), "59.87");
    assert.deepEqual(await journal(`receivables:${ap.application.id}:ar.advance.applied`), ["1130:0.00:459.00:P", "2170:59.87:0.00:P", "2410:399.13:0.00:P"].sort());
    await rejects(applyAdvance({ invoiceId: inv2, amount: "1.00", appliedOn: D(3, 15) }, w.prep), /advance is 0.00/);

    const cn = await createSalesDoc({ kind: "CREDIT_NOTE", originalInvoiceId: inv2, customerId: w.customer, issueDate: D(3, 20), reason: "مرتجع", lines: [{ description: "مرتجع", quantity: "1", unitPrice: "200", taxCategoryId: w.vat15 }] }, w.prep);
    await submitSalesDoc(cn.id, w.prep); await approveSalesDoc(cn.id, w.appr); await postSalesDoc(cn.id, w.appr);   // 230, settles inv2 → open 461

    // A credit on a fully paid invoice stays as the customer's credit, then is refunded.
    const cnPaid = await createSalesDoc({ kind: "CREDIT_NOTE", originalInvoiceId: inv1, customerId: w.customer, issueDate: D(3, 22), reason: "تعويض تأخير", lines: [{ description: "تعويض", quantity: "1", unitPrice: "100", taxCategoryId: w.vat15 }] }, w.prep);
    await submitSalesDoc(cnPaid.id, w.prep); await approveSalesDoc(cnPaid.id, w.appr); await postSalesDoc(cnPaid.id, w.appr);   // 115 unapplied
    const t2 = await bankLine(w, D(3, 25), "-115.00", "CUSTOMER_REFUND");
    const a2 = await assignReceipt(t2, { customerId: w.customer }, w.prep);
    assert.deepEqual(await journal(`bank:${t2}:confirmed`), ["1120:0.00:115.00", "1130:115.00:0.00:P"].sort());
    assert.equal(a2.receipt.arAmount.toFixed(2), "-115.00");

    const aging = await arAging(accountingDate(D(3, 31)));
    assert.equal(aging.subledger, "461.00");
    assert.equal(aging.ledger, "461.00");
    assert.equal(aging.reconciled, true, JSON.stringify(aging));
    assert.equal(aging.advances.total, "0.00"); assert.equal(aging.advances.reconciled, true);
    // As of 12 March the advance of 459 was still open (applied on the 15th).
    const mid = await arAging(accountingDate(D(3, 12)));
    assert.equal(mid.reconciled, true, JSON.stringify(mid)); assert.equal(mid.advances.total, "459.00"); assert.equal(mid.advances.reconciled, true);

    const st = await customerStatement(w.customer, accountingDate(D(1, 1)), accountingDate(D(3, 31)));
    assert.deepEqual(st.lines.map((l) => `${l.kind}:${l.debit}:${l.credit}:${l.balance}`),
      ["invoice:1541.00:0.00:1541.00", "receipt:0.00:2000.00:-459.00", "invoice:1150.00:0.00:691.00", "credit_note:0.00:230.00:461.00", "credit_note:0.00:115.00:346.00", "refund:115.00:0.00:461.00"]);
    assert.equal(st.closing, "461.00"); assert.equal(st.ledgerBalance, "461.00"); assert.equal(st.reconciled, true);
  });

  test("a posted receipt voided through a correction releases its allocations; the invoice is owed again; ties hold", async () => {
    const w = await world();
    const inv = await postedDoc(w, [{ description: "بن", quantity: "1", unitPrice: "1000", taxCategoryId: w.vat15 }]);
    const t = await bankLine(w, D(3, 10), "1150.00");
    await assignReceipt(t, { customerId: w.customer, allocations: [{ invoiceId: inv, amount: "1150.00" }] }, w.prep);
    assert.equal((await invoiceOpen(prisma, inv)).toFixed(2), "0.00");
    const c = await requestBankCorrection(t, { kind: "VOID", reason: "الشيك مرتجع من البنك" }, w.prep);
    await approveBankCorrection(c.id, w.appr);
    assert.equal((await invoiceOpen(prisma, inv)).toFixed(2), "1150.00");
    assert.equal((await prisma.customerReceipt.findFirstOrThrow({ where: { bankTransactionId: t } })).voided, true);
    const today = todayAccountingDate();
    const aging = await arAging(today);
    assert.equal(aging.reconciled, true, JSON.stringify(aging)); assert.equal(aging.subledger, "1150.00");
    const st = await customerStatement(w.customer, accountingDate(D(1, 1)), today);
    assert.equal(st.reconciled, true, JSON.stringify(st)); assert.equal(st.closing, "1150.00");
  });

  test("policy gates: undecided D-2 or unapproved advances policy hold an advance, not a plain receipt; invoices wait for their policy", async () => {
    const w = await world({ policies: false, advanceVat: null });
    for (const key of ["bank.posting"]) { const p = await draftPolicy(key, {}, w.prep); await approvePolicy(p.id, w.appr); }
    const d = await createSalesDoc({ customerId: w.customer, issueDate: D(3, 1), lines: [{ description: "بن", quantity: "1", unitPrice: "1000", taxCategoryId: w.vat15 }] }, w.prep);
    await submitSalesDoc(d.id, w.prep); await approveSalesDoc(d.id, w.appr);
    const r = await postSalesDoc(d.id, w.appr);
    assert.equal(r.ledger?.status, "BLOCKED");
    assert.match(r.ledger?.message ?? "", /receivables.recognition/);
    const t = await bankLine(w, D(3, 10), "500.00");
    const a = await assignReceipt(t, { customerId: w.customer }, w.prep);   // all advance
    assert.equal(a.ledger?.status, "BLOCKED");
    assert.match(a.ledger?.message ?? "", /receivables\.advances/); assert.match(a.ledger?.message ?? "", /D-2/);
    // once decided and approved, both post
    await prisma.accountingSettings.update({ where: { id: "singleton" }, data: { advanceVatTreatment: "NOT_AT_RECEIPT" } });
    for (const key of ["receivables.recognition", "receivables.advances"]) { const p = await draftPolicy(key, {}, w.prep); await approvePolicy(p.id, w.appr); }
    const again = await assignReceipt(t, { customerId: w.customer }, w.prep);   // re-assigned under the decided treatment: no VAT at receipt
    assert.equal(again.receipt.advanceVat.toFixed(2), "0.00");
    await processPendingEvents();
    assert.deepEqual(await journal(`bank:${t}:confirmed`), ["1120:500.00:0.00", "2410:0.00:500.00:P"].sort());
    assert.equal((await eventOf(`receivables:${d.id}:ar.invoice.posted`))?.status, "TRANSLATED");
  });

  test("sales collections and commissions: the linked collection names the customer; one bank journal, commission journals unchanged", async () => {
    const w = await world();
    const rep = await prisma.employee.create({ data: { name: "Rep", pin: "x", role: "custom" } });
    const stage = await prisma.pipelineStage.create({ data: { code: "WON", nameEn: "Won", nameAr: "مكسوب", position: 9 } });
    const opp = await prisma.opportunity.create({ data: { title: "توريد شهري", customerId: w.customer, stageId: stage.id, ownerId: rep.id } });
    const ce = await prisma.collectionEvent.create({ data: { externalRef: "SC-1", customerId: w.customer, opportunityId: opp.id, amountGross: dec("1150"), amountTax: dec("150"), collectedAt: new Date(`${D(3, 10)}T09:00:00Z`) } });
    const coll = await prisma.salesCollection.create({ data: { collectionEventId: ce.id, opportunityId: opp.id, customerId: w.customer, idempotencyKey: "k1", amountGross: dec("1150"), amountTax: dec("150"), amountNet: dec("1000"), collectedAt: new Date(`${D(3, 10)}T09:00:00Z`), submittedById: rep.id, status: "APPROVED", decidedById: w.appr, decidedAt: new Date() } });
    // Commission as the sales module records it, and its journal.
    const plan = await prisma.commissionPlan.create({ data: { code: "STD", name: "Standard" } });
    const pv = await prisma.commissionPlanVersion.create({ data: { planId: plan.id, version: 1, baseRatePercent: dec("2.000000"), effectiveFrom: new Date(`${YEAR}-01-01T00:00:00Z`), createdById: w.prep } });
    const cp = await draftPolicy("commissions.recognition", {}, w.prep); await approvePolicy(cp.id, w.appr); await approveCommissionPlanVersion(pv.id, w.appr);
    await prisma.commissionLedgerEntry.create({ data: { type: "ACCRUAL", employeeId: rep.id, periodStart: new Date(`${YEAR}-03-01T00:00:00Z`), amount: dec("20.00"), planVersionId: pv.id } });
    await processPendingEvents();
    const commissionJournals = await prisma.journalEntry.count({ where: { sourceModule: "commissions" } });
    assert.equal(commissionJournals, 1);

    const inv = await postedDoc(w, [{ description: "بن", quantity: "1", unitPrice: "1000", taxCategoryId: w.vat15 }]);
    const t = await bankLine(w, D(3, 10), "1150.00", "CUSTOMER_RECEIPT", coll.id);
    await rejects(assignReceipt(t, { customerId: w.other }, w.prep), /differs from the sales collection/);
    const a = await assignReceipt(t, { allocations: [{ invoiceId: inv, amount: "1150.00" }] }, w.prep);
    assert.equal(a.receipt.customerId, w.customer);
    assert.equal(a.receipt.salesCollectionId, coll.id);
    await processPendingEvents();
    assert.equal(await prisma.journalEntry.count({ where: { sourceModule: "bank", sourceDocumentId: t } }), 1, "exactly one cash journal");
    assert.equal(await prisma.journalEntry.count({ where: { sourceModule: "commissions" } }), commissionJournals, "no commission journal added or duplicated");
    assert.equal(await prisma.journalEntry.count({ where: { sourceDocumentId: coll.id } }), 0, "the collection itself never posts");
    const t2 = await bankLine(w, D(3, 11), "1150.00", "CUSTOMER_RECEIPT");
    await rejects(assignReceipt(t2, { customerId: w.customer, salesCollectionId: coll.id }, w.prep), /already assigned/);
  });

  test("concurrency: two receipts cannot over-settle one invoice; re-assigning a line keeps one set of allocations", async () => {
    const w = await world();
    const inv = await postedDoc(w, [{ description: "بن", quantity: "1", unitPrice: "1000", taxCategoryId: w.vat15 }]);   // 1,150
    const [ta, tb] = [await bankLine(w, D(3, 10), "700.00"), await bankLine(w, D(3, 10), "700.00")];
    const out = await Promise.allSettled([
      assignReceipt(ta, { customerId: w.customer, allocations: [{ invoiceId: inv, amount: "700.00" }] }, w.prep),
      assignReceipt(tb, { customerId: w.customer, allocations: [{ invoiceId: inv, amount: "700.00" }] }, w.prep),
    ]);
    assert.deepEqual(out.map((o) => o.status).sort(), ["fulfilled", "rejected"]);
    assert.match(String((out.find((o) => o.status === "rejected") as PromiseRejectedResult).reason), /owed only|is owed/);
    assert.equal((await invoiceOpen(prisma, inv)).toFixed(2), "450.00");
    // an unposted line can be re-assigned; old allocations are switched off, not duplicated
    const tc = await prisma.bankTransaction.create({ data: { cashAccountId: w.bank, branchKey: "COMPANY", txnDate: accountingDate(D(1, 20)), amount: dec("100"), status: "CONFIRMED", classification: "CUSTOMER_RECEIPT", reviewStatus: "REVIEWED", splits: { create: [{ finCategoryId: w.salesCat, amount: dec("100") }] } } });
    await assignReceipt(tc.id, { customerId: w.customer, allocations: [{ invoiceId: inv, amount: "100.00" }] }, w.prep);   // before bank start: skipped, not posted
    await assignReceipt(tc.id, { customerId: w.customer, allocations: [{ invoiceId: inv, amount: "50.00" }] }, w.prep);
    assert.equal(await prisma.arAllocation.count({ where: { receiptId: { not: null }, invoiceId: inv, active: true } }), 2);
    assert.equal((await invoiceOpen(prisma, inv)).toFixed(2), "400.00");
    await rejects(prisma.arAllocation.deleteMany({ where: { invoiceId: inv } }), /audit trail/);
  });
});

describe("stage 3 — credits", () => {
  test("an unapplied credit is used on another invoice of the same customer, with no ledger effect", async () => {
    const w = await world();
    const inv1 = await postedDoc(w, [{ description: "بن", quantity: "1", unitPrice: "100", taxCategoryId: w.vat15 }]);   // 115
    const t = await bankLine(w, D(3, 3), "115.00");
    await assignReceipt(t, { customerId: w.customer, allocations: [{ invoiceId: inv1, amount: "115.00" }] }, w.prep);
    const cn = await createSalesDoc({ kind: "CREDIT_NOTE", originalInvoiceId: inv1, customerId: w.customer, issueDate: D(3, 5), reason: "خصم لاحق", lines: [{ description: "خصم", quantity: "1", unitPrice: "40", taxCategoryId: w.vat15 }] }, w.prep);
    await submitSalesDoc(cn.id, w.prep); await approveSalesDoc(cn.id, w.appr); await postSalesDoc(cn.id, w.appr);   // 46 unapplied
    const inv2 = await postedDoc(w, [{ description: "بن", quantity: "1", unitPrice: "200", taxCategoryId: w.vat15 }], { issueDate: D(3, 6) });   // 230
    const before = await prisma.journalEntry.count();
    await allocateCredit({ creditNoteId: cn.id, invoiceId: inv2, amount: "46.00" }, w.prep);
    assert.equal(await prisma.journalEntry.count(), before);
    await rejects(allocateCredit({ creditNoteId: cn.id, invoiceId: inv2, amount: "0.01" }, w.prep), /left/);
    assert.equal((await invoiceOpen(prisma, inv2)).toFixed(2), "184.00");
    const aging = await arAging(accountingDate(D(3, 31)));
    assert.equal(aging.reconciled, true, JSON.stringify(aging)); assert.equal(aging.subledger, "184.00");
  });
});
