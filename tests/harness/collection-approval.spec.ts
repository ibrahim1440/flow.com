/**
 * THE VERIFICATION QUEUE — what each audience sees on the same pending collection.
 *
 * Reported: Finance could not approve a 575.00 collection. Two causes, and only one was a
 * privilege. The Finance role holds no sales module by design, so the queue — which lives
 * under Sales — had no nav entry for them at all; and every unavailable action rendered as
 * an empty cell, so "you lack the privilege", "this is not your job" and "you recorded this
 * one yourself" were three different situations that looked identical.
 *
 * These mount the real queue against the three payload shapes the server produces.
 *
 * ── What this suite does NOT prove ──
 * Not authorisation. The decision verdicts here are fixtures; a fixture claiming
 * `allowed: true` produces a button whatever the real server would say. That the SERVER
 * grants Finance and refuses the manager and the submitter is proven in
 * `scripts/e2e/regression/sales-collections.mjs` section E, over HTTP against PostgreSQL
 * with three separate logins.
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
      (window as never as Record<string, unknown>).__PARAMS__ = {};
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

test.describe("the collection verification queue", () => {
  test("3. Finance is offered approve and reject, in full words", async ({ page }) => {
    await mount(page, "sales-collections-finance");

    const approve = page.getByTestId("approve-scq");
    const reject = page.getByTestId("reject-scq");
    await expect(approve).toBeVisible();
    await expect(reject).toBeVisible();
    await expect(approve).toContainText("اعتماد التحصيل");
    await expect(reject).toContainText("رفض التحصيل");

    // Not offered, because the row is not approved yet.
    await expect(page.getByTestId("reverse-scq")).toHaveCount(0);
    // And no "why not" chip, because an action IS available.
    await expect(page.getByTestId("decision-blocked-scq")).toHaveCount(0);
  });

  test("3b. opening it shows the figures the decision rests on, and the evidence", async ({ page }) => {
    await mount(page, "sales-collections-finance");
    await page.getByTestId("open-scq").click();
    await page.waitForTimeout(300);

    const figures = page.getByTestId("detail-figures");
    await expect(figures).toBeVisible();
    await expect(figures, "gross received").toContainText("575.00");
    await expect(figures, "derived VAT").toContainText("75.00");
    await expect(figures, "net basis the commission is computed on").toContainText("500.00");

    // What approving would be worth, said before the decision rather than after.
    const commission = page.getByTestId("detail-commission");
    await expect(commission).toContainText("5.00");
    await expect(commission, "and labelled an estimate that is in no total yet").toContainText("تقدير");

    // The evidence, linked to the one route that returns the bytes.
    const evidence = page.getByTestId("detail-evidence-ev1");
    await expect(evidence).toBeVisible();
    await expect(evidence).toContainText("receipt.pdf");
    await expect(evidence).toHaveAttribute(
      "href",
      "/api/sales/collections/scq/evidence/ev1",
    );

    // Both decisions reachable from the opened collection too.
    await expect(page.getByTestId("detail-approve")).toContainText("اعتماد التحصيل");
    await expect(page.getByTestId("detail-reject")).toContainText("رفض التحصيل");
  });

  test("2. a sales manager sees the collection but is told why they cannot decide", async ({ page }) => {
    await mount(page, "sales-collections-manager");

    // The row is there — seeing is not deciding.
    await expect(page.getByTestId("collection-scq")).toBeVisible();

    await expect(page.getByTestId("approve-scq")).toHaveCount(0);
    await expect(page.getByTestId("reject-scq")).toHaveCount(0);

    const why = page.getByTestId("decision-blocked-scq");
    await expect(why, "an empty cell is not an explanation").toBeVisible();
    await expect(why).toHaveAttribute("data-reason", "NO_PRIVILEGE");
    await expect(why).toContainText("صلاحية");
  });

  test("5. the submitter is told it is theirs, not that they lack a privilege", async ({ page }) => {
    await mount(page, "sales-collections-self");

    await expect(page.getByTestId("approve-scq")).toHaveCount(0);
    await expect(page.getByTestId("reject-scq")).toHaveCount(0);

    const why = page.getByTestId("decision-blocked-scq");
    await expect(why).toBeVisible();
    await expect(why, "the reason must be the separation of duties").toHaveAttribute(
      "data-reason",
      "SELF_SUBMITTED",
    );
    await expect(why).toContainText("أنت من سجّل هذا التحصيل");

    // And the same reason inside the opened collection, where the buttons would have been.
    await page.getByTestId("open-scq").click();
    await page.waitForTimeout(300);
    await expect(page.getByTestId("detail-approve")).toHaveCount(0);
    await expect(page.getByTestId("detail-reject")).toHaveCount(0);
    await expect(page.getByTestId("detail-blocked")).toHaveAttribute("data-reason", "SELF_SUBMITTED");
  });

  test("the three audiences render distinctly on the same row", async ({ page }) => {
    // A guard against the queue quietly showing everyone the same thing, which is what the
    // original defect looked like from the outside.
    const seen: string[] = [];
    for (const name of [
      "sales-collections-finance",
      "sales-collections-manager",
      "sales-collections-self",
    ]) {
      await mount(page, name);
      const approve = (await page.getByTestId("approve-scq").count()) > 0;
      const blocked = (await page.getByTestId("decision-blocked-scq").count()) > 0
        ? await page.getByTestId("decision-blocked-scq").getAttribute("data-reason")
        : "none";
      seen.push(`${approve ? "approve" : "no-approve"}/${blocked}`);
    }
    expect(new Set(seen).size, `each audience must differ: ${seen.join(", ")}`).toBe(3);
  });
});
