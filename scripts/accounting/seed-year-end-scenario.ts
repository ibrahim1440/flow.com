#!/usr/bin/env tsx
/**
 * LOCAL-ONLY synthetic scenario for the browser year-end close (tests/accounting/visual/year-end-forms.mjs).
 *
 * Runs only against the local disposable erp_finance_yearend database (same guard as the other
 * fixtures: loopback server on 54329, FIN_DISPOSABLE_DB=erp_finance_yearend, and the server-side
 * disposable marker), which scripts/accounting/local-year-end-browser.sh drops, recreates and
 * migrates first. All names and amounts are invented. Everything goes through the real services.
 *
 * The previous year Y (= this year − 1) and the next year Y+1 exist; every period of Y is LOCKED
 * (nothing else can post into it); the closing policy is approved (a SYNTHETIC approval for this
 * test database only — not a company decision); no fixed assets, no pending entries or events.
 *
 * Hand-calculated figures (SAR), all posted and approved by a second person:
 *   Y-01-10  Dr 1120 Bank 200,000.00            / Cr 3100 Capital 200,000.00
 *   Y-03-31  Dr 1120 345,000.00                 / Cr 4100 Sales 300,000.00 · Cr 4100 [branch YE-SYN] 45,000.00
 *   Y-05-31  Dr 4900 Returns 5,000.00           / Cr 1120 5,000.00
 *   Y-09-30  Dr 5100 COGS 150,000.00 · Dr 6100 Salaries 84,000.00 · Dr 6200 Rent 24,000.00 / Cr 1120 258,000.00
 *   Y-12-31  Dr 6200 Rent 2,000.00              / Cr 1120 2,000.00
 *   Y+1-01-15 Dr 1120 1,000.00                  / Cr 4100 1,000.00   (next-year activity; not closed)
 *   Net income Y = 345,000 − (5,000 + 150,000 + 84,000 + 26,000) = 80,000.00
 *
 *   FIN_DISPOSABLE_DB=erp_finance_yearend DATABASE_URL=<owner URL of erp_finance_yearend> \
 *     npx tsx scripts/accounting/seed-year-end-scenario.ts
 */
import { checkUrl, assertDisposableFinanceDb } from "../finance/local-db-guard.mjs";
const DB = "erp_finance_yearend";
const problems = checkUrl(process.env.DATABASE_URL, DB);
if (problems.length) { console.error(`Refusing: ${problems.join("; ")}.`); process.exit(1); }
const password = process.env.FIN_FIXTURE_PASSWORD;
if (!password || password.length < 12) { console.error("Set FIN_FIXTURE_PASSWORD (12+ characters) in the local .env first."); process.exit(1); }

import { hash } from "bcryptjs";
import { prisma } from "../../src/lib/db";
import { buildDefaultPermissions, MODULE_SUB_PRIVILEGES, type Permissions } from "../../src/lib/auth-shared";
import { applyChartTemplate, updateSettings } from "../../src/lib/accounting/setup-service";
import { createFiscalYear, lockFiscalPeriod } from "../../src/lib/accounting/fiscal-period-service";
import { createManualJournalEntry, submitJournalEntry, approveJournalEntry, postJournalEntry } from "../../src/lib/accounting/journal-service";
import { draftPolicy, approvePolicy } from "../../src/lib/accounting/policy-service";
import { accountingDate, todayAccountingDate } from "../../src/lib/accounting/dates";

const THIS = Number(todayAccountingDate().toISOString().slice(0, 4));
const Y = THIS - 1;
const D = (y: number, m: number, d: number) => accountingDate(`${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`);
const ALL = MODULE_SUB_PRIVILEGES.accounting.map((s) => s.key);
function perms(subs: string[]): Permissions {
  const p = buildDefaultPermissions("custom");
  p.dashboard = { access: "edit" };
  p.accounting = { access: "edit", sub: Object.fromEntries(ALL.map((k) => [k, subs.includes(k)])) };
  return p;
}
async function user(username: string, name: string, p: Permissions) {
  return (await prisma.employee.create({ data: { username, name, pin: "fixture-no-pin", role: "custom", permissions: JSON.stringify(p), password: await hash(password!, 10), preferredLanguage: "ar" } })).id;
}

async function main() {
  await assertDisposableFinanceDb({ url: process.env.DATABASE_URL, expectedDb: DB, query: (q: string) => prisma.$queryRawUnsafe(q) });
  if (await prisma.account.count()) { console.error("Refusing: the database is not freshly migrated (recreate it with local-year-end-browser.sh)."); process.exit(1); }
  const prep = await user("acc.preparer", "سارة القحطاني", perms(["journal_create", "journal_submit", "policy_prepare", "coa_manage", "settings_manage", "period_lock", "year_close_prepare"]));
  const appr = await user("acc.approver", "خالد العتيبي", perms(["journal_approve", "journal_post", "policy_approve", "period_lock", "period_close", "year_close_approve"]));
  await applyChartTemplate(prep);
  await createFiscalYear(Y, 1, prep);
  await createFiscalYear(THIS, 1, prep);
  await updateSettings({ ledgerCutoverDate: D(Y, 1, 1), setupComplete: true }, prep);
  const p = await draftPolicy("closing.year_end", {}, prep); await approvePolicy(p.id, appr);
  const acc = Object.fromEntries((await prisma.account.findMany()).map((a) => [a.code, a.id]));
  const branch = (await prisma.finBranch.create({ data: { code: "YE-SYN", nameEn: "Year-end branch (synthetic)", nameAr: "فرع تجريبي للإقفال" } })).id;
  const je = async (date: Date, description: string, lines: [string, string, string, string?][]) => {
    const e = await createManualJournalEntry({ entryDate: date, description, lines: lines.map(([code, debit, credit, branchId]) => ({ accountId: acc[code], debit, credit, branchId })) }, prep);
    await submitJournalEntry(e.id, prep); await approveJournalEntry(e.id, appr); await postJournalEntry(e.id, appr);
  };
  await je(D(Y, 1, 10), "SYNTHETIC رأس مال", [["1120", "200000", "0"], ["3100", "0", "200000"]]);
  await je(D(Y, 3, 31), "SYNTHETIC مبيعات", [["1120", "345000", "0"], ["4100", "0", "300000"], ["4100", "0", "45000", branch]]);
  await je(D(Y, 5, 31), "SYNTHETIC مردودات", [["4900", "5000", "0"], ["1120", "0", "5000"]]);
  await je(D(Y, 9, 30), "SYNTHETIC تكلفة ورواتب وإيجار", [["5100", "150000", "0"], ["6100", "84000", "0"], ["6200", "24000", "0"], ["1120", "0", "258000"]]);
  await je(D(Y, 12, 31), "SYNTHETIC إيجار ديسمبر", [["6200", "2000", "0"], ["1120", "0", "2000"]]);
  await je(D(THIS, 1, 15), "SYNTHETIC مبيعات السنة التالية", [["1120", "1000", "0"], ["4100", "0", "1000"]]);
  for (const per of await prisma.fiscalPeriod.findMany({ where: { year: Y }, orderBy: { periodNo: "asc" } })) await lockFiscalPeriod(per.id, appr);
  console.log(`Year-end scenario: year ${Y} (12 periods locked), next year ${THIS}; synthetic net income 80,000.00.`);
}
main().then(async () => { await prisma.$disconnect(); process.exit(0); }).catch(async (e) => { console.error(e instanceof Error ? e.message : e); await prisma.$disconnect(); process.exit(1); });
