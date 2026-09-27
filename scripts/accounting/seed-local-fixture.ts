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

const TABLES = ["AccountingEvent", "QoyodExportRecord", "JournalEntryLine", "JournalEntry", "FiscalPeriod", "AccountMapping", "AccountingPolicy", "Account", "AccountingSettings",
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
    await prisma.$executeRawUnsafe(`DELETE FROM "BankTransactionMatch" WHERE "transactionId" IN (SELECT t.id FROM "BankTransaction" t JOIN "CashAccount" c ON c.id = t."cashAccountId" WHERE c.code LIKE 'ACC-%')`);
    await prisma.$executeRawUnsafe(`UPDATE "BankTransaction" SET "transferPeerId" = NULL WHERE "cashAccountId" IN (SELECT id FROM "CashAccount" WHERE code LIKE 'ACC-%')`);
    // Bank lines are append-only (Finance trigger). On this verified disposable database the
    // guard is suspended for the fixture's own ACC- lines only, inside one transaction.
    await prisma.$transaction([
      prisma.$executeRawUnsafe(`ALTER TABLE "BankTransaction" DISABLE TRIGGER "BankTransaction_no_delete"`),
      prisma.$executeRawUnsafe(`DELETE FROM "BankTransaction" WHERE "cashAccountId" IN (SELECT id FROM "CashAccount" WHERE code LIKE 'ACC-%')`),
      prisma.$executeRawUnsafe(`ALTER TABLE "BankTransaction" ENABLE TRIGGER "BankTransaction_no_delete"`),
    ]);
    await prisma.$executeRawUnsafe(`DELETE FROM "CashAccount" WHERE code LIKE 'ACC-%'`);
    await prisma.$executeRawUnsafe(`ALTER TABLE "SupplierBill" DISABLE TRIGGER "SupplierBill_accounting_guard"`);
    await prisma.$executeRawUnsafe(`ALTER TABLE "SupplierBillLine" DISABLE TRIGGER "SupplierBillLine_accounting_guard"`);
    await prisma.$executeRawUnsafe(`TRUNCATE "SupplierBillLine", "SupplierBill" RESTART IDENTITY`);
    await prisma.$executeRawUnsafe(`ALTER TABLE "SupplierBill" ENABLE TRIGGER "SupplierBill_accounting_guard"`);
    await prisma.$executeRawUnsafe(`ALTER TABLE "SupplierBillLine" ENABLE TRIGGER "SupplierBillLine_accounting_guard"`);
    await prisma.$executeRawUnsafe(`DELETE FROM "FinObligation" WHERE description LIKE 'ACC-FIXTURE%' OR "sourceType" = 'SUPPLIER_BILL'`);
    await prisma.$executeRawUnsafe(`DELETE FROM "Supplier" WHERE contact = 'fixture:accounting'`);
    await prisma.$executeRawUnsafe(`UPDATE "FinCategory" SET "glAccountId" = NULL WHERE "glAccountId" IS NOT NULL`);
    await prisma.$executeRawUnsafe(`DELETE FROM "FinCategory" WHERE code LIKE 'ACC-%'`);
    await prisma.$executeRawUnsafe(`TRUNCATE ${TABLES.map((t) => `"${t}"`).join(", ")} RESTART IDENTITY CASCADE`);
    await prisma.$executeRawUnsafe(`DELETE FROM "FinAuditLog" WHERE "entityType" LIKE 'accounting.%'`).catch(() => undefined);
  }
  if (await prisma.account.count()) { console.log("Accounting fixture already present (use --reset)."); return; }

  const PREP = ["journal_create", "journal_submit", "policy_prepare", "coa_manage", "mapping_manage", "settings_manage", "events_process", "period_lock", "tax_category_manage", "export_view", "ap_bill_create"];
  const APPR = ["journal_approve", "journal_post", "journal_reverse", "policy_approve", "period_lock", "period_close", "unlock_period", "events_process", "ap_bill_approve", "ap_bill_post", "bank_posting_manage"];
  const prep = await user("acc.preparer", "سارة القحطاني", perms(PREP));
  const appr = await user("acc.approver", "خالد العتيبي", perms(APPR));
  await user("acc.approver.en", "Khalid Al-Otaibi (EN)", perms(APPR), "en");
  await user("acc.viewer", "نورة الشهري", perms("view"));
  await user("no.accounting", "موظف بلا صلاحية محاسبة", perms("none"));
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
  const bankRow = async (o: { acct?: string; day: number; amount: string; cls: string; ref: string; desc: string; splits?: [string, string][]; match?: [string, string] }) => {
    const t = await prisma.bankTransaction.create({ data: {
      cashAccountId: o.acct ?? bankAcc.id, branchKey: "COMPANY", txnDate: D(9, o.day), amount: new Prisma.Decimal(o.amount), status: "CONFIRMED",
      classification: o.cls as never, reviewStatus: "NEEDS_REVIEW", bankReference: o.ref, description: o.desc, createdBy: prep,
      splits: o.splits ? { create: o.splits.map(([c, a]) => ({ finCategoryId: c, amount: new Prisma.Decimal(a) })) } : undefined,
      matches: o.match ? { create: [{ targetType: "OBLIGATION", targetId: o.match[0], amount: new Prisma.Decimal(o.match[1]), createdBy: prep }] } : undefined,
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
  console.log(`Accounting fixture: ${await prisma.journalEntry.count()} entries, ${await prisma.accountingEvent.count()} events.`);
}

// Exit explicitly: the pg Pool behind the driver adapter keeps the event loop alive after $disconnect.
main().then(async () => { await prisma.$disconnect(); process.exit(0); }).catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
