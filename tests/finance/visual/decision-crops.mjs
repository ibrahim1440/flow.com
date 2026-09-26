// Application crops for the visual decision sheet (docs/finance/DECISIONS.md), taken from the
// running app on the local fixture. Each crop is the card whose title is given, so it lines up
// with the Figma node exported for the same decision.
//
//   BASE_URL=http://localhost:3040 FIN_PASSWORD=... node tests/finance/visual/decision-crops.mjs docs/finance/decisions
import { chromium } from "@playwright/test";
import path from "node:path";

const BASE = process.env.BASE_URL ?? "http://localhost:3040";
if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(BASE)) throw new Error("Refusing to run against a non-local server.");
const out = process.argv[2] ?? "decisions";

const CROPS = [
  { id: "D2-review-panel", route: "/dashboard/finance/transactions", title: "مراجعة سطر بنكي", before: async (p) => { await p.locator("tbody tr").first().click(); await p.waitForTimeout(800); } },
  { id: "D3-categories", route: "/dashboard/finance/allocation", title: /^فئات التخصيص/ },
  { id: "D4-toolbar", route: "/dashboard/finance/budget", selector: "select[aria-label=\"الشهر\"]", card: true },
  { id: "D4-comparison", route: "/dashboard/finance/budget", title: "المقارنة الشهرية" },
  { id: "D5-obligations", route: "/dashboard/finance/obligations", title: "الالتزامات المفتوحة" },
  { id: "D6-accounts", route: "/dashboard/finance/reports", title: "الحسابات البنكية والنقدية" },
  { id: "D6-branches", route: "/dashboard/finance/reports", title: "الفروع والوصول" },
  { id: "D6-budget-categories", route: "/dashboard/finance/reports", title: "بنود الميزانية النقدية" },
];

const browser = await chromium.launch({ channel: "chrome" });
try {
  for (const c of CROPS) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 2600 } });
    const page = await ctx.newPage();
    await page.goto(`${BASE}/login`);
    await page.evaluate(async ([u, p]) => fetch("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ method: "password", username: u, password: p }) }), ["fin.manager", process.env.FIN_PASSWORD]);
    await page.goto(`${BASE}${c.route}`);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(800);
    if (c.before) await c.before(page);
    const anchor = c.selector ? page.locator(c.selector).first() : page.getByText(c.title, { exact: typeof c.title === "string" }).first();
    await anchor.waitFor();
    const handle = await anchor.evaluateHandle((el) => el.closest(".rounded-2xl") ?? el);
    await handle.asElement().screenshot({ path: path.join(out, `${c.id}-app.png`) });
    console.log("captured", c.id);
    await ctx.close();
  }
} finally {
  await browser.close();
}
