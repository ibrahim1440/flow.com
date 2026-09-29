#!/usr/bin/env tsx
/**
 * LOCAL-ONLY synthetic fixture for the accounting screens (UI review, Figma parity, HTTP tests).
 *
 * Refuses to run unless DATABASE_URL is the local disposable erp_finance_dev database (same
 * guard as the finance fixture). All names and amounts are invented. Everything is created
 * through the real accounting services, so the fixture passes the same validation, four-eyes
 * and database guards as the application.
 *
 *   npx tsx --env-file=.env scripts/accounting/seed-local-fixture.ts --reset
 */
import { checkUrl, assertDisposableFinanceDb } from "../finance/local-db-guard.mjs";
import { isPreviewTarget, IDENTITY_SQL, identityProblems } from "./preview-target.mjs";
// Two permitted targets: the local disposable erp_finance_dev, or the one named Neon preview
// database (scripts/accounting/preview-target.mjs), which must also carry the disposable marker.
const previewMode = isPreviewTarget(process.env.DATABASE_URL);
if (!previewMode) {
  const problems = checkUrl(process.env.DATABASE_URL, "erp_finance_dev");
  if (problems.length) { console.error(`Refusing: ${problems.join("; ")}.`); process.exit(1); }
}
const password = process.env.FIN_FIXTURE_PASSWORD;
if (!password || password.length < 12) { console.error("Set FIN_FIXTURE_PASSWORD (12+ characters) in the local .env first."); process.exit(1); }

import { hash } from "bcryptjs";
import { prisma } from "../../src/lib/db";
import { Prisma } from "../../src/generated/prisma/client";
import { buildDefaultPermissions, MODULE_SUB_PRIVILEGES, type Permissions } from "../../src/lib/auth-shared";
import { applyChartTemplate, updateSettings } from "../../src/lib/accounting/setup-service";
import { createFiscalYear, lockFiscalPeriod, closeFiscalPeriod } from "../../src/lib/accounting/fiscal-period-service";
import { createManualJournalEntry, submitJournalEntry, approveJournalEntry, postJournalEntry, rejectJournalEntry, requestJournalReversal } from "../../src/lib/accounting/journal-service";
import { draftPolicy, approvePolicy, approveCommissionPlanVersion } from "../../src/lib/accounting/policy-service";
import { processPendingEvents } from "../../src/lib/accounting/event-processor";
import { requestBankCorrection, approveBankCorrection } from "../../src/lib/accounting/bank-correction-service";
import { accountingDate, todayAccountingDate } from "../../src/lib/accounting/dates";

const YEAR = Number(todayAccountingDate().toISOString().slice(0, 4));
const CURRENT_MONTH = todayAccountingDate().getUTCMonth() + 1;
const D = (m: number, d: number) => accountingDate(`${YEAR}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`);

const ALL = MODULE_SUB_PRIVILEGES.accounting.map((s) => s.key);
function perms(subs: string[] | "view" | "none"): Permissions {
  const p = buildDefaultPermissions("custom");
  p.dashboard = { access: "edit" };
  if (subs === "none") p.accounting = { access: "none" };
  else if (subs === "view") p.accounting = { access: "view", sub: Object.fromEntries(ALL.map((k) => [k, false])) };
  else p.accounting = { access: "edit", sub: Object.fromEntries(ALL.map((k) => [k, subs.includes(k)])) };
  return p;
}

async function user(username: string, name: string, p: Permissions, lang: "ar" | "en" = "ar") {
  const e = await prisma.employee.upsert({
    where: { username },
    update: { permissions: JSON.stringify(p), password: await hash(password!, 10), active: true, preferredLanguage: lang, role: "custom" },
    create: { username, name, pin: "fixture-no-pin", role: "custom", permissions: JSON.stringify(p), password: await hash(password!, 10), preferredLanguage: lang },
  });
  return e.id;
}

const TABLES = ["EInvoiceSubmission", "EInvoice", "EInvoiceJob", "EInvoiceProfile", "FaDepLine", "FaDepRun", "FaDisposal", "FaAssetSource", "FaAsset", "FaClassPolicy", "FaClass", "YearEndClose", "AccountingEvent", "QoyodExportRecord", "JournalEntryLine", "JournalEntry", "FiscalPeriod", "AccountMapping", "AccountingPolicy", "Account", "AccountingSettings",
  "CommissionLedgerCorrection", "CommissionLedgerEntry", "CommissionAccrual", "CommissionAssignment", "CommissionTier", "CommissionPlanVersion", "CommissionPlan"];

async function main() {
  if (previewMode) {
    // Server-reported identity (Neon project/branch/endpoint ids, database, marker) — not the URL.
    const [r] = await prisma.$queryRawUnsafe<Record<string, string | null>[]>(IDENTITY_SQL);
    const problems = identityProblems(r);
    if (problems.length) { console.error(`Refusing: ${problems.join("; ")}.`); process.exit(1); }
  } else {
    await assertDisposableFinanceDb({ url: process.env.DATABASE_URL, expectedDb: "erp_finance_dev", query: (q: string) => prisma.$queryRawUnsafe(q) });
  }
  if (process.argv.includes("--reset")) {
    // Stage-2 fixture rows share Finance tables, so they are removed by their ACC- tag only.
    // Bank lines are append-only and, once posted, immutable (Finance and accounting triggers).
    // On this verified disposable database those guards are suspended for the fixture's own ACC-
    // lines only, inside one transaction, and re-enabled before it commits.
    // Stage 4 cost subledger: accounting-owned tables whose guards are row triggers (TRUNCATE does
    // not fire them); then the synthetic operational records the fixture created (ACC- tags).
    await prisma.$executeRawUnsafe(`TRUNCATE "InvMove", "InvLayer", "InvDocLine", "InvDocument", "InvLossBand", "InvUnit", "InvItem", "InvLocation", "InvCosting", "InvOpsEvent", "InvCostPool", "CustomerReturnLine", "CustomerReturn", "ApCreditAllocation" RESTART IDENTITY CASCADE`);
    await prisma.$executeRawUnsafe(`DELETE FROM "InventoryMovement" WHERE notes LIKE 'fixture:accounting%' OR "sourceDocId" IN (SELECT id FROM "RoastingBatch" WHERE "batchNumber" LIKE 'ACC-%')`);
    // Operational rows the HTTP operational test made from the fixture's coffee (batches, lots, packing, deliveries).
    const fxProduct = `SELECT id FROM "CoffeeProduct" WHERE "productNameEn" LIKE '%(fixture)'`;
    const fxBatches = `SELECT id FROM "RoastingBatch" WHERE "productId" IN (${fxProduct}) OR "batchNumber" LIKE 'ACC-%'`;
    const fxLots = `SELECT id FROM "FinishedGoodsLot" WHERE "productId" IN (${fxProduct})`;
    await prisma.$executeRawUnsafe(`DELETE FROM "Delivery" WHERE "orderItemId" IN (SELECT i.id FROM "OrderItem" i JOIN "Order" o ON o.id = i."orderId" WHERE o.notes = 'fixture:accounting')`);
    await prisma.$executeRawUnsafe(`DELETE FROM "StockAllocation" WHERE "finishedGoodsLotId" IN (${fxLots})`);
    await prisma.$executeRawUnsafe(`DELETE FROM "PackagingSource" WHERE "roastingBatchId" IN (${fxBatches}) OR "finishedGoodsLotId" IN (${fxLots})`);
    await prisma.$executeRawUnsafe(`DELETE FROM "PackagingOperation" WHERE "batchId" IN (${fxBatches})`);
    await prisma.$executeRawUnsafe(`DELETE FROM "FinishedGoodsLot" WHERE id IN (${fxLots})`);
    await prisma.$executeRawUnsafe(`DELETE FROM "InventoryMovement" WHERE "sourceDocId" IN (${fxBatches}) OR "referenceEntityId" IN (SELECT id FROM "GreenBean" WHERE "serialNumber" LIKE 'ACC-%') OR "referenceEntityId" IN (SELECT id FROM "MaterialItem" WHERE code LIKE 'ACC-%')`);
    await prisma.$executeRawUnsafe(`DELETE FROM "RoastingBatch" WHERE id IN (${fxBatches})`);
    await prisma.$executeRawUnsafe(`DELETE FROM "PurchaseRecord" WHERE notes LIKE 'fixture:accounting%' OR "supplierId" IN (SELECT id FROM "Supplier" WHERE contact = 'fixture:accounting')`);
    await prisma.$executeRawUnsafe(`DELETE FROM "ProductSKU" WHERE "skuCode" LIKE 'ACC-%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM "CoffeeProduct" WHERE "productNameEn" LIKE '%(fixture)'`);
    await prisma.$executeRawUnsafe(`DELETE FROM "GreenBean" WHERE "serialNumber" LIKE 'ACC-%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM "MaterialItem" WHERE code LIKE 'ACC-%'`);
    const acc = `SELECT t.id FROM "BankTransaction" t JOIN "CashAccount" c ON c.id = t."cashAccountId" WHERE c.code LIKE 'ACC-%'`;
    // Stage 3 documents are accounting-owned tables (guarded like bills): cleared first, since
    // receipts reference the bank lines.
    const arGuards: [string, string][] = [["AdvanceApplication", "AdvanceApplication_accounting_guard"], ["ArAllocation", "ArAllocation_accounting_guard"], ["CustomerReceipt", "CustomerReceipt_accounting_guard"], ["SalesInvoiceLine", "SalesInvoiceLine_accounting_guard"], ["SalesInvoice", "SalesInvoice_accounting_guard"]];
    await prisma.$transaction([
      ...arGuards.map(([t, g]) => prisma.$executeRawUnsafe(`ALTER TABLE "${t}" DISABLE TRIGGER "${g}"`)),
      prisma.$executeRawUnsafe(`TRUNCATE "AdvanceApplication", "ArAllocation", "CustomerReceipt", "SalesInvoiceLine", "SalesInvoice" RESTART IDENTITY`),
      ...arGuards.map(([t, g]) => prisma.$executeRawUnsafe(`ALTER TABLE "${t}" ENABLE TRIGGER "${g}"`)),
    ]);
    const guards: [string, string][] = [["BankTransaction", "BankTransaction_no_delete"], ["BankTransaction", "BankTransaction_posted_guard"], ["BankTransactionSplit", "BankTransactionSplit_posted_guard"], ["BankTransactionMatch", "BankTransactionMatch_posted_guard"], ["BankCorrection", "BankCorrection_guard"]];
    await prisma.$transaction([
      ...guards.map(([t, g]) => prisma.$executeRawUnsafe(`ALTER TABLE "${t}" DISABLE TRIGGER "${g}"`)),
      prisma.$executeRawUnsafe(`DELETE FROM "BankCorrection" WHERE "transactionId" IN (${acc})`),
      prisma.$executeRawUnsafe(`DELETE FROM "BankTransactionMatch" WHERE "transactionId" IN (${acc})`),
      prisma.$executeRawUnsafe(`UPDATE "BankTransaction" SET "transferPeerId" = NULL, "replacesTransactionId" = NULL WHERE id IN (${acc})`),
      prisma.$executeRawUnsafe(`DELETE FROM "BankTransaction" WHERE id IN (${acc})`),
      ...guards.map(([t, g]) => prisma.$executeRawUnsafe(`ALTER TABLE "${t}" ENABLE TRIGGER "${g}"`)),
    ]);
    await prisma.$executeRawUnsafe(`DELETE FROM "CashAccount" WHERE code LIKE 'ACC-%'`);
    await prisma.$executeRawUnsafe(`ALTER TABLE "SupplierBill" DISABLE TRIGGER "SupplierBill_accounting_guard"`);
    await prisma.$executeRawUnsafe(`ALTER TABLE "SupplierBillLine" DISABLE TRIGGER "SupplierBillLine_accounting_guard"`);
    await prisma.$executeRawUnsafe(`TRUNCATE "SupplierBillLine", "SupplierBill" RESTART IDENTITY`);
    await prisma.$executeRawUnsafe(`ALTER TABLE "SupplierBill" ENABLE TRIGGER "SupplierBill_accounting_guard"`);
    await prisma.$executeRawUnsafe(`ALTER TABLE "SupplierBillLine" ENABLE TRIGGER "SupplierBillLine_accounting_guard"`);
    await prisma.$executeRawUnsafe(`DELETE FROM "FinObligation" WHERE description LIKE 'ACC-FIXTURE%' OR "sourceType" = 'SUPPLIER_BILL'`);
    await prisma.$executeRawUnsafe(`DELETE FROM "Supplier" WHERE contact = 'fixture:accounting'`);
    await prisma.$executeRawUnsafe(`DELETE FROM "SalesCollection" WHERE "idempotencyKey" LIKE 'acc-fixture-%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM "CollectionEvent" WHERE "externalRef" LIKE 'ACC-SC-%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM "Opportunity" WHERE title LIKE 'ACC-FIXTURE%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM "PipelineStage" WHERE code = 'ACC-WON' AND NOT EXISTS (SELECT 1 FROM "Opportunity" o WHERE o."stageId" = "PipelineStage".id)`);
    await prisma.$executeRawUnsafe(`DELETE FROM "Order" WHERE notes = 'fixture:accounting'`);
    await prisma.$executeRawUnsafe(`DELETE FROM "Customer" WHERE address = 'fixture:accounting'`);
    await prisma.$executeRawUnsafe(`UPDATE "FinCategory" SET "glAccountId" = NULL WHERE "glAccountId" IS NOT NULL`);
    await prisma.$executeRawUnsafe(`DELETE FROM "FinCategory" WHERE code LIKE 'ACC-%'`);
    await prisma.$executeRawUnsafe(`TRUNCATE ${TABLES.map((t) => `"${t}"`).join(", ")} RESTART IDENTITY CASCADE`);
    await prisma.$executeRawUnsafe(`DELETE FROM "FinAuditLog" WHERE "entityType" LIKE 'accounting.%'`).catch(() => undefined);
  }
  if (await prisma.account.count()) { console.log("Accounting fixture already present (use --reset)."); return; }

  const PREP = ["journal_create", "journal_submit", "policy_prepare", "coa_manage", "mapping_manage", "settings_manage", "events_process", "period_lock", "tax_category_manage", "export_view", "ap_bill_create", "bank_correction_request", "ar_invoice_create", "ar_receipt_assign", "inv_doc_create", "inv_master_manage", "fa_setup", "fa_prepare", "year_close_prepare", "einv_profile_prepare", "einv_generate", "einv_submit"];
  const APPR = ["journal_approve", "journal_post", "journal_reverse", "policy_approve", "period_lock", "period_close", "unlock_period", "events_process", "ap_bill_approve", "ap_bill_post", "bank_posting_manage", "bank_correction_approve", "ar_invoice_approve", "ar_invoice_post", "inv_doc_approve", "inv_doc_post", "fa_approve", "year_close_approve", "einv_profile_approve"];
  const prep = await user("acc.preparer", "سارة القحطاني", perms(PREP));
  const appr = await user("acc.approver", "خالد العتيبي", perms(APPR));
  await user("acc.approver.en", "Khalid Al-Otaibi (EN)", perms(APPR), "en");
  await user("acc.viewer", "نورة الشهري", perms("view"));
  // A Finance clerk (bank lines), to show that Finance cannot change a line once it has posted.
  const clerk = perms("none");
  clerk.finance = { access: "edit", sub: { txn_enter: true, all_branches: true } } as never;
  await user("acc.finclerk", "ريم — المالية (حركات البنك)", clerk);
  await user("no.accounting", "موظف بلا صلاحية محاسبة", perms("none"));
  // Warehouse: confirms customer returns arrived (with evidence); cannot prepare or approve them.
  const warehouse = await user("acc.warehouse", "ماجد — المستودع", perms(["inv_return_receive"]));
  // Operations staff (roasting, QC, packing, dispatch, purchasing) with no accounting access: their
  // screens create the inventory documents without anyone re-entering quantities.
  const opsPerms = buildDefaultPermissions("admin");
  opsPerms.accounting = { access: "none" }; opsPerms.finance = { access: "none" };
  await user("ops.roastery", "فيصل — التشغيل", opsPerms);
  await user("ops.roastery.en", "Faisal — operations (EN)", opsPerms, "en");
  const salesAdmin = await user("sales.plans", "مدير المبيعات", perms("none"));
  const rep1 = await user("rep.fahad", "فهد الدوسري", perms("none"));
  const rep2 = await user("rep.reem", "ريم الزهراني", perms("none"));

  const branch = await prisma.finBranch.upsert({ where: { code: "OLAYA" }, update: {}, create: { code: "OLAYA", nameEn: "Olaya roastery & café", nameAr: "محمصة ومقهى العليا" } });
  const cc = async (code: string, en: string, ar: string) => prisma.finCostCenter.upsert({ where: { code }, update: {}, create: { code, nameEn: en, nameAr: ar } });
  const roast = await cc("ROAST", "Roasting", "التحميص");
  const cafe = await cc("CAFE", "Café", "المقهى");
  const bakery = await cc("BAKERY", "Bakery", "المخبز");

  await applyChartTemplate(prep);
  await createFiscalYear(YEAR, 1, prep);
  await updateSettings({ ledgerCutoverDate: D(1, 1), setupComplete: true }, prep);
  const A = Object.fromEntries((await prisma.account.findMany()).map((a) => [a.code, a.id]));

  type L = [string, string, string, { cc?: string; desc?: string }?];
  const line = ([code, debit, credit, o]: L) => ({ accountId: A[code], debit, credit, description: o?.desc, branchId: branch.id, costCenterId: o?.cc ?? null });
  async function journal(date: Date, description: string, lines: L[], until: "DRAFT" | "SUBMITTED" | "APPROVED" | "POSTED" = "POSTED", type: "MANUAL" | "OPENING" | "ADJUSTMENT" = "MANUAL") {
    const e = await createManualJournalEntry({ entryDate: date, description, type, lines: lines.map(line) }, prep);
    if (until === "DRAFT") return e;
    await submitJournalEntry(e.id, prep);
    if (until === "SUBMITTED") return e;
    await approveJournalEntry(e.id, appr);
    if (until === "APPROVED") return e;
    return postJournalEntry(e.id, appr);
  }

  // Opening position at the cutover (synthetic).
  await journal(D(1, 1), "أرصدة افتتاحية في تاريخ التحول — بيانات تجريبية", [
    ["1120", "412500.00", "0"], ["1110", "8500.00", "0"], ["1210", "1234567.89", "0"], ["1220", "96000.00", "0"],
    ["1290", "0", "210000.00"], ["2130", "0", "18500.00"], ["3100", "0", "1000000.00"], ["3900", "0", "523067.89"],
  ], "POSTED", "OPENING");

  const cafeRev = [0, 84200, 79650, 91300, 88740, 95120, 72400, 69880, 101230, 97450, 0, 0, 0];
  for (let m = 1; m <= Math.min(CURRENT_MONTH, 9); m++) {
    const lastDay = new Date(Date.UTC(YEAR, m, 0)).getUTCDate();
    const net = cafeRev[m];
    const vat = (net * 0.15).toFixed(2);
    await journal(D(m, lastDay), `ملخص مبيعات المقهى لشهر ${m} (نقاط البيع) — بيانات تجريبية`, [
      ["1120", (net * 1.15).toFixed(2), "0"], ["4200", "0", net.toFixed(2), { cc: cafe.id }], ["2170", "0", vat],
    ]);
    await journal(D(m, 28), `رواتب شهر ${m}`, [["6100", "46500.00", "0", { cc: roast.id }], ["6100", "38250.00", "0", { cc: cafe.id }], ["6100", "21400.00", "0", { cc: bakery.id }], ["1120", "0", "106150.00"]]);
    if (m === 1) await journal(D(1, 2), "دفع إيجار ستة أشهر مقدماً (يناير – يونيو)", [["1150", "90000.00", "0"], ["1120", "0", "90000.00"]]);
    if (m <= 6) await journal(D(m, 5), `إطفاء إيجار مدفوع مقدماً — شهر ${m}`, [["6200", "15000.00", "0", { cc: cafe.id }], ["1150", "0", "15000.00"]]);
    else await journal(D(m, 5), `إيجار شهر ${m}`, [["6200", "15000.00", "0", { cc: cafe.id }], ["1120", "0", "15000.00"]]);
    await journal(D(m, 12), `فاتورة الكهرباء والمياه — شهر ${m}`, [["6300", (3100 + m * 87.35).toFixed(2), "0", { cc: roast.id }], ["1120", "0", (3100 + m * 87.35).toFixed(2)]]);
  }

  // Fixed assets (synthetic): a packing machine bought on credit and paid in two instalments, a
  // delivery van financed by a bank loan, and quarterly depreciation — non-cash items the
  // cash-flow statement must disclose rather than report as flows.
  await journal(D(2, 8), "آلة تعبئة بالتقسيط من المورد — بيانات تجريبية", [["1210", "64000.00", "0"], ["2195", "0", "64000.00"]]);
  await journal(D(3, 8), "القسط الأول لآلة التعبئة", [["2195", "24000.00", "0"], ["1120", "0", "24000.00"]]);
  await journal(D(5, 8), "القسط الثاني لآلة التعبئة", [["2195", "40000.00", "0"], ["1120", "0", "40000.00"]]);
  await journal(D(4, 15), "سيارة توصيل ممولة بقرض بنكي — بيانات تجريبية", [["1230", "118000.00", "0"], ["2220", "0", "118000.00"]]);
  await journal(D(6, 15), "سداد قسط القرض", [["2220", "9800.00", "0"], ["1120", "0", "9800.00"]]);
  for (const q of [3, 6]) await journal(D(q, 30), `إهلاك الربع ${q / 3}`, [["6600", "31250.00", "0"], ["1290", "0", "31250.00"]]);

  // A posted entry and its approved reversal.
  const wrong = await journal(D(3, 14), "صيانة آلة التحميص — قيدت بالخطأ على التسويق", [["6400", "4750.00", "0"], ["1120", "0", "4750.00"]]);
  const rv = await requestJournalReversal(wrong.id, prep, "الحساب الصحيح هو الصيانة وليس التسويق", D(3, 20));
  await approveJournalEntry(rv.id, appr);
  await postJournalEntry(rv.id, appr);
  await journal(D(3, 20), "صيانة آلة التحميص (تصحيح)", [["6700", "4750.00", "0", { cc: roast.id }], ["1120", "0", "4750.00"]]);

  const m = Math.min(CURRENT_MONTH, 9);
  // Work in progress, in every state the screens must show.
  await journal(D(m, 3), "شراء عدّة باريستا للمقهى: مطحنة إسبريسو، أباريق حليب، موازين دقيقة، وأدوات تنظيف — فاتورة المورد رقم INV-2026-0931 بانتظار المطابقة مع أمر الشراء والاستلام", [["6700", "12840.00", "0", { cc: cafe.id }], ["1160", "1926.00", "0"], ["1120", "0", "14766.00"]], "DRAFT");
  await journal(D(m, 4), "رسوم بنكية وعمولات نقاط البيع", [["6900", "1287.45", "0"], ["1120", "0", "1287.45"]], "SUBMITTED");
  await journal(D(m, 6), "حملة تسويق موسم الشتاء", [["6400", "8500.00", "0", { cc: cafe.id }], ["1120", "0", "8500.00"]], "SUBMITTED");
  await journal(D(m, 7), "أتعاب مراجعة القوائم المالية", [["6800", "18000.00", "0"], ["2130", "0", "18000.00"]], "APPROVED");
  const rej = await journal(D(m, 8), "مصروف توصيل طلبات الجملة", [["6500", "2150.00", "0"], ["1110", "0", "2150.00"]], "SUBMITTED");
  await rejectJournalEntry(rej.id, appr, "المبلغ لا يطابق فاتورة شركة الشحن (2,015.00)");

  // Commissions: approved policy, plan v1 approved for accounting, plan v2 still provisional.
  const pol = await draftPolicy("commissions.recognition", {}, prep);
  await approvePolicy(pol.id, appr);
  const plan = await prisma.commissionPlan.create({ data: { code: "WHOLESALE", name: "Wholesale sales", nameAr: "مبيعات الجملة", createdById: salesAdmin } });
  const v1 = await prisma.commissionPlanVersion.create({ data: { planId: plan.id, version: 1, baseRatePercent: new Prisma.Decimal("2.5"), effectiveFrom: new Date(`${YEAR}-01-01T00:00:00Z`), createdById: salesAdmin } });
  const v2 = await prisma.commissionPlanVersion.create({ data: { planId: plan.id, version: 2, baseRatePercent: new Prisma.Decimal("3"), effectiveFrom: new Date(`${YEAR}-${String(m).padStart(2, "0")}-01T00:00:00Z`), createdById: salesAdmin } });
  await approveCommissionPlanVersion(v1.id, appr);
  const move = (employeeId: string, type: "ACCRUAL" | "REVERSAL" | "ADJUSTMENT" | "PAYOUT", amount: string, pv: string | null, month: number, day: number, reason?: string) =>
    prisma.commissionLedgerEntry.create({ data: { type, employeeId, amount: new Prisma.Decimal(amount), planVersionId: pv, periodStart: new Date(Date.UTC(YEAR, month - 1, 1)), reason, createdAt: new Date(Date.UTC(YEAR, month - 1, day, 9)) } });
  await move(rep1, "ACCRUAL", "1875.00", v1.id, 4, 18);
  await move(rep2, "ACCRUAL", "2210.40", v1.id, 5, 9);
  await move(rep1, "ADJUSTMENT", "150.00", null, 5, 20, "تصحيح نسبة عمولة صفقة مشتركة");
  await move(rep1, "PAYOUT", "2025.00", null, 6, 1);
  await move(rep1, "REVERSAL", "-600.00", v1.id, 6, 15, "مرتجع بضاعة من العميل بعد صرف العمولة");
  await move(rep2, "ACCRUAL", "940.00", v2.id, m, 2); // plan v2 not approved → BLOCKED
  await processPendingEvents();

  // Periods: January–June closed, July locked, later months open.
  for (let p = 1; p <= Math.min(6, m - 2); p++) {
    const per = await prisma.fiscalPeriod.findFirstOrThrow({ where: { year: YEAR, periodNo: p } });
    await lockFiscalPeriod(per.id, appr);
    await closeFiscalPeriod(per.id, appr);
  }
  if (m >= 9) {
    const jul = await prisma.fiscalPeriod.findFirstOrThrow({ where: { year: YEAR, periodNo: 7 } });
    await lockFiscalPeriod(jul.id, appr);
  }

  // ─── Stage 2: payables and bank-to-ledger (synthetic; tagged ACC- / fixture:accounting) ───
  for (const key of ["payables.recognition", "bank.posting"]) { const pp = await draftPolicy(key, {}, prep); await approvePolicy(pp.id, appr); }
  const vat15 = await prisma.taxCategory.upsert({ where: { code: "VAT15" }, update: { isActive: true }, create: { code: "VAT15", nameEn: "Standard rate 15%", nameAr: "النسبة الأساسية 15%", rate: new Prisma.Decimal("15.00"), isDefault: true, zatcaTaxCategoryCode: "S" } });
  const zero = await prisma.taxCategory.upsert({ where: { code: "ZERO" }, update: { isActive: true }, create: { code: "ZERO", nameEn: "Zero-rated", nameAr: "خاضعة بنسبة صفر", rate: new Prisma.Decimal("0.00"), categoryType: "ZERO_RATED", zatcaTaxCategoryCode: "Z" } });
  const sup = async (name: string, vatNumber: string | null, terms = 30, crNumber: string | null = null) =>
    (await prisma.supplier.create({ data: { name, vatNumber, paymentTermsDays: terms, crNumber, contact: "fixture:accounting" } })).id;
  const S1 = await sup("محمصة الوادي للتوريد", "310245678900003", 30, "1010987654");
  const S2 = await sup("شركة التغليف الحديثة", "300987654300003", 30, "1010456789");
  const S3 = await sup("مؤسسة الألبان الطازجة", "311122233300003", 15);
  const S4 = await sup("شركة الكهرباء السعودية", "300000000000003", 21);
  const S5 = await sup("ورشة صيانة المكائن", null, 30);
  const bankAcc = await prisma.cashAccount.create({ data: { code: "ACC-BANK", nameEn: "Main bank account (synthetic)", nameAr: "الحساب البنكي الرئيسي (تجريبي)", type: "BANK", bankName: "بنك تجريبي", accountLast4: "0001", openingBalance: new Prisma.Decimal(0), openingBalanceDate: D(1, 1) } });
  const till = await prisma.cashAccount.create({ data: { code: "ACC-TILL", nameEn: "Café till", nameAr: "صندوق المقهى", type: "CASH", openingBalance: new Prisma.Decimal(0), openingBalanceDate: D(1, 1) } });
  const catRow = async (code: string, nameAr: string, kind: "PAYMENT" | "RECEIPT", gl: string | null) =>
    (await prisma.finCategory.create({ data: { code, nameEn: code, nameAr, kind, glAccountId: gl ? A[gl] : null } })).id;
  const C = {
    SUP: await catRow("ACC-SUPPLIERS", "مدفوعات الموردين", "PAYMENT", "2110"), FEES: await catRow("ACC-BANKFEES", "رسوم بنكية", "PAYMENT", "6900"),
    MKT: await catRow("ACC-MARKETING", "تسويق", "PAYMENT", null), SALES: await catRow("ACC-CAFE-SALES", "مبيعات المقهى", "RECEIPT", "4200"),
  };
  await prisma.cashAccount.update({ where: { id: bankAcc.id }, data: { glAccountId: A["1120"] } });
  await prisma.cashAccount.update({ where: { id: till.id }, data: { glAccountId: A["1110"] } });

  const { createBill, submitBill, approveBill, rejectBill, postBill } = await import("../../src/lib/accounting/payables-service");
  const bill = async (supplierId: string, inv: string, date: Date, lines: { kind?: "EXPENSE" | "STOCK_RECEIPT"; code?: string; d: string; q: string; p: string; vat?: boolean }[], until: "DRAFT" | "SUBMITTED" | "POSTED", po?: string) => {
    const b = await createBill({
      supplierId, supplierInvoiceNo: inv, billDate: date.toISOString().slice(0, 10), purchaseObligationId: po ?? null,
      lines: lines.map((l) => ({ kind: l.kind ?? "EXPENSE", accountId: l.code ? A[l.code] : undefined, description: l.d, quantity: l.q, unitPrice: l.p, taxCategoryId: l.vat === false ? zero.id : vat15.id })),
    }, prep);
    if (until === "DRAFT") return b;
    await submitBill(b.id, prep);
    if (until === "SUBMITTED") return b;
    await approveBill(b.id, appr);
    return (await postBill(b.id, appr)).bill;
  };
  const b1 = await bill(S5, "118", D(8, 20), [{ code: "6700", d: "صيانة مطحنة المقهى", q: "1", p: "900", vat: false }], "DRAFT");
  void b1;
  const bElec = await bill(S4, "300118876", D(8, 25), [{ code: "6300", d: "كهرباء المحمصة — أغسطس", q: "1", p: "3623.48" }], "POSTED");
  const bMilk = await bill(S3, "A-7710", D(8, 28), [{ code: "5100", d: "حليب طازج — 1,090 لتر", q: "1090", p: "2" }], "POSTED");
  const bPack = await bill(S2, "5521", D(9, 1), [{ kind: "STOCK_RECEIPT", d: "أكياس تغليف 1 كغ — 5,000 كيس", q: "5000", p: "0.65" }], "POSTED");
  const po = await prisma.finObligation.create({ data: { branchKey: "COMPANY", type: "PURCHASE_ORDER", description: "ACC-FIXTURE PO-2026-0412 · محمصة الوادي", counterparty: "محمصة الوادي للتوريد", amount: new Prisma.Decimal("11500.00"), dueDate: D(10, 3), sourceType: "MANUAL", createdBy: prep } });
  await bill(S1, "INV-88213", D(9, 3), [{ kind: "STOCK_RECEIPT", d: "بن إثيوبي جوجي 400 كغ", q: "400", p: "28.50" }, { code: "6500", d: "شحن من الميناء", q: "1", p: "1000" }], "SUBMITTED", po.id);
  const rj = await bill(S2, "5560", D(9, 10), [{ code: "6400", d: "ملصقات عرض", q: "200", p: "3.25" }], "SUBMITTED");
  await rejectBill(rj.id, appr, "الكمية لا تطابق إشعار الاستلام (180 وليس 200)");

  // Bank lines (Finance module rows). Posting to the ledger starts 15th of the month: earlier
  // cash movements stay with the manual journals above. The bank book is opened at the ledger's
  // cash balance on that day, so the reconciliation shows only real differences.
  const bankFrom = D(9, 15);
  const bal = async (code: string) => {
    const r = await prisma.journalEntryLine.aggregate({ where: { accountId: A[code], journalEntry: { status: { in: ["POSTED", "REVERSED"] }, entryDate: { lt: bankFrom } } }, _sum: { debit: true, credit: true } });
    return new Prisma.Decimal(r._sum.debit ?? 0).sub(new Prisma.Decimal(r._sum.credit ?? 0));
  };
  const dayBefore = new Date(bankFrom.getTime() - 86_400_000);
  await prisma.cashAccount.update({ where: { id: bankAcc.id }, data: { openingBalance: await bal("1120"), openingBalanceDate: dayBefore } });
  await prisma.cashAccount.update({ where: { id: till.id }, data: { openingBalance: await bal("1110"), openingBalanceDate: dayBefore } });
  await updateSettings({ bankPostingFrom: bankFrom }, appr);
  const ob = async (b: { obligationId: string | null }) => b.obligationId!;
  const bankRow = async (o: { acct?: string; day: number; amount: string; cls: string; ref: string; desc: string; splits?: [string, string][]; match?: [string, string, ("OBLIGATION" | "SALES_COLLECTION")?] }) => {
    const t = await prisma.bankTransaction.create({ data: {
      cashAccountId: o.acct ?? bankAcc.id, branchKey: "COMPANY", txnDate: D(9, o.day), amount: new Prisma.Decimal(o.amount), status: "CONFIRMED",
      classification: o.cls as never, reviewStatus: "NEEDS_REVIEW", bankReference: o.ref, description: o.desc, createdBy: prep,
      splits: o.splits ? { create: o.splits.map(([c, a]) => ({ finCategoryId: c, amount: new Prisma.Decimal(a) })) } : undefined,
      matches: o.match ? { create: [{ targetType: o.match[2] ?? "OBLIGATION", targetId: o.match[0], amount: new Prisma.Decimal(o.match[1]), createdBy: prep }] } : undefined,
    } });
    return t.id;
  };
  const review = (ids: string[]) => prisma.bankTransaction.updateMany({ where: { id: { in: ids } }, data: { reviewStatus: "REVIEWED", reviewedBy: appr, reviewedAt: new Date() } });
  const pMilk = await bankRow({ day: 16, amount: "-2507.00", cls: "SUPPLIER_PAYMENT", ref: "TRF-2291", desc: "سداد فاتورة الألبان A-7710", splits: [[C.SUP, "-2507.00"]], match: [await ob(bMilk), "2507.00"] });
  const pPack = await bankRow({ day: 18, amount: "-2000.00", cls: "SUPPLIER_PAYMENT", ref: "TRF-2297", desc: "دفعة جزئية — التغليف الحديثة 5521", splits: [[C.SUP, "-2000.00"]], match: [await ob(bPack), "2000.00"] });
  const fee = await bankRow({ day: 20, amount: "-45.50", cls: "BANK_FEE", ref: "FEE-0920", desc: "رسوم تحويلات", splits: [[C.FEES, "-45.50"]] });
  const unmatched = await bankRow({ day: 21, amount: "-600.00", cls: "SUPPLIER_PAYMENT", ref: "TRF-2304", desc: "دفعة لمورد بلا فاتورة مرحّلة", splits: [[C.SUP, "-600.00"]] });
  const mkt = await bankRow({ day: 22, amount: "-1200.00", cls: "OTHER_OPERATING_PAYMENT", ref: "CARD-7781", desc: "إعلانات ممولة", splits: [[C.MKT, "-1200.00"]] });
  const rcpt = await bankRow({ day: 23, amount: "4830.00", cls: "CUSTOMER_RECEIPT", ref: "DEP-5510", desc: "تحصيل عميل جملة", splits: [[C.SALES, "4830.00"]] });
  const tOut = await bankRow({ day: 24, amount: "-3000.00", cls: "INTERNAL_TRANSFER", ref: "TRF-2311", desc: "تعبئة صندوق المقهى" });
  const tIn = await bankRow({ acct: till.id, day: 24, amount: "3000.00", cls: "INTERNAL_TRANSFER", ref: "TRF-2311", desc: "تعبئة صندوق المقهى" });
  await prisma.bankTransaction.update({ where: { id: tOut }, data: { transferPeerId: tIn } });
  await prisma.bankTransaction.update({ where: { id: tIn }, data: { transferPeerId: tOut } });
  const needsReview = await bankRow({ day: 25, amount: "-310.00", cls: "UNCLASSIFIED", ref: "POS-REF-12", desc: "حركة غير مصنفة بعد" });
  void needsReview;
  await review([pMilk, pPack, fee, unmatched, mkt, rcpt, tOut, tIn]);
  void bElec;
  await processPendingEvents();

  // Corrections of posted bank lines (ACC-28): one applied (a bank fee keyed wrongly), one waiting.
  const feeCorr = await requestBankCorrection(fee, { kind: "REPLACE", reason: "الرسوم الصحيحة 40.50 حسب كشف البنك", replacement: { txnDate: `${YEAR}-09-20`, amount: "-40.50", classification: "BANK_FEE", splits: [{ finCategoryId: C.FEES, amount: "-40.50" }] } }, prep);
  await approveBankCorrection(feeCorr.id, appr);
  await requestBankCorrection(pPack, { kind: "REPLACE", reason: "الدفعة الفعلية 2,100 وليست 2,000", replacement: { txnDate: `${YEAR}-09-18`, amount: "-2100.00", classification: "SUPPLIER_PAYMENT", splits: [{ finCategoryId: C.SUP, amount: "-2100.00" }], matches: [{ targetType: "OBLIGATION", targetId: await ob(bPack), amount: "2100.00" }] } }, prep);
  await processPendingEvents();

  // ─── Stage 3: sales invoices, credit notes, customer receipts (synthetic; tagged fixture:accounting) ───
  // Recognition policy approved; the advances policy is prepared but not approved and decision D-2
  // (VAT on advances) is left undecided, so a receipt with an advance waits — the real state until
  // the accountant decides. Nothing here is a real customer, order or amount.
  const rp = await draftPolicy("receivables.recognition", {}, prep); await approvePolicy(rp.id, appr);
  await draftPolicy("receivables.advances", {}, prep);
  const { createSalesDoc, submitSalesDoc, approveSalesDoc, rejectSalesDoc, postSalesDoc, assignReceipt } = await import("../../src/lib/accounting/receivables-service");
  const cust = async (nameAr: string, name: string, vatNumber: string | null, terms: number, crNumber: string | null = null, creditLimit: string | null = null) =>
    (await prisma.customer.create({ data: { nameAr, name, vatNumber, crNumber, paymentTermsDays: terms, creditLimit: creditLimit ? new Prisma.Decimal(creditLimit) : null, address: "fixture:accounting" } })).id;
  const K1 = await cust("فندق الروضة", "Al-Rawda Hotel", "300445566700003", 30, "1010223344", "20000");
  const K2 = await cust("مطاعم البيت الشامي", "Al-Bait Al-Shami Restaurants", "310556677800003", 15, "1010334455", "10000");
  const K3 = await cust("مقاهي نجد المختصة", "Najd Specialty Cafés", "311667788900003", 30);
  const K4 = await cust("عميل أفراد — نقدي", "Walk-in customer", null, 0);
  // Stage 6 (LOCAL e-invoice validation only; nothing is sent to ZATCA): a SYNTHETIC seller profile,
  // approved by someone else, and a SYNTHETIC national address for one customer. K2 and K3 have no
  // address, so their standard invoices fail local validation and wait (shown in the tax screens).
  { const EI = await import("../../src/lib/accounting/einvoice/service");
    const pf = await EI.draftProfile({ sellerName: "شركة حقبة التجريبية (بيانات تجريبية)", sellerNameEn: "Hiqbah synthetic seller", vatNumber: "399999999900003", crNumber: "1010000000", street: "شارع تجريبي", buildingNo: "1234", district: "حي تجريبي", city: "الرياض", postalCode: "12345", countryCode: "SA", egsSerial: "EGS-LOCAL-01", environment: "LOCAL_ONLY" }, prep);
    await EI.approveProfile(pf.id, appr);
    await prisma.customer.update({ where: { id: K1 }, data: { nationalAddress: { street: "طريق تجريبي", buildingNo: "4321", district: "حي تجريبي", city: "جدة", postalCode: "23456", countryCode: "SA" } } }); }
  const order = async (orderNumber: number, customerId: string) => (await prisma.order.create({ data: { orderNumber, customerId, status: "Completed", approvalStatus: "Yes", notes: "fixture:accounting" } })).id;
  const O1 = await order(7009, K1);
  await order(7012, K2);
  type SL = { d: string; q: string; p: string; disc?: string; code?: string };
  const sdoc = async (customerId: string, issue: Date, lines: SL[], until: "DRAFT" | "SUBMITTED" | "APPROVED" | "POSTED" | "REJECTED", extra: { orderId?: string; kind?: "CREDIT_NOTE"; originalInvoiceId?: string; reason?: string; description?: string; creditType?: "PRICE_ADJUSTMENT" | "RETURN_OF_GOODS" } = {}) => {
    const d = await createSalesDoc({ customerId, issueDate: issue.toISOString().slice(0, 10), ...extra, lines: lines.map((l) => ({ description: l.d, quantity: l.q, unitPrice: l.p, discountPercent: l.disc ?? "0", accountId: l.code ? A[l.code] : undefined, taxCategoryId: vat15.id })) }, prep);
    if (until === "DRAFT") return d.id;
    await submitSalesDoc(d.id, prep);
    if (until === "SUBMITTED") return d.id;
    if (until === "REJECTED") { await rejectSalesDoc(d.id, appr, "سعر الكيلو لا يطابق عرض السعر المعتمد"); return d.id; }
    await approveSalesDoc(d.id, appr);
    if (until === "APPROVED") return d.id;
    await postSalesDoc(d.id, appr);
    return d.id;
  };
  const I1 = await sdoc(K1, D(9, 1), [{ d: "بن كولومبي محمص — 30 كغ", q: "30", p: "140" }], "POSTED", { orderId: O1, description: "توريد شهري للفندق" });
  await sdoc(K2, D(8, 28), [{ d: "خلطة إسبريسو البيت — 20 كغ", q: "20", p: "150" }, { d: "تدريب باريستا (جلسة)", q: "1", p: "200", code: "4200" }], "POSTED");
  const I3 = await sdoc(K3, D(9, 10), [{ d: "إثيوبي يرغاتشيفي محمص — 12 كغ", q: "12", p: "125", disc: "5" }], "POSTED");
  await sdoc(K3, D(9, 14), [{ d: "تعويض عن كيسين تالفين — 2 كغ", q: "2", p: "125", disc: "5" }], "POSTED", { kind: "CREDIT_NOTE", creditType: "PRICE_ADJUSTMENT", originalInvoiceId: I3, reason: "تلف في التغليف عند الاستلام — تعويض دون إرجاع البضاعة" });
  await sdoc(K1, D(9, 20), [{ d: "بن برازيلي محمص — 15 كغ", q: "15", p: "110" }], "SUBMITTED");
  await sdoc(K3, D(9, 21), [{ d: "أكواب ورقية مطبوعة — 1,000", q: "1000", p: "0.9", code: "4200" }], "APPROVED");
  await sdoc(K2, D(9, 15), [{ d: "خلطة إسبريسو البيت — 10 كغ", q: "10", p: "165" }], "REJECTED");
  await sdoc(K4, D(9, 22), [{ d: "بن مطحون — 2 كغ", q: "2", p: "95" }], "DRAFT");
  // A posted cash sale to a walk-in customer (no VAT number) → a SIMPLIFIED e-invoice, stamped with the local test key only.
  await sdoc(K4, D(9, 23), [{ d: "بن محمص للأفراد — 1 كغ", q: "1", p: "100" }], "POSTED");

  // Customer bank lines: DEP-5510 (above) pays INV for order 7009 in full; a line linked in Finance
  // to an approved sales collection (the collection names the customer and keeps its commission);
  // a line nobody has assigned; and a receipt that leaves an advance (waits for D-2).
  const stage = await prisma.pipelineStage.upsert({ where: { code: "ACC-WON" }, update: {}, create: { code: "ACC-WON", nameEn: "Won (fixture)", nameAr: "مكسوب (تجريبي)", position: 99 } });
  const opp = await prisma.opportunity.create({ data: { title: "ACC-FIXTURE توريد مطاعم البيت الشامي", customerId: K2, stageId: stage.id, ownerId: rep1 } });
  const ce = await prisma.collectionEvent.create({ data: { externalRef: "ACC-SC-0931", customerId: K2, opportunityId: opp.id, amountGross: new Prisma.Decimal("5000"), amountTax: new Prisma.Decimal("652.17"), collectedAt: new Date(`${YEAR}-09-26T09:00:00Z`) } });
  const coll = await prisma.salesCollection.create({ data: { collectionEventId: ce.id, opportunityId: opp.id, customerId: K2, idempotencyKey: "acc-fixture-sc-0931", referenceNumber: "SC-0931", amountGross: new Prisma.Decimal("5000"), amountTax: new Prisma.Decimal("652.17"), amountNet: new Prisma.Decimal("4347.83"), collectedAt: new Date(`${YEAR}-09-26T09:00:00Z`), submittedById: rep1, status: "APPROVED", decidedById: appr, decidedAt: new Date() } });
  const dep30 = await bankRow({ day: 26, amount: "5000.00", cls: "CUSTOMER_RECEIPT", ref: "DEP-5530", desc: "تحويل من مطاعم البيت الشامي", splits: [[C.SALES, "5000.00"]], match: [coll.id, "5000.00", "SALES_COLLECTION"] });
  const dep21 = await bankRow({ day: 22, amount: "1150.00", cls: "CUSTOMER_RECEIPT", ref: "DEP-5521", desc: "إيداع شيك", splits: [[C.SALES, "1150.00"]] });
  const dep40 = await bankRow({ day: 27, amount: "2300.00", cls: "CUSTOMER_RECEIPT", ref: "DEP-5540", desc: "تحويل مقاهي نجد المختصة", splits: [[C.SALES, "2300.00"]] });
  await review([dep30, dep21, dep40]);
  await assignReceipt(rcpt, { customerId: K1, allocations: [{ invoiceId: I1, amount: "4830.00" }] }, prep);
  const open3 = await prisma.salesInvoice.findUniqueOrThrow({ where: { id: I3 } });
  const cn3 = await prisma.arAllocation.aggregate({ where: { invoiceId: I3, active: true }, _sum: { amount: true } });
  await assignReceipt(dep40, { customerId: K3, allocations: [{ invoiceId: I3, amount: new Prisma.Decimal(open3.totalGross).sub(cn3._sum.amount ?? 0).toFixed(2) }] }, prep);
  await processPendingEvents();

  // ─── Stage 4: inventory and manufacturing costing (synthetic; the chain worked by hand in
  // tests/accounting/integration/inventory.test.ts, January–March, replayed
  // in August–September because the fixture closes January–June and locks July) ───
  // Decision D-1 is left UNDECIDED and the inventory.costing policy is prepared but not approved:
  // on this verified disposable database the documents post provisionally (weighted average
  // fallback, journals marked provisional), exactly as the product behaves before the accountant
  // decides. The loss bands (18% / 1% / 5%) are SYNTHETIC TEST ASSUMPTIONS, not company policy.
  await draftPolicy("inventory.costing", {}, prep);
  const inv = await import("../../src/lib/accounting/inventory-service");
  const provisionalBefore = process.env.ACCOUNTING_PROVISIONAL_POSTING;
  if (!previewMode) process.env.ACCOUNTING_PROVISIONAL_POSTING = "isolated-test";
  const gb = await prisma.greenBean.create({ data: { serialNumber: "ACC-ETH-YRG-0412", beanType: "Yirgacheffe", beanTypeAr: "يرغاتشيفي", country: "Ethiopia", countryAr: "إثيوبيا", quantityKg: 89.5 } });
  const cp = await prisma.coffeeProduct.create({ data: { productNameEn: "Ethiopia Yirgacheffe (fixture)", productNameAr: "إثيوبي يرغاتشيفي", countryEn: "Ethiopia" } });
  const sku = await prisma.productSKU.create({ data: { productId: cp.id, skuCode: "ACC-ETH-250", weightGrams: 250, price: 25 } });
  const bagMat = await prisma.materialItem.create({ data: { code: "ACC-BAG-250G", name: "250 g bag", nameAr: "كيس 250 غ", quantityOnHand: 700 } });
  // Bill of materials of the 250 g SKU: 0.25 kg of the roast and one bag per unit (packing draws the bag).
  await prisma.bomComponent.createMany({ data: [
    { productSkuId: sku.id, type: "ROASTED_COFFEE", coffeeProductId: cp.id, quantityPerUnit: 0.25, unitOfMeasure: "KG" },
    { productSkuId: sku.id, type: "MATERIAL", materialItemId: bagMat.id, quantityPerUnit: 1, unitOfMeasure: "PIECE" },
  ] });
  // A 500 g SKU whose accounting item exists but is NOT linked yet: packing it blocks until an
  // accountant links the item in inventory setup (browser test of recovery from a blocked posting).
  const sku500 = await prisma.productSKU.create({ data: { productId: cp.id, skuCode: "ACC-ETH-500", weightGrams: 500, price: 48 } });
  await prisma.bomComponent.createMany({ data: [
    { productSkuId: sku500.id, type: "ROASTED_COFFEE", coffeeProductId: cp.id, quantityPerUnit: 0.5, unitOfMeasure: "KG" },
    { productSkuId: sku500.id, type: "MATERIAL", materialItemId: bagMat.id, quantityPerUnit: 1, unitOfMeasure: "PIECE" },
  ] });
  const ship500 = await prisma.order.create({ data: { orderNumber: 7021, customerId: K1, status: "Ready for Shipping", approvalStatus: "Yes", notes: "fixture:accounting" } });
  await prisma.orderItem.create({ data: { orderId: ship500.id, beanTypeName: "إثيوبي يرغاتشيفي 500 غ", quantityKg: 1, quantityUnits: 2, productSkuId: sku500.id, productId: cp.id } });
  // An order line ready to ship (for the operational flow over HTTP: roast → QC → pack → dispatch → invoice).
  const shipOrder = await prisma.order.create({ data: { orderNumber: 7020, customerId: K1, status: "Ready for Shipping", approvalStatus: "Yes", notes: "fixture:accounting" } });
  await prisma.orderItem.create({ data: { orderId: shipOrder.id, beanTypeName: "إثيوبي يرغاتشيفي 250 غ", quantityKg: 2, quantityUnits: 8, productSkuId: sku.id, productId: cp.id } });
  const rst = await inv.createLocation({ code: "RST", name: "Roastery", nameAr: "المحمصة", isSalesDefault: true }, prep);
  const cafeLoc = await inv.createLocation({ code: "CAFE", name: "Café", nameAr: "المقهى" }, prep);
  const item = (code: string, nameAr: string, kind: string, baseUnit: string, extra: Record<string, unknown> = {}) => inv.createItem({ code, name: code, nameAr, kind, baseUnit, ...extra }, prep);
  const IT = {
    green: await item("GRN-ETH", "بن إثيوبي أخضر", "GREEN_COFFEE", "kg", { greenBeanId: gb.id }),
    roasted: await item("RST-ETH", "بن إثيوبي محمص", "ROASTED_COFFEE", "kg", { coffeeProductId: cp.id }),
    bag: await item("BAG-250", "كيس 250 غ", "PACKAGING", "piece", { units: [{ unit: "pack100", factor: "100" }], materialItemId: bagMat.id }),
    label: await item("LBL-ETH", "ملصق", "PACKAGING", "piece"),
    sku: await item("SKU-ETH-250", "إثيوبي 250 غ", "FINISHED_GOOD", "unit", { yieldPerUnit: "0.25", productSkuId: sku.id }),
    milk: await item("MILK", "حليب طازج", "MILK", "l", { units: [{ unit: "carton12", factor: "12" }] }),
    flour: await item("FLOUR", "دقيق", "BAKERY_INGREDIENT", "kg"),
    butter: await item("BUTTER", "زبدة", "BAKERY_INGREDIENT", "kg"),
    croissant: await item("CROISSANT", "كرواسون", "FINISHED_GOOD", "piece", { yieldPerUnit: "0.08" }),
    sku500: await item("SKU-ETH-500", "إثيوبي 500 غ", "FINISHED_GOOD", "unit", { yieldPerUnit: "0.5" }),   // not linked (see above)
  };
  const lband = async (code: string, nameAr: string, process: string, pct: string, approve = true) => {
    const b = await inv.createLossBand({ code, name: `${code} (synthetic test band)`, nameAr, process, maxLossPercent: pct }, prep);
    return approve ? (await inv.approveLossBand(b.id, appr)).id : b.id;
  };
  const LB = { roast: await lband("ROAST-SYN", "نطاق تحميص تجريبي للاختبار", "ROASTING", "18"), pack: await lband("PACK-SYN", "نطاق تعبئة تجريبي للاختبار", "PACKING", "1"), bake: await lband("BAKE-SYN", "نطاق خبز تجريبي للاختبار", "BAKING", "5") };
  await lband("DARK-SYN", "نطاق تحميص داكن تجريبي", "ROASTING", "20", false);
  const freight = await sup("شركة الشحن السريع", "300112233400003", 30);
  const idoc = async (input: Parameters<typeof inv.createInvDoc>[0], until: "DRAFT" | "SUBMITTED" | "POSTED" = "POSTED") => {
    const d = await inv.createInvDoc(input, prep);
    if (until === "DRAFT") return { id: d.id, lineIds: [] as string[] };
    await inv.submitInvDoc(d.id, prep);
    if (until === "SUBMITTED") return { id: d.id, lineIds: [] as string[] };
    await inv.approveInvDoc(d.id, appr);
    const r = await inv.postInvDoc(d.id, appr);
    return { id: d.id, lineIds: r.document.lines.map((l) => l.id) };
  };
  const ymd = (m: number, d: number) => D(m, d).toISOString().slice(0, 10);
  const R1 = await idoc({ type: "RECEIPT", docDate: ymd(8, 10), locationId: rst.id, supplierId: S1, description: "بن أخضر وتغليف — محمصة الوادي", lines: [
    { itemId: IT.green.id, quantity: "100", unitCost: "30" }, { itemId: IT.bag.id, quantity: "10", unit: "pack100", unitCost: "0.65" }, { itemId: IT.label.id, quantity: "1000", unitCost: "0.15" }] });
  const R2 = await idoc({ type: "RECEIPT", docDate: ymd(8, 12), locationId: rst.id, supplierId: S1, description: "بن أخضر — الشحنة الثانية", lines: [{ itemId: IT.green.id, quantity: "50", unitCost: "36" }] });
  await idoc({ type: "PRODUCTION", docDate: ymd(8, 20), locationId: rst.id, lossBandId: LB.roast, description: "تحميص إثيوبي — دفعة R-2026-014", lines: [{ role: "INPUT", itemId: IT.green.id, quantity: "60" }, { role: "OUTPUT", itemId: IT.roasted.id, quantity: "47" }] });
  const sbill = async (supplierId: string, no: string, date: Date, d: string, q: string, p: string) => {
    const b = await createBill({ supplierId, supplierInvoiceNo: no, billDate: date.toISOString().slice(0, 10), lines: [{ kind: "STOCK_RECEIPT", description: d, quantity: q, unitPrice: p, taxCategoryId: vat15.id }] }, prep);
    await submitBill(b.id, prep); await approveBill(b.id, appr); await postBill(b.id, appr);
    return (await prisma.supplierBillLine.findFirstOrThrow({ where: { billId: b.id } })).id;
  };
  const greenLine = await sbill(S1, "G-1", D(8, 22), "بن إثيوبي 100 كغ", "100", "31");
  const freightLine = await sbill(freight, "F-1", D(8, 22), "شحن من الميناء", "1", "480");
  await idoc({ type: "LANDED_COST", docDate: ymd(8, 25), locationId: rst.id, billLineId: freightLine, allocationBasis: "VALUE", description: "شحن من الميناء", lines: [{ itemId: IT.green.id, targetLineId: R1.lineIds[0] }, { itemId: IT.green.id, targetLineId: R2.lineIds[0] }] });
  await idoc({ type: "BILL_MATCH", docDate: ymd(8, 28), locationId: rst.id, billLineId: greenLine, lines: [{ itemId: IT.green.id, targetLineId: R1.lineIds[0] }] });
  await idoc({ type: "RECEIPT", docDate: ymd(9, 1), locationId: cafeLoc.id, supplierId: S3, description: "حليب ودقيق وزبدة للمقهى", lines: [
    { itemId: IT.milk.id, quantity: "3", unit: "carton12", unitCost: "5.50" }, { itemId: IT.flour.id, quantity: "25", unitCost: "4" }, { itemId: IT.butter.id, quantity: "5", unitCost: "40" }] });
  await idoc({ type: "PRODUCTION", docDate: ymd(9, 5), locationId: rst.id, lossBandId: LB.pack, description: "180 × 250 غ من 45.4 كغ محمص", lines: [
    { role: "INPUT", itemId: IT.roasted.id, quantity: "45.4" }, { role: "INPUT", itemId: IT.bag.id, quantity: "180" }, { role: "INPUT", itemId: IT.label.id, quantity: "180" }, { role: "OUTPUT", itemId: IT.sku.id, quantity: "180" }] });
  // The sale: posting the invoice issues its cost of sales (one system document per invoice).
  const sale = await createSalesDoc({ customerId: K1, issueDate: ymd(9, 10), description: "توريد إثيوبي 250 غ", lines: [{ productSkuId: sku.id, description: "إثيوبي 250 غ", quantity: "100", unitPrice: "25", taxCategoryId: vat15.id }] }, prep);
  await submitSalesDoc(sale.id, prep); await approveSalesDoc(sale.id, appr);
  const saleId = sale.id;
  await postSalesDoc(saleId, appr);
  // A physical return of 5 units: recorded, received by the warehouse with its evidence, approved
  // by a third person, posted at the cost the goods left at.
  const CR = await import("../../src/lib/accounting/customer-returns");
  const saleLine = (await prisma.salesInvoiceLine.findFirstOrThrow({ where: { invoiceId: saleId } })).id;
  const ret = await CR.createCustomerReturn({ invoiceId: saleId, locationId: rst.id, reason: "خمس عبوات زائدة عن الطلب", lines: [{ invoiceLineId: saleLine, quantity: "5" }] }, prep);
  await CR.receiveCustomerReturn(ret.id, { receivedOn: ymd(9, 12), evidenceRef: "GRN-RET-0001 (synthetic)" }, warehouse);
  await CR.approveCustomerReturn(ret.id, appr);
  await CR.postCustomerReturn(ret.id, appr);
  // A second return, received and waiting for approval (exception-free work queue).
  const ret2 = await CR.createCustomerReturn({ invoiceId: saleId, locationId: rst.id, reason: "عبوتان تالفتان عند الاستلام", lines: [{ invoiceLineId: saleLine, quantity: "2", condition: "DAMAGED" }] }, prep);
  await CR.receiveCustomerReturn(ret2.id, { receivedOn: ymd(9, 24), evidenceRef: "PHOTO-0917 (synthetic)" }, warehouse);
  await idoc({ type: "TRANSFER", docDate: ymd(9, 15), locationId: rst.id, toLocationId: cafeLoc.id, description: "بالتكلفة نفسها — بلا قيد", lines: [{ itemId: IT.sku.id, quantity: "10" }] });
  await idoc({ type: "ISSUE", issueReason: "INTERNAL_USE", docDate: ymd(9, 16), locationId: cafeLoc.id, description: "حليب للمشروبات", lines: [{ itemId: IT.milk.id, quantity: "30" }] });
  await idoc({ type: "ISSUE", issueReason: "SPOILAGE", docDate: ymd(9, 17), locationId: cafeLoc.id, description: "حليب منتهي الصلاحية", lines: [{ itemId: IT.milk.id, quantity: "2" }] });
  await idoc({ type: "PRODUCTION", docDate: ymd(9, 18), locationId: cafeLoc.id, lossBandId: LB.bake, description: "60 كرواسون — نطاق الخبز 5% (تجريبي)", lines: [
    { role: "INPUT", itemId: IT.flour.id, quantity: "4" }, { role: "INPUT", itemId: IT.butter.id, quantity: "1" }, { role: "INPUT", itemId: IT.milk.id, quantity: "1" }, { role: "OUTPUT", itemId: IT.croissant.id, quantity: "60" }] });
  await idoc({ type: "COUNT", docDate: ymd(9, 20), locationId: rst.id, reason: "جرد نهاية الربع", description: "جرد نهاية الربع — بن أخضر 89.5 كغ", lines: [{ itemId: IT.green.id, countedQty: "89.5" }] });
  const V1 = await idoc({ type: "SUPPLIER_RETURN", docDate: ymd(9, 22), locationId: rst.id, supplierId: S1, reason: "أكياس معيبة", description: "100 كيس معيب — محمصة الوادي", lines: [{ itemId: IT.bag.id, quantity: "100", targetLineId: R1.lineIds[1] }] });
  // The supplier's credit note for the returned bags settles the return (GRNI cleared).
  const greenBill = (await prisma.supplierBillLine.findUniqueOrThrow({ where: { id: greenLine } })).billId;
  const cnb = await createBill({ kind: "CREDIT_NOTE", originalBillId: greenBill, reason: "إشعار دائن عن 100 كيس معيب", supplierId: S1, supplierInvoiceNo: "CN-G-1", billDate: ymd(9, 25),
    lines: [{ kind: "STOCK_RETURN", description: "إرجاع 100 كيس معيب", quantity: "100", unitPrice: "0.65", taxCategoryId: vat15.id, invDocumentId: V1.id }] } as never, prep);
  await submitBill(cnb.id, prep); await approveBill(cnb.id, appr); await postBill(cnb.id, appr);
  await idoc({ type: "ISSUE", issueReason: "CALIBRATION", docDate: ymd(9, 23), locationId: rst.id, description: "بن محمص 1 كغ لمعايرة المحمصة", lines: [{ itemId: IT.roasted.id, quantity: "1" }] });
  // Operational records waiting to become documents: a roasting batch (draft, submitted) and a purchase (draft).
  const rb = await prisma.roastingBatch.create({ data: { batchNumber: "ACC-R-2026-118", greenBeanId: gb.id, productId: cp.id, greenBeanQuantity: 12, roastedBeanQuantity: 10.2, wasteQuantity: 0, date: D(9, 27) } });
  const pd = await inv.productionDraftFromRoastingBatch(rb.id, { locationId: rst.id, lossBandId: LB.roast, docDate: ymd(9, 27) }, prep);
  await inv.submitInvDoc(pd.id, prep);
  const pr = await prisma.purchaseRecord.create({ data: { supplierId: S1, type: "GREEN_BEAN", itemId: gb.id, quantity: 60, costPerUnit: 31.5, totalCost: 1890, purchaseDate: D(9, 27), notes: "fixture:accounting" } });
  await inv.receiptDraftFromPurchase(pr.id, { locationId: rst.id, docDate: ymd(9, 27) }, prep);
  await prisma.roastingBatch.create({ data: { batchNumber: "ACC-R-2026-121", greenBeanId: gb.id, productId: cp.id, greenBeanQuantity: 15, roastedBeanQuantity: 12.6, wasteQuantity: 0, date: D(9, 28) } });
  // Conversion cost pools — SYNTHETIC TEST ASSUMPTIONS (codes end -SYN), not company rates: an
  // approved roasting overhead pool absorbed per kg of roasted output, and a labour pool in draft.
  const CC = await import("../../src/lib/accounting/conversion-costs");
  const acct = async (code: string) => (await prisma.account.findUniqueOrThrow({ where: { code } })).id;
  const oh = await CC.createCostPool({ code: "ROAST-OH-SYN", name: "Roasting overhead (synthetic)", nameAr: "تكاليف تحميص غير مباشرة (تجريبي)", kind: "PRODUCTION_OVERHEAD", process: "ROASTING", basis: "PER_KG_OUTPUT", budgetAmount: "6000", normalCapacity: "12000", expenseAccountId: await acct("6700") }, prep);
  await CC.approveCostPool(oh.id, appr);
  await CC.createCostPool({ code: "ROAST-LAB-SYN", name: "Roasting labour (synthetic)", nameAr: "أجور تحميص مباشرة (تجريبي)", kind: "DIRECT_LABOUR", process: "ROASTING", basis: "PER_BATCH", budgetAmount: "9000", normalCapacity: "300", expenseAccountId: await acct("6100") }, prep);
  // Operational events as the operational routes record them. The inventory.operations policy is
  // left unapproved, so each prepared document waits for an accountant (HELD); a stock movement
  // written outside the integration is an exception (UNINTEGRATED).
  const OPS = await import("../../src/lib/accounting/ops-integration");
  const opsBuy = await prisma.$transaction(async (tx) => {
    const p = await tx.purchaseRecord.create({ data: { supplierId: S1, type: "GREEN_BEAN", itemId: gb.id, quantity: 20, costPerUnit: 32, totalCost: 640, purchaseDate: D(9, 26), notes: "fixture:accounting" } });
    await tx.inventoryMovement.create({ data: { type: "IN", category: "RAW_MATERIAL", referenceEntityId: gb.id, quantityChanged: 20, previousQuantity: 89.5, newQuantity: 109.5, sourceDocType: "PURCHASE", sourceDocId: p.id, notes: "fixture:accounting" } });
    return OPS.recordStockEvent(tx, { kind: "PURCHASE", sourceId: p.id, occurredOn: D(9, 26), payload: { purchaseId: p.id, greenBeanId: gb.id, quantity: 20, costPerUnit: 32, supplierId: S1 } });
  });
  await OPS.processOpsEvent(opsBuy.id);
  await prisma.inventoryMovement.create({ data: { type: "ADJUSTMENT", category: "PACKAGING_MATERIAL", referenceEntityId: bagMat.id, quantityChanged: -12, previousQuantity: 700, newQuantity: 688, sourceDocType: "MANUAL_ADJUSTMENT", notes: "fixture:accounting — written by a script outside the integration" } });
  await prisma.materialItem.update({ where: { id: bagMat.id }, data: { quantityOnHand: 688 } });
  // ─── Stage 5: fixed assets (SYNTHETIC classes, lives and rates — codes end -SYN; not company policy) ───
  const FA = await import("../../src/lib/accounting/fixed-assets-service");
  { const fp = await draftPolicy("fixed_assets.depreciation", {}, prep); await approvePolicy(fp.id, appr); }
  const faClass = async (code: string, name: string, nameAr: string, cost: string, pol: Record<string, unknown>, approve = true) => {
    const c = await FA.createClass({ code, name, nameAr, costAccountId: A[cost], accumAccountId: A["1290"], expenseAccountId: A["6600"] }, prep);
    const v = await FA.draftClassPolicy(c.id, { ...pol, note: "SYNTHETIC TEST ASSUMPTION" }, prep);
    if (approve) await FA.approveClassPolicy(v.id, appr);
    return c.id;
  };
  const mach = await faClass("MACH-SYN", "Machinery (synthetic)", "آلات ومعدات (تجريبي)", "1210", { method: "STRAIGHT_LINE", usefulLifeMonths: 60, residualPercent: "0", startConvention: "IN_SERVICE_MONTH", disposalConvention: "NONE", capitalisationThreshold: "1000" });
  const veh = await faClass("VEH-SYN", "Vehicles (synthetic)", "سيارات (تجريبي)", "1230", { method: "STRAIGHT_LINE", usefulLifeMonths: 60, residualPercent: "0", startConvention: "NEXT_MONTH", disposalConvention: "NONE", capitalisationThreshold: "1000" });
  await faClass("FURN-SYN", "Furniture and fit-out (synthetic)", "أثاث وتجهيزات (تجريبي)", "1220", { method: "DECLINING_BALANCE", usefulLifeMonths: 84, residualPercent: "5", decliningFactor: "2", startConvention: "NEXT_MONTH", disposalConvention: "FULL_MONTH", capitalisationThreshold: "1000" }, false);
  const eqSup = await sup("مؤسسة المعدات (تجريبي)", "310555666700003", 30);
  const eqBill = await createBill({ supplierId: eqSup, supplierInvoiceNo: "EQ-12", billDate: ymd(8, 5), lines: [
    { kind: "EXPENSE", accountId: A["1210"], description: "مطحنة تجارية", quantity: "1", unitPrice: "18500", taxCategoryId: vat15.id },
    { kind: "EXPENSE", accountId: A["1210"], description: "قطع غيار", quantity: "1", unitPrice: "3600", taxCategoryId: vat15.id },
  ] } as never, prep);
  await submitBill(eqBill.id, prep); await approveBill(eqBill.id, appr); await postBill(eqBill.id, appr);
  const eqLine = (await prisma.supplierBillLine.findFirstOrThrow({ where: { billId: eqBill.id, lineNo: 1 } })).id;
  const asset = async (b: Record<string, unknown>, until: "DRAFT" | "SUBMITTED" | "CAPITALISED") => {
    const a = await FA.saveAsset(b, prep);
    if (until !== "DRAFT") await FA.submitAsset(a.id, prep);
    if (until === "CAPITALISED") await FA.capitaliseAsset(a.id, appr);
    return a.id;
  };
  await asset({ name: "محمصة 12 كغ (تجريبي)", classId: mach, inServiceDate: ymd(1, 1), usefulLifeMonths: 60, residualValue: "12000", deviationReason: "SYNTHETIC: residual value of the roaster", sources: [{ kind: "ACCOUNT", counterAccountId: A["2195"], amount: "120000", description: "فاتورة المحمصة (تجريبي)" }] }, "CAPITALISED");
  await asset({ name: "مطحنة تجارية (تجريبي)", classId: mach, inServiceDate: ymd(8, 5), sources: [{ kind: "BILL_LINE", billLineId: eqLine }] }, "CAPITALISED");
  await asset({ name: "سيارة توصيل (تجريبي)", classId: veh, inServiceDate: ymd(1, 15), sources: [{ kind: "ACCOUNT", counterAccountId: A["2195"], amount: "95000", description: "سيارة توصيل (تجريبي)" }] }, "CAPITALISED");
  await asset({ name: "ماكينة إسبريسو (تجريبي)", classId: mach, inServiceDate: ymd(7, 1), usefulLifeMonths: 48, deviationReason: "SYNTHETIC: heavy café use", sources: [{ kind: "ACCOUNT", counterAccountId: A["2195"], amount: "42000", description: "تركيب وتشغيل (تجريبي)" }] }, "SUBMITTED");
  // Monthly runs for past open months (a locked month is caught up by the next run, as the service does).
  for (let mm = 1; mm < m; mm++) {
    const per = await prisma.fiscalPeriod.findFirstOrThrow({ where: { year: YEAR, periodNo: mm } });
    if (per.status !== "OPEN") continue;
    const r = await FA.createRun(per.id, prep).catch(() => null);
    if (r) await FA.approveRun(r.id, appr);
  }
  if (provisionalBefore === undefined) delete process.env.ACCOUNTING_PROVISIONAL_POSTING; else process.env.ACCOUNTING_PROVISIONAL_POSTING = provisionalBefore;
  await processPendingEvents();
  console.log(`Accounting fixture: ${await prisma.journalEntry.count()} entries, ${await prisma.accountingEvent.count()} events.`);
}

// Exit explicitly: the pg Pool behind the driver adapter keeps the event loop alive after $disconnect.
main().then(async () => { await prisma.$disconnect(); process.exit(0); }).catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
