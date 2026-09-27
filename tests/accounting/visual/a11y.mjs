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
