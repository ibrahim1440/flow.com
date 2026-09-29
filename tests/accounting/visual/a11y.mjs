// Automated accessibility audit (axe-core, WCAG 2.1 A/AA rules) of the Accounting screens in
// Arabic (RTL) and English (LTR), desktop and 390 px. Local fixture server only.
//
//   BASE_URL=http://localhost:3040 FIN_PASSWORD=... node tests/accounting/visual/a11y.mjs [out.json]
// Exit 1 if any serious/critical violation is found inside the accounting content (<main>).
import { chromium } from "@playwright/test";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";

const BASE = process.env.BASE_URL ?? "http://localhost:3040";
if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(BASE)) throw new Error("Refusing to audit a non-local server.");
const AXE = readFileSync(createRequire(import.meta.url).resolve("axe-core/axe.min.js"), "utf8");
const out = process.argv[2];

const firstJournal = async (p) => {
  const id = await p.evaluate(async () => (await (await fetch(`/api/accounting/journals?status=SUBMITTED&sort=oldest`)).json()).rows.find((r) => r.type === "MANUAL")?.id);
  await p.goto(`${BASE}/dashboard/accounting/journals/${id}`);
};
const invDoc = (type, status = "POSTED") => async (p) => {
  const id = await p.evaluate(async ([t, s]) => (await (await fetch(`/api/accounting/inventory/documents?status=${s}&type=${t}`)).json()).rows.at(-1)?.id, [type, status]);
  await p.goto(`${BASE}/dashboard/accounting/inventory/documents/${id}`);
};
const stockCard = async (p) => {
  const m = await p.evaluate(async () => { const r = await (await fetch("/api/accounting/inventory/items")).json(); return { item: r.items.find((i) => i.code === "SKU-ETH-250").id, loc: r.locations.find((l) => l.code === "RST").id }; });
  await p.goto(`${BASE}/dashboard/accounting/inventory/stock-card?itemId=${m.item}&locationId=${m.loc}`);
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
const tab = (name) => async (p) => { await p.getByRole("button", { name }).click(); };
const PAGES = [
  ["ACC-01 overview", "/dashboard/accounting"],
  ["ACC-02 journals", "/dashboard/accounting/journals"],
  ["ACC-03 editor", "/dashboard/accounting/journals/new", "acc.preparer"],
  ["ACC-04 detail", "/dashboard/accounting", undefined, firstJournal],
  ["ACC-05 accounts", "/dashboard/accounting/accounts"],
  ["ACC-06 periods", "/dashboard/accounting/periods"],
  ["ACC-07 reports TB", "/dashboard/accounting/reports"],
  ["ACC-08 income statement", "/dashboard/accounting/reports", undefined, tab("قائمة الدخل")],
  ["ACC-08 balance sheet", "/dashboard/accounting/reports", undefined, tab("المركز المالي")],
  ["ACC-09 automation", "/dashboard/accounting/automation"],
  ["ACC-10 no permission", "/dashboard/accounting", "no.accounting"],
  ["ACC-11 mobile detail", "/dashboard/accounting", undefined, firstJournal, 390],
  ["ACC-12 English detail", "/dashboard/accounting", "acc.approver.en", firstJournal],
  ["ACC-12 English reports", "/dashboard/accounting/reports", "acc.approver.en"],
  ["ACC-20 bills", "/dashboard/accounting/payables"],
  ["ACC-21 bill editor", "/dashboard/accounting/payables/new", "acc.preparer"],
  ["ACC-22 bill detail", "/dashboard/accounting/payables", undefined, firstBill("SUBMITTED")],
  ["ACC-22 bill detail EN", "/dashboard/accounting/payables", "acc.approver.en", firstBill("POSTED")],
  ["ACC-23 aging", "/dashboard/accounting/payables/aging"],
  ["ACC-24 bank", "/dashboard/accounting/bank"],
  ["ACC-25 bank reconciliation", "/dashboard/accounting/bank?view=reconcile"],
  ["ACC-26 mobile bills", "/dashboard/accounting/payables?status=PENDING", undefined, undefined, 390],
  ["ACC-28 bank corrections", "/dashboard/accounting/bank?view=corrections"],
  ["ACC-28 correction request", "/dashboard/accounting/bank?view=corrections", "acc.preparer", async (p) => { await p.locator("tr", { hasText: "TRF-2291" }).getByRole("button", { name: "طلب تصحيح" }).click(); }],
  ["ACC-30 sales invoices", "/dashboard/accounting/receivables"],
  ["ACC-31 sales invoice editor", "/dashboard/accounting/receivables/new", "acc.preparer"],
  ["ACC-32 sales invoice detail", "/dashboard/accounting/receivables", undefined, firstSale("POSTED")],
  ["ACC-33 customer receipts", "/dashboard/accounting/receivables/receipts"],
  ["ACC-33 receipt assignment", "/dashboard/accounting/receivables/receipts", "acc.preparer", assignDep],
  ["ACC-34 receivables aging", "/dashboard/accounting/receivables/aging"],
  ["ACC-35 credit note", "/dashboard/accounting/receivables", "acc.preparer", firstSale("POSTED", "credit")],
  ["ACC-36 mobile sales invoices", "/dashboard/accounting/receivables?status=PENDING", undefined, undefined, 390],
  ["ACC-40 inventory valuation", "/dashboard/accounting/inventory"],
  ["ACC-41 inventory documents", "/dashboard/accounting/inventory/documents"],
  ["ACC-42 inventory document editor", "/dashboard/accounting/inventory/documents/new?type=RECEIPT", "acc.preparer"],
  ["ACC-43 inventory document detail", "/dashboard/accounting/inventory", undefined, invDoc("PRODUCTION")],
  ["ACC-44 stock card", "/dashboard/accounting/inventory", undefined, stockCard],
  ["ACC-45 GRNI and matching", "/dashboard/accounting/inventory/grni", "acc.preparer"],
  ["ACC-46 inventory setup", "/dashboard/accounting/inventory/setup"],
  ["ACC-47 mobile inventory approvals", "/dashboard/accounting/inventory/documents?status=PENDING", undefined, undefined, 390],
  ["ACC-48 exceptions queue", "/dashboard/accounting/inventory/exceptions"],
  ["ACC-48 exceptions 390", "/dashboard/accounting/inventory/exceptions", undefined, undefined, 390],
  ["ACC-49 customer returns", "/dashboard/accounting/inventory/returns"],
  ["ACC-50 gross margin", "/dashboard/accounting/inventory/margin"],
  ["ACC-51 inventory setup + pools", "/dashboard/accounting/inventory/setup"],
  ["ACC-60 fixed-asset register", "/dashboard/accounting/assets"],
  ["ACC-60 register 390", "/dashboard/accounting/assets", undefined, undefined, 390],
  ["ACC-61 asset editor", "/dashboard/accounting/assets/new", "acc.preparer"],
  ["ACC-62 depreciation runs", "/dashboard/accounting/assets/runs"],
  ["ACC-64 classes and policies", "/dashboard/accounting/assets/setup"],
  ["ACC-65 year-end close", "/dashboard/accounting/periods/year-end"],
  ["ACC-70 e-invoices", "/dashboard/accounting/tax"],
  ["ACC-70 e-invoices 390", "/dashboard/accounting/tax", undefined, undefined, 390],
  ["ACC-71 seller profile", "/dashboard/accounting/tax/profile"],
  ["ACC-72 VAT return", "/dashboard/accounting/tax/vat-return"],
  ["ACC-27 cash flow", "/dashboard/accounting/reports", undefined, tab("التدفقات النقدية")],
];

const browser = await chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
const results = [];
let blocking = 0;
try {
  for (const [name, route, user = "acc.approver", act, w = 1440] of PAGES) {
    const ctx = await browser.newContext({ viewport: { width: w, height: 900 } });
    const page = await ctx.newPage();
    await page.goto(`${BASE}/login`);
    const st = await page.evaluate(async ([u, p]) => (await fetch("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ method: "password", username: u, password: p }) })).status, [user, process.env.FIN_PASSWORD]);
    if (st !== 200) throw new Error(`login ${user}: ${st}`);
    await page.goto(`${BASE}${route}`);
    await page.waitForLoadState("networkidle");
    if (act) { await act(page); await page.waitForLoadState("networkidle"); }
    await page.waitForTimeout(400);
    await page.addScriptTag({ content: AXE });
    const r = await page.evaluate(async () => {
      const res = await window.axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] } });
      return {
        dir: document.documentElement.dir || getComputedStyle(document.body).direction, lang: document.documentElement.lang,
        violations: res.violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.map((n) => ({ target: n.target.join(" "), inMain: !!document.querySelector(n.target.join(" "))?.closest("main"), summary: n.failureSummary?.split("\n").slice(0, 3).join(" ") })) })),
      };
    });
    for (const v of r.violations) for (const n of v.nodes) if (n.inMain && ["serious", "critical"].includes(v.impact)) blocking++;
    results.push({ name, user, width: w, ...r });
    console.log(`${name.padEnd(26)} ${r.dir}/${r.lang}  ${r.violations.length ? r.violations.map((v) => `${v.id}(${v.impact}) ×${v.nodes.length} [main ${v.nodes.filter((n) => n.inMain).length}]`).join(", ") : "no violations"}`);
    await ctx.close();
  }
} finally { await browser.close(); }
if (out) writeFileSync(out, JSON.stringify(results, null, 2));
console.log(`\nserious/critical violations inside accounting content: ${blocking}`);
process.exit(blocking ? 1 : 0);
