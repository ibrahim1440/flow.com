// Captures Finance UI states and the 1024px breakpoint for review (local fixture server only).
//
//   BASE_URL=http://localhost:3040 FIN_PASSWORD=... node tests/finance/visual/states.mjs <outDir>
//
// All captures are Chrome (Playwright, channel "chrome") viewport EMULATION on this machine,
// not physical devices. Each capture records the measured window.innerWidth, the document's
// clientWidth (innerWidth minus any classic scrollbar), the lg media query result, and whether
// the sidebar is on-canvas — written to <outDir>/states-manifest.json.
//
// States:
//   loading    API requests to /api/finance/* are held open (route interception) — the real
//              LoadingState, captured while waiting.
//   error      /api/finance/overview answered with HTTP 500 by interception — the real ErrorState.
//   empty      fin.viewer has Finance access but no branch access: the API returns an empty
//              scope, so the real EmptyState renders (no interception).
//   validation The manual-entry dialog submitted with an invalid amount — real client validation.
//   noperm     no.finance (no Finance module) — the real NoPermission screen.
import { chromium } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const BASE = process.env.BASE_URL ?? "http://localhost:3040";
if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(BASE)) throw new Error("Refusing to run against a non-local server.");
const out = process.argv[2] ?? "finance-states";
mkdirSync(out, { recursive: true });
const manifest = { browser: null, emulation: "Playwright Chrome viewport emulation (not a physical device)", captures: [] };

const browser = await chromium.launch({ channel: "chrome" });
manifest.browser = `Chrome ${browser.version()}`;

async function session(user, width, height = 900) {
  const ctx = await browser.newContext({ viewport: { width, height }, locale: "en-GB" });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/login`);
  const st = await page.evaluate(async ([u, p]) => (await fetch("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ method: "password", username: u, password: p }) })).status, [user, process.env.FIN_PASSWORD]);
  if (st !== 200) throw new Error(`login ${user}: ${st}`);
  return { ctx, page };
}
async function metrics(page) {
  return page.evaluate(() => {
    const aside = document.querySelector("aside");
    const r = aside ? aside.getBoundingClientRect() : null;
    return {
      innerWidth: window.innerWidth,
      clientWidth: document.documentElement.clientWidth,
      lgMediaQuery: window.matchMedia("(min-width: 1024px)").matches,
      sidebarOnCanvas: !!r && r.right > 0 && r.left < window.innerWidth,
      menuButtonVisible: [...document.querySelectorAll("header button")].some((b) => b.offsetParent !== null && b.querySelector("svg.lucide-menu")),
      horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    };
  });
}
async function shot(page, id, note, opts = {}) {
  const file = path.join(out, `${id}.png`);
  if (opts.element) await page.locator(opts.element).first().screenshot({ path: file });
  else await page.screenshot({ path: file, fullPage: false });
  const m = await metrics(page);
  manifest.captures.push({ id, file: path.basename(file), note, ...m });
  console.log("captured", id, JSON.stringify(m));
}

try {
  // Loading — hold every finance API call; capture the spinner, then release.
  {
    const { ctx, page } = await session("fin.manager", 1440);
    const held = [];
    await page.route("**/api/finance/**", (route) => { held.push(route); });
    await page.goto(`${BASE}/dashboard/finance`, { waitUntil: "domcontentloaded" });
    await page.getByRole("status").first().waitFor({ timeout: 10_000 }).catch(() => {});
    await page.waitForTimeout(700);
    await shot(page, "STATE-loading-1440", "API requests held open by interception; real LoadingState");
    await page.unroute("**/api/finance/**");
    for (const r of held) await r.continue().catch(() => {});
    await ctx.close();
  }
  // Error — the overview endpoint answers 500.
  {
    const { ctx, page } = await session("fin.manager", 1440);
    await page.route("**/api/finance/overview**", (route) => route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "Injected failure (test)" }) }));
    await page.goto(`${BASE}/dashboard/finance`);
    await page.getByText("تعذّر تحميل البيانات").waitFor();
    await shot(page, "STATE-error-1440", "HTTP 500 injected on /api/finance/overview; real ErrorState with retry");
    await ctx.close();
  }
  // Empty — real empty scope.
  {
    const { ctx, page } = await session("fin.viewer", 1440);
    await page.goto(`${BASE}/dashboard/finance`);
    await page.getByText("لا توجد حسابات بنكية أو نقدية بعد").waitFor();
    await shot(page, "STATE-empty-1440", "fin.viewer: Finance access, no branch access → empty scope; real EmptyState, no interception");
    await ctx.close();
  }
  // Validation — manual entry with an invalid amount.
  {
    const { ctx, page } = await session("fin.manager", 1440);
    await page.goto(`${BASE}/dashboard/finance/transactions`);
    await page.getByRole("button", { name: "قيد يدوي" }).click();
    const d = page.locator("[role=dialog]");
    await d.getByLabel("المبلغ (سالب للمبالغ الصادرة)").fill("12.345");
    await d.getByLabel("التاريخ").fill("");
    await d.getByRole("button", { name: "حفظ" }).click();
    await page.waitForTimeout(400);
    await shot(page, "STATE-validation-dialog", "Manual entry: 3-decimal amount and empty date → field errors, nothing saved", { element: "[role=dialog]" });
    await d.getByLabel("المبلغ (سالب للمبالغ الصادرة)").fill("-250.00");
    await d.getByLabel("التاريخ").fill("2030-01-01");
    await d.getByRole("button", { name: "حفظ" }).click();
    await page.waitForTimeout(400);
    await shot(page, "STATE-validation-future-confirmed", "Manual entry: a CONFIRMED line dated in the future is refused (record it as pending)", { element: "[role=dialog]" });
    await ctx.close();
  }
  // No permission.
  {
    const { ctx, page } = await session("no.finance", 1440);
    await page.goto(`${BASE}/dashboard/finance`);
    await page.waitForLoadState("networkidle");
    await shot(page, "STATE-noperm-1440", "no.finance: no Finance module → NoPermission; API also 403 (tests/finance/http)");
    await ctx.close();
  }
  // Breakpoint: just below, at and above 1024 CSS px.
  for (const w of [1023, 1024, 1025]) {
    const { ctx, page } = await session("fin.manager", w);
    await page.goto(`${BASE}/dashboard/finance`);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(600);
    await shot(page, `BP-${w}`, `Overview at ${w}px viewport`);
    if (w === 1023) {
      await page.locator("header button").filter({ has: page.locator("svg.lucide-menu") }).first().click();
      await page.waitForTimeout(500);
      await shot(page, "BP-1023-drawer-open", "Below lg: navigation opens as an overlay drawer from the menu button");
    }
    await ctx.close();
  }
  // Same breakpoint check for the widest table screen.
  for (const w of [1023, 1025]) {
    const { ctx, page } = await session("fin.manager", w);
    await page.goto(`${BASE}/dashboard/finance/budget`);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(600);
    await shot(page, `BP-${w}-budget`, `Monthly budget table at ${w}px (table scrolls inside its card; page must not overflow)`);
    await ctx.close();
  }
} finally {
  await browser.close();
  writeFileSync(path.join(out, "states-manifest.json"), JSON.stringify(manifest, null, 2));
}
