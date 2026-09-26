import { test, expect, type Page } from "@playwright/test";
import { loginAs } from "./support/app";

/**
 * The navigation shell's own contract.
 *
 * The three-level navigation replaced a flat list of nineteen links, and the things that
 * make it usable are invisible to a screenshot: which entry claims to be current, whether
 * a group reports its state, and whether a keyboard user can get out of the drawer. None
 * of it is covered by the workflow suites, which drive the pages rather than the chrome,
 * and document-level overflow already has a home in responsive.spec.ts.
 */

test.describe.configure({ mode: "serial" });

async function shellReady(page: Page) {
  const nav = page.locator("nav").first();
  await nav.getByRole("link", { name: /Dashboard|لوحة التحكم/ })
    .waitFor({ state: "visible", timeout: 30_000 });
  return nav;
}

test("the sidebar marks exactly one current destination", async ({ page }) => {
  await loginAs(page, "admin");
  await page.goto("/dashboard/workstation/preparation");
  const nav = await shellReady(page);

  // Two highlighted entries is the bug the old prefix matching produced: "production"
  // lit up while the operator was on "production-orders".
  await expect(nav.locator('[aria-current="page"]')).toHaveCount(1);
  await expect(nav.locator('[aria-current="page"]'))
    .toHaveText(/Order Preparation|تجهيز الطلبات/);
});

test("groups report their expanded state, and disclose their pages", async ({ page }) => {
  await loginAs(page, "admin");
  await page.goto("/dashboard");
  const nav = await shellReady(page);

  const groups = nav.locator("button[aria-expanded]");
  expect(await groups.count(), "the sidebar should be grouped, not flat").toBeGreaterThan(0);

  // A collapsed group renders none of its children; opening it must reveal them, and the
  // control must say so rather than leaving a screen reader to infer it.
  const first = groups.first();
  const before = await nav.getByRole("link").count();
  await expect(first).toHaveAttribute("aria-expanded", "false");
  await first.click();
  await expect(first).toHaveAttribute("aria-expanded", "true");
  expect(await nav.getByRole("link").count(),
    "expanding a group must reveal its destinations").toBeGreaterThan(before);
});

test("the breadcrumb names the branch the page belongs to", async ({ page }) => {
  await loginAs(page, "admin");
  await page.goto("/dashboard/workstation/preparation");
  await page.locator("header").waitFor({ state: "visible", timeout: 30_000 });

  const crumbs = page.getByRole("navigation", { name: /Breadcrumb|مسار التنقل/ });
  const text = (await crumbs.locator("li").allInnerTexts()).join(" ");
  // Preparation is fulfilment work and lives under Operations, not under Sales.
  expect(text).toMatch(/Operations|العمليات/);
  expect(text).toMatch(/Order Preparation|تجهيز الطلبات/);
  // Only the last crumb is the page itself.
  await expect(crumbs.locator('[aria-current="page"]')).toHaveCount(1);
});

test("the mobile drawer closes on Escape and gives focus back", async ({ page }) => {
  await loginAs(page, "admin");
  await page.goto("/dashboard");
  await shellReady(page);
  await page.setViewportSize({ width: 390, height: 760 });

  const opener = page.getByRole("button", { name: /Open menu|فتح القائمة/ });
  await expect(opener).toBeVisible();
  await expect(opener).toHaveAttribute("aria-expanded", "false");

  await opener.click();
  await expect(opener).toHaveAttribute("aria-expanded", "true");

  // Without the focus return, closing the drawer drops the caret at the top of the
  // document and a keyboard user has to tab through the whole page to get back.
  await page.keyboard.press("Escape");
  await expect(opener).toHaveAttribute("aria-expanded", "false");
  await expect(opener).toBeFocused();
});

test("navigation destinations are real links, and disclosures are not", async ({ page }) => {
  await loginAs(page, "admin");
  await page.goto("/dashboard");
  const nav = await shellReady(page);

  // Middle-click, ctrl-click and "open in new tab" only work on a real href. Everything
  // that navigates is a link; only the group disclosures, which navigate nowhere, are
  // buttons.
  const links = nav.getByRole("link");
  const count = await links.count();
  expect(count).toBeGreaterThan(0);
  for (let i = 0; i < count; i++) {
    const href = await links.nth(i).getAttribute("href");
    expect(href, "every navigation entry needs a real href").toBeTruthy();
    expect(href!.startsWith("/"), `href should be a route, got ${href}`).toBeTruthy();
  }
});
