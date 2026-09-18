import { readFileSync } from "node:fs";
import { expect, type Page, type Locator, type BrowserContext } from "@playwright/test";
import { ROLES, type RoleName } from "./roles";
import { CATALOG_PATH, type Catalog } from "./global-setup";

export const catalog: Catalog = JSON.parse(readFileSync(CATALOG_PATH, "utf8"));

/**
 * Sign in the way an employee does: tap the PIN on the keypad, press the arrow.
 *
 * Never by planting a cookie. Half the point of this suite is that the login screen, the
 * session it issues and the permissions baked into it all work together.
 */
export async function loginAs(page: Page, role: RoleName): Promise<void> {
  const { pin } = ROLES[role];
  await page.goto("/login");
  await expect(page.getByText(/Enter Your PIN/i)).toBeVisible();

  const keypad = page.locator("div.grid").filter({ has: page.getByRole("button", { name: "1", exact: true }) }).first();
  for (const digit of pin) {
    await keypad.getByRole("button", { name: digit, exact: true }).click();
  }
  // The arrow key is the last button in the keypad and carries an icon, not a label.
  await keypad.locator("button").last().click();

  await page.waitForURL(/\/dashboard/, { timeout: 60_000 });
}

export async function logout(page: Page): Promise<void> {
  await page.getByRole("button", { name: /Sign Out/i }).click();
  await page.waitForURL(/\/login/, { timeout: 60_000 });
}

/** Every failure in this suite should say what the browser was complaining about. */
export function collectPageProblems(page: Page) {
  const consoleErrors: string[] = [];
  const failedRequests: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text());
  });
  page.on("pageerror", (e) => consoleErrors.push("pageerror: " + e.message));
  page.on("response", (r) => {
    // 4xx is often a deliberate part of a test (a refused action), so only server faults
    // and hard network failures are treated as unexpected here.
    if (r.status() >= 500) failedRequests.push(`${r.status()} ${r.request().method()} ${new URL(r.url()).pathname}`);
  });
  page.on("requestfailed", (r) => {
    const err = r.failure()?.errorText ?? "";
    if (!/ERR_ABORTED/.test(err)) failedRequests.push(`${err} ${new URL(r.url()).pathname}`);
  });
  return { consoleErrors, failedRequests };
}

// ─── Orders ─────────────────────────────────────────────────────────────────

export type OrderLine = { sku: keyof Catalog["skus"]; units: number };

/** Create an order through the New Order modal. Returns its order number. */
export async function createOrder(
  page: Page,
  customer: keyof Catalog["customers"],
  note: string,
  lines: OrderLine[]
): Promise<number> {
  await page.goto("/dashboard/orders");
  await page.getByRole("button", { name: /New Order/i }).click();

  const modal = page.locator("div.fixed").filter({ hasText: /New Order/i }).first();
  await expect(modal).toBeVisible();

  await modal.locator("select").first().selectOption({ label: catalog.customers[customer].name });
  // Quotation Number carries the test's tag so the order can be found again afterwards.
  // Its label is not associated with the input, so it is addressed by position: it is the
  // only free text field in the modal while the new-customer block stays collapsed.
  await modal.locator('input[type="text"]').first().fill(note);

  for (const [i, line] of lines.entries()) {
    if (i > 0) await modal.getByRole("button", { name: /Add item/i }).click();
    const sku = catalog.skus[line.sku];
    // The product field is an input backed by a datalist; typing the exact option label
    // is what a user picking from the dropdown produces.
    await modal.getByPlaceholder(/Search Product/i).nth(i).fill(sku.label);
    await modal.getByPlaceholder(/Quantity/i).nth(i).fill(String(line.units));
  }

  const submit = modal.getByRole("button", { name: /Create Order/i });
  await expect(submit).toBeEnabled();
  await submit.click();
  await expect(modal).toBeHidden({ timeout: 60_000 });

  const { one } = await import("./db");
  const row = await one<{ orderNumber: number }>(
    `SELECT "orderNumber" FROM "Order" WHERE "quotationNumber"=$1 ORDER BY "createdAt" DESC LIMIT 1`,
    [note]
  );
  return Number(row.orderNumber);
}

/**
 * The card for one record, addressed by a stable test hook.
 *
 * These screens are queues: dispatch lists every shippable line, QC every batch awaiting a
 * verdict. Clicking "the first Deliver button on the page" would act on somebody else's
 * coffee, and locating by utility class proved brittle because the class lists are
 * assembled from template literals and change with state. Each operational card therefore
 * carries a data-testid — a non-visual hook added for exactly this purpose.
 */
export const orderCard = (page: Page, orderNumber: number) => page.getByTestId(`order-card-${orderNumber}`);
export const wsCard = (page: Page, orderNumber: number) => page.getByTestId(`ws-order-${orderNumber}`);
export const dispatchRow = (page: Page, orderNumber: number) => page.getByTestId(`dispatch-row-${orderNumber}`);
export const roastItem = (page: Page, orderNumber: number) => page.getByTestId(`roast-item-${orderNumber}`);
export const qcBatch = (page: Page, batchNumber: string) => page.getByTestId(`qc-batch-${batchNumber}`);
export const packBatch = (page: Page, batchNumber: string) => page.getByTestId(`pack-batch-${batchNumber}`);

/** Expand an order row on /dashboard/orders. */
export async function openOrderCard(page: Page, orderNumber: number) {
  await page.goto("/dashboard/orders");
  const card = orderCard(page, orderNumber);
  await expect(card).toBeVisible({ timeout: 60_000 });
  await card.locator("div.cursor-pointer").first().click();
  return card;
}

// ─── Preparation workstation ────────────────────────────────────────────────

export async function openWorkstationOrder(page: Page, orderNumber: number) {
  await page.goto("/dashboard/workstation/preparation");
  const card = wsCard(page, orderNumber);
  await expect(card).toBeVisible({ timeout: 60_000 });
  // The whole card header is the expand control, and it also contains the status badge —
  // so it must be clicked by position, never by a text match, or a later "Review" lookup
  // will hit the header and collapse the card again.
  const commitBtn = card.getByRole("button", { name: /Commit Allocation/i });
  if (!(await commitBtn.isVisible().catch(() => false))) {
    await card.locator("button").first().click();
  }
  return card;
}

/**
 * Commit the allocation the way the reviewer does it.
 *
 * There is no per-line decision to choose any more. The derived result is computed by the
 * server from what the shelf can actually cover and is read-only in the UI, so the
 * reviewer's only normal input is whether to block a line. That leaves one primary
 * action, enabled as soon as the stock preview has loaded.
 */
export async function submitPreparationReview(card: Locator) {
  const commit = card.getByRole("button", { name: /Commit Allocation/i });
  await expect(commit, "the allocation commits once the stock preview has loaded").toBeEnabled({
    timeout: 30_000,
  });
  await commit.click();
  await expect(commit).toBeEnabled({ timeout: 60_000 });
}

/**
 * Block one line, supply the reason the server requires, and commit.
 *
 * Blocking is the single manual exception left in preparation: everything else about the
 * outcome is derived. The reason is mandatory — the commit stays disabled without it,
 * which is asserted here rather than assumed.
 */
export async function blockLineAndCommit(card: Locator, reason: string) {
  await card.getByRole("button", { name: /Block Item/i }).first().click();
  const commit = card.getByRole("button", { name: /Commit Allocation/i });
  await expect(commit, "a blocked line cannot commit without a reason").toBeDisabled({
    timeout: 30_000,
  });
  await card.locator("textarea").first().fill(reason);
  await expect(commit).toBeEnabled({ timeout: 30_000 });
  await commit.click();
  await expect(commit).toBeEnabled({ timeout: 60_000 });
}

// ─── Production orders ──────────────────────────────────────────────────────

export async function openProductionOrder(page: Page, productionNumber: string) {
  await page.goto("/dashboard/production-orders");
  await page.getByRole("link", { name: productionNumber }).click();
  await expect(page.getByRole("heading", { name: productionNumber })).toBeVisible({ timeout: 60_000 });
}

// ─── Misc ───────────────────────────────────────────────────────────────────

/** Wait until no button on the page is in its busy/disabled write state. */
export async function settled(page: Page) {
  await page.waitForLoadState("networkidle").catch(() => {});
}

export async function newTab(context: BrowserContext, url: string): Promise<Page> {
  const p = await context.newPage();
  await p.goto(url);
  return p;
}

// ─── Whole workflow steps, as an operator performs them ─────────────────────
// Extracted from the critical path so the scenario suite reads as a sequence of
// operational actions rather than a wall of selectors. Every one of these drives the real
// screen; none of them calls a business API directly.

/** Roast against an order line. Returns the batch number the ERP generated. */
export async function roastForOrder(
  page: Page,
  orderNumber: number,
  greenKg: number,
  roastedKg: number,
  opts: { acceptSurplus?: boolean } = {}
): Promise<string> {
  // Counted BEFORE the roast is entered. Waiting for a batch to merely exist is enough for
  // the first roast against a line and wrong for every one after it: the poll below would
  // return the previous batch immediately and the caller would carry on before this roast
  // had committed — or, worse, after it had been refused outright.
  const { one: countOne } = await import("./db");
  const before = Number((await countOne<{ n: number }>(
    `SELECT COUNT(*)::int n FROM "RoastingBatch" rb
       JOIN "OrderItem" oi ON oi.id = rb."orderItemId"
       JOIN "Order" o ON o.id = oi."orderId"
      WHERE o."orderNumber" = $1`, [orderNumber])).n);
  await page.goto("/dashboard/production");
  // The pending list is fetched after the shell renders; wait for the screen to settle
  // before looking for the order, or a second roast races the reload from the first.
  await expect(page.getByRole("heading", { name: /^Production$/ })).toBeVisible({ timeout: 60_000 });
  const card = roastItem(page, orderNumber);
  await expect(card).toBeVisible({ timeout: 90_000 });
  // The card offers "Start Production" for the first roast against a line and "Continue"
  // for every one after it, alongside a produced/remaining bar.
  const start = card.getByRole("button", { name: /Start Production|Continue/i });
  await expect(start).toBeEnabled({ timeout: 60_000 });
  await start.click();

  const modal = page.locator("div.fixed").filter({ hasText: /Start Production|Green Bean Source/i }).last();
  const field = (label: string) => modal.locator(`xpath=.//label[contains(., "${label}")]/following::input[1]`);
  await field("Green Bean Qty").fill(String(greenKg));
  await field("Roasted Qty").fill(String(roastedKg));
  await modal.getByRole("button", { name: /Record Batch/i }).click();

  // Deliberate over-production has to be confirmed; an on-target roast never asks.
  const surplus = page.getByRole("button", { name: /Add as Surplus/i });
  if (opts.acceptSurplus && (await surplus.isVisible({ timeout: 8_000 }).catch(() => false))) {
    // The server refuses surplus authorization without a written reason — an admin included
    // — so the dialog asks for one and keeps the button disabled until it is given.
    const dialog = page.locator("div.fixed").filter({ hasText: /Add as Surplus/i }).last();
    await dialog.locator("textarea").first().fill("UAT authorised surplus for shelf stock");
    await expect(surplus, "a written reason is what authorizes the surplus").toBeEnabled();
    await surplus.click();
  }

  const { one } = await import("./db");
  let batchNumber = "";
  await expect
    .poll(async () => {
      const rows = await (await import("./db")).all<{ b: string }>(
        `SELECT rb."batchNumber" b FROM "RoastingBatch" rb
           JOIN "OrderItem" oi ON oi.id = rb."orderItemId"
           JOIN "Order" o ON o.id = oi."orderId"
          WHERE o."orderNumber" = $1 ORDER BY rb."createdAt" DESC`,
        [orderNumber]
      );
      batchNumber = rows[0]?.b ?? "";
      return rows.length;
    }, { timeout: 60_000 })
    .toBe(before + 1);
  return batchNumber;
}

/** File a QC verdict and finalize the batch as passed. */
export async function qcPass(page: Page, batchNumber: string) {
  await page.goto("/dashboard/qc");
  const card = qcBatch(page, batchNumber);
  await expect(card).toBeVisible({ timeout: 60_000 });

  await card.getByRole("button", { name: /Add My Record/i }).click();
  const form = page.locator("div.fixed").filter({ hasText: /Submit QC Record/i }).last();
  await form.getByRole("button", { name: /^Accepted$/i }).click();
  await form.getByRole("button", { name: /Save Record/i }).click();
  await expect(form).toBeHidden({ timeout: 60_000 });

  await card.getByRole("button", { name: /Finalize QC/i }).click();
  const finalize = page.locator("div.fixed").filter({ hasText: /Finalize QC/i }).last();
  await finalize.getByRole("button", { name: /^Passed$/i }).click();
  await finalize.getByRole("button", { name: /^Confirm$/i }).click();

  const { one } = await import("./db");
  await expect
    .poll(async () => (await one<{ s: string }>(`SELECT status s FROM "RoastingBatch" WHERE "batchNumber"=$1`, [batchNumber])).s,
      { timeout: 60_000 })
    .toBe("Passed");
}

/**
 * Pack a passed batch into complete packages of a SKU.
 *
 * Drives the ONE packaging operation. There is no method to choose and no second dialog:
 * a row names a product, how many packages, and what actually went into each. Leaving the
 * fill at the SKU's nominal weight — which the screen fills in on selection — is what makes
 * these complete, sellable packages rather than partial ones.
 */
export async function packIntoSku(page: Page, batchNumber: string, skuId: string, units: number) {
  await page.goto("/dashboard/packaging");
  const card = packBatch(page, batchNumber);
  await expect(card).toBeVisible({ timeout: 60_000 });
  await card.getByRole("button", { name: /Start Packaging|Continue Packaging/i }).click();

  const modal = page.getByTestId("packaging-dialog");
  await expect(modal).toBeVisible({ timeout: 60_000 });

  const line = modal.getByTestId("pack-line-0");
  // nth(1): the first select on the row chooses what KIND of line it is, and it already
  // says "New packages". The second names the product.
  await line.locator("select").nth(1).selectOption(skuId);
  await line.locator('input[type="number"]').first().fill(String(units));

  // The reconciliation is answered by the server, so the commit button only enables once
  // the screen and the server agree about what this run will do.
  const pack = modal.getByRole("button", { name: /Confirm packaging/i });
  await expect(pack).toBeEnabled({ timeout: 60_000 });
  await pack.click();
  await expect(modal).toBeHidden({ timeout: 60_000 });
}

/** Record a delivery of `units` against an order line. */
export async function deliverUnits(page: Page, orderNumber: number, units: number) {
  await page.goto("/dashboard/dispatch");
  const row = dispatchRow(page, orderNumber);
  await expect(row).toBeVisible({ timeout: 60_000 });
  await row.getByRole("button", { name: /^Deliver$/i }).click();

  const modal = page.locator("div.fixed").filter({ hasText: /Record Delivery/i }).first();
  await expect(modal.getByText(/Loading lots/i)).toBeHidden({ timeout: 60_000 });
  const lotSelect = modal.locator('xpath=.//label[contains(., "Finished Goods Lot")]/following::select[1]');
  await expect(lotSelect).toBeVisible({ timeout: 60_000 });
  await lotSelect.selectOption({ index: 1 });
  await modal.locator('input[type="number"]').first().fill(String(units));
  await modal.getByRole("button", { name: /Confirm Delivery|Record Delivery/i }).click();
  await expect(modal).toBeHidden({ timeout: 60_000 });
}

/** Hold, resume, cancel or complete an order from the order card. */
export async function orderStatusAction(page: Page, orderNumber: number, label: RegExp, reason?: string) {
  await page.goto("/dashboard/orders");
  const card = orderCard(page, orderNumber);
  await expect(card).toBeVisible({ timeout: 60_000 });
  await card.locator("div.cursor-pointer").first().click();

  await card.getByRole("button", { name: label }).first().click();
  if (reason !== undefined) {
    const dialog = page.locator("div.fixed").last();
    const box = dialog.locator("textarea, input[type='text']").first();
    if (await box.isVisible().catch(() => false)) await box.fill(reason);
    await dialog.getByRole("button", { name: /Confirm|Hold|Cancel order|Complete/i }).last().click();
  }
}

/**
 * Answer the native dialogs the order screen uses.
 *
 * Hold and Cancel collect their reason with window.prompt() and confirm the cancellation
 * with window.confirm(), rather than with an in-page dialog. Playwright dismisses native
 * dialogs by default, which would silently abandon the action, so they are answered here.
 */
export function answerNativeDialogs(page: Page, reason: string) {
  const seen: string[] = [];
  page.on("dialog", async (d) => {
    seen.push(`${d.type()}: ${d.message()}`);
    if (d.type() === "prompt") await d.accept(reason);
    else await d.accept();
  });
  return seen;
}
