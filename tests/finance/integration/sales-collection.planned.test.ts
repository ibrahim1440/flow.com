// Sales collection ↔ bank receipt — IMPLEMENTED on the disposable integration branch
// (trial/finance-sales-integration-20260926 = feature/sales-crm-commissions + finance).
// On feature/finance-cash-budget the same file holds the skipped specification.
//
// One approved sales collection matched to one bank receipt is exactly one economic cash
// receipt and cannot be allocated twice — including retries, races and a later reversal.
import { test, describe, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { Prisma } from "../../../src/generated/prisma/client";
import { prisma, reset, makeUser, ALL_SCOPE_SUBS } from "./support";
import { resolveScope, COMPANY } from "../../../src/lib/finance/server/context";
import { createAccount, reviewTransaction, commitImport, linkSalesCollection, suggestSalesCollection, collectionSuggestion } from "../../../src/lib/finance/server/transactions";
import { createCategory, saveRuleDraft, submitRuleVersion, runAllocation } from "../../../src/lib/finance/server/allocation";
import { decideApproval } from "../../../src/lib/finance/server/approvals";
import { installRecommended } from "../../../src/lib/finance/server/setup";
import { poolSummaries } from "../../../src/lib/finance/server/ledger";
import { createBudget, budgetReport } from "../../../src/lib/finance/server/budgets";
import { overview } from "../../../src/lib/finance/server/dashboard";
import { riyadhDateString, monthOf, monthStart } from "../../../src/lib/finance/dates";
import { submitCollection, approveCollection, reverseCollection } from "../../../src/lib/services/sales/collections";

const today = riyadhDateString();
const month = monthOf(today);
const mapping = { date: "Date", amount: "Amount", reference: "Reference", description: "Description", dateFormat: "YYYY-MM-DD" };
const statement = `Date,Amount,Reference,Description\n${today},8050.00,IN-2291,TRANSFER ELITE ROASTERY\n`;

async function resetSales() {
  await prisma.$executeRawUnsafe(`TRUNCATE "CollectionEvidence","SalesCollection","CommissionLedgerEntry","CommissionAccrual","CollectionEvent","QuoteLine","Quote","OpportunityStageEvent","OpportunityOwner","Opportunity","PipelineStage" RESTART IDENTITY CASCADE`);
}

async function setup() {
  const prep = await makeUser("Finance preparer", ALL_SCOPE_SUBS);
  const appr = await makeUser("Finance approver", ["budget_approve", "all_branches"]);
  const rep = await makeUser("Sales rep", []);
  const verifier = await makeUser("Collections verifier", []);
  const ps = await resolveScope(prep);
  await installRecommended(prep, ps, COMPANY);
  const bank = await createAccount(prep, ps, { code: "SNB-CUR", nameEn: "SNB current", openingBalance: "0", openingBalanceDate: monthStart(month) });
  const cat = await createCategory(prep, ps, { code: "OPEX", nameEn: "Operating" });
  const { version } = await saveRuleDraft(prep, ps, { steps: [{ method: "PERCENT_OF_BASE", categoryId: cat.id, percent: "100" }] });
  await decideApproval(appr, await resolveScope(appr), (await submitRuleVersion(prep, ps, version.id, null)).id, { decision: "APPROVE" });
  // A deal with an accepted quotation: 7,000.00 + 1,050.00 VAT = 8,050.00.
  const stage = await prisma.pipelineStage.create({ data: { code: "T_NEW", nameEn: "New", nameAr: "جديد", position: 1, probability: 10, isActive: true } });
  const customer = await prisma.customer.create({ data: { name: "Elite Roastery" } });
  const opp = await prisma.opportunity.create({ data: { title: "Elite Roastery — wholesale", customerId: customer.id, stageId: stage.id, amount: "8050", currency: "SAR", probability: 50, ownerId: rep.id } });
  await prisma.quote.create({ data: { quoteNumber: "T-Q-1", revision: 1, opportunityId: opp.id, customerId: customer.id, status: "ACCEPTED", currency: "SAR", subtotal: "7000", discountTotal: "0", taxTotal: "1050", grandTotal: "8050", acceptedAt: new Date() } });
  const fin = Object.fromEntries((await prisma.finCategory.findMany()).map((c) => [c.code, c.id]));
  return { prep, ps, rep, verifier, bank, opp, fin };
}
type Ctx = Awaited<ReturnType<typeof setup>>;

async function approvedCollection(c: Ctx, key = "k-1") {
  const s = await prisma.$transaction((tx) => submitCollection(tx, {
    opportunityId: c.opp.id, amountGross: new Prisma.Decimal("8050.00"), currency: "SAR", collectedAt: new Date(`${today}T08:00:00Z`),
    paymentMethod: "BANK_TRANSFER", referenceNumber: "IN-2291", note: null, idempotencyKey: key, submittedById: c.rep.id,
  }));
  await prisma.$transaction((tx) => approveCollection(tx, { collectionId: s.collectionId, actorId: c.verifier.id }));
  return s.collectionId;
}
const finance = async (c: Ctx) => {
  const p = (await poolSummaries(prisma, c.ps)).find((x) => x.branchKey === COMPANY)!;
  return { lines: await prisma.bankTransaction.count({ where: { status: { not: "VOID" } } }), eligible: p.eligibleCash, allocated: p.allocated, entries: await prisma.allocationEntry.count(), runs: await prisma.allocationRun.count() };
};

beforeEach(async () => { await reset(); await resetSales(); });
after(async () => { await prisma.$disconnect(); });

describe("sales collection ↔ bank receipt (integration branch)", () => {
  test("approving a collection moves no finance cash, allocation or actual", async () => {
    const c = await setup();
    const before = await finance(c);
    const id = await approvedCollection(c);
    assert.equal((await prisma.salesCollection.findUniqueOrThrow({ where: { id } })).status, "APPROVED");
    assert.equal(await prisma.collectionEvent.count(), 1, "the commission engine got its event");
    assert.deepEqual(await finance(c), before, "no bank line, no eligible cash, no allocation");
    const b = await createBudget(c.prep, c.ps, { month });
    assert.equal((await budgetReport(prisma, c.ps, b.id, today)).totals.receipts.toDate.actual, 0, "no budget actual");
  });

  test("statement receipt is the only cash; allocation and actual counted once, even when retried or raced", async () => {
    const c = await setup();
    const id = await approvedCollection(c);
    await commitImport(c.prep, c.ps, { cashAccountId: c.bank.id, csv: statement, mapping });
    const line = await firstLine();
    const s = await suggestSalesCollection(prisma, c.ps, line.id);
    assert.deepEqual(s, { kind: "MATCH", collectionId: id, basis: "REFERENCE" });
    const m1 = await linkSalesCollection(c.prep, c.ps, line.id, id);
    const m2 = await linkSalesCollection(c.prep, c.ps, line.id, id);
    assert.equal(m2.id, m1.id, "retrying the link returns the same link");
    assert.equal(toTax(m1.taxAmount), 105_000, "VAT from the collection");
    await reviewTransaction(c.prep, c.ps, line.id, { classification: "CUSTOMER_RECEIPT", splits: [{ finCategoryId: c.fin["RC-WHOLESALE"], amount: "8050" }] });
    const race = await Promise.allSettled([runAllocation(c.prep, c.ps, line.id), runAllocation(c.prep, c.ps, line.id), runAllocation(c.prep, c.ps, line.id)]);
    assert.ok(race.some((r) => r.status === "fulfilled"));
    const f = await finance(c);
    assert.equal(f.lines, 1, "one bank line");
    assert.equal(f.eligible, 805_000, "8,050.00 of cash, once");
    assert.equal(f.runs, 1, "one allocation run for the receipt, however many concurrent attempts");
    assert.ok(f.allocated > 0 && f.allocated <= 805_000, "allocated from this receipt at most once");
    await runAllocation(c.prep, c.ps, line.id).catch(() => undefined);
    assert.deepEqual(await finance(c), f, "a later retry allocates nothing more");
    const b = await createBudget(c.prep, c.ps, { month });
    assert.equal((await budgetReport(prisma, c.ps, b.id, today)).rows.find((r) => r.code === "RC-WHOLESALE")!.actualToDate, 805_000, "actual once");
    assert.equal(await prisma.bankTransactionMatch.count({ where: { targetType: "SALES_COLLECTION" } }), 1);
  });

  test("one collection ↔ one bank line: a second link either way is refused (service and database)", async () => {
    const c = await setup();
    const id = await approvedCollection(c, "k-a");
    await commitImport(c.prep, c.ps, { cashAccountId: c.bank.id, csv: `Date,Amount,Reference,Description\n${today},8050.00,IN-2291,A\n${today},8050.00,IN-2292,B\n`, mapping });
    const [l1, l2] = await prisma.bankTransaction.findMany({ orderBy: { bankReference: "asc" } });
    await linkSalesCollection(c.prep, c.ps, l1.id, id);
    await assert.rejects(linkSalesCollection(c.prep, c.ps, l2.id, id), /already linked to another bank line/);
    // A second approved collection for the same deal cannot land on the line already settling the first.
    await prisma.quote.updateMany({ data: { grandTotal: "16100", subtotal: "14000", taxTotal: "2100" } });
    await prisma.opportunity.updateMany({ data: { amount: "16100" } });
    const id2 = await approvedCollection(c, "k-b");
    await assert.rejects(linkSalesCollection(c.prep, c.ps, l1.id, id2), /already settles another sales collection/);
    // The database refuses a duplicate active link even if the service were bypassed.
    await assert.rejects(prisma.bankTransactionMatch.create({ data: { transactionId: l2.id, targetType: "SALES_COLLECTION", targetId: id, amount: "8050", createdBy: c.prep.id } }), /Unique constraint|unique/i);
    // Concurrent links of one collection to two lines: exactly one wins.
    const race = await Promise.allSettled([linkSalesCollection(c.prep, c.ps, l2.id, id2), linkSalesCollection(c.prep, c.ps, l2.id, id2)]);
    assert.equal(new Set(race.filter((r) => r.status === "fulfilled").map((r) => (r as PromiseFulfilledResult<{ id: string }>).value.id)).size, 1);
    assert.equal(await prisma.bankTransactionMatch.count({ where: { targetType: "SALES_COLLECTION", active: true } }), 2);
  });

  test("a reversed collection flags the link and changes no cash until a refund line exists", async () => {
    const c = await setup();
    const id = await approvedCollection(c);
    await commitImport(c.prep, c.ps, { cashAccountId: c.bank.id, csv: statement, mapping });
    const line = await firstLine();
    await linkSalesCollection(c.prep, c.ps, line.id, id);
    await reviewTransaction(c.prep, c.ps, line.id, { classification: "CUSTOMER_RECEIPT", splits: [{ finCategoryId: c.fin["RC-WHOLESALE"], amount: "8050" }] });
    await runAllocation(c.prep, c.ps, line.id);
    const before = await finance(c);
    await prisma.$transaction((tx) => reverseCollection(tx, { collectionId: id, actorId: c.verifier.id, reason: "customer disputed the transfer" }));
    assert.deepEqual(await finance(c), before, "cash, allocations and runs unchanged — the money is still in the bank");
    const alerts = (await overview(prisma, c.ps)).alerts.filter((a: { kind: string }) => a.kind === "COLLECTION_REVERSED");
    assert.equal(alerts.length, 1, "Finance is told to review the receipt");
    const line2 = (await commitImport(c.prep, c.ps, { cashAccountId: c.bank.id, csv: `Date,Amount,Reference,Description
${today},8050.00,IN-9999,OTHER
`, mapping }));
    assert.equal(line2.importedCount, 1);
    const other = await prisma.bankTransaction.findFirstOrThrow({ where: { bankReference: "IN-9999" } });
    await assert.rejects(linkSalesCollection(c.prep, c.ps, other.id, id), /already linked to another bank line/, "a reversed collection is not re-linked elsewhere");
  });

  test("re-import after linking inserts nothing and keeps the link", async () => {
    const c = await setup();
    const id = await approvedCollection(c);
    await commitImport(c.prep, c.ps, { cashAccountId: c.bank.id, csv: statement, mapping });
    const line = await firstLine();
    await linkSalesCollection(c.prep, c.ps, line.id, id);
    const again = await commitImport(c.prep, c.ps, { cashAccountId: c.bank.id, csv: statement, mapping });
    assert.equal(again.importedCount + again.attachedCount, 0);
    assert.equal(await prisma.bankTransaction.count(), 1);
    assert.equal(await prisma.bankTransactionMatch.count({ where: { targetType: "SALES_COLLECTION", active: true, targetId: id } }), 1);
  });

  test("the review panel suggestion: an approved collection is offered with its details, linking shows it as linked", async () => {
    const c = await setup();
    const id = await approvedCollection(c);
    await commitImport(c.prep, c.ps, { cashAccountId: c.bank.id, fileName: "s.csv", csv: statement, mapping });
    const line = await firstLine();
    const s1 = await collectionSuggestion(prisma, c.ps, line.id);
    assert.equal(s1.linked, null);
    assert.deepEqual(s1.decision, { kind: "MATCH", collectionId: id, basis: "REFERENCE" });
    assert.equal(s1.candidates[0].customer, "Elite Roastery");
    assert.deepEqual([s1.candidates[0].amountGross, s1.candidates[0].amountTax], [805000, 105000]);
    assert.equal(await prisma.bankTransactionMatch.count(), 0, "a suggestion links nothing");
    await linkSalesCollection(c.prep, c.ps, line.id, id);
    const s2 = await collectionSuggestion(prisma, c.ps, line.id);
    assert.equal(s2.linked?.id, id);
    assert.equal(s2.decision, null);
  });
});

function toTax(v: unknown) { return Math.round(Number(String(v)) * 100); }
function firstLine() { return prisma.bankTransaction.findFirstOrThrow({ orderBy: { createdAt: "asc" } }); }
