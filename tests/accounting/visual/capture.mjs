// Captures the running Accounting screens for comparison with Figma page
// "17 — Accounting · General Ledger" (file CYWypOA4538FYoTDUdGyP5).
//
//   BASE_URL=http://localhost:3040 FIN_PASSWORD=... node tests/accounting/visual/capture.mjs <outDir> [ids]
//
// Local fixture only (scripts/accounting/seed-local-fixture.ts). Full height by growing the
// viewport to the scrolling <main> content — capture technique only; no CSS is injected.
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";
import path from "node:path";

const BASE = process.env.BASE_URL ?? "http://localhost:3040";
if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(BASE)) throw new Error("Refusing to capture a non-local server.");
const out = process.argv[2] ?? "accounting-shots";
const only = process.argv[3] ?? "all";
mkdirSync(out, { recursive: true });

const firstJournal = (status) => async (p) => {
  const id = await p.evaluate(async (s) => (await (await fetch(`/api/accounting/journals?status=${s}&sort=oldest`)).json()).rows.find((r) => r.type === "MANUAL")?.id, status);
  await p.goto(`${BASE}/dashboard/accounting/journals/${id}`);
};

const firstSale = (status, path = "") => async (p) => {
  const id = await p.evaluate(async (s) => (await (await fetch(`/api/accounting/receivables/invoices?status=${s}&kind=INVOICE`)).json()).rows.at(-1)?.id, status);
  await p.goto(path ? `${BASE}/dashboard/accounting/receivables/new?creditFor=${id}` : `${BASE}/dashboard/accounting/receivables/${id}`);
};
const assignDep = async (p) => { await p.locator("tr", { hasText: "DEP-5530" }).getByRole("button", { name: "إسناد" }).click(); await p.getByText("مطاعم البيت الشامي").first().waitFor(); };
const firstBill = (status) => async (p) => {
  const id = await p.evaluate(async (s) => (await (await fetch(`/api/accounting/bills?status=${s}`)).json()).rows[0]?.id, status);
  await p.goto(`${BASE}/dashboard/accounting/payables/${id}`);
};

const invDoc = (type, status = "POSTED") => async (p) => {
  const id = await p.evaluate(async ([t, s]) => (await (await fetch(`/api/accounting/inventory/documents?status=${s}&type=${t}`)).json()).rows.at(-1)?.id, [type, status]);
  await p.goto(`${BASE}/dashboard/accounting/inventory/documents/${id}`);
};
const stockCard = async (p) => {
  const m = await p.evaluate(async () => { const r = await (await fetch("/api/accounting/inventory/items")).json(); return { item: r.items.find((i) => i.code === "SKU-ETH-250").id, loc: r.locations.find((l) => l.code === "RST").id }; });
  await p.goto(`${BASE}/dashboard/accounting/inventory/stock-card?itemId=${m.item}&locationId=${m.loc}`);
};

const fillReceipt = async (p) => {
  const pick = async (loc, text) => { const o = loc.locator("option", { hasText: text }).first(); await o.waitFor({ state: "attached" }); await loc.selectOption(await o.getAttribute("value")); };
  await pick(p.getByLabel(/^المورد/), "محمصة الوادي");
  await pick(p.getByLabel(/^الموقع/), "المحمصة");
  for (let i = 0; i < 2; i++) await p.getByRole("button", { name: "+ بند" }).click();
  const rows = [["GRN-ETH", "100", null, "30"], ["BAG-250", "10", "pack100", "0.65"], ["LBL-ETH", "1000", null, "0.15"]];
  for (const [i, [item, q, unit, cost]] of rows.entries()) {
    await pick(p.getByLabel(`صنف البند ${i + 1}`), item);
    await p.getByLabel(`كمية البند ${i + 1}`).fill(q);
    if (unit) await pick(p.getByLabel(`وحدة البند ${i + 1}`), unit);
    await p.getByLabel(`تكلفة البند ${i + 1}`).fill(cost);
  }
};

const SHOTS = [
  { id: "ACC-01", route: "/dashboard/accounting" },
  { id: "ACC-02", route: "/dashboard/accounting/journals" },
  { id: "ACC-03", route: "/dashboard/accounting/journals/new", user: "acc.preparer", act: async (p) => {
      const rows = p.locator("tbody tr");
      const pick = async (i, code) => { const sel = rows.nth(i).locator("select").first(); const opts = await sel.locator("option").allTextContents(); await sel.selectOption({ index: opts.findIndex((o) => o.startsWith(code)) }); };
      await p.getByRole("button", { name: "سطر", exact: true }).click();
      await p.locator("input").nth(1).fill("شراء عدّة باريستا للمقهى: مطحنة إسبريسو، أباريق حليب، موازين دقيقة، وأدوات تنظيف — فاتورة المورد INV-2026-0931");
      await pick(0, "6700"); await pick(1, "1160"); await pick(2, "1120");
      await p.getByLabel("مدين السطر 1").fill("12,840.00"); await p.getByLabel("مدين السطر 2").fill("1,926.00"); await p.getByLabel("دائن السطر 3").fill("14,760.00");
      await p.getByRole("button", { name: "حفظ وتقديم للاعتماد" }).click();
    } },
  { id: "ACC-04", route: "/dashboard/accounting", act: firstJournal("SUBMITTED") },
  { id: "ACC-05", route: "/dashboard/accounting/accounts" },
  { id: "ACC-06", route: "/dashboard/accounting/periods" },
  { id: "ACC-07", route: "/dashboard/accounting/reports", act: async (p) => { await p.locator("tbody tr", { hasText: "عمولات المبيعات" }).first().click(); } },
  { id: "ACC-07-tb", route: "/dashboard/accounting/reports" },
  { id: "ACC-08-is", route: "/dashboard/accounting/reports", act: async (p) => { await p.getByRole("button", { name: "قائمة الدخل" }).click(); } },
  { id: "ACC-08-bs", route: "/dashboard/accounting/reports", act: async (p) => { await p.getByRole("button", { name: "المركز المالي" }).click(); } },
  { id: "ACC-08-com", route: "/dashboard/accounting/reports", act: async (p) => { await p.getByRole("button", { name: "مطابقة العمولات" }).click(); } },
  { id: "ACC-09", route: "/dashboard/accounting/automation" },
  { id: "ACC-10-noperm", route: "/dashboard/accounting", user: "no.accounting" },
  { id: "ACC-10-viewer", route: "/dashboard/accounting", user: "acc.viewer", act: firstJournal("SUBMITTED") },
  { id: "ACC-11", route: "/dashboard/accounting", w: 390, act: firstJournal("SUBMITTED") },
  { id: "ACC-12-en", route: "/dashboard/accounting", user: "acc.approver.en", act: firstJournal("SUBMITTED") },
  { id: "ACC-01-1024", route: "/dashboard/accounting", w: 1024 },
  // Stage 2 — Figma page "18 — Accounting · Payables & Bank"
  { id: "ACC-20", route: "/dashboard/accounting/payables" },
  { id: "ACC-21", route: "/dashboard/accounting/payables/new", user: "acc.preparer" },
  { id: "ACC-22", route: "/dashboard/accounting/payables", act: firstBill("SUBMITTED") },
  { id: "ACC-22-posted-en", route: "/dashboard/accounting/payables", user: "acc.approver.en", act: firstBill("POSTED") },
  { id: "ACC-23", route: "/dashboard/accounting/payables/aging" },
  { id: "ACC-23-statement", route: "/dashboard/accounting/payables/aging", act: async (p) => { await p.getByRole("button", { name: "كشف حساب مورد" }).click(); } },
  { id: "ACC-24", route: "/dashboard/accounting/bank" },
  { id: "ACC-25", route: "/dashboard/accounting/bank?view=reconcile" },
  { id: "ACC-26", route: "/dashboard/accounting/payables?status=PENDING", w: 390 },
  { id: "ACC-27", route: "/dashboard/accounting/reports", act: async (p) => { await p.getByRole("button", { name: "التدفقات النقدية" }).click(); } },
  { id: "ACC-27-390", route: "/dashboard/accounting/reports", w: 390, act: async (p) => { await p.getByRole("button", { name: "التدفقات النقدية" }).click(); } },
  { id: "ACC-28", route: "/dashboard/accounting/bank?view=corrections" },
  { id: "ACC-28-request", route: "/dashboard/accounting/bank?view=corrections", user: "acc.preparer", act: async (p) => { await p.locator("tr", { hasText: "TRF-2291" }).getByRole("button", { name: "طلب تصحيح" }).click(); } },
  { id: "ACC-30", route: "/dashboard/accounting/receivables" },
  { id: "ACC-30-en", route: "/dashboard/accounting/receivables", user: "acc.approver.en" },
  { id: "ACC-31", route: "/dashboard/accounting/receivables/new", user: "acc.preparer" },
  { id: "ACC-32", route: "/dashboard/accounting/receivables", act: firstSale("POSTED") },
  { id: "ACC-32-submitted", route: "/dashboard/accounting/receivables", act: firstSale("SUBMITTED") },
  { id: "ACC-33", route: "/dashboard/accounting/receivables/receipts" },
  { id: "ACC-33-assign", route: "/dashboard/accounting/receivables/receipts", user: "acc.preparer", act: assignDep },
  { id: "ACC-34", route: "/dashboard/accounting/receivables/aging" },
  { id: "ACC-35", route: "/dashboard/accounting/receivables", user: "acc.preparer", act: firstSale("POSTED", "credit") },
  { id: "ACC-36", route: "/dashboard/accounting/receivables?status=PENDING", w: 390 },
  { id: "ACC-40", route: "/dashboard/accounting/inventory" },
  { id: "ACC-40-en", route: "/dashboard/accounting/inventory", user: "acc.approver.en" },
  { id: "ACC-41", route: "/dashboard/accounting/inventory/documents" },
  { id: "ACC-42", route: "/dashboard/accounting/inventory/documents/new?type=RECEIPT", user: "acc.preparer", act: fillReceipt },
  { id: "ACC-43", route: "/dashboard/accounting/inventory", act: invDoc("PRODUCTION") },
  { id: "ACC-43-submitted", route: "/dashboard/accounting/inventory", act: invDoc("PRODUCTION", "PENDING") },
  { id: "ACC-44", route: "/dashboard/accounting/inventory", act: stockCard },
  { id: "ACC-45", route: "/dashboard/accounting/inventory/grni", user: "acc.preparer" },
  { id: "ACC-46", route: "/dashboard/accounting/inventory/setup" },
  { id: "ACC-47", route: "/dashboard/accounting/inventory/documents?status=PENDING", w: 390 },
  // Stage 4b screens (no Figma frames yet — FIGMA_PARITY.md).
  { id: "ACC-48", route: "/dashboard/accounting/inventory/exceptions" },
  { id: "ACC-48-costing", route: "/dashboard/accounting/inventory/exceptions", act: async (p) => { await p.getByRole("radio", { name: /تكلفة المبيعات/ }).first().click().catch(() => p.getByText(/تكلفة المبيعات/).first().click()); } },
  { id: "ACC-48-reconciliation", route: "/dashboard/accounting/inventory/exceptions", act: async (p) => { await p.getByRole("radio", { name: /المطابقة/ }).first().click().catch(() => p.getByText(/المطابقة/).first().click()); } },
  { id: "ACC-48-390", route: "/dashboard/accounting/inventory/exceptions", w: 390 },
  { id: "ACC-49", route: "/dashboard/accounting/inventory/returns" },
  { id: "ACC-49-390", route: "/dashboard/accounting/inventory/returns", w: 390 },
  { id: "ACC-50", route: "/dashboard/accounting/inventory/margin" },
  { id: "ACC-51", route: "/dashboard/accounting/inventory/setup", act: async (p) => { await p.getByText(/مجمّعات|تكاليف التحويل|Conversion/).first().scrollIntoViewIfNeeded().catch(() => undefined); } },
  { id: "ACC-32-costing", route: "/dashboard/accounting/receivables", act: firstSale("POSTED") },
  { id: "ACC-52", route: "/dashboard/accounting/payables", user: "acc.preparer", act: async (p) => {
    const id = await p.evaluate(async () => (await (await fetch("/api/accounting/bills?status=POSTED")).json()).rows.find((r) => r.kind !== "CREDIT_NOTE" && r.supplierInvoiceNo === "G-1")?.id);
    await p.goto(`${BASE}/dashboard/accounting/payables/new?creditFor=${id}`); } },
  { id: "ACC-53", route: "/dashboard/accounting/payables", act: async (p) => {
    const id = await p.evaluate(async () => (await (await fetch("/api/accounting/bills?status=POSTED")).json()).rows.find((r) => r.kind === "CREDIT_NOTE")?.id);
    await p.goto(`${BASE}/dashboard/accounting/payables/${id}`); } },
  { id: "OPS-purchases", route: "/dashboard/purchases", user: "ops.roastery" },
  { id: "OPS-production", route: "/dashboard/production", user: "ops.roastery", act: async (p) => { await p.getByText(/جميع الدفعات/).first().click(); } },
  { id: "OPS-packaging", route: "/dashboard/packaging", user: "ops.roastery" },
  { id: "OPS-dispatch", route: "/dashboard/dispatch", user: "ops.roastery" },
  { id: "ACC-27-en", route: "/dashboard/accounting/reports", user: "acc.approver.en", act: async (p) => { await p.getByRole("button", { name: "Cash flow" }).click(); } },
];

async function login(page, user, password) {
  await page.goto(`${BASE}/login`);
  const r = await page.evaluate(async ([u, p]) => (await fetch("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ method: "password", username: u, password: p }) })).status, [user, password]);
  if (r !== 200) throw new Error(`login failed ${r}`);
}

// PW_CHROMIUM lets a sandbox with a different pre-installed browser run the capture.
const browser = await chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
const report = [];
try {
  for (const s of SHOTS.filter((x) => only === "all" || only.split(",").includes(x.id))) {
    const w = s.w ?? 1440;
    const ctx = await browser.newContext({ viewport: { width: w, height: 900 }, locale: "en-GB" });
    const page = await ctx.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await login(page, s.user ?? "acc.approver", process.env.FIN_PASSWORD);
    await page.goto(`${BASE}${s.route}`);
    await page.waitForLoadState("networkidle");
    if (s.act) { await s.act(page); await page.waitForLoadState("networkidle"); }
    await page.waitForTimeout(700);
    const extra = await page.evaluate(() => { const m = document.querySelector("main"); return m ? m.scrollHeight - m.clientHeight : 0; });
    if (extra > 0) { await page.setViewportSize({ width: w, height: 900 + extra }); await page.waitForTimeout(400); }
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
    const dir = await page.evaluate(() => document.documentElement.dir);
    const file = path.join(out, `${s.id}-app-${w}.png`);
    await page.screenshot({ path: file });
    report.push({ id: s.id, file, width: w, dir, pageOverflowX: overflow, pageErrors: errors });
    console.log(JSON.stringify(report.at(-1)));
    await ctx.close();
  }
} finally {
  await browser.close();
}
