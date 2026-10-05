// Browser proof of the year-end close (Figma ACC-65) on the ISOLATED synthetic scenario of
// scripts/accounting/seed-year-end-scenario.ts, through the real page, as the preparer and a
// second person. Run it with scripts/accounting/local-year-end-browser.sh (disposable database
// erp_finance_yearend, server as the restricted runtime role). Refuses any other database.
//
// Hand-calculated expectations (SAR; see the scenario for the postings):
//   net income Y = 345,000 − 5,000 − 150,000 − 84,000 − 26,000 = 80,000.00
//   closing entry (CLOSING, Y-12-31, period 12 LOCKED):
//     Dr 4100 300,000 · Dr 4100 [branch] 45,000 / Cr 4900 5,000 · Cr 5100 150,000 · Cr 6100 84,000
//     · Cr 6200 26,000 · Cr 3200 80,000            (both sides 345,000)
//   retained earnings 3200 at Y-12-31: 80,000 credit; current earnings 0
//   opening Y+1: 1120 = 200,000 + 345,000 − 5,000 − 258,000 − 2,000 = 280,000 Dr; 3100 200,000 Cr;
//     3200 80,000 Cr; every revenue and expense account 0 (the Y+1 sale of 1,000 is Y+1 activity)
//
//   BASE_URL=http://localhost:3041 FIN_PASSWORD=... RUNTIME_DATABASE_URL=... node tests/accounting/visual/year-end-forms.mjs [shotsDir]
import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";

const BASE = process.env.BASE_URL ?? "http://localhost:3041";
if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(BASE)) throw new Error("Refusing to run against a non-local server.");
const DB_URL = process.env.RUNTIME_DATABASE_URL;
if (!DB_URL || !/@(127\.0\.0\.1|localhost):\d+\/erp_finance_yearend(\?|$)/.test(DB_URL)) throw new Error("RUNTIME_DATABASE_URL must be the local disposable erp_finance_yearend database.");
const out = process.argv[2]; if (out) mkdirSync(out, { recursive: true });
const { Client } = createRequire(import.meta.url)("pg");
const db = new Client({ connectionString: DB_URL }); await db.connect();
const one = async (sql, args = []) => (await db.query(sql, args)).rows[0];
assert.equal((await one("select current_database() d")).d, "erp_finance_yearend");
const THIS = new Date(Date.now() + 3 * 3600_000).getUTCFullYear();
const Y = THIS - 1;

const EXPECTED_CLOSING = ["3200:0.00:80000.00", "4100:300000.00:0.00", "4100@B:45000.00:0.00", "4900:0.00:5000.00", "5100:0.00:150000.00", "6100:0.00:84000.00", "6200:0.00:26000.00"];
const EXPECTED_OPENING = { "1120": "280000.00", "3100": "-200000.00", "3200": "-80000.00" };

const browser = await chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
const results = [];
const ok = (m) => { results.push(m); console.log(`ok - ${m}`); };
async function session(user) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "ar-SA" });
  const page = await ctx.newPage();
  const errors = []; page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(`${BASE}/login`);
  const st = await page.evaluate(async ([u, p]) => (await fetch("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ method: "password", username: u, password: p }) })).status, [user, process.env.FIN_PASSWORD]);
  if (st !== 200) throw new Error(`login ${user}: ${st}`);
  return { ctx, page, errors };
}
const shot = async (page, name) => { if (out) await page.screenshot({ path: `${out}/${name}.png`, fullPage: true }); };
const go = async (page, path) => { await page.goto(`${BASE}${path}`); await page.waitForLoadState("networkidle"); };
const openYear = async (page) => {
  await go(page, "/dashboard/accounting/periods/year-end");
  await page.locator('select[aria-label="السنة المالية"]').selectOption(String(Y));
  await page.getByRole("heading", { name: `إقفال السنة المالية ${Y}` }).or(page.getByText(`إقفال السنة المالية ${Y}`)).first().waitFor();
  await page.waitForLoadState("networkidle");
};
const fmt = (n) => Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

try {
  const prep = await session("acc.preparer");
  const appr = await session("acc.approver");
  const P = prep.page, A = appr.page;

  // 1. Preparer: every condition met; the computed closing entry shows the hand-calculated figures.
  await openYear(P);
  for (const code of ["PERIODS_OPEN", "PENDING_ENTRIES", "WAITING_EVENTS", "DEPRECIATION_MISSING", "PREVIOUS_OPEN", "NO_NEXT_YEAR", "NOT_ENDED"]) {
    await P.getByTestId(`check-${code}`).getByText("✓ متحقق").waitFor({ timeout: 10000 });
  }
  const preview = await P.evaluate(async (y) => (await fetch(`/api/accounting/year-end?year=${y}`)).json(), Y);
  assert.deepEqual(preview.blockers, []);
  assert.equal(preview.netIncome, "80000.00");
  assert.deepEqual(preview.preview.map((l) => `${l.code}${l.branchId ? "@B" : ""}:${l.net}`), ["4100:-300000.00", "4100@B:-45000.00", "4900:5000.00", "5100:150000.00", "6100:84000.00", "6200:26000.00"]);
  await P.getByText(fmt(80000)).first().waitFor();
  await shot(P, "ACC-65-ye-ready");
  ok(`year ${Y}: all seven conditions met in the page; computed closing entry = hand figures (net income 80,000.00; 4100 by branch, 4900, 5100, 6100, 6200)`);

  // 2. Preparer prepares through the form; they cannot approve their own close.
  const prepareBtn = P.getByRole("button", { name: "إعداد الإقفال" });
  assert.ok(await prepareBtn.isEnabled());
  await prepareBtn.click();
  await P.getByText("أُعدّ الإقفال؛ بانتظار اعتماد شخص آخر.").waitFor({ timeout: 15000 });
  await P.getByText("أنت أعددت الإقفال؛ يعتمده شخص آخر.").waitFor();
  assert.equal(await P.getByRole("button", { name: "اعتماد وترحيل الإقفال" }).count(), 0, "no approve button for the preparer");
  const c = await one(`select id, status, "netIncome"::text n, "preparedBy" from "YearEndClose" where year = $1`, [Y]);
  assert.deepEqual([c.status, Number(c.n).toFixed(2)], ["DRAFT", "80000.00"]);
  const self = await P.evaluate(async (id) => (await fetch(`/api/accounting/year-end/${id}/approve`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).status, c.id);
  assert.equal(self, 403, "the preparer's own approval is refused by the server too");
  assert.equal((await one(`select count(*)::int n from "JournalEntry" where type = 'CLOSING'`)).n, 0, "nothing posted yet");
  await shot(P, "ACC-65-ye-prepared");
  ok("close prepared in the form by the preparer (DRAFT, 80,000.00); no approve button for them and the server refuses their approval (403); nothing posted");

  // 3. Second person approves and posts through the form.
  await openYear(A);
  await A.getByRole("button", { name: "اعتماد وترحيل الإقفال" }).click();
  await A.getByText("اعتُمد الإقفال ورُحّل.").waitFor({ timeout: 20000 });
  await A.getByText("كل حسابات الإيرادات والمصروفات صفر في بداية السنة التالية · حسابات الميزانية = أرصدة نهاية السنة").waitFor({ timeout: 15000 });
  for (const v of ["280,000.00", "200,000.00", "80,000.00"]) await A.getByText(v, { exact: false }).first().waitFor();
  await shot(A, "ACC-65-ye-posted-opening");

  // 4. The ledger: one CLOSING entry dated Y-12-31 in the locked period 12, lines = hand figures.
  const closed = await one(`select status, "approvedBy" from "YearEndClose" where id = $1`, [c.id]);
  assert.equal(closed.status, "POSTED");
  assert.notEqual(closed.approvedBy, c.preparedBy);
  const ev = await one(`select status, "journalEntryId" from "AccountingEvent" where "idempotencyKey" = $1`, [`closing:${c.id}:gl.year.closed:1`]);
  assert.equal(ev.status, "TRANSLATED");
  const e = await one(`select e.type::text t, to_char(e."entryDate", 'YYYY-MM-DD') d, p."periodNo" pn, p.year, p.status::text ps from "JournalEntry" e join "FiscalPeriod" p on p.id = e."fiscalPeriodId" where e.id = $1`, [ev.journalEntryId]);
  assert.deepEqual([e.t, e.d, e.pn, e.year, e.ps], ["CLOSING", `${Y}-12-31`, 12, Y, "LOCKED"]);
  const lines = (await db.query(`select a.code, l."branchId" b, l.debit::text d, l.credit::text c from "JournalEntryLine" l join "Account" a on a.id = l."accountId" where l."journalEntryId" = $1`, [ev.journalEntryId])).rows
    .map((r) => `${r.code}${r.b ? "@B" : ""}:${Number(r.d).toFixed(2)}:${Number(r.c).toFixed(2)}`).sort();
  assert.deepEqual(lines, EXPECTED_CLOSING);
  assert.equal((await one(`select count(*)::int n from "JournalEntry" where type = 'CLOSING'`)).n, 1);
  ok(`approved and posted by the second person: one CLOSING entry dated ${Y}-12-31 in the LOCKED period 12; lines equal the hand-calculated entry (345,000.00 each side, Cr 3200 80,000.00)`);

  // 5. Retained earnings, statements and next-year opening balances.
  const re = await one(`select coalesce(sum(l.debit - l.credit), 0)::text n from "JournalEntryLine" l join "JournalEntry" e on e.id = l."journalEntryId" join "Account" a on a.id = l."accountId" where a.code = '3200' and e.status in ('POSTED','REVERSED') and e."entryDate" <= $1`, [`${Y}-12-31`]);
  assert.equal(Number(re.n).toFixed(2), "-80000.00");
  const api = async (path) => A.evaluate(async (p) => (await fetch(p)).json(), path);
  const is = await api(`/api/accounting/reports/income-statement?from=${Y}-01-01&to=${Y}-12-31`);
  assert.equal(is.netIncome, 8000000, "income statement for Y unchanged by the close (halalas)");
  // The report page sends from=<1 January this year> with the as-of date; that must not be refused (defect 35).
  const bs = await api(`/api/accounting/reports/balance-sheet?from=${THIS}-01-01&to=${Y}-12-31&provisional=include`);
  assert.equal(bs.error, undefined, JSON.stringify(bs));
  assert.equal(bs.currentEarnings, 0);
  assert.ok(bs.balanced);
  const open = await api(`/api/accounting/year-end/opening?year=${Y}`);
  assert.equal(open.profitAndLossNotClosed, 0);
  assert.ok(open.balanced);
  assert.deepEqual(Object.fromEntries(open.lines.map((l) => [l.code, l.net])), EXPECTED_OPENING);
  const next = await api(`/api/accounting/reports/income-statement?from=${THIS}-01-01&to=${THIS}-12-31`);
  assert.equal(next.netIncome, 100000, `${THIS} income statement starts from zero: only its own 1,000.00`);
  ok(`retained earnings 3200 at ${Y}-12-31 = 80,000.00 Cr; income statement ${Y} still 80,000.00; balance sheet current earnings 0 and balanced; opening ${THIS}: 1120 280,000.00 Dr, 3100 200,000.00 Cr, 3200 80,000.00 Cr, every P&L account 0; ${THIS} P&L holds only its own 1,000.00`);

  // 6. The balance sheet screen at Y-12-31.
  await go(A, "/dashboard/accounting/reports");
  await A.getByText("المركز المالي", { exact: true }).first().click();
  await A.waitForLoadState("networkidle");
  const bsLoaded = A.waitForResponse((r) => r.url().includes("/api/accounting/reports/balance-sheet") && r.url().includes(`to=${Y}-12-31`) && r.status() === 200, { timeout: 15000 });
  await A.locator('input[type="date"]').last().fill(`${Y}-12-31`);
  await bsLoaded;
  await A.getByText("80,000.00").first().waitFor({ timeout: 15000 });
  assert.equal(await A.getByText("EQUITY", { exact: true }).count(), 0, "section headings are localised (defect 36)");
  await shot(A, "ACC-65-ye-balance-sheet");
  ok(`balance sheet screen at ${Y}-12-31 shows retained earnings 80,000.00`);

  for (const s of [prep, appr]) assert.deepEqual(s.errors, [], "no page errors");
  for (const s of [prep, appr]) await s.ctx.close();
} finally { await browser.close(); await db.end(); }
console.log(`# pass ${results.length}\n# fail 0`);
