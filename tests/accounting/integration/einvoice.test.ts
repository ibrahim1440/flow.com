// Stage 6 against real PostgreSQL: e-invoice generation, chain, local validation, submission
// gating and retries, and the VAT return. LOCAL ONLY: nothing is sent to ZATCA; "sandbox"
// submissions go to an in-process stub. Seller, buyers and the zero-rating code are SYNTHETIC.
// Passing these tests is not ZATCA validation.
// Run: npm run test:accounting:db
import { test, describe, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { Prisma } from "../../../src/generated/prisma/client";
import { prisma, reset, makeUser, rejects } from "./support";
import { applyChartTemplate, updateSettings } from "../../../src/lib/accounting/setup-service";
import { createFiscalYear } from "../../../src/lib/accounting/fiscal-period-service";
import { draftPolicy, approvePolicy } from "../../../src/lib/accounting/policy-service";
import { createSalesDoc, submitSalesDoc, approveSalesDoc, postSalesDoc, reverseSalesDoc, type SalesLineInput } from "../../../src/lib/accounting/receivables-service";
import { createBill, submitBill, approveBill, postBill } from "../../../src/lib/accounting/payables-service";
import { createManualJournalEntry, submitJournalEntry, approveJournalEntry, postJournalEntry } from "../../../src/lib/accounting/journal-service";
import * as EI from "../../../src/lib/accounting/einvoice/service";
import { vatReturn } from "../../../src/lib/accounting/einvoice/vat-return";
import { readQr, INITIAL_PIH, verifyLocally, verifyQrStamp, derToP1363 } from "../../../src/lib/accounting/einvoice/ubl";
import { accountingDate, todayAccountingDate } from "../../../src/lib/accounting/dates";

const TODAY = todayAccountingDate();
const YEAR = TODAY.getUTCFullYear(), MONTH = TODAY.getUTCMonth() + 1;
const D = (d: number) => `${YEAR}-${String(MONTH).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
const dec = (s: string) => new Prisma.Decimal(s);
beforeEach(reset);
after(async () => { await prisma.$disconnect(); });

const ADDR = { street: "طريق تجريبي", buildingNo: "4321", district: "حي تجريبي", city: "جدة", postalCode: "23456", countryCode: "SA" };
const PROFILE = { sellerName: "شركة حقبة التجريبية", vatNumber: "399999999900003", crNumber: "1010000000", street: "شارع تجريبي", buildingNo: "1234", district: "حي تجريبي", city: "الرياض", postalCode: "12345", egsSerial: "EGS-LOCAL-01" };

async function world() {
  const prep = await makeUser("Tax accountant");
  const appr = await makeUser("Controller");
  await applyChartTemplate(prep);
  await createFiscalYear(YEAR, 1, prep);
  await updateSettings({ ledgerCutoverDate: accountingDate(`${YEAR}-01-01`), setupComplete: true }, prep);
  for (const key of ["receivables.recognition", "payables.recognition"]) { const p = await draftPolicy(key, {}, prep); await approvePolicy(p.id, appr); }
  const acc = Object.fromEntries((await prisma.account.findMany()).map((a) => [a.code, a.id]));
  const vat15 = (await prisma.taxCategory.create({ data: { code: "VAT15", nameEn: "Standard 15%", nameAr: "قياسية 15%", rate: dec("15.00"), isDefault: true, zatcaTaxCategoryCode: "S" } })).id;
  const zero = (await prisma.taxCategory.create({ data: { code: "ZERO", nameEn: "Zero-rated", rate: dec("0"), categoryType: "ZERO_RATED", zatcaTaxCategoryCode: "Z", zatcaExemptionCode: "VATEX-SA-TEST", zatcaExemptionReason: "SYNTHETIC zero-rating reason" } })).id;
  const b2b = (await prisma.customer.create({ data: { name: "Al-Rawda Hotel", nameAr: "فندق الروضة (تجريبي)", vatNumber: "300445566700003", nationalAddress: ADDR } })).id;
  const noAddr = (await prisma.customer.create({ data: { name: "Najd Cafés", nameAr: "مقاهي نجد (تجريبي)", vatNumber: "310998877600003" } })).id;
  const b2c = (await prisma.customer.create({ data: { name: "Walk-in", nameAr: "عميل نقدي" } })).id;
  return { prep, appr, acc, vat15, zero, b2b, noAddr, b2c };
}
type W = Awaited<ReturnType<typeof world>>;
const line = (w: W, price: string, qty = "1", tax?: string): SalesLineInput => ({ description: "خدمة تحميص (تجريبي)", quantity: qty, unitPrice: price, taxCategoryId: tax ?? w.vat15, stockTreatment: "NON_STOCK" });
async function posted(w: W, customerId: string, lines: SalesLineInput[], extra: Record<string, unknown> = {}) {
  const d = await createSalesDoc({ customerId, issueDate: D(1), lines, ...extra } as never, w.prep);
  await submitSalesDoc(d.id, w.prep); await approveSalesDoc(d.id, w.appr);
  const r = await postSalesDoc(d.id, w.appr);
  return { id: d.id, r };
}
async function profile(w: W, environment = "LOCAL_ONLY") {
  const p = await EI.draftProfile({ ...PROFILE, environment }, w.prep);
  return EI.approveProfile(p.id, w.appr);
}
const einv = (salesInvoiceId: string) => prisma.eInvoice.findUniqueOrThrow({ where: { salesInvoiceId } });

describe("profile and generation", () => {
  test("no approved profile: posting waits; the profile needs someone else's approval and never production; retry generates ICV 1 from the initial hash", async () => {
    const w = await world();
    const a = await posted(w, w.b2b, [line(w, "1000")]);
    assert.equal(a.r.einvoice?.status, "WAITING_PROFILE");
    assert.equal((await prisma.eInvoiceJob.findUniqueOrThrow({ where: { salesInvoiceId: a.id } })).status, "WAITING_PROFILE");
    const p = await EI.draftProfile({ ...PROFILE }, w.prep);
    await rejects(EI.approveProfile(p.id, w.prep), /someone else must approve/);
    await rejects(prisma.eInvoiceProfile.update({ where: { id: p.id }, data: { environment: "PRODUCTION" } }), /not allowed/);
    await rejects(EI.draftProfile({ ...PROFILE, environment: "PRODUCTION" }, w.prep), /production is not available/);
    await EI.approveProfile(p.id, w.appr);
    await rejects(prisma.eInvoiceProfile.update({ where: { id: p.id }, data: { vatNumber: "300000000000003" } }), /cannot change; prepare a new version/);
    const g = await EI.generateEInvoice(a.id, w.prep);
    assert.equal(g.status, "GENERATED");
    const e = await einv(a.id);
    assert.deepEqual([e.icv, e.previousHash, e.typeCode, e.subtype, e.signer], [1, INITIAL_PIH, "388", "0100000", "LOCAL_TEST_KEY"]);
    assert.deepEqual((e.validation as { ok: boolean }[]).filter((x) => !x.ok), []);
    assert.equal((await EI.generateEInvoice(a.id, w.prep)).status, "ALREADY", "idempotent");
    assert.match(e.xml, /<cbc:CompanyID>300445566700003<\/cbc:CompanyID>/);
  });

  test("an invalid document does not consume the chain; fixed and retried, it takes the next ICV with the previous hash", async () => {
    const w = await world();
    await profile(w);
    const a = await posted(w, w.b2b, [line(w, "1000")]);
    const bad = await posted(w, w.noAddr, [line(w, "500")]);
    assert.equal(bad.r.einvoice?.status, "INVALID");
    const job = await prisma.eInvoiceJob.findUniqueOrThrow({ where: { salesInvoiceId: bad.id } });
    assert.deepEqual((job.errors as { id: string }[]).map((x) => x.id), ["LOCAL-BUYER-ADDR"]);
    const c = await posted(w, w.b2b, [line(w, "200")]);
    assert.equal((await einv(c.id)).icv, 2, "the invalid document took no ICV");
    await prisma.customer.update({ where: { id: w.noAddr }, data: { nationalAddress: ADDR } });
    assert.equal((await EI.generateEInvoice(bad.id, w.prep)).status, "GENERATED");
    const e3 = await einv(bad.id), e2 = await einv(c.id);
    assert.deepEqual([e3.icv, e3.previousHash], [3, e2.invoiceHash]);
    assert.equal((await prisma.eInvoiceJob.findUniqueOrThrow({ where: { salesInvoiceId: bad.id } })).attempts, 2);
    assert.equal((await einv(a.id)).icv, 1);
  });

  test("simplified invoice: signed with the local test key, QR tags 1–8; credit and debit notes reference their invoice with a reason", async () => {
    const w = await world();
    await profile(w);
    const s = await posted(w, w.b2c, [line(w, "50", "2")]);
    const e = await einv(s.id);
    assert.equal(e.subtype, "0200000");
    const q = readQr(e.qr!);
    assert.deepEqual([q[1].toString(), q[2].toString(), q[4].toString(), q[5].toString(), q[6].toString("base64")], [PROFILE.sellerName, PROFILE.vatNumber, "115.00", "15.00", e.invoiceHash]);
    assert.deepEqual([q[6].length, q[7].length, q[8].length], [32, 64, 64], "default layout OFFICIAL_DOCS: 32-byte hash, P1363 signature, 64-byte key");
    assert.equal(q[7].toString("hex"), derToP1363(Buffer.from(e.signature!, "base64")).toString("hex"), "tag 7: the stored signature as r‖s");
    assert.ok(verifyQrStamp(q), "the QR's own stamp verifies");
    assert.ok(verifyLocally(e.invoiceHash, e.signature!, e.publicKey!));
    assert.equal(q[9], undefined, "no tag 9: there is no ZATCA certificate");
    const inv = await posted(w, w.b2b, [line(w, "1000")]);
    const cn = await posted(w, w.b2b, [line(w, "200")], { kind: "CREDIT_NOTE", originalInvoiceId: inv.id, reason: "خصم سعر متفق عليه (تجريبي)", creditType: "PRICE_ADJUSTMENT" });
    const ecn = await einv(cn.id);
    assert.equal(ecn.typeCode, "381");
    const invNo = (await prisma.salesInvoice.findUniqueOrThrow({ where: { id: inv.id } })).invoiceNo;
    assert.match(ecn.xml, new RegExp(`<cac:BillingReference><cac:InvoiceDocumentReference><cbc:ID>INV-${invNo}</cbc:ID>`));
    assert.match(ecn.xml, /<cbc:InstructionNote>خصم سعر متفق عليه \(تجريبي\)<\/cbc:InstructionNote>/);
    await rejects(createSalesDoc({ customerId: w.b2b, issueDate: D(1), debitNoteOfId: inv.id, reason: "x", lines: [line(w, "10")] } as never, w.prep), /reason \(at least 5/);
    await rejects(createSalesDoc({ customerId: w.b2c, issueDate: D(1), debitNoteOfId: inv.id, reason: "رسوم توصيل إضافية", lines: [line(w, "10")] } as never, w.prep), /same customer/);
    const dn = await posted(w, w.b2b, [line(w, "150")], { debitNoteOfId: inv.id, reason: "رسوم توصيل إضافية (تجريبي)" });
    const edn = await einv(dn.id);
    assert.equal(edn.typeCode, "383");
    assert.match(edn.xml, /<cbc:ID>DN-\d+<\/cbc:ID>/);
    assert.deepEqual((edn.validation as { ok: boolean }[]).filter((x) => !x.ok), []);
    // The chain is gapless across all of them.
    const all = await prisma.eInvoice.findMany({ orderBy: { icv: "asc" } });
    for (let i = 1; i < all.length; i++) assert.equal(all[i].previousHash, all[i - 1].invoiceHash);
    assert.deepEqual((await EI.revalidate(edn.id)).filter((x) => !x.ok), []);
  });

  test("concurrent generation keeps the chain gapless; stored e-invoices cannot change, be deleted or be inserted out of chain", async () => {
    const w = await world();
    await profile(w);
    const docs = [];
    for (let i = 0; i < 6; i++) {
      const d = await createSalesDoc({ customerId: w.b2b, issueDate: D(1), lines: [line(w, String(100 + i))] }, w.prep);
      await submitSalesDoc(d.id, w.prep); await approveSalesDoc(d.id, w.appr);
      docs.push(d.id);
    }
    // Post (which generates) all six at once.
    await Promise.all(docs.map((id) => postSalesDoc(id, w.appr)));
    const all = await prisma.eInvoice.findMany({ orderBy: { icv: "asc" } });
    assert.deepEqual(all.map((e) => e.icv), [1, 2, 3, 4, 5, 6]);
    for (let i = 1; i < all.length; i++) assert.equal(all[i].previousHash, all[i - 1].invoiceHash);
    await rejects(prisma.eInvoice.update({ where: { id: all[0].id }, data: { xml: "<x/>" } }), /cannot be changed or deleted/);
    await rejects(prisma.eInvoice.delete({ where: { id: all[0].id } }), /cannot be changed or deleted/);
    await rejects(prisma.eInvoice.create({ data: { ...all[5], id: "x", salesInvoiceId: "y", uuid: "z", icv: 7, previousHash: all[0].invoiceHash, validation: [] } as never }), /does not match/);
    await rejects(prisma.eInvoice.create({ data: { ...all[5], id: "x", salesInvoiceId: "y", uuid: "z", icv: 9, validation: [] } as never }), /has no predecessor/);
  });
});

describe("submission and VAT return", () => {
  test("LOCAL_ONLY sends nothing; SANDBOX goes only to an allowed test target; retryable errors back off; accepted is final; attempts are append-only", async () => {
    const w = await world();
    await profile(w);
    const a = await posted(w, w.b2b, [line(w, "1000")]);
    const ea = await einv(a.id);
    const s0 = await EI.submitEInvoice(ea.id, w.prep);
    assert.equal(s0.outcome, "NOT_SENT");
    assert.match(JSON.stringify(s0.response), /LOCAL_ONLY. Nothing was sent to ZATCA/);
    // A SANDBOX profile version (same EGS): the chain continues.
    await profile(w, "SANDBOX");
    const b = await posted(w, w.b2c, [line(w, "40")]);
    const eb = await einv(b.id);
    assert.equal(eb.icv, 2);
    const prod = await EI.submitEInvoice(eb.id, w.prep, { env: { ZATCA_SANDBOX_URL: "https://gw-fatoora.zatca.gov.sa/e-invoicing/core" } });
    assert.equal(prod.outcome, "NOT_SENT");
    assert.match(JSON.stringify(prod.response), /never sends to production/);
    const calls: { url: string; headers: Record<string, string>; body: string }[] = [];
    const stub = (status: number, json: unknown) => async (url: string, init: { headers: Record<string, string>; body: string }) => { calls.push({ url, ...init }); return { status, json: async () => json }; };
    const env = { ZATCA_SANDBOX_URL: "http://127.0.0.1:9911" };
    const t0 = new Date();
    const r1 = await EI.submitEInvoice(eb.id, w.prep, { env, fetcher: stub(503, { message: "busy" }), now: t0 });
    assert.deepEqual([r1.outcome, r1.httpStatus], ["RETRYABLE_ERROR", 503]);
    assert.equal(calls[0].url, "http://127.0.0.1:9911/invoices/reporting/single");
    const sent = JSON.parse(calls[0].body);
    assert.equal(sent.invoiceHash, eb.invoiceHash);
    assert.equal(Buffer.from(sent.invoice, "base64").toString("utf8"), eb.xml);
    await rejects(EI.submitEInvoice(eb.id, w.prep, { env, fetcher: stub(200, {}), now: t0 }), /next attempt is due/);
    assert.deepEqual(await EI.processDueSubmissions(w.prep, { env, fetcher: stub(200, {}), now: t0 }), [], "not yet due");
    const due = await EI.processDueSubmissions(w.prep, { env, fetcher: stub(200, { reportingStatus: "REPORTED" }), now: new Date(t0.getTime() + 2 * 60_000) });
    assert.equal((due[0] as { outcome: string }).outcome, "ACCEPTED");
    await rejects(EI.submitEInvoice(eb.id, w.prep, { env, fetcher: stub(200, {}) }), /already been accepted/);
    const c = await posted(w, w.b2b, [line(w, "300")]);
    const ec = await einv(c.id);
    const rej = await EI.submitEInvoice(ec.id, w.prep, { env, fetcher: stub(400, { validationResults: { status: "ERROR" } }) });
    assert.equal(rej.outcome, "REJECTED");
    assert.equal(calls.at(-1)!.url, "http://127.0.0.1:9911/invoices/clearance/single");
    await rejects(prisma.eInvoiceSubmission.update({ where: { id: rej.id }, data: { outcome: "ACCEPTED" } }), /append-only/);
    assert.equal(await prisma.eInvoiceSubmission.count({ where: { eInvoiceId: eb.id } }), 3, "production refused, retryable, accepted");
    const audit = await prisma.finAuditLog.count({ where: { entityType: "accounting.einvoice", action: "einvoice.submit" } });
    assert.equal(audit, 5);
  });

  test("VAT return: boxes from posted documents (credit notes and reversals in their own period), reconciled to 2170 and 1160 with differences by source", async () => {
    const w = await world();
    await profile(w);
    await posted(w, w.b2b, [line(w, "1000"), line(w, "400", "1", w.zero)]);                 // S 1,000 / 150; Z 400
    const inv = await posted(w, w.b2b, [line(w, "600")]);                                    // S 600 / 90
    await posted(w, w.b2b, [line(w, "100")], { kind: "CREDIT_NOTE", originalInvoiceId: inv.id, reason: "خصم (تجريبي)", creditType: "PRICE_ADJUSTMENT" }); // S −100 / −15
    const rev = await posted(w, w.b2c, [line(w, "20")]);                                     // S 20 / 3, then reversed today: −20 / −3
    await reverseSalesDoc(rev.id, w.appr, "مستند خاطئ (تجريبي)");
    const sup = (await prisma.supplier.create({ data: { name: "مورد تجريبي", vatNumber: "310245678900003" } })).id;
    const b = await createBill({ supplierId: sup, supplierInvoiceNo: "SUP-1", billDate: D(1), lines: [{ kind: "EXPENSE", accountId: w.acc["6200"], description: "إيجار", quantity: "1", unitPrice: "2000", taxCategoryId: w.vat15 }] } as never, w.prep);
    await submitBill(b.id, w.prep); await approveBill(b.id, w.appr); await postBill(b.id, w.appr);   // S 2,000 / 300
    const j = await createManualJournalEntry({ entryDate: accountingDate(D(1)), description: "SYNTHETIC VAT adjustment", lines: [{ accountId: w.acc["1160"], debit: "25", credit: "0" }, { accountId: w.acc["6900"], debit: "0", credit: "25" }] }, w.prep);
    await submitJournalEntry(j.id, w.prep); await approveJournalEntry(j.id, w.appr); await postJournalEntry(j.id, w.appr);
    const r = await vatReturn(accountingDate(D(1)), TODAY);
    assert.deepEqual([r.boxes["1"].amount, r.boxes["1"].vat], ["1500.00", "225.00"]);
    assert.deepEqual([r.boxes["3"].amount, r.boxes["3"].vat], ["400.00", "0.00"]);
    assert.deepEqual([r.boxes["7"].amount, r.boxes["7"].vat], ["2000.00", "300.00"]);
    assert.equal(r.boxes["13"].vat, "-75.00");
    const out = r.reconciliation.find((x) => x.role === "OUTPUT_VAT")!, inp = r.reconciliation.find((x) => x.role === "INPUT_VAT")!;
    assert.deepEqual([out.fromDocuments, out.ledger, out.difference], ["225.00", "225.00", "0.00"]);
    assert.deepEqual([inp.fromDocuments, inp.ledger, inp.difference, inp.unexplained], ["300.00", "325.00", "25.00", "0.00"]);
    assert.equal(out.unexplained, "0.00");
    assert.ok(inp.bySource.some((s) => s.outsideDocuments && s.amount === "25.00"), JSON.stringify(inp.bySource));
    // The reversed document keeps its e-invoice (issued documents are never undone), and is flagged.
    const list = await EI.eInvoiceList();
    assert.ok(list.find((x) => x.salesInvoiceId === rev.id)?.reversedAfterIssue);
  });
});
