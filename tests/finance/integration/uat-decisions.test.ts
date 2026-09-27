// Server rules behind the resolved decisions: D5 (cancel with reason, audited release),
// D6 (branch access by administrators only, audited; suggested categories optional) and
// D4a (per-row completeness in the budget report).
import { test, describe, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { prisma, reset, makeUser, financePerms, ALL_SCOPE_SUBS } from "./support";
import type { Permissions } from "../../../src/lib/auth-shared";
import { resolveScope, COMPANY } from "../../../src/lib/finance/server/context";
import { createAccount, createManualTransaction, reviewTransaction, addMatch } from "../../../src/lib/finance/server/transactions";
import { createCategory, manualAllocate, createReservation, listCategories } from "../../../src/lib/finance/server/allocation";
import { createObligation, cancelObligation, cancelEffects } from "../../../src/lib/finance/server/obligations";
import { createBranch, setBranchAccess, createFinCategory } from "../../../src/lib/finance/server/setup";
import { createBudget, saveDraftLines, budgetReport } from "../../../src/lib/finance/server/budgets";
import { previewReconciliation, saveReconciliation } from "../../../src/lib/finance/server/reconciliation";
import { riyadhDateString, monthOf, monthStart, addDays } from "../../../src/lib/finance/dates";
import { fromMinor } from "../../../src/lib/finance/money";

const today = riyadhDateString();
const d1 = monthStart(monthOf(today));

beforeEach(async () => { await reset(); });
after(async () => { await prisma.$disconnect(); });

async function base() {
  const prep = await makeUser("Preparer", ALL_SCOPE_SUBS);
  const ps = await resolveScope(prep);
  const bank = await createAccount(prep, ps, { code: "BANK1", nameEn: "Main bank", openingBalance: "10000", openingBalanceDate: d1 });
  return { prep, ps, bank };
}

describe("D5 cancelling an obligation", () => {
  test("a reason is required", async () => {
    const { prep, ps } = await base();
    const [o] = await createObligation(prep, ps, { type: "OTHER", description: "Service contract", amount: "900", dueDate: addDays(today, 10) });
    await assert.rejects(cancelObligation(prep, ps, o.id, "  no "), /reason/i);
    assert.equal((await prisma.finObligation.findUniqueOrThrow({ where: { id: o.id } })).status, "OPEN");
  });

  test("open payment requests are released with their own audit entry; without the allocate duty it is refused", async () => {
    const { prep, ps, bank } = await base();
    const cat = await createCategory(prep, ps, { code: "SUP", nameEn: "Supplies" });
    await manualAllocate(prep, ps, { categoryId: cat.id, amount: "2000", sourceCashAccountId: bank.id, reason: "fund supplies" });
    const [o] = await createObligation(prep, ps, { type: "SUPPLIER_BILL", description: "Filters", counterparty: "Cafe Supply Co", amount: "1500", dueDate: addDays(today, 5), allocationCategoryId: cat.id });
    const { reservation } = await createReservation(prep, ps, { categoryId: cat.id, amount: "1500", payee: "Cafe Supply Co", purpose: "Filters", obligationId: o.id });
    const avail = async () => (await listCategories(prisma, ps)).find((c) => c.id === cat.id)!.available;
    assert.equal(await avail(), 50000);

    const noAlloc = await makeUser("Preparer without allocate", ["budget_prepare", "all_branches"]);
    await assert.rejects(cancelObligation(noAlloc, await resolveScope(noAlloc), o.id, "Supplier withdrew the offer"), (e: Error & { status?: number }) => e.status === 403);
    assert.equal((await prisma.paymentReservation.findUniqueOrThrow({ where: { id: reservation.id } })).status, "ACTIVE");

    const fx = await cancelEffects(prisma, ps, o.id);
    assert.deepEqual([fx.paid, fx.remaining, fx.reservations.length], [0, 150000, 1]);
    const res = await cancelObligation(prep, ps, o.id, "Supplier withdrew the offer");
    assert.equal(res.released.length, 1);
    assert.equal((await prisma.paymentReservation.findUniqueOrThrow({ where: { id: reservation.id } })).status, "RELEASED");
    assert.equal(await avail(), 200000, "the held money is back in the category");
    const audits = await prisma.finAuditLog.findMany({ where: { action: { in: ["reservation.released", "obligation.cancelled"] } }, orderBy: { createdAt: "asc" } });
    assert.deepEqual(audits.map((a) => a.action), ["reservation.released", "obligation.cancelled"]);
    assert.ok(audits.every((a) => a.userId === prep.id && /Supplier withdrew the offer/.test(a.reason ?? "")));
  });

  test("a partly paid obligation: the payment stays recorded, only the remainder is cancelled", async () => {
    const { prep, ps, bank } = await base();
    const [o] = await createObligation(prep, ps, { type: "OTHER", description: "Consultant", amount: "1000", dueDate: addDays(today, 3) });
    const pay = (await createManualTransaction(prep, ps, { cashAccountId: bank.id, amount: "-400", txnDate: today, description: "Consultant — first part" })).transaction;
    const fin = await createFinCategory(prep, { code: "PY-X", nameEn: "Services", kind: "PAYMENT" });
    await reviewTransaction(prep, ps, pay.id, { classification: "OTHER_OPERATING_PAYMENT", splits: [{ finCategoryId: fin.id, amount: "-400" }] });
    await addMatch(prep, ps, pay.id, { targetType: "OBLIGATION", targetId: o.id, amount: "400" });
    assert.equal((await prisma.finObligation.findUniqueOrThrow({ where: { id: o.id } })).status, "PARTIALLY_PAID");
    const res = await cancelObligation(prep, ps, o.id, "Scope reduced; remainder not owed");
    assert.deepEqual([res.paidRetained, res.remainingCancelled], [40000, 60000]);
    assert.equal(await prisma.bankTransactionMatch.count({ where: { targetId: o.id, active: true } }), 1, "the payment match is kept");
    const a = await prisma.finAuditLog.findFirstOrThrow({ where: { action: "obligation.cancelled", entityId: o.id } });
    const after = a.after as { paidRetained: string; remainingCancelled: string };
    assert.deepEqual([after.paidRetained, after.remainingCancelled], [fromMinor(40000), fromMinor(60000)]);
  });
});

describe("D6 branch access and optional suggestions", () => {
  test("only an administrator who may edit employees changes branch access; never their own; every change audited", async () => {
    const settings = await makeUser("Finance settings (no employee edit)", ["settings_manage", "all_branches"]);
    const adminPerms: Permissions = { ...financePerms(["settings_manage", "all_branches"]), employees: { access: "edit" } };
    const adminRow = await prisma.employee.create({ data: { name: "Administrator", pin: "x", role: "custom", permissions: JSON.stringify(adminPerms) } });
    const admin = { id: adminRow.id, role: "custom", permissions: adminPerms };
    const staff = await makeUser("Café manager", ["txn_enter"]);
    const cafe = await createBranch(admin, { code: "CAFE", nameEn: "Café" });

    await assert.rejects(setBranchAccess(settings, { employeeId: staff.id, branchId: cafe.id }), (e: Error & { status?: number }) => e.status === 403);
    await assert.rejects(setBranchAccess(admin, { employeeId: admin.id, branchId: cafe.id }), /own branch access/);
    assert.equal(await prisma.finBranchAccess.count(), 0);

    assert.equal((await setBranchAccess(admin, { employeeId: staff.id, branchId: cafe.id })).changed, true);
    assert.equal((await setBranchAccess(admin, { employeeId: staff.id, branchId: cafe.id })).changed, false, "a repeat grant changes nothing");
    assert.equal((await setBranchAccess(admin, { employeeId: staff.id, branchId: cafe.id, grant: false })).changed, true);
    const audits = await prisma.finAuditLog.findMany({ where: { entityType: "FinBranchAccess" }, orderBy: { createdAt: "asc" } });
    assert.deepEqual(audits.map((a) => a.action), ["branch_access.granted", "branch_access.revoked"]);
    assert.deepEqual(audits.map((a) => [(a.before as { access: boolean }).access, (a.after as { access: boolean }).access]), [[false, true], [true, false]]);
    assert.ok(audits.every((a) => a.userId === admin.id && (a.after as { employeeName: string; branchCode: string }).employeeName === "Café manager" && (a.after as { branchCode: string }).branchCode === "CAFE"));
  });

  test("finance works without the suggested categories", async () => {
    const { prep, ps } = await base();
    const rc = await createFinCategory(prep, { code: "RC-MINE", nameEn: "My receipts", kind: "RECEIPT" });
    const py = await createFinCategory(prep, { code: "PY-MINE", nameEn: "My payments", kind: "PAYMENT" });
    await createCategory(prep, ps, { code: "MINE", nameEn: "My envelope" });
    const b = await createBudget(prep, ps, { month: monthOf(today) });
    await saveDraftLines(prep, ps, b.id, { lines: [{ kind: "RECEIPT", finCategoryId: rc.id, plannedAmount: "1000", phasing: "STRAIGHT_LINE" }, { kind: "PAYMENT", finCategoryId: py.id, plannedAmount: "500", phasing: "STRAIGHT_LINE" }] });
    assert.equal(await prisma.finCategory.count(), 2, "only the two created by hand");
    assert.equal((await budgetReport(prisma, ps, b.id, today)).rows.length, 2);
  });
});

describe("D4a budget rows: verified zero vs not yet verified", () => {
  test("indicators are per row: direction, category and reconciliation", async () => {
    const { prep, ps, bank } = await base();
    const rcA = await createFinCategory(prep, { code: "RC-A", nameEn: "Receipts A", kind: "RECEIPT" });
    const rcB = await createFinCategory(prep, { code: "RC-B", nameEn: "Receipts B", kind: "RECEIPT" });
    const py = await createFinCategory(prep, { code: "PY-A", nameEn: "Payments A", kind: "PAYMENT" });
    const b = await createBudget(prep, ps, { month: monthOf(today) });
    await saveDraftLines(prep, ps, b.id, { lines: [
      { kind: "RECEIPT", finCategoryId: rcA.id, plannedAmount: "1000", phasing: "STRAIGHT_LINE" },
      { kind: "RECEIPT", finCategoryId: rcB.id, plannedAmount: "1000", phasing: "STRAIGHT_LINE" },
      { kind: "PAYMENT", finCategoryId: py.id, plannedAmount: "500", phasing: "STRAIGHT_LINE" },
    ] });
    const row = async (id: string) => (await budgetReport(prisma, ps, b.id, today)).rows.find((r) => r.finCategoryId === id)!.completeness;

    // Never reconciled: every row is unverified, and says why.
    assert.deepEqual(await row(py.id), { verified: false, unreviewed: 0, pending: 0, unreconciled: ["BANK1"] });

    // An unknown deposit awaiting review, then the account reconciled through today.
    const dep = (await createManualTransaction(prep, ps, { cashAccountId: bank.id, amount: "250", txnDate: today, description: "Unknown deposit" })).transaction;
    const pre = await previewReconciliation(ps, bank.id, today, "0");
    await saveReconciliation(prep, ps, { cashAccountId: bank.id, statementDate: today, statementBalance: fromMinor(pre.ledgerBalance) });
    assert.deepEqual(await row(py.id), { verified: true, unreviewed: 0, pending: 0, unreconciled: [] }, "a payment row is a verified zero");
    assert.equal((await row(rcA.id)).unreviewed, 1, "the deposit could still land in either receipt row");
    assert.equal((await row(rcB.id)).verified, false);

    // Classified to B: A becomes a verified zero; B has an actual.
    await reviewTransaction(prep, ps, dep.id, { classification: "OTHER_OPERATING_RECEIPT", splits: [{ finCategoryId: rcB.id, amount: "250" }] });
    assert.equal((await row(rcA.id)).verified, true);
    const rb = (await budgetReport(prisma, ps, b.id, today)).rows.find((r) => r.finCategoryId === rcB.id)!;
    assert.equal(rb.actualToDate, 25000);
    void COMPANY;
  });
});
