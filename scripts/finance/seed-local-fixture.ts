#!/usr/bin/env tsx
/**
 * LOCAL-ONLY realistic fixture for the finance module (UI review, Figma parity checks).
 *
 * Refuses to run unless DATABASE_URL points at the embedded local PostgreSQL
 * (127.0.0.1, database erp_finance_dev). Never run against Neon, demo or production.
 * Everything is created through the real services, so the fixture exercises the same
 * validation, approvals and ledgers the application uses.
 *
 * Fixture logins use FIN_FIXTURE_PASSWORD from the local .env (gitignored).
 *
 *   node .local-postgres/pg.mjs            # in another terminal
 *   npx tsx --env-file=.env scripts/finance/seed-local-fixture.ts
 */
import { checkUrl, assertDisposableFinanceDb } from "./local-db-guard.mjs";
{
  // Cheap checks before anything connects; the marker check runs once prisma is up.
  const problems = checkUrl(process.env.DATABASE_URL, "erp_finance_dev");
  if (problems.length) { console.error(`Refusing: ${problems.join("; ")}.`); process.exit(1); }
}
const password = process.env.FIN_FIXTURE_PASSWORD;
if (!password || password.length < 12) {
  console.error("Set FIN_FIXTURE_PASSWORD (12+ characters) in the local .env first.");
  process.exit(1);
}

import { hash } from "bcryptjs";
import { prisma } from "../../src/lib/db";
import { buildDefaultPermissions, MODULE_SUB_PRIVILEGES, type Permissions } from "../../src/lib/auth-shared";
import { resolveScope, COMPANY, type FinanceActor } from "../../src/lib/finance/server/context";
import { installRecommended, createBranch, setBranchAccess } from "../../src/lib/finance/server/setup";
import { createAccount, createManualTransaction, reviewTransaction, addMatch, createTransfer, commitImport } from "../../src/lib/finance/server/transactions";
import { updateCategory, saveRuleDraft, submitRuleVersion, runAllocation, manualAllocate, createReservation, executeReservation, requestCategoryTransfer } from "../../src/lib/finance/server/allocation";
import { decideApproval } from "../../src/lib/finance/server/approvals";
import { createObligation, supersedeObligation, createForecastItem } from "../../src/lib/finance/server/obligations";
import { createBudget, saveDraftLines, submitBudget, startRevision, addVarianceNote, saveForecastSnapshot } from "../../src/lib/finance/server/budgets";
import { saveReconciliation, previewReconciliation } from "../../src/lib/finance/server/reconciliation";
import { addDays } from "../../src/lib/finance/dates";
import { fromMinor } from "../../src/lib/finance/money";

const M = "2026-09";
const D = (d: number) => `${M}-${String(d).padStart(2, "0")}`;

function perms(subs: string[], extra: Permissions = {}): Permissions {
  const p = buildDefaultPermissions("custom");
  p.dashboard = { access: "edit" };
  p.finance = { access: "edit", sub: Object.fromEntries(MODULE_SUB_PRIVILEGES.finance.map((s) => [s.key, subs.includes(s.key)])) };
  return { ...p, ...extra };
}

async function user(username: string, name: string, p: Permissions, lang: "ar" | "en" = "ar", role = "custom"): Promise<FinanceActor> {
  const e = await prisma.employee.upsert({
    where: { username },
    update: { role, permissions: JSON.stringify(p), password: await hash(password!, 10), active: true, preferredLanguage: lang },
    create: { username, name, pin: "fixture-no-pin", role, permissions: JSON.stringify(p), password: await hash(password!, 10), preferredLanguage: lang },
  });
  return { id: e.id, role: e.role, permissions: p };
}

async function main() {
  await assertDisposableFinanceDb({ url: process.env.DATABASE_URL, expectedDb: "erp_finance_dev", query: (q) => prisma.$queryRawUnsafe(q) });
  if (process.argv.includes("--reset")) {
    // Local disposable database only (guarded above). TRUNCATE bypasses the row triggers
    // that make the finance ledgers append-only everywhere else.
    const tables = ["FinAuditLog","FinApprovalRequest","FinForecastSnapshot","FinVarianceNote","BudgetLine","BudgetRevision","FinBudget","FinForecastItem","FinObligation","PaymentReservation","AllocationEntry","AllocationRun","AllocationRuleStep","AllocationRuleVersion","AllocationCategory","FinAttachment","BankTransactionMatch","BankTransactionSplit","BankTransaction","BankReconciliation","BankImportBatch","CashAccount","FinCategory","FinCostCenter","FinBranchAccess","FinBranch","FinSettings","OrderActivity","OrderItem","Order","Customer","LoginAttempt","RateLimit"];
    await prisma.$executeRawUnsafe(`TRUNCATE ${tables.map((t) => `"${t}"`).join(", ")} RESTART IDENTITY CASCADE`);
  }
  if ((await prisma.bankTransaction.count()) > 0) {
    console.error("The local dev database already has finance data. Reset it first (drop and re-migrate erp_finance_dev).");
    process.exit(1);
  }
  const prep = await user("fin.manager", "سارة العتيبي — المالية", perms(["txn_enter", "reconcile", "budget_prepare", "allocate", "all_branches", "settings_manage"]));
  const appr = await user("fin.approver", "عبدالله الحربي — المدير العام", perms(["budget_approve", "transfer_approve", "spend_override_approve", "period_close", "all_branches"]));
  const cafeUser = await user("fin.cafe", "نورة — مديرة المقهى", perms(["txn_enter", "budget_prepare"]));
  await user("fin.viewer", "مراجع — عرض فقط", perms([]));
  await user("fin.manager.en", "Sara Alotaibi — Finance", perms(["txn_enter", "reconcile", "budget_prepare", "allocate", "all_branches", "settings_manage"]), "en");
  await user("no.finance", "موظف بلا صلاحية مالية", { ...buildDefaultPermissions("custom"), dashboard: { access: "edit" } });
  // First-grant scenario (tests/finance/http/admin-grant.test.mjs): an administrator whose
  // stored permissions were written before the Finance module existed, and two staff members
  // who have no finance access yet.
  const legacyAdmin = buildDefaultPermissions("admin");
  delete legacyAdmin.finance;
  await user("legacy.admin", "مدير النظام (صلاحيات سابقة)", legacyAdmin, "ar", "admin");
  await user("new.preparer", "موظف جديد — إعداد", { ...buildDefaultPermissions("custom"), dashboard: { access: "edit" } });
  await user("new.approver", "موظف جديد — اعتماد", { ...buildDefaultPermissions("custom"), dashboard: { access: "edit" } });

  let ps = await resolveScope(prep);
  await installRecommended(prep, ps, COMPANY);
  const cafe = await createBranch(prep, { code: "CAFE", nameEn: "Café", nameAr: "المقهى" });
  await setBranchAccess(prep, { employeeId: cafeUser.id, branchId: cafe.id });
  ps = await resolveScope(prep);
  const as = await resolveScope(appr);
  const fin = Object.fromEntries((await prisma.finCategory.findMany()).map((c) => [c.code, c.id]));
  const al = Object.fromEntries((await prisma.allocationCategory.findMany()).map((c) => [c.code, c]));

  // Accounts — last four digits only.
  const snb = await createAccount(prep, ps, { code: "SNB-CUR", nameEn: "SNB current account", nameAr: "الأهلي — الحساب الجاري", bankName: "SNB", accountLast4: "4471", openingBalance: "85000", openingBalanceDate: D(1) });
  const cash = await createAccount(prep, ps, { code: "CASH-BOX", nameEn: "Cash box", nameAr: "الصندوق النقدي", type: "CASH", openingBalance: "3200", openingBalanceDate: D(1) });
  await createAccount(prep, ps, { code: "GUAR", nameEn: "Bank guarantee (restricted)", nameAr: "ضمان بنكي (مقيد)", isRestricted: true, openingBalance: "15000", openingBalanceDate: D(1) });
  const cafeAcc = await createAccount(prep, ps, { code: "RJH-CAFE", nameEn: "Al Rajhi — café", nameAr: "الراجحي — حساب المقهى", branchKey: cafe.id, bankName: "Al Rajhi", accountLast4: "9920", openingBalance: "6500", openingBalanceDate: D(1) });
  await installRecommended(prep, ps, cafe.id);

  // Category policies.
  await updateCategory(prep, ps, al["AL-SALARY"].id, { fundingType: "MONTHLY_TARGET", targetAmount: "38000", dueDay: 28 });
  await updateCategory(prep, ps, al["AL-RENT"].id, { fundingType: "MONTHLY_TARGET", targetAmount: "12000", dueDay: 1 });
  await updateCategory(prep, ps, al["AL-RESERVE"].id, { fundingType: "RESERVE_TARGET", targetAmount: "25000", replenish: true });
  await updateCategory(prep, ps, al["AL-GREEN"].id, { spendingLimit: "30000", approverEmployeeId: appr.id });
  await updateCategory(prep, ps, al["AL-MKT"].id, { spendingLimit: "5000" });

  // Opening balance earmarks.
  for (const [code, amt] of [["AL-SALARY", "20000"], ["AL-RENT", "12000"], ["AL-RESERVE", "15000"], ["AL-GREEN", "20000"]] as const) {
    await manualAllocate(prep, ps, { categoryId: al[code].id, amount: amt, sourceCashAccountId: snb.id, reason: "Opening balance earmark" });
  }

  // Approved allocation rules v1.
  const { version } = await saveRuleDraft(prep, ps, {
    notes: "Initial policy — approved by the general manager",
    steps: [
      { method: "RECEIPT_TAX_COMPONENT", categoryId: al["AL-VAT"].id },
      { method: "PERCENT_OF_BASE", categoryId: al["AL-GREEN"].id, percent: "35" },
      { method: "PERCENT_OF_BASE", categoryId: al["AL-PACK"].id, percent: "5" },
      { method: "PERCENT_OF_BASE", categoryId: al["AL-OPS"].id, percent: "8" },
      { method: "PERCENT_OF_BASE", categoryId: al["AL-SHIP"].id, percent: "4" },
      { method: "PERCENT_OF_BASE", categoryId: al["AL-MKT"].id, percent: "3" },
      { method: "FILL_TARGET", categoryId: al["AL-SALARY"].id },
      { method: "FILL_TARGET", categoryId: al["AL-RENT"].id },
      { method: "FILL_TARGET", categoryId: al["AL-RESERVE"].id },
      { method: "LEAVE_UNALLOCATED" },
    ],
  });
  const rreq = await submitRuleVersion(prep, ps, version.id, "Initial allocation policy");
  await decideApproval(appr, as, rreq.id, { decision: "APPROVE", note: "Approved" });

  // Customers and orders to match receipts against.
  const c1 = await prisma.customer.create({ data: { name: "Riyadh Specialty Café", nameAr: "مقهى الرياض المختص" } });
  const c2 = await prisma.customer.create({ data: { name: "شركة بن الشرقية", nameAr: "شركة بن الشرقية" } });
  const orders: { id: string }[] = [];
  for (const [n, c] of [[1001, c1], [1002, c2], [1003, c1]] as const) {
    orders.push(await prisma.order.create({ data: { orderNumber: n, customerId: c.id, approvalStatus: "Yes", status: "Completed" } }));
  }

  const line = async (date: string, amount: string, desc: string, ref: string, account = snb.id) =>
    (await createManualTransaction(prep, ps, { cashAccountId: account, amount, txnDate: date, description: desc, bankReference: ref })).transaction;
  const review = (id: string, classification: string, splits: [string, string][], extra: Record<string, unknown> = {}) =>
    reviewTransaction(prep, ps, id, { classification, splits: splits.map(([c, a]) => ({ finCategoryId: fin[c], amount: a })), ...extra });

  // Rent on the 1st, paid from the rent envelope.
  const rent = await line(D(1), "-12000", "Rent — roastery September", "SO-0901");
  await review(rent.id, "RENT", [["PY-RENT", "-12000"]]);
  const rentRes = await createReservation(prep, ps, { categoryId: al["AL-RENT"].id, amount: "12000", payee: "العليا العقارية", purpose: "September rent" });
  await executeReservation(prep, ps, rentRes.reservation.id, { txnId: rent.id });

  // Receipts through the month, each allocated by the approved rules.
  const wholesale = async (d: number, amount: string, vat: string, order: number, ref: string, desc: string) => {
    const t = await line(D(d), amount, desc, ref);
    await addMatch(prep, ps, t.id, { targetType: "ORDER", targetId: orders[order].id, amount, taxAmount: vat });
    await review(t.id, "CUSTOMER_RECEIPT", [["RC-WHOLESALE", amount]]);
    await runAllocation(prep, ps, t.id);
    return t;
  };
  const settlement = async (d: number, cls: string, gross: string, fee: string, net: string, cat: string, ref: string, desc: string) => {
    const t = await line(D(d), net, desc, ref);
    await review(t.id, cls, [[cat, gross], ["PY-FEES", `-${fee}`]], { grossAmount: gross, feeAmount: fee });
    await runAllocation(prep, ps, t.id);
    return t;
  };
  await wholesale(3, "23000", "3000", 0, "IN-2231", "Transfer — Riyadh Specialty Café");
  await settlement(7, "POS_SETTLEMENT", "9850", "147.75", "9702.25", "RC-CAFE", "MADA-0907", "mada settlement 01–06 Sep");

  // Green coffee shipment: PO superseded by the supplier bill, paid via reservation.
  const [po] = await createObligation(prep, ps, { type: "PURCHASE_ORDER", description: "بن أخضر — إثيوبيا قوجي", counterparty: "هرر التجارية", amount: "26500", dueDate: D(9), allocationCategoryId: al["AL-GREEN"].id, finCategoryId: fin["PY-GREEN"] });
  const bill = await supersedeObligation(prep, ps, po.id, { amount: "26500", dueDate: D(9) });
  const greenRes = await createReservation(prep, ps, { categoryId: al["AL-GREEN"].id, amount: "26500", payee: "هرر التجارية", purpose: "Ethiopia Guji lot", obligationId: bill.id, dueDate: D(9) });
  const greenPay = await line(D(9), "-26500", "Harar Trading — invoice HT-5521", "OUT-5521");
  await review(greenPay.id, "SUPPLIER_PAYMENT", [["PY-GREEN", "-26500"]]);
  await executeReservation(prep, ps, greenRes.reservation.id, { txnId: greenPay.id });

  await settlement(10, "GATEWAY_SETTLEMENT", "6420", "160.50", "6259.50", "RC-ONLINE", "PAYTABS-0910", "Online store payout");
  const owner = await line(D(12), "20000", "Owner capital injection", "OWN-12");
  await review(owner.id, "OWNER_CONTRIBUTION", [["RC-OWNER", "20000"]]);

  const pack = await line(D(14), "-4380", "Gulf Packaging — bags & labels", "OUT-5588");
  await review(pack.id, "SUPPLIER_PAYMENT", [["PY-PACK", "-4380"]]);
  const packRes = await createReservation(prep, ps, { categoryId: al["AL-PACK"].id, amount: "1500", payee: "Gulf Packaging", purpose: "Bags (part)" });
  await executeReservation(prep, ps, packRes.reservation.id, { txnId: pack.id });

  await wholesale(15, "17250", "2250", 1, "IN-2260", "Eastern Beans — partial payment");
  const util = await line(D(18), "-2145", "SEC electricity — roastery", "SEC-0918");
  await review(util.id, "UTILITIES_OPERATING", [["PY-UTIL", "-2145"]]);
  const mkt = await line(D(20), "-3600", "Instagram campaign — new harvest", "ADS-0920");
  await review(mkt.id, "OTHER_OPERATING_PAYMENT", [["PY-MKT", "-3600"]]);
  await settlement(21, "POS_SETTLEMENT", "11300", "169.50", "11130.50", "RC-CAFE", "MADA-0921", "mada settlement 07–20 Sep");
  await createTransfer(prep, ps, { fromAccountId: snb.id, toAccountId: cash.id, amount: "1500", txnDate: D(22), description: "Petty cash top-up" });
  await wholesale(24, "8050", "1050", 2, "IN-2291", "Transfer — Riyadh Specialty Café");
  const fee = await line(D(25), "-85", "Monthly account fee", "FEE-0925");
  await review(fee.id, "BANK_FEE", [["PY-FEES", "-85"]]);

  // Café branch lines (branch-scoped).
  const cs = await resolveScope(cafeUser);
  const cafeLine = (await createManualTransaction(cafeUser, cs, { cashAccountId: cafeAcc.id, amount: "4200", txnDate: D(16), description: "Café cash deposit" })).transaction;
  await reviewTransaction(cafeUser, cs, cafeLine.id, { classification: "POS_SETTLEMENT", splits: [{ finCategoryId: fin["RC-CAFE"], amount: "4200" }] });

  // Reconcile SNB through the 20th at a zero difference.
  const pre = await previewReconciliation(ps, snb.id, D(20), "0");
  await saveReconciliation(prep, ps, { cashAccountId: snb.id, statementDate: D(20), statementBalance: fromMinor(pre.ledgerBalance), notes: "Statement 01–20 Sep" });

  // Statement import for the last days: one unknown deposit enters the review queue.
  await commitImport(prep, ps, {
    cashAccountId: snb.id, fileName: "snb-statement-26sep.csv",
    csv: `Date,Amount,Reference,Description\n${D(26)},2300.00,TRF88213,INCOMING TRANSFER 88213\n${D(26)},-450.00,POS-REF-77,CARD PURCHASE PENDING\n`,
    mapping: { date: "Date", amount: "Amount", reference: "Reference", description: "Description", dateFormat: "YYYY-MM-DD" },
  });
  const pendingLine = await prisma.bankTransaction.findFirstOrThrow({ where: { bankReference: "POS-REF-77" } });
  await prisma.bankTransaction.update({ where: { id: pendingLine.id }, data: { status: "PENDING" } });

  // Obligations ahead.
  await createObligation(prep, ps, { type: "PAYROLL", description: "الرواتب", amount: "38000", dueDate: D(28), allocationCategoryId: al["AL-SALARY"].id, finCategoryId: fin["PY-SALARY"], repeatMonths: 3 });
  await createObligation(prep, ps, { type: "RENT", description: "إيجار المحمصة", counterparty: "العليا العقارية", amount: "12000", dueDate: "2026-10-01", allocationCategoryId: al["AL-RENT"].id, finCategoryId: fin["PY-RENT"], repeatMonths: 3 });
  const [po2] = await createObligation(prep, ps, { type: "PURCHASE_ORDER", description: "بن أخضر — كولومبيا هويلا", counterparty: "أنديز لتصدير البن", amount: "31200", dueDate: "2026-10-05", allocationCategoryId: al["AL-GREEN"].id, finCategoryId: fin["PY-GREEN"] });
  await supersedeObligation(prep, ps, po2.id, { amount: "31200", dueDate: "2026-10-05" });
  await createObligation(prep, ps, { type: "TAX", description: "إقرار ضريبة القيمة المضافة — الربع الثالث", counterparty: "ZATCA", amount: "18400", dueDate: "2026-10-31", allocationCategoryId: al["AL-VAT"].id, finCategoryId: fin["PY-VAT"] });
  await createObligation(prep, ps, { type: "UTILITIES", description: "الكهرباء والمياه", amount: "2300", dueDate: "2026-10-10", allocationCategoryId: al["AL-OPS"].id, finCategoryId: fin["PY-UTIL"], repeatMonths: 3 });
  await createObligation(prep, ps, { type: "LOAN_REPAYMENT", description: "قسط قرض كفالة", counterparty: "SIDF", amount: "5000", dueDate: "2026-10-15", finCategoryId: fin["PY-LOAN"], repeatMonths: 3 });

  // Expected receipts (never cash until they arrive).
  await createForecastItem(prep, ps, { kind: "RECEIPT", description: "بن الشرقية — باقي الطلب #1002", counterparty: "شركة بن الشرقية", amount: "14500", expectedDate: D(30), finCategoryId: fin["RC-WHOLESALE"] });
  for (let w = 0; w < 13; w++) {
    const date = addDays("2026-09-28", w * 7);
    await createForecastItem(prep, ps, { kind: "RECEIPT", description: "مبيعات المقهى (أسبوعي)", amount: "5200", expectedDate: date, finCategoryId: fin["RC-CAFE"] });
    await createForecastItem(prep, ps, { kind: "RECEIPT", description: "المتجر الإلكتروني (أسبوعي)", amount: "2900", expectedDate: addDays(date, 2), finCategoryId: fin["RC-ONLINE"] });
    if (w % 2 === 1) await createForecastItem(prep, ps, { kind: "RECEIPT", description: "تحصيلات الجملة", amount: "16000", expectedDate: addDays(date, 3), finCategoryId: fin["RC-WHOLESALE"] });
  }
  await createForecastItem(prep, ps, { kind: "PAYMENT", description: "الشحن — أرامكس الشهري", amount: "1650", expectedDate: D(29), finCategoryId: fin["PY-SHIP"] });

  // September budget: approved, then revised for green coffee.
  const b = await createBudget(prep, ps, { month: M, title: "September 2026" });
  const lines = (green: string) => [
    { kind: "RECEIPT", finCategoryId: fin["RC-WHOLESALE"], plannedAmount: "52000", phasing: "CUSTOM_WEIGHTS", phasingWeights: { "5": 1, "15": 1, "25": 1 }, ownerEmployeeId: prep.id, assumptions: "Three wholesale accounts, one payment each per decade" },
    { kind: "RECEIPT", finCategoryId: fin["RC-CAFE"], plannedAmount: "30000", phasing: "STRAIGHT_LINE", assumptions: "≈1,000 SAR/day" },
    { kind: "RECEIPT", finCategoryId: fin["RC-ONLINE"], plannedAmount: "12000", phasing: "STRAIGHT_LINE" },
    { kind: "PAYMENT", finCategoryId: fin["PY-GREEN"], plannedAmount: green, dueDate: D(10), ownerEmployeeId: prep.id },
    { kind: "PAYMENT", finCategoryId: fin["PY-PACK"], plannedAmount: "4000", dueDate: D(15) },
    { kind: "PAYMENT", finCategoryId: fin["PY-SALARY"], plannedAmount: "38000", dueDate: D(28) },
    { kind: "PAYMENT", finCategoryId: fin["PY-RENT"], plannedAmount: "12000", dueDate: D(1) },
    { kind: "PAYMENT", finCategoryId: fin["PY-UTIL"], plannedAmount: "2500", dueDate: D(18) },
    { kind: "PAYMENT", finCategoryId: fin["PY-MKT"], plannedAmount: "2500", dueDate: D(20), ownerEmployeeId: prep.id },
    { kind: "PAYMENT", finCategoryId: fin["PY-FEES"], plannedAmount: "600", phasing: "STRAIGHT_LINE" },
    { kind: "PAYMENT", finCategoryId: fin["PY-SHIP"], plannedAmount: "1800", phasing: "STRAIGHT_LINE" },
    { kind: "SALES_MEMO", finCategoryId: fin["RC-WHOLESALE"], plannedAmount: "61000", assumptions: "Expected wholesale SALES (invoiced), not collections" },
  ];
  await saveDraftLines(prep, ps, b.id, { lines: lines("30000") });
  const b1 = await submitBudget(prep, ps, b.id, {});
  await decideApproval(appr, as, b1.id, { decision: "APPROVE", note: "Approved as presented" });
  await prisma.budgetRevision.updateMany({ where: { budgetId: b.id, revisionNo: 1 }, data: { reason: "Original budget" } });
  await startRevision(prep, ps, b.id, "ارتفاع أسعار البن الأخضر نحو 7% لدفعة قوجي");
  await saveDraftLines(prep, ps, b.id, { lines: lines("32000") });
  const b2 = await submitBudget(prep, ps, b.id, {});
  await decideApproval(appr, as, b2.id, { decision: "APPROVE", note: "Accepted — harvest pricing" });
  const mktKey = `PAYMENT:${fin["PY-MKT"]}:-`;
  await addVarianceNote(prep, ps, b.id, { lineKey: mktKey, explanation: "أُطلقت حملة المحصول الجديد قبل موعدها بأسبوع", correctiveAction: "تخفيض تسويق أكتوبر بمبلغ 1,100 ر.س", responsibleEmployeeId: prep.id, followUpDate: "2026-10-05" });
  await saveForecastSnapshot(prep, ps, b.id, D(26));

  // October budget awaiting approval, and a category transfer awaiting its approver.
  const oct = await createBudget(prep, ps, { month: "2026-10", startFrom: "COPY_PREVIOUS", title: "October 2026" });
  await submitBudget(prep, ps, oct.id, {});
  await requestCategoryTransfer(prep, ps, { fromCategoryId: al["AL-RESERVE"].id, toCategoryId: al["AL-GREEN"].id, amount: "5000", reason: "تعزيز البن الأخضر لشحنة كولومبيا" });

  console.log("Local finance fixture created. Logins: fin.manager, fin.approver, fin.cafe, fin.viewer, fin.manager.en, no.finance, legacy.admin, new.preparer, new.approver (password from FIN_FIXTURE_PASSWORD).");
}

main().then(async () => { await prisma.$disconnect(); process.exit(0); }).catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
