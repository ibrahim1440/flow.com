import { test, expect, type Page } from "@playwright/test";
import { loginAs } from "./support/app";
import { exec } from "./support/db";
import { TAG } from "./support/global-setup";

// The workstation screens live on whatever is propped next to the roaster, so they are
// measured at tablet size as well as desktop. The assertions are geometric rather than
// visual: nothing may sit outside the viewport, no page may scroll sideways, and any
// table too wide to fit must scroll inside its own container instead of pushing the page.

const OPERATIONAL_SCREENS: { path: string; role: Parameters<typeof loginAs>[1]; name: string }[] = [
  { path: "/dashboard/orders", role: "sales", name: "Orders" },
  { path: "/dashboard/workstation/preparation", role: "sales", name: "Order Preparation" },
  { path: "/dashboard/production", role: "production", name: "Production" },
  { path: "/dashboard/production-orders", role: "production", name: "Production Orders" },
  { path: "/dashboard/qc", role: "qc", name: "Quality Control" },
  { path: "/dashboard/packaging", role: "packaging", name: "Packaging" },
  { path: "/dashboard/dispatch", role: "dispatch", name: "Dispatch" },
];

/** No screen may push the document wider than the window. */
async function expectNoHorizontalOverflow(page: Page, label: string) {
  const overflow = await page.evaluate(() => ({
    doc: document.documentElement.scrollWidth,
    win: window.innerWidth,
  }));
  expect(
    overflow.doc,
    `${label}: the page scrolls sideways (${overflow.doc}px of content in a ${overflow.win}px window)`
  ).toBeLessThanOrEqual(overflow.win + 1);
}

/** Every visible control must be reachable inside the viewport. */
async function expectControlsInView(page: Page, label: string) {
  const offscreen = await page.evaluate(() => {
    const bad: string[] = [];
    const w = window.innerWidth;
    for (const el of Array.from(document.querySelectorAll("button, a[href], select, input"))) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;              // hidden
      if (getComputedStyle(el).visibility === "hidden") continue;
      // Inside a horizontally scrollable container the control is reachable by scrolling.
      let p: HTMLElement | null = el.parentElement;
      let scrollable = false;
      while (p) {
        const ov = getComputedStyle(p).overflowX;
        if ((ov === "auto" || ov === "scroll") && p.scrollWidth > p.clientWidth) { scrollable = true; break; }
        p = p.parentElement;
      }
      if (scrollable) continue;
      if (r.right > w + 1 || r.left < -1) {
        bad.push(`${el.tagName.toLowerCase()}"${(el.textContent || "").trim().slice(0, 28)}" at ${Math.round(r.left)}..${Math.round(r.right)}`);
      }
    }
    return bad;
  });
  expect(offscreen, `${label}: controls sit outside the viewport`).toEqual([]);
}

/** A table wider than its space must scroll inside its own container. */
async function expectTablesContained(page: Page, label: string) {
  const bad = await page.evaluate(() => {
    const problems: string[] = [];
    for (const table of Array.from(document.querySelectorAll("table"))) {
      const holder = table.parentElement;
      if (!holder) continue;
      if (table.scrollWidth > holder.clientWidth + 1) {
        const ov = getComputedStyle(holder).overflowX;
        if (ov !== "auto" && ov !== "scroll") {
          problems.push(`a ${table.scrollWidth}px table in a ${holder.clientWidth}px container that does not scroll`);
        }
      }
    }
    return problems;
  });
  expect(bad, `${label}: an unusable table`).toEqual([]);
}

for (const screen of OPERATIONAL_SCREENS) {
  test(`${screen.name} is usable at this viewport`, async ({ page }, testInfo) => {
    const label = `${screen.name} @ ${testInfo.project.name}`;
    await loginAs(page, screen.role);
    await page.goto(screen.path);
    // Let the client data land, so the measurements are of the real screen and not a spinner.
    await page.waitForLoadState("networkidle").catch(() => {});
    await page.waitForTimeout(2500);

    await expectNoHorizontalOverflow(page, label);
    await expectControlsInView(page, label);
    await expectTablesContained(page, label);

    // The screen's primary action must be reachable, not merely present.
    const anyAction = page.getByRole("button").first();
    await expect(anyAction, `${label}: no usable control on the screen`).toBeVisible();
  });
}

test("A modal fits inside the viewport and its buttons stay reachable", async ({ page }, testInfo) => {
  await loginAs(page, "sales");
  await page.goto("/dashboard/orders");
  await page.getByRole("button", { name: /New Order/i }).click();

  const modal = page.locator("div.fixed").filter({ hasText: /New Order/i }).first();
  await expect(modal).toBeVisible();

  const box = await modal.locator("> div").first().boundingBox();
  const view = page.viewportSize()!;
  expect(box, "the dialog has a measurable box").not.toBeNull();
  expect(box!.width, `dialog wider than the ${testInfo.project.name} viewport`).toBeLessThanOrEqual(view.width);
  expect(box!.x, "dialog starts off the left edge").toBeGreaterThanOrEqual(-1);
  expect(box!.x + box!.width, "dialog runs past the right edge").toBeLessThanOrEqual(view.width + 1);

  // Its actions have to be reachable — the dialog scrolls internally when it is too tall.
  await expect(modal.getByRole("button", { name: /Create Order/i })).toBeVisible();
  await expect(modal.getByRole("button", { name: /^Cancel$/i })).toBeVisible();
  await expectNoHorizontalOverflow(page, `New Order dialog @ ${testInfo.project.name}`);
});

test("The Arabic layout flips to right-to-left without breaking the page", async ({ page }, testInfo) => {
  // Language follows the employee's own preference, so it is switched the way an Arabic
  // speaker's account would be configured rather than by a URL flag.
  await exec(`UPDATE "Employee" SET "preferredLanguage"='ar' WHERE id=$1`, [`${TAG}_emp_production`]);
  try {
    await loginAs(page, "production");
    await page.goto("/dashboard/production-orders");
    await page.waitForLoadState("networkidle").catch(() => {});
    await page.waitForTimeout(2500);

    const dir = await page.evaluate(() => document.documentElement.getAttribute("dir") || getComputedStyle(document.body).direction);
    expect(dir, "the document flips to right-to-left").toMatch(/rtl/i);

    const label = `Production Orders (Arabic) @ ${testInfo.project.name}`;
    await expectNoHorizontalOverflow(page, label);
    await expectControlsInView(page, label);
    await expectTablesContained(page, label);

    // Arabic strings must actually be rendered, not English left in place.
    const body = await page.locator("main").innerText();
    expect(body, "the screen is translated, not just mirrored").toMatch(/[؀-ۿ]/);
  } finally {
    await exec(`UPDATE "Employee" SET "preferredLanguage"='en' WHERE id=$1`, [`${TAG}_emp_production`]);
  }
});
