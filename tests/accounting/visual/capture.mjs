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
