// Integration candidate only: the Finance entry inside the sales branch's navigation registry.
//   BASE_URL=http://localhost:3070 FIN_PASSWORD=... node tests/finance/visual/nav-integration.mjs
// Local fixture server only. Asserts, per role, what the sidebar offers and what the shell
// lets the user open.
import { chromium } from "@playwright/test";
import assert from "node:assert/strict";

const BASE = process.env.BASE_URL ?? "http://localhost:3070";
if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(BASE)) throw new Error("Refusing to run against a non-local server.");

const CASES = [
  // user, sees Finance group, sees Cash & budget, sees Accounting, may open /dashboard/finance
  { user: "fin.manager", group: true, cash: true, accounting: false, open: true, why: "Finance module, no accounting" },
  { user: "no.finance", group: false, cash: false, accounting: false, open: false, why: "neither Finance nor accounting" },
  { user: "legacy.admin", group: true, cash: false, accounting: true, open: false, why: "administrator whose stored permissions predate Finance: keeps Accounting, no Finance until granted" },
  { user: "fin.approver", group: true, cash: true, accounting: false, open: true, why: "approver with Finance duties" },
];

const browser = await chromium.launch({ channel: "chrome" });
const results = [];
try {
  for (const c of CASES) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    await page.goto(`${BASE}/login`);
    const st = await page.evaluate(async ([u, p]) => (await fetch("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ method: "password", username: u, password: p }) })).status, [c.user, process.env.FIN_PASSWORD]);
    assert.equal(st, 200, `login ${c.user}`);
    await page.goto(`${BASE}/dashboard`);
    await page.waitForLoadState("networkidle");
    const group = page.getByTestId("navgroup-finance");
    const hasGroup = (await group.count()) > 0;
    let hasCash = false, hasAccounting = false, cashHref = null;
    if (hasGroup) {
      if ((await group.getAttribute("aria-expanded")) !== "true") await group.click();
      hasCash = (await page.getByTestId("nav-finance.cash").count()) > 0;
      hasAccounting = (await page.getByTestId("nav-finance.accounting").count()) > 0;
      if (hasCash) cashHref = await page.getByTestId("nav-finance.cash").getAttribute("href");
    }
    await page.goto(`${BASE}/dashboard/finance`);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(500);
    const opened = (await page.getByText("المالية — النقد والميزانية").count()) > 0;
    results.push({ user: c.user, why: c.why, group: hasGroup, cash: hasCash, accounting: hasAccounting, opened });
    assert.equal(hasGroup, c.group, `${c.user}: Finance group`);
    assert.equal(hasCash, c.cash, `${c.user}: Cash & budget entry`);
    assert.equal(hasAccounting, c.accounting, `${c.user}: Accounting entry`);
    assert.equal(opened, c.open, `${c.user}: can open /dashboard/finance`);
    if (hasCash) assert.equal(cashHref, "/dashboard/finance");
    console.log("✔", c.user, "—", c.why, JSON.stringify({ group: hasGroup, cash: hasCash, accounting: hasAccounting, opened }));
    await ctx.close();
  }
  console.log(`\n${results.length} navigation cases passed`);
} finally {
  await browser.close();
}
