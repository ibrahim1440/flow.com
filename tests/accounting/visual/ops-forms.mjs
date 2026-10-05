// Browser proof of the operational integration: an operations user (no accounting access) fills the
// real purchase form and the real roast-to-stock form; the screens then show each record's
// accounting status ("posted"), and the accounting side holds the documents. Local fixture only,
// synthetic data; the operations policy approval is a SYNTHETIC TEST STEP (as in the HTTP test).
//
//   BASE_URL=http://localhost:3040 FIN_PASSWORD=... RUNTIME_DATABASE_URL=... node tests/accounting/visual/ops-forms.mjs [shotsDir]
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

async function login(page, user) {
  await page.goto(`${BASE}/login`);
  const r = await page.evaluate(async ([u, p]) => (await fetch("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ method: "password", username: u, password: p }) })).status, [user, process.env.FIN_PASSWORD]);
  if (r !== 200) throw new Error(`login ${user}: ${r}`);
}
const browser = await chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
const results = [];
try {
  // SYNTHETIC TEST STEP: operations policy approved by two accountants (API, as their screens do).
  const pol = await one(`select id, status from "AccountingPolicy" where key = 'inventory.operations' order by version desc limit 1`);
  if (pol?.status !== "APPROVED") {
    const ctx = await browser.newContext(); const p = await ctx.newPage();
    await login(p, "acc.preparer");
    const id = pol?.status === "DRAFT" ? pol.id : (await p.evaluate(async () => (await (await fetch("/api/accounting/policies", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key: "inventory.operations" }) })).json()).id));
    await ctx.close();
    const c2 = await browser.newContext(); const q = await c2.newPage(); await login(q, "acc.approver");
    const st = await q.evaluate(async (i) => (await fetch(`/api/accounting/policies/${i}/approve`, { method: "POST" })).status, id);
    assert.equal(st, 200, "policy approval"); await c2.close();
  }

  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const errors = []; page.on("pageerror", (e) => errors.push(String(e)));
  await login(page, "ops.roastery");

  // 1. Purchase form.
  const before = Number((await one(`select count(*) n from "PurchaseRecord"`)).n);
  await page.goto(`${BASE}/dashboard/purchases`); await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: /إضافة مشتريات جديدة/ }).first().click();
  const form = page.locator("form").first();
  const supplier = await one(`select id from "Supplier" where name = 'محمصة الوادي للتوريد'`);
  const bean = await one(`select id from "GreenBean" where "serialNumber" = 'ACC-ETH-YRG-0412'`);
  await form.locator("select").nth(0).selectOption(supplier.id);
  await form.locator("select").nth(1).selectOption(bean.id);
  await form.locator('input[type="number"]').nth(0).fill("12");
  await form.locator('input[type="number"]').nth(1).fill("32.5");
  await form.locator('button[type="submit"]').click();
  await page.waitForLoadState("networkidle"); await page.waitForTimeout(800);
  const pur = await one(`select id from "PurchaseRecord" order by "createdAt" desc limit 1`);
  assert.equal(Number((await one(`select count(*) n from "PurchaseRecord"`)).n), before + 1, "the form recorded one purchase");
  const pe = await one(`select status, "documentId" from "InvOpsEvent" where kind = 'PURCHASE' and "sourceId" = $1`, [pur.id]);
  assert.equal(pe.status, "POSTED", "its goods receipt posted");
  const rj = (await db.query(`select a.code, l.debit::text d, l.credit::text c from "JournalEntryLine" l join "Account" a on a.id = l."accountId" join "JournalEntry" j on j.id = l."journalEntryId" join "AccountingEvent" e on e.id = j."originEventId" where e."idempotencyKey" = $1 order by a.code`, [`inventory:${pe.documentId}:inv.document.posted`])).rows.map((r) => `${r.code}:${Number(r.d).toFixed(2)}:${Number(r.c).toFixed(2)}`);
  assert.deepEqual(rj, ["1171:390.00:0.00", "2120:0.00:390.00"], "12 kg × 32.50");
  await page.reload(); await page.waitForLoadState("networkidle"); await page.waitForTimeout(600);
  const chip = page.locator("tr", { hasText: "12" }).getByText("مُرحّل محاسبياً").first();
  await chip.waitFor({ timeout: 5000 });
  if (out) await page.screenshot({ path: `${out}/OPS-form-purchase.png`, fullPage: true });
  results.push("purchase form → receipt posted, chip shown");

  // 2. Roast-to-stock form.
  const cp = await one(`select id from "CoffeeProduct" where "productNameEn" = 'Ethiopia Yirgacheffe (fixture)'`);
  await page.goto(`${BASE}/dashboard/production`); await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: /تحميص للمخزون/ }).first().click();
  const modal = page.locator(".fixed.inset-0").last();
  await modal.locator("select").nth(0).selectOption(cp.id);
  await modal.locator("select").nth(1).selectOption(bean.id);
  await modal.locator('input[type="number"]').nth(0).fill("8");
  await modal.locator('input[type="number"]').nth(1).fill("6.8");
  await modal.locator('button[type="submit"], button:has-text("تسجيل"), button:has-text("حفظ")').last().click();
  await page.waitForLoadState("networkidle"); await page.waitForTimeout(800);
  const rb = await one(`select id, "batchNumber" from "RoastingBatch" where "greenBeanQuantity" = 8 order by "createdAt" desc limit 1`);
  assert.ok(rb, "the form recorded the roast");
  const re = await one(`select status, "lastError" from "InvOpsEvent" where kind = 'ROAST' and "sourceId" = $1`, [rb.id]);
  assert.equal(re.status, "POSTED", re.lastError ?? "");
  await page.getByText(/جميع الدفعات/).first().click(); await page.waitForTimeout(800);
  await page.locator("div", { hasText: rb.batchNumber }).getByText("مُرحّل محاسبياً").first().waitFor({ timeout: 5000 });
  if (out) await page.screenshot({ path: `${out}/OPS-form-roast.png`, fullPage: true });
  results.push("roast-to-stock form → production posted, chip shown");

  assert.deepEqual(errors, [], "no page errors");
  await ctx.close();
} finally { await browser.close(); await db.end(); }
for (const r of results) console.log(`ok - ${r}`);
console.log(`# pass ${results.length}\n# fail 0`);
