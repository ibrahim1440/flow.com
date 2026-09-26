// Captures the running Finance screens for Figma parity review.
//
//   BASE_URL=http://localhost:3040 FIN_USER=fin.manager FIN_PASSWORD=... node tests/finance/visual/capture.mjs <outDir> [lang]
//
// Local fixture environment only (see scripts/finance/seed-local-fixture.ts). The dashboard
// shell scrolls inside <main>; for a full-height capture the viewport is grown to the
// content height (no injected CSS) — capture technique only, the application is unchanged.
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";
import path from "node:path";

const BASE = process.env.BASE_URL ?? "http://localhost:3040";
const out = process.argv[2] ?? "finance-shots";
const only = process.argv[3] ?? "all";
mkdirSync(out, { recursive: true });

const SHOTS = [
  { id: "FIN-01", route: "/dashboard/finance", w: 1440 },
  { id: "FIN-02", route: "/dashboard/finance/transactions", w: 1440, open: "first-review" },
  { id: "FIN-03", route: "/dashboard/finance/allocation", w: 1440 },
  { id: "FIN-04", route: "/dashboard/finance/budget?", w: 1440, date: "2026-09-26" },
  { id: "FIN-05", route: "/dashboard/finance/obligations", w: 1440 },
  { id: "FIN-06", route: "/dashboard/finance/reports", w: 1440 },
  { id: "FIN-09", route: "/dashboard/finance", w: 1024 },
  { id: "FIN-10", route: "/dashboard/finance", w: 1440, user: "fin.manager.en" },
  // Dialogs, driven through the real UI (element screenshots of the dialog panel).
  { id: "FIN-07a", route: "/dashboard/finance", w: 1440, user: "fin.approver", dialog: async (p) => { await p.getByRole("button", { name: /الموافقات/ }).click(); await p.getByText("نقل 5000.00").first().click().catch(() => p.locator("[role=dialog] button.text-start").first().click()); } },
  { id: "FIN-07b", route: "/dashboard/finance/transactions", w: 1440, dialog: async (p) => {
      await p.getByRole("button", { name: /استيراد CSV/ }).click();
      await p.locator("[role=dialog] input[type=file]").setInputFiles({ name: "snb-statement-oct.csv", mimeType: "text/csv", buffer: Buffer.from("Date,Amount,Reference,Description\n2026-09-26,2300.00,TRF88213,INCOMING TRANSFER 88213\n2026-09-26,125.00,,Cafe sale\n2026-09-26,125.00,,Cafe sale\n31/09/2026,10.00,,bad date\n2026-09-25,\"1,20\",,bad amount\n") });
      await p.getByRole("button", { name: /^معاينة$/ }).click();
      await p.waitForTimeout(800);
    } },
  { id: "FIN-07c", route: "/dashboard/finance/allocation", w: 1440, dialog: async (p) => {
      await p.getByRole("button", { name: /^طلب دفع$/ }).first().click();
      const d = p.locator("[role=dialog]");
      await d.locator("select").nth(0).selectOption({ label: /شراء البن الأخضر/ }).catch(async () => { const opts = await d.locator("select").nth(0).locator("option").allTextContents(); await d.locator("select").nth(0).selectOption({ index: opts.findIndex((o) => o.includes("شراء البن الأخضر")) }); });
      await p.waitForTimeout(500);
      const o = await d.locator("select").nth(1).locator("option").allTextContents();
      await d.locator("select").nth(1).selectOption({ index: o.findIndex((x) => x.includes("كولومبيا")) });
      await p.waitForTimeout(300);
    } },
  // "Record payment made": needs an ACTIVE reservation and a pending outgoing line, created
  // through the real API first (the base fixture executes all of its reservations).
  { id: "FIN-07d", route: "/dashboard/finance/allocation", w: 1440, dialog: async (p) => {
      await p.evaluate(async () => {
        const j = (u, b) => fetch(u, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) }).then((r) => r.json());
        const cats = await fetch("/api/finance/categories").then((r) => r.json());
        const list = Array.isArray(cats) ? cats : cats.rows ?? cats.categories;
        const green = list.find((c) => /GREEN/.test(c.code));
        await j("/api/finance/reservations", { categoryId: green.id, amount: "4800.00", payee: "Andes Coffee Export", purpose: "Sample lot — Huila", idempotencyKey: crypto.randomUUID() });
        const accs = await fetch("/api/finance/accounts").then((r) => r.json());
        const snb = (Array.isArray(accs) ? accs : accs.rows ?? accs.accounts).find((a) => a.code === "SNB-CUR");
        await j("/api/finance/transactions", { cashAccountId: snb.id, amount: "-4800.00", txnDate: "2026-09-26", status: "PENDING", bankReference: "TRF-AC790", description: "Andes Coffee Export — sample lot", idempotencyKey: crypto.randomUUID() });
      });
      await p.reload(); await p.waitForLoadState("networkidle");
      await p.locator("tr", { hasText: "Andes Coffee Export" }).getByRole("button", { name: "تسجيل الدفع المنفّذ" }).click();
      const d = p.locator("[role=dialog]");
      await p.waitForTimeout(600);
      const o = await d.locator("select").locator("option").allTextContents();
      await d.locator("select").selectOption({ index: o.findIndex((x) => x.includes("sample lot")) });
    } },
  { id: "FIN-08-noperm", route: "/dashboard/finance", w: 1440, user: "no.finance" },
];



async function login(page, user, password) {
  await page.goto(`${BASE}/login`);
  const r = await page.evaluate(async ([u, p]) => (await fetch("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ method: "password", username: u, password: p }) })).status, [user, password]);
  if (r !== 200) throw new Error(`login failed ${r}`);
}

const browser = await chromium.launch({ channel: "chrome" });
try {
  const user = process.env.FIN_USER ?? "fin.manager";
  for (const s of SHOTS.filter((x) => only === "all" || only.split(",").includes(x.id))) {
    const ctx = await browser.newContext({ viewport: { width: s.w, height: 900 }, locale: "en-GB" });
    const page = await ctx.newPage();
    await login(page, s.user ?? user, process.env.FIN_PASSWORD);
    await page.goto(`${BASE}${s.route}`);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(800);
    if (s.open === "first-review") {
      await page.locator("tbody tr").first().click();
      await page.waitForLoadState("networkidle");
      await page.waitForTimeout(600);
    }
    const file = path.join(out, `${s.id}-app-${s.w}.png`);
    if (s.dialog) {
      await s.dialog(page);
      await page.waitForLoadState("networkidle");
      await page.waitForTimeout(500);
      await page.locator("[role=dialog]").screenshot({ path: file });
      console.log("captured", file);
      await ctx.close();
      continue;
    }
    // Full height without touching the app's CSS: grow the viewport to the height of the
    // scrolling <main> content (the unclip stylesheet distorted the 1024px layout).
    const extra = await page.evaluate(() => { const m = document.querySelector("main"); return m ? m.scrollHeight - m.clientHeight : 0; });
    if (extra > 0) { await page.setViewportSize({ width: s.w, height: 900 + extra }); await page.waitForTimeout(500); }
    await page.screenshot({ path: file });
    console.log("captured", file);
    await ctx.close();
  }
} finally {
  await browser.close();
}
