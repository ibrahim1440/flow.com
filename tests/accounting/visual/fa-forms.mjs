// Browser proof of the stage 5 screens through their real forms (Figma ACC-60..65), as the
// fixture's preparer (acc.preparer) and approver (acc.approver), with database checks after each
// step. Classes, lives and rates are the fixture's SYNTHETIC test assumptions.
//  1. capitalisation: the preparer cannot approve their own asset; the approver capitalises
//     FA-0004 → Dr 1210 42,000 / Cr 2195;
//  2. registering an asset through the form: below the class threshold is refused, then registered
//     and submitted;
//  3. disposal of the van: a bank account as proceeds account is refused; submitted; approved by
//     the approver → cost, accumulated depreciation to last month, proceeds and the loss;
//  4. depreciation run for the current month: computed by the preparer (a second run for the same
//     period is refused), approved and posted by the approver (journal 6600 / 1290 = run total);
//     the disposed van is not in it; the espresso machine is caught up from July;
//  5. reversal of that run: requested by the preparer, approved by the approver;
//  6. year-end page: the current year cannot be prepared and says why.
//
//   BASE_URL=http://localhost:3040 FIN_PASSWORD=... RUNTIME_DATABASE_URL=... node tests/accounting/visual/fa-forms.mjs [shotsDir]
import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";

const BASE = process.env.BASE_URL ?? "http://localhost:3040";
if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(BASE)) throw new Error("Refusing to run against a non-local server.");
const DB_URL = process.env.RUNTIME_DATABASE_URL;
if (!DB_URL || !/@(127\.0\.0\.1|localhost):\d+\//.test(DB_URL)) throw new Error("RUNTIME_DATABASE_URL must be a local database.");
const out = process.argv[2]; if (out) mkdirSync(out, { recursive: true });
const { Client } = createRequire(import.meta.url)("pg");
const db = new Client({ connectionString: DB_URL }); await db.connect();
const one = async (sql, args = []) => (await db.query(sql, args)).rows[0];
const journal = async (key) => (await db.query(
  `select a.code, l.debit::text d, l.credit::text c from "JournalEntryLine" l join "Account" a on a.id = l."accountId" join "AccountingEvent" e on e."journalEntryId" = l."journalEntryId"
    where e."idempotencyKey" = $1 order by a.code, l.debit desc`, [key])).rows.map((r) => `${r.code}:${Number(r.d).toFixed(2)}:${Number(r.c).toFixed(2)}`);
const YEAR = new Date(Date.now() + 3 * 3600_000).getUTCFullYear();
const MONTH = new Date(Date.now() + 3 * 3600_000).getUTCMonth() + 1;
const PERIOD = `${YEAR}-${String(MONTH).padStart(2, "0")}`;

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
const sel = (scope, label) => scope.locator(`select[aria-label="${label}"]`);
const go = async (page, path) => { await page.goto(`${BASE}${path}`); await page.waitForLoadState("networkidle"); };
const pickByText = async (select, re) => {
  const opts = await select.locator("option").evaluateAll((os) => os.map((o) => ({ v: o.value, t: o.textContent })));
  const o = opts.find((x) => re.test(x.t ?? ""));
  if (!o) throw new Error(`no option ${re} in ${JSON.stringify(opts.map((x) => x.t))}`);
  await select.selectOption(o.v);
};

try {
  const prep = await session("acc.preparer");
  const appr = await session("acc.approver");
  const P = prep.page, A = appr.page;
  const espresso = await one(`select id, "assetNo" from "FaAsset" where name like 'ماكينة إسبريسو%'`);
  const van = await one(`select id, cost::text from "FaAsset" where name like 'سيارة توصيل%'`);

  // 1. Capitalisation (four-eyes).
  await go(P, `/dashboard/accounting/assets/${espresso.id}`);
  assert.equal(await P.getByRole("button", { name: "اعتماد ورسملة" }).count(), 0, "the preparer has no approve button on their own asset");
  await P.getByText("أنت أعددت هذا الأصل؛ يعتمده شخص آخر.").waitFor();
  await go(A, `/dashboard/accounting/assets/${espresso.id}`);
  await shot(A, "ACC-61-submitted");
  await A.getByRole("button", { name: "اعتماد ورسملة" }).click();
  await A.getByText("اعتُمد الأصل ورُسمل.").waitFor({ timeout: 10000 });
  assert.equal((await one(`select status from "FaAsset" where id = $1`, [espresso.id])).status, "CAPITALISED");
  assert.deepEqual(await journal(`fixed_assets:${espresso.id}:fa.asset.capitalised:1`), ["1210:42000.00:0.00", "2195:0.00:42000.00"]);
  await shot(A, "ACC-61-capitalised");
  ok("capitalisation: the preparer cannot approve their own asset; the approver capitalised FA-0004 in the browser (Dr 1210 42,000 / Cr 2195)");

  // 2. Register an asset through the form: threshold refusal, then registered and submitted.
  await go(P, "/dashboard/accounting/assets/new");
  const ed = P.getByTestId("asset-editor");
  await ed.getByLabel("اسم الأصل").fill("ميزان تحميص (تجريبي)");
  await pickByText(sel(ed, "الفئة"), /MACH-SYN/);
  await ed.getByLabel("تاريخ بدء الخدمة").fill(`${YEAR}-${String(MONTH).padStart(2, "0")}-01`);
  const src = P.getByTestId("source-0");
  await sel(src, "نوع المصدر").selectOption("ACCOUNT");
  await pickByText(sel(src, "الحساب المقابل"), /^2195/);
  await src.getByLabel("المبلغ").fill("400");
  await ed.getByRole("button", { name: "تسجيل كمسودة" }).click();
  await ed.getByText(/capitalisation threshold/).waitFor({ timeout: 10000 });
  const before = Number((await one(`select count(*) c from "FaAsset"`)).c);
  await shot(P, "ACC-61-threshold-refused");
  await src.getByLabel("المبلغ").fill("4500");
  await ed.getByRole("button", { name: "تسجيل كمسودة" }).click();
  await P.waitForURL(/\/assets\/c[a-z0-9]+$/, { timeout: 15000 }); await P.waitForLoadState("networkidle");
  assert.equal(Number((await one(`select count(*) c from "FaAsset"`)).c), before + 1);
  await P.getByRole("button", { name: "تقديم للاعتماد" }).click();
  await P.getByText("قُدّم الأصل للاعتماد.").waitFor({ timeout: 10000 });
  const scale = await one(`select status, cost::text from "FaAsset" where name = 'ميزان تحميص (تجريبي)'`);
  assert.deepEqual([scale.status, scale.cost], ["SUBMITTED", "4500.00"]);
  ok("asset form: 400.00 refused (below the class's capitalisation threshold), 4,500.00 registered and submitted");

  // 3. Disposal of the van (before this month's run: depreciation through last month has posted).
  await go(P, `/dashboard/accounting/assets/${van.id}`);
  await P.getByRole("button", { name: "استبعاد الأصل…" }).click();
  await P.getByLabel("المتحصلات", { exact: true }).fill("80000");
  await P.getByLabel("سبب الاستبعاد").fill("استبدال بسيارة أحدث (تجريبي)");
  const bankListed = await sel(P, "حساب المتحصلات").locator("option", { hasText: /^1120/ }).count();
  assert.equal(bankListed, 0, "bank accounts are not offered as a proceeds account");
  await P.getByRole("button", { name: "تقديم للاعتماد" }).click();
  await P.getByText(/Proceeds account: choose an account/).waitFor({ timeout: 10000 });
  await pickByText(sel(P, "حساب المتحصلات"), /^2190/);
  await P.getByRole("button", { name: "تقديم للاعتماد" }).click();
  await P.getByText("سُجّل الاستبعاد؛ بانتظار اعتماد شخص آخر.").waitFor({ timeout: 10000 });
  await shot(P, "ACC-63-submitted");
  const disp = await one(`select id from "FaDisposal" where "assetId" = $1 and status = 'DRAFT'`, [van.id]);
  await go(A, `/dashboard/accounting/assets/${van.id}`);
  await A.getByTestId("disposal-DRAFT").getByRole("button", { name: "اعتماد وترحيل" }).click();
  await A.getByText("اعتُمد الاستبعاد ورُحّل.").waitFor({ timeout: 10000 });
  const dd = await one(`select cost::text, accumulated::text, nbv::text, "gainLoss"::text g from "FaDisposal" where id = $1`, [disp.id]);
  const jd = await journal(`fixed_assets:${disp.id}:fa.disposal.posted:1`);
  const loss = (-Number(dd.g)).toFixed(2);
  assert.deepEqual(jd, [`1230:0.00:${van.cost}`, `1290:${dd.accumulated}:0.00`, "2190:80000.00:0.00", `6960:${loss}:0.00`].sort());
  assert.equal((Number(dd.cost) - Number(dd.accumulated)).toFixed(2), dd.nbv);
  await shot(A, "ACC-63-posted");
  ok(`disposal form: no bank account offered, a missing proceeds account refused; approved by the approver → Dr 1290 ${dd.accumulated} · Dr 2190 80,000 · Dr 6960 ${loss} / Cr 1230 ${van.cost}`);

  // 4. This month's depreciation run.
  await go(P, "/dashboard/accounting/assets/runs");
  await pickByText(sel(P, "الفترة"), new RegExp(`^${PERIOD}$`));
  await P.getByRole("button", { name: "حساب قيد الإهلاك" }).click();
  await P.getByText("حُسب قيد الإهلاك؛ بانتظار اعتماد شخص آخر.").waitFor({ timeout: 10000 });
  await P.getByText("أنت أعددت هذا القيد؛ يعتمده شخص آخر.").waitFor();
  await shot(P, "ACC-62-draft");
  const run = await one(`select r.id, r.total::text t, r."runNo" from "FaDepRun" r join "FiscalPeriod" p on p.id = r."fiscalPeriodId" where r.status = 'DRAFT' and p."periodNo" = $1 and p.year = $2`, [MONTH, YEAR]);
  const lines = (await db.query(`select a.name, l.amount::text, l.months from "FaDepLine" l join "FaAsset" a on a.id = l."assetId" where l."runId" = $1`, [run.id])).rows;
  assert.ok(!lines.some((l) => l.name.startsWith("سيارة توصيل")), "the disposed van is not depreciated");
  const esp = lines.find((l) => l.name.startsWith("ماكينة إسبريسو"));
  assert.deepEqual([esp.amount, esp.months], [(875 * (MONTH - 6)).toFixed(2), MONTH - 6], "espresso caught up from July (42,000 / 48 = 875.00 a month)");
  await pickByText(sel(P, "الفترة"), new RegExp(`^${PERIOD}$`));
  await P.getByRole("button", { name: "حساب قيد الإهلاك" }).click();
  await P.getByText(/already exists/).waitFor({ timeout: 10000 });
  ok(`run form: ${PERIOD} computed (${run.t}; van excluded, espresso caught up ${esp.months} months); a second run for the period refused`);
  await go(A, `/dashboard/accounting/assets/runs?run=${run.id}`);
  await A.getByRole("button", { name: "اعتماد وترحيل" }).click();
  await A.getByText("اعتُمد قيد الإهلاك ورُحّل.").waitFor({ timeout: 10000 });
  assert.equal((await one(`select status from "FaDepRun" where id = $1`, [run.id])).status, "POSTED");
  assert.deepEqual(await journal(`fixed_assets:${run.id}:fa.depreciation.posted:1`), [`1290:0.00:${run.t}`, `6600:${run.t}:0.00`]);
  await shot(A, "ACC-62-posted");
  ok(`run approved and posted by the approver in the browser: Dr 6600 ${run.t} / Cr 1290`);

  // 5. Reversal of the run (latest only), four-eyes.
  await go(P, "/dashboard/accounting/assets/runs");
  await P.getByTestId(`run-${PERIOD}-POSTED`).getByRole("button", { name: "طلب عكس" }).click();
  await P.getByRole("dialog").getByLabel("السبب").fill("إعادة الاحتساب بعد تعديل العمر (تجريبي)");
  await P.getByRole("dialog").getByRole("button", { name: "تأكيد" }).click();
  await P.getByText("طُلب العكس؛ يقرّه شخص آخر.").waitFor({ timeout: 10000 });
  await go(A, "/dashboard/accounting/assets/runs");
  await A.getByTestId(`run-${PERIOD}-REVERSAL_REQUESTED`).getByRole("button", { name: "اعتماد العكس" }).click();
  await A.getByText("عُكس قيد الإهلاك؛ يمكن حساب الفترة من جديد.").waitFor({ timeout: 10000 });
  assert.deepEqual(await journal(`fixed_assets:${run.id}:fa.depreciation.reversed:1`), [`1290:${run.t}:0.00`, `6600:0.00:${run.t}`]);
  await shot(A, "ACC-62-reversed");
  ok("run reversal requested by the preparer and approved by the approver in the browser; reversing journal posted");

  // Register and reconciliation after all of it.
  await go(P, "/dashboard/accounting/assets");
  await P.getByText("مطابقة السجل مع الأستاذ العام").waitFor();
  await shot(P, "ACC-60-register");
  const rec = await P.evaluate(async () => (await fetch("/api/accounting/fixed-assets/reconciliation")).json());
  for (const a of rec.accounts) assert.equal(a.unexplained, "0.00", `${a.code} unexplained ${a.unexplained}`);
  ok(`register and reconciliation: ${rec.accounts.map((a) => `${a.code} difference ${a.difference}`).join(", ")}; nothing unexplained`);

  // 6. Year-end: the current year cannot be closed, and the page says why.
  await go(P, "/dashboard/accounting/periods/year-end");
  await P.getByTestId("check-NOT_ENDED").getByText("✗ غير متحقق").waitFor();
  assert.ok(await P.getByRole("button", { name: "إعداد الإقفال" }).isDisabled());
  await shot(P, "ACC-65-blocked");
  ok("year-end page: the current year shows its unmet conditions (not ended, periods open) and cannot be prepared");

  await go(P, "/dashboard/accounting/assets/setup");
  await P.getByTestId("class-FURN-SYN-DRAFT").waitFor();
  await shot(P, "ACC-64-setup");
  for (const s of [prep, appr]) assert.deepEqual(s.errors, [], "no page errors");
  for (const s of [prep, appr]) await s.ctx.close();
} finally { await browser.close(); await db.end(); }
console.log(`# pass ${results.length}\n# fail 0`);
