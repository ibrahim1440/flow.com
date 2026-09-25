/**
 * THE "RECORD A COLLECTION" ACTION — what a person actually sees.
 *
 * This suite exists because of a specific report: a reviewer looking at their own Won deal,
 * with an accepted quotation and 1,150.00 outstanding, found no «تسجيل تحصيل» button and
 * nothing on the screen explaining why. Two things were true at once — their role predated
 * the `collection_submit` privilege, so the server correctly said the action was
 * unavailable; and the panel rendered *nothing at all* when it could not offer the button,
 * so there was no way to tell a withheld action from a broken one.
 *
 * The rule these tests encode: when the action is unavailable the screen says which reason,
 * and when it is available the button is there and opens a form already bound to the deal
 * and its accepted quotation.
 *
 * ── What this suite does NOT prove ──
 * Nothing here is authorisation evidence. The components are mounted against fixture
 * `fetch`, so a fixture claiming `available: true` produces a button whatever the real
 * server would have said. That the SERVER withholds the action from the wrong caller is
 * proven in `scripts/e2e/regression/sales-collections.mjs`, against PostgreSQL over HTTP.
 */
import { test, expect, type Page } from "@playwright/test";
import path from "node:path";
import { pathToFileURL } from "node:url";

const HARNESS = pathToFileURL(path.join(__dirname, "index.html")).href;

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { ROUTES, REP } = require("./routes.mjs") as {
  ROUTES: Record<string, { screen: string; api: Record<string, unknown> }>;
  REP: unknown;
};

async function mount(page: Page, routeName: string) {
  const spec = ROUTES[routeName];
  if (!spec) throw new Error(`no fixture named ${routeName}`);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(HARNESS);
  await page.evaluate(
    ([r, u]) => {
      (window as never as Record<string, unknown>).__ROUTES__ = r;
      (window as never as Record<string, unknown>).__USER__ = u;
      (window as never as Record<string, unknown>).__LANG__ = "ar";
      (window as never as Record<string, unknown>).__PARAMS__ = { id: "d1" };
      document.documentElement.setAttribute("dir", "rtl");
      document.documentElement.setAttribute("lang", "ar");
    },
    [spec.api, REP] as const,
  );
  await page.evaluate(
    (s) => (window as never as { mountScreen: (s: string) => void }).mountScreen(s),
    spec.screen,
  );
  await page.waitForTimeout(500);
}

test.describe("the record-a-collection action", () => {
  test("1. an eligible owned deal offers the button", async ({ page }) => {
    await mount(page, "sales-deal-collection-available");

    const button = page.getByTestId("record-collection");
    await expect(button, "the reported case must show the action").toHaveCount(1);
    await expect(button).toBeVisible();
    await expect(button).toContainText("تسجيل تحصيل");

    // And no warning, because there is nothing to warn about.
    await expect(page.getByTestId("collection-unavailable")).toHaveCount(0);

    // The panel is reachable by the anchor the quotation page links to.
    await expect(page.locator("#collections")).toHaveCount(1);
  });

  test("2. clicking it opens the form bound to this deal and its accepted quotation", async ({ page }) => {
    await mount(page, "sales-deal-collection-available");
    await page.getByTestId("record-collection").click();
    await page.waitForTimeout(300);

    const dialog = page.locator("[role=dialog]");
    await expect(dialog).toBeVisible();

    // The accepted quotation is named in the form, not chosen by the person: one deal has
    // one eligible document and picking it would be a way to pick the wrong one.
    await expect(dialog).toContainText("Q-202609-0012");
    // The outstanding figure it is bounded by.
    await expect(dialog).toContainText("1,150.00");
    // The amount field starts empty — a prefilled total is a total people accept without reading.
    await expect(page.getByTestId("confirm-collection")).toBeDisabled();
  });

  test("4. a user without the privilege is told why, not shown a blank space", async ({ page }) => {
    await mount(page, "sales-deal-collection-no-privilege");

    await expect(page.getByTestId("record-collection")).toHaveCount(0);

    const reason = page.getByTestId("collection-unavailable");
    await expect(reason, "the reason must be on the screen, not implied by absence").toBeVisible();
    await expect(reason).toHaveAttribute("data-reason", "NO_PRIVILEGE");
    // It names the permission and where it is granted, so the reader knows who to ask.
    await expect(reason).toContainText("صلاحية");
    await expect(reason).toContainText("تسجيل تحصيل");

    // The figures are still shown: withholding the action does not withhold the deal.
    await expect(page.getByTestId("collection-state")).toBeVisible();
  });

  test("4b. a deal with no accepted quotation says that instead", async ({ page }) => {
    await mount(page, "sales-deal-collection-no-document");

    await expect(page.getByTestId("record-collection")).toHaveCount(0);
    const reason = page.getByTestId("collection-unavailable");
    await expect(reason).toBeVisible();
    await expect(reason).toHaveAttribute("data-reason", "NO_ACCEPTED_DOCUMENT");
    await expect(reason).toContainText("عرض سعر مقبول");
  });

  test("7. once nothing is outstanding the button is gone, and no warning replaces it", async ({ page }) => {
    await mount(page, "sales-deal-collection-settled");

    await expect(page.getByTestId("record-collection")).toHaveCount(0);
    // Deliberately no banner here: the state chip already reads "fully collected", and a
    // warning would make a finished deal look like a fault.
    await expect(page.getByTestId("collection-unavailable")).toHaveCount(0);
    await expect(page.getByTestId("collection-state")).toContainText("محصَّل بالكامل");
  });

  test("the four verdicts are visibly different from one another", async ({ page }) => {
    // A guard against the whole panel silently rendering the same thing every time, which is
    // what the original defect looked like from the outside.
    const seen: string[] = [];
    for (const name of [
      "sales-deal-collection-available",
      "sales-deal-collection-no-privilege",
      "sales-deal-collection-no-document",
      "sales-deal-collection-settled",
    ]) {
      await mount(page, name);
      const hasButton = (await page.getByTestId("record-collection").count()) > 0;
      const reason = (await page.getByTestId("collection-unavailable").count()) > 0
        ? await page.getByTestId("collection-unavailable").getAttribute("data-reason")
        : "none";
      seen.push(`${hasButton ? "button" : "no-button"}/${reason}`);
    }
    expect(new Set(seen).size, `each verdict must render distinctly: ${seen.join(", ")}`).toBe(4);
  });
});
