// Real financial lifecycle, opening balances, and database-level controls under the
// least-privilege application role. Run: npm run test:finance:db
import { test, describe, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { Client } from "pg";
import { prisma, reset, makeUser, ALL_SCOPE_SUBS, APPROVER_SUBS } from "./support";
import { resolveScope, COMPANY } from "../../../src/lib/finance/server/context";
import { createAccount, createManualTransaction, reviewTransaction, confirmPending, commitImport, previewImport, resolveDuplicate } from "../../../src/lib/finance/server/transactions";
import { createCategory, saveRuleDraft, submitRuleVersion, runAllocation, manualAllocate, createReservation, executeReservation, listCategories } from "../../../src/lib/finance/server/allocation";
import { decideApproval } from "../../../src/lib/finance/server/approvals";
import { installRecommended } from "../../../src/lib/finance/server/setup";
import { poolSummaries } from "../../../src/lib/finance/server/ledger";
import { createObligation, listObligations } from "../../../src/lib/finance/server/obligations";
import { createBudget, budgetReport } from "../../../src/lib/finance/server/budgets";
import { overview } from "../../../src/lib/finance/server/dashboard";
import { riyadhDateString, monthOf, monthStart, addDays } from "../../../src/lib/finance/dates";
import { toMinor } from "../../../src/lib/finance/money";

const today = riyadhDateString();
const month = monthOf(today);
const d1 = monthStart(month);
const mapping = { date: "Date", amount: "Amount", reference: "Reference", description: "Description", dateFormat: "YYYY-MM-DD" };

async function setup() {
  const prep = await makeUser("Preparer", ALL_SCOPE_SUBS);
  const appr = await makeUser("Approver", APPROVER_SUBS);
  const ps = await resolveScope(prep);
  await installRecommended(prep, ps, COMPANY);
  const bank = await createAccount(prep, ps, { code: "BANK1", nameEn: "Main bank", openingBalance: "10000", openingBalanceDate: d1 });
  const fin = Object.fromEntries((await prisma.finCategory.findMany()).map((c) => [c.code, c.id]));
  return { prep, appr, ps, as: await resolveScope(appr), bank, fin };
}
const pool = async (c: Awaited<ReturnType<typeof setup>>) => (await poolSummaries(prisma, c.ps)).find((p) => p.branchKey === COMPANY)!;

beforeEach(reset);
after(async () => { await prisma.$disconnect(); });

describe("financial lifecycle", () => {
  test("receipt → confirm → allocate → approve & reserve → pay outside → statement import confirms the same lines (no second outflow or actual)", async () => {
    const c = await setup();
    const green = await createCategory(c.prep, c.ps, { code: "GREEN", nameEn: "Green", spendingLimit: "3000", approverEmployeeId: c.appr.id });
    const { version } = await saveRuleDraft(c.prep, c.ps, { steps: [{ method: "PERCENT_OF_BASE", categoryId: green.id, percent: "50" }] });
    await decideApproval(c.appr, c.as, (await submitRuleVersion(c.prep, c.ps, version.id, null)).id, { decision: "APPROVE" });
    const [bill] = await createObligation(c.prep, c.ps, { type: "SUPPLIER_BILL", description: "Beans bill", amount: "4000", dueDate: addDays(today, 5), allocationCategoryId: green.id, finCategoryId: c.fin["PY-GREEN"] });

    // 1. Receipt recorded on arrival as pending (not cash yet), then confirmed.
    const rc = (await createManualTransaction(c.prep, c.ps, { cashAccountId: c.bank.id, amount: "8000", txnDate: today, status: "PENDING", bankReference: "IN-77", description: "Customer transfer" })).transaction;
    assert.equal((await pool(c)).eligibleCash, 1_000_000, "pending receipt is not cash");
    await confirmPending(c.prep, c.ps, rc.id);
    await reviewTransaction(c.prep, c.ps, rc.id, { classification: "CUSTOMER_RECEIPT", splits: [{ finCategoryId: c.fin["RC-WHOLESALE"], amount: "8000" }] });
    // 2. Allocate.
    await runAllocation(c.prep, c.ps, rc.id);
    assert.equal((await listCategories(prisma, c.ps)).find((x) => x.id === green.id)!.balance, 400_000);
    // 3. Reservation above the category limit → approved override.
    const res = await createReservation(c.prep, c.ps, { categoryId: green.id, amount: "4000", payee: "Supplier", purpose: "Beans", obligationId: bill.id });
    assert.equal(res.reservation.status, "PENDING_APPROVAL");
    const ov = await prisma.finApprovalRequest.findFirstOrThrow({ where: { type: "SPEND_OVERRIDE" } });
    assert.equal(ov.assignedToId, c.appr.id, "routed to the category's named approver");
    await decideApproval(c.appr, c.as, ov.id, { decision: "APPROVE" });
    // 4. Payment made in online banking, recorded here as a PENDING outgoing line.
    const before = await pool(c);
    const pay = (await createManualTransaction(c.prep, c.ps, { cashAccountId: c.bank.id, amount: "-4000", txnDate: today, status: "PENDING", bankReference: "OUT-12", description: "Beans supplier" })).transaction;
    await executeReservation(c.prep, c.ps, res.reservation.id, { txnId: pay.id });
    const afterPay = await pool(c);
    assert.equal(afterPay.unallocated, before.unallocated, "paying from an earmark frees no cash: unallocated is what it was before the payment");
    assert.equal(afterPay.allocated + afterPay.unallocated, afterPay.eligibleCash);
    // 5. The bank statement arrives with BOTH lines (receipt and payment).
    const csv = `Date,Amount,Reference,Description\n${today},8000.00,IN-77,INCOMING 77\n${today},-4000.00,OUT-12,OUTGOING 12\n`;
    const pv = await previewImport(c.prep, c.ps, { cashAccountId: c.bank.id, csv, mapping });
    assert.equal(pv.summary.existing, 2);
    assert.equal(pv.summary.new, 0);
    const lines = await prisma.bankTransaction.count();
    const batch = await commitImport(c.prep, c.ps, { cashAccountId: c.bank.id, csv, mapping });
    assert.equal(batch.attachedCount, 2);
    assert.equal(batch.importedCount, 0);
    assert.equal(await prisma.bankTransaction.count(), lines, "no new bank line");
    const payNow = await prisma.bankTransaction.findUniqueOrThrow({ where: { id: pay.id } });
    assert.equal(payNow.status, "CONFIRMED", "statement confirmed the recorded payment");
    await reviewTransaction(c.prep, c.ps, pay.id, { classification: "SUPPLIER_PAYMENT", splits: [{ finCategoryId: c.fin["PY-GREEN"], amount: "-4000" }] });
    // 6. One outflow, one actual, one settled obligation, one category payment.
    const p = await pool(c);
    assert.equal(p.bookCash, 1_000_000 + 800_000 - 400_000);
    assert.equal(p.allocated + p.unallocated, p.eligibleCash);
    const b = await createBudget(c.prep, c.ps, { month });
    const rep = await budgetReport(prisma, c.ps, b.id, today);
    assert.equal(rep.rows.find((r) => r.code === "PY-GREEN")!.actualToDate, 400_000);
    assert.equal(rep.rows.find((r) => r.code === "RC-WHOLESALE")!.actualToDate, 800_000);
    assert.equal((await listObligations(prisma, c.ps)).rows.length, 0, "obligation fully paid once");
    assert.equal(await prisma.allocationEntry.count({ where: { entryType: "PAYMENT" } }), 1);
    // 7. Re-importing the same statement changes nothing.
    const again = await commitImport(c.prep, c.ps, { cashAccountId: c.bank.id, csv, mapping });
    assert.equal(again.importedCount + again.attachedCount, 0);
  });

  test("ambiguous statement line is flagged, then merged by a reviewer without a second outflow", async () => {
    const c = await setup();
    await createManualTransaction(c.prep, c.ps, { cashAccountId: c.bank.id, amount: "-250", txnDate: today, status: "PENDING", description: "Courier A" });
    await createManualTransaction(c.prep, c.ps, { cashAccountId: c.bank.id, amount: "-250", txnDate: today, status: "PENDING", description: "Courier B" });
    const csv = `Date,Amount,Reference,Description\n${today},-250.00,,COURIER\n`;
    const batch = await commitImport(c.prep, c.ps, { cashAccountId: c.bank.id, csv, mapping });
    assert.equal(batch.attachedCount, 0);
    assert.equal(batch.flaggedCount, 1, "two candidates → a person chooses");
    const imported = await prisma.bankTransaction.findFirstOrThrow({ where: { source: "CSV_IMPORT" } });
    const book = (await pool(c)).bookCash;
    await resolveDuplicate(c.prep, c.ps, imported.id, imported.possibleDuplicateOfId!);
    assert.equal((await prisma.bankTransaction.findUniqueOrThrow({ where: { id: imported.id } })).status, "VOID");
    const kept = await prisma.bankTransaction.findUniqueOrThrow({ where: { id: imported.possibleDuplicateOfId! } });
    assert.equal(kept.status, "CONFIRMED");
    assert.equal(book, 1_000_000 - 25_000, "before merge: the imported line is the only confirmed −250");
    assert.equal((await pool(c)).bookCash, book, "after merge: still exactly one −250 (the recorded line), imported one void");
    const again = await commitImport(c.prep, c.ps, { cashAccountId: c.bank.id, csv, mapping });
    assert.equal(again.importedCount, 0, "the statement identity moved to the kept line");
  });

  test("opening balances are not receipts and cannot be allocated twice", async () => {
    const c = await setup();
    const k = await createCategory(c.prep, c.ps, { code: "K", nameEn: "K" });
    const ov = await overview(prisma, c.ps);
    assert.equal(ov.monthly.receipts, 0, "opening cash is not this month's receipts");
    const b = await createBudget(c.prep, c.ps, { month });
    const rep = await budgetReport(prisma, c.ps, b.id, today);
    assert.equal(rep.totals.receipts.toDate.actual, 0, "opening cash is not a budget actual");
    await manualAllocate(c.prep, c.ps, { categoryId: k.id, amount: "6000", sourceCashAccountId: c.bank.id, reason: "opening" });
    await assert.rejects(manualAllocate(c.prep, c.ps, { categoryId: k.id, amount: "5000", sourceCashAccountId: c.bank.id, reason: "again" }), /Only 4000.00 SAR of the opening balance/);
    const race = await Promise.allSettled(Array.from({ length: 4 }, () => manualAllocate(c.prep, c.ps, { categoryId: k.id, amount: "4000", sourceCashAccountId: c.bank.id, reason: "race" })));
    assert.equal(race.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal((await listCategories(prisma, c.ps)).find((x) => x.id === k.id)!.balance, 1_000_000, "exactly the opening balance, never more");
  });
});

describe("database controls under the application role (finance_app)", () => {
  async function appClient() {
    const u = new URL(process.env.DATABASE_URL!);
    const c = new Client({ host: u.hostname, port: Number(u.port), database: u.pathname.slice(1), user: "finance_app", password: process.env.FIN_LOCAL_PG_APP_PASSWORD });
    await c.connect();
    return c;
  }
  test("role is not superuser/owner and cannot truncate or disable triggers", async () => {
    const c = await appClient();
    try {
      const r = await c.query(`SELECT rolsuper, rolbypassrls, rolcreaterole FROM pg_roles WHERE rolname = current_user`);
      assert.deepEqual(r.rows[0], { rolsuper: false, rolbypassrls: false, rolcreaterole: false });
      await assert.rejects(c.query(`TRUNCATE "AllocationEntry"`), /permission denied/);
      await assert.rejects(c.query(`ALTER TABLE "AllocationEntry" DISABLE TRIGGER ALL`), /must be owner/);
    } finally { await c.end(); }
  });

  test("append-only ledgers, protected approved budgets and four-eyes approvals hold in SQL", async () => {
    const s = await setup();
    const k = await createCategory(s.prep, s.ps, { code: "K", nameEn: "K" });
    await manualAllocate(s.prep, s.ps, { categoryId: k.id, amount: "100", sourceCashAccountId: s.bank.id, reason: "x" });
    await createManualTransaction(s.prep, s.ps, { cashAccountId: s.bank.id, amount: "50", txnDate: today, description: "row for the delete check" });
    // Row triggers fire per row, so every statement below targets rows that exist.
    for (const t of ["AllocationEntry", "FinAuditLog", "BankTransaction"]) assert.ok(Number((await prisma.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*) AS n FROM "${t}"`))[0].n) > 0, t);
    const b = await createBudget(s.prep, s.ps, { month });
    await prisma.budgetLine.create({ data: { revisionId: (await prisma.budgetRevision.findFirstOrThrow({ where: { budgetId: b.id } })).id, lineKey: "PAYMENT:x:-", finCategoryId: s.fin["PY-RENT"], kind: "PAYMENT", plannedAmount: "10" } });
    const { submitBudget } = await import("../../../src/lib/finance/server/budgets");
    const req = await submitBudget(s.prep, s.ps, b.id, {});
    const c = await appClient();
    try {
      await assert.rejects(c.query(`UPDATE "AllocationEntry" SET amount = 1`), /append-only/);
      await assert.rejects(c.query(`DELETE FROM "AllocationEntry"`), /append-only/);
      await assert.rejects(c.query(`DELETE FROM "FinAuditLog"`), /append-only/);
      await assert.rejects(c.query(`DELETE FROM "BankTransaction"`), /append-only/);
      // Self-approval in raw SQL is refused by the database, not only by the service.
      await assert.rejects(c.query(`UPDATE "FinApprovalRequest" SET status = 'APPROVED', "decidedBy" = "requestedBy" WHERE id = $1`, [req.id]), /cannot decide their own request/);
      await assert.rejects(c.query(`UPDATE "BudgetRevision" SET status = 'APPROVED', "decidedBy" = "submittedBy" WHERE "budgetId" = $1`, [b.id]), /someone other than its submitter/);
      await assert.rejects(c.query(`DELETE FROM "FinApprovalRequest" WHERE id = $1`, [req.id]), /cannot be deleted/);
      // A proper decision by someone else succeeds, after which the request and the approved lines are frozen.
      await decideApproval(s.appr, s.as, req.id, { decision: "APPROVE" });
      await assert.rejects(c.query(`UPDATE "FinApprovalRequest" SET "decisionNote" = 'edited' WHERE id = $1`, [req.id]), /decided approval request cannot be changed/);
      await assert.rejects(c.query(`UPDATE "BudgetLine" SET "plannedAmount" = 999 WHERE "revisionId" IN (SELECT id FROM "BudgetRevision" WHERE "budgetId" = $1)`, [b.id]), /cannot be changed/);
      await assert.rejects(c.query(`UPDATE "BudgetRevision" SET status = 'DRAFT' WHERE "budgetId" = $1`, [b.id]), /cannot be changed/);
    } finally { await c.end(); }
  });
  test("no self-approval bypass: the application role cannot enable one, forge one, or skip the request", async () => {
    const s = await setup();
    const { requestCategoryTransfer } = await import("../../../src/lib/finance/server/allocation");
    const { submitBudget } = await import("../../../src/lib/finance/server/budgets");
    const k1 = await createCategory(s.prep, s.ps, { code: "K1", nameEn: "K1", spendingLimit: "100", approverEmployeeId: s.appr.id });
    const k2 = await createCategory(s.prep, s.ps, { code: "K2", nameEn: "K2" });
    await manualAllocate(s.prep, s.ps, { categoryId: k1.id, amount: "500", sourceCashAccountId: s.bank.id, reason: "fund" });
    // Four pending requests, all raised by the preparer.
    const b = await createBudget(s.prep, s.ps, { month });
    await prisma.budgetLine.create({ data: { revisionId: (await prisma.budgetRevision.findFirstOrThrow({ where: { budgetId: b.id } })).id, lineKey: "PAYMENT:x:-", finCategoryId: s.fin["PY-RENT"], kind: "PAYMENT", plannedAmount: "10" } });
    const budgetReq = await submitBudget(s.prep, s.ps, b.id, {});
    const res = await createReservation(s.prep, s.ps, { categoryId: k1.id, amount: "300", payee: "P", purpose: "over the 100 limit" });
    assert.equal(res.reservation.status, "PENDING_APPROVAL");
    const transferReq = await requestCategoryTransfer(s.prep, s.ps, { fromCategoryId: k1.id, toCategoryId: k2.id, amount: "50", reason: "move" });
    const requests = await prisma.finApprovalRequest.findMany({ orderBy: { requestedAt: "asc" } });
    assert.equal(requests.length, 3);
    assert.ok(requests.every((r) => r.status === "PENDING" && r.requestedBy === s.prep.id));
    const overrideReq = requests.find((r) => r.type === "SPEND_OVERRIDE")!;
    const transferId = requests.find((r) => r.type === "CATEGORY_TRANSFER")!.id;
    assert.ok(transferReq && budgetReq);

    // Snapshot everything a bypass could change, as the owner.
    const snap = async () => Object.fromEntries(await Promise.all(["FinApprovalRequest", "BudgetRevision", "FinBudget", "PaymentReservation", "AllocationEntry", "AllocationRuleVersion", "FinAuditLog", "BankTransaction", "FinSettings"].map(async (t) =>
      [t, (await prisma.$queryRawUnsafe<{ h: string }[]>(`SELECT md5(COALESCE(json_agg(x ORDER BY x."id")::text, '')) AS h FROM "${t}" x`))[0].h])));
    const before = await snap();

    const c = await appClient();
    try {
      // 1. The exception no longer exists and cannot be re-created or re-enabled.
      await assert.rejects(c.query(`UPDATE "FinSettings" SET "allowSelfApproval" = true`), /column "allowSelfApproval" .*does not exist/);
      await assert.rejects(c.query(`ALTER TABLE "FinSettings" ADD COLUMN "allowSelfApproval" boolean DEFAULT true`), /must be owner/);
      await assert.rejects(c.query(`CREATE OR REPLACE FUNCTION fin_guard_approval_request() RETURNS trigger AS $$ BEGIN RETURN NEW; END; $$ LANGUAGE plpgsql`), /must be owner|permission denied/);
      await assert.rejects(c.query(`DROP TRIGGER "FinApprovalRequest_guard" ON "FinApprovalRequest"`), /must be owner/);
      await assert.rejects(c.query(`ALTER TABLE "FinApprovalRequest" DISABLE TRIGGER USER`), /must be owner/);
      // A session setting is not a way around it either: disabling triggers per session needs superuser.
      await assert.rejects(c.query(`SET session_replication_role = replica`), /permission denied/);
      // 2. Self-approval, directly.
      await assert.rejects(c.query(`UPDATE "FinApprovalRequest" SET status = 'APPROVED', "decidedBy" = "requestedBy", "decidedAt" = now() WHERE id = $1`, [overrideReq.id]), /cannot decide their own request/);
      // 3. A forged, already-approved request.
      await assert.rejects(c.query(`INSERT INTO "FinApprovalRequest" (id, type, "branchKey", "entityType", "entityId", summary, payload, "requiredSub", "requestedBy", status, "decidedBy", "decidedAt")
        SELECT 'forged', type, "branchKey", "entityType", "entityId", summary, payload, "requiredSub", "requestedBy", 'APPROVED', $2, now() FROM "FinApprovalRequest" WHERE id = $1`, [overrideReq.id, s.appr.id]), /must be created pending/);
      // 4. Skipping the request: approval-gated states cannot be written without an approved request.
      await assert.rejects(c.query(`UPDATE "PaymentReservation" SET status = 'ACTIVE' WHERE id = $1`, [res.reservation.id]), /approved override request/);
      await assert.rejects(c.query(`UPDATE "BudgetRevision" SET status = 'APPROVED', "decidedBy" = $2, "decidedAt" = now() WHERE "budgetId" = $1`, [b.id, s.appr.id]), /through an approved request/);
      await assert.rejects(c.query(`INSERT INTO "AllocationEntry" (id, "categoryId", "branchKey", "entryType", "sourceType", amount, "periodMonth", "approvalId", "createdBy") VALUES ('forged-t', $1, 'COMPANY', 'TRANSFER_IN', 'CATEGORY_TRANSFER', 50, $2, $3, $4)`, [k2.id, month, transferId, s.prep.id]), /approved transfer request/);
    } finally { await c.end(); }

    // Nothing changed: requests, approval state, reservations, ledgers, audit, bank lines, settings.
    assert.deepEqual(await snap(), before);
    const after = await prisma.finApprovalRequest.findMany();
    assert.ok(after.every((r) => r.status === "PENDING" && r.decidedBy === null));

    // The service refuses the requester too, and the real path still works for someone else.
    await assert.rejects(decideApproval(s.prep, s.ps, overrideReq.id, { decision: "APPROVE" }), /cannot decide a request you raised|do not hold the duty/);
    await decideApproval(s.appr, s.as, overrideReq.id, { decision: "APPROVE" });
    assert.equal((await prisma.paymentReservation.findUniqueOrThrow({ where: { id: res.reservation.id } })).status, "ACTIVE");
  });

  test("a category's named approver cannot be the person raising the request", async () => {
    const s = await setup();
    const both = await makeUser("Both duties", [...ALL_SCOPE_SUBS, "spend_override_approve"]);
    const bs = await resolveScope(both);
    const k = await createCategory(s.prep, s.ps, { code: "K", nameEn: "K", spendingLimit: "10", approverEmployeeId: both.id });
    await manualAllocate(s.prep, s.ps, { categoryId: k.id, amount: "100", sourceCashAccountId: s.bank.id, reason: "fund" });
    await assert.rejects(createReservation(both, bs, { categoryId: k.id, amount: "50", payee: "P", purpose: "x" }), /cannot be the approver of your own request/);
    assert.equal(await prisma.paymentReservation.count(), 0);
  });
});

