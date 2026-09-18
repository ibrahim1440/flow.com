import { test, expect, type Locator, type Page } from "@playwright/test";
import {
  loginAs, createOrder, openWorkstationOrder, submitPreparationReview,
  roastForOrder, qcPass, packBatch, catalog, collectPageProblems,
} from "./support/app";
import { one, exec, num } from "./support/db";

// UNIFIED PACKAGING V2 — the workflow as an operator meets it.
//
// The backend contract is proved by scripts/e2e/regression/unified-packaging.mjs. What
// these cases prove is the half that suite cannot reach: that the screen presents ONE
// packaging operation, that it never asks the operator to understand how inventory stores
// the result, and that a partial package is impossible to create by accident and
// impossible to sell once created.
//
// Serial, and deliberately cumulative: the partial package made in P7 is the one topped up
// in P10, because that IS the workflow. Splitting them into independent tests would have
// each one build its own partial through the very screen under test and prove less.

test.describe.configure({ mode: "serial" });

const SKU = catalog.skus.col500;          // 500 g nominal
const NOMINAL = SKU.grams;

let orderNumber: number;
let batchNumber: string;
let partialLotId = "";

const dialog = (page: Page) => page.getByTestId("packaging-dialog");
const row = (page: Page, i: number) => dialog(page).getByTestId(`pack-line-${i}`);
const confirmBtn = (page: Page) => dialog(page).getByRole("button", { name: /Confirm packaging/i });
/**
 * What the server decided about a row, as the row reports it.
 *
 * Deliberately a test id rather than the badge's words. The line-kind picker on the same
 * row carries the same vocabulary — "Complete a partial package", "Declared loss" — so a
 * text locator matches a hidden <option> as readily as the badge, and the assertion then
 * fails for a reason that has nothing to do with the behaviour under test.
 */
const outcome = (page: Page, i: number) => row(page, i).getByTestId("line-outcome");

/** Open the one packaging action on a batch's card. */
async function openPackaging(page: Page, batch: string) {
  await page.goto("/dashboard/packaging");
  const card = packBatch(page, batch);
  await expect(card).toBeVisible({ timeout: 60_000 });
  await card.getByRole("button", { name: /Start Packaging|Continue Packaging/i }).click();
  await expect(dialog(page)).toBeVisible({ timeout: 60_000 });
}

/** Fill a "New packages" row. The kind select is first on the row; the product second. */
async function fillPackRow(line: Locator, skuId: string, packages: number, gramsEach?: number) {
  await line.locator("select").nth(1).selectOption(skuId);
  await line.locator('input[type="number"]').first().fill(String(packages));
  if (gramsEach !== undefined) {
    await line.locator('input[type="number"]').nth(1).fill(String(gramsEach));
  }
}

const unpackedGrams = async (batch: string) =>
  Math.round(num((await one<{ q: number }>(
    `SELECT "roastedAvailableKg" q FROM "RoastingBatch" WHERE "batchNumber"=$1`, [batch])).q) * 1000);

const freeUnits = async (skuId: string) =>
  num((await one<{ n: number }>(
    `SELECT COALESCE(SUM("unitsAvailable" - "unitsReserved"),0)::int n
       FROM "FinishedGoodsLot" WHERE "productSkuId"=$1 AND status='AVAILABLE'`, [skuId])).n);

const partialLots = async (skuId: string) =>
  num((await one<{ n: number }>(
    `SELECT COUNT(*)::int n FROM "FinishedGoodsLot" WHERE "productSkuId"=$1 AND status='PARTIAL'`,
    [skuId])).n);

// ── Groundwork ─────────────────────────────────────────────────────────────
test("Groundwork: a passed roast is waiting to be packed", async ({ page }) => {
  await loginAs(page, "admin");
  orderNumber = await createOrder(page, "hotel", "UAT-PKG2", [{ sku: "col500", units: 10 }]);

  const card = await openWorkstationOrder(page, orderNumber);
  await submitPreparationReview(card);

  // 10 x 500 g needs 5 kg. Roast 6 kg so there is deliberate room left over to pack in
  // several goes, which is what the unified workflow is for.
  batchNumber = await roastForOrder(page, orderNumber, 7.2, 6, { acceptSurplus: true });
  await qcPass(page, batchNumber);

  expect(await unpackedGrams(batchNumber), "6 kg is unpacked").toBe(6000);
});

// ── P1 ─────────────────────────────────────────────────────────────────────
test("P1 — the card offers ONE packaging action and no method vocabulary", async ({ page }) => {
  const problems = collectPageProblems(page);
  await loginAs(page, "packaging");
  await page.goto("/dashboard/packaging");

  const card = packBatch(page, batchNumber);
  await expect(card).toBeVisible({ timeout: 60_000 });

  const actions = card.getByRole("button", { name: /Packaging|Pack/i });
  await expect(actions, "exactly one packaging action per card").toHaveCount(1);
  await expect(card.getByRole("button", { name: /Start Packaging/i })).toBeVisible();

  // The internal storage distinction is gone from the screen, in both languages.
  for (const gone of [/Finished units/i, /Bulk bags/i, /method locked/i, /Choose packing method/i, /أكياس سائبة/]) {
    await expect(page.getByText(gone), `"${gone}" must not appear`).toHaveCount(0);
  }

  expect(problems.consoleErrors).toEqual([]);
  expect(problems.failedRequests).toEqual([]);
});

// ── P2 ─────────────────────────────────────────────────────────────────────
test("P2 — Start Packaging opens one sheet stating what the roast still holds", async ({ page }) => {
  await loginAs(page, "packaging");
  await openPackaging(page, batchNumber);

  await expect(dialog(page).getByRole("heading", { name: /Start Packaging/i })).toBeVisible();
  await expect(dialog(page).getByText(new RegExp(`${batchNumber}`))).toBeVisible();
  // Grams, read from the server rather than converted on the screen.
  await expect(dialog(page).getByText(/Unpacked coffee on this roast/i)).toBeVisible();
  await expect(dialog(page).getByText(/6000 g/)).toBeVisible({ timeout: 60_000 });
});

// ── P3 ─────────────────────────────────────────────────────────────────────
test("P3 — choosing a product fills in its nominal weight as the actual fill", async ({ page }) => {
  await loginAs(page, "packaging");
  await openPackaging(page, batchNumber);

  const line = row(page, 0);
  await line.locator("select").nth(1).selectOption(SKU.id);

  await expect(line.getByText(/Nominal weight/i)).toBeVisible();
  // A complete package is the ordinary case, so it is what the screen offers first; a
  // partial one is always something the operator deliberately typed.
  await expect(line.locator('input[type="number"]').nth(1)).toHaveValue(String(NOMINAL));
});

// ── P4 ─────────────────────────────────────────────────────────────────────
test("P4 — a full fill reads as a complete package and every gram reconciles", async ({ page }) => {
  await loginAs(page, "packaging");
  await openPackaging(page, batchNumber);
  await fillPackRow(row(page, 0), SKU.id, 4);

  const recon = dialog(page).getByTestId("packaging-reconciliation");
  await expect(recon).toBeVisible({ timeout: 60_000 });
  await expect(outcome(page, 0)).toContainText(/Complete package/i);
  await expect(recon.getByText(/Every gram is accounted for/i)).toBeVisible();
  // 4 x 500 g out of 6000 g leaves 4000 g on the roast.
  await expect(recon.getByText(/4000 g/).first()).toBeVisible();
  await expect(confirmBtn(page)).toBeEnabled({ timeout: 60_000 });
});

// ── P5 ─────────────────────────────────────────────────────────────────────
test("P5 — dropping below the nominal weight turns the row into a partial package", async ({ page }) => {
  await loginAs(page, "packaging");
  await openPackaging(page, batchNumber);
  await fillPackRow(row(page, 0), SKU.id, 1, 300);

  await expect(outcome(page, 0)).toContainText(/Partial package/i, { timeout: 60_000 });
  await expect(dialog(page).getByText(/This will create partial packages/i)).toBeVisible();
  await expect(
    dialog(page).getByText(/cannot be sold, reserved or dispatched as a full unit/i),
    "the consequence is stated, not implied"
  ).toBeVisible();
});

// ── P6 ─────────────────────────────────────────────────────────────────────
test("P6 — a partial package cannot be committed without acknowledging it", async ({ page }) => {
  await loginAs(page, "packaging");
  await openPackaging(page, batchNumber);
  await fillPackRow(row(page, 0), SKU.id, 1, 300);

  await expect(dialog(page).getByText(/This will create partial packages/i)).toBeVisible({ timeout: 60_000 });
  await expect(confirmBtn(page), "blocked until the operator says so").toBeDisabled();

  await dialog(page).getByRole("checkbox").check();
  await expect(confirmBtn(page)).toBeEnabled({ timeout: 60_000 });
});

// ── P7 ─────────────────────────────────────────────────────────────────────
test("P7 — committing a partial creates real stock that is not sellable", async ({ page }) => {
  await loginAs(page, "packaging");
  const freeBefore = await freeUnits(SKU.id);
  const partialsBefore = await partialLots(SKU.id);

  await openPackaging(page, batchNumber);
  await fillPackRow(row(page, 0), SKU.id, 1, 300);
  await expect(dialog(page).getByText(/This will create partial packages/i)).toBeVisible({ timeout: 60_000 });
  await dialog(page).getByRole("checkbox").check();
  await expect(confirmBtn(page)).toBeEnabled({ timeout: 60_000 });
  await confirmBtn(page).click();
  await expect(dialog(page)).toBeHidden({ timeout: 60_000 });

  await expect.poll(async () => partialLots(SKU.id), { timeout: 60_000 }).toBe(partialsBefore + 1);
  expect(await freeUnits(SKU.id), "nothing became sellable").toBe(freeBefore);
  expect(await unpackedGrams(batchNumber), "300 g left the roast").toBe(5700);

  const lot = await one<{ id: string; g: number }>(
    `SELECT f.id, f."actualContentGrams" g FROM "FinishedGoodsLot" f
      WHERE f."productSkuId"=$1 AND f.status='PARTIAL' ORDER BY f."createdAt" DESC LIMIT 1`, [SKU.id]);
  partialLotId = lot.id;
  expect(num(lot.g), "it holds exactly what was put in").toBe(300);
});

// ── P8 ─────────────────────────────────────────────────────────────────────
test("P8 — the partial package is visible on the Finished Products screen, beside the sellable figure", async ({ page }) => {
  await loginAs(page, "admin");
  await page.goto("/dashboard/products");

  const line = page.getByRole("row").filter({ hasText: SKU.code });
  await expect(line).toBeVisible({ timeout: 60_000 });
  // Shown, and shown as a separate figure. A partial package that is invisible is stock
  // nobody will ever finish; one that is added to the sellable count is a half-full bag
  // sold as a full one.
  await expect(line.getByText(/partial/i)).toBeVisible();
  await expect(line.getByText(/\(300 g\)/)).toBeVisible();
});

// ── P9 ─────────────────────────────────────────────────────────────────────
test("P9 — the card now offers Continue Packaging", async ({ page }) => {
  await loginAs(page, "packaging");
  await page.goto("/dashboard/packaging");

  const card = packBatch(page, batchNumber);
  await expect(card).toBeVisible({ timeout: 60_000 });
  await expect(card.getByRole("button", { name: /Continue Packaging/i })).toBeVisible();
  await expect(card.getByRole("button", { name: /Packaging|Pack/i }), "still exactly one action").toHaveCount(1);
});

// ── P10 ────────────────────────────────────────────────────────────────────
test("P10 — the open package is offered for top-up, short by exactly what it lacks", async ({ page }) => {
  await loginAs(page, "packaging");
  await openPackaging(page, batchNumber);

  await row(page, 0).locator("select").first().selectOption("topUp");
  const select = row(page, 0).locator("select").nth(1);
  await expect(select).toBeVisible({ timeout: 60_000 });
  await select.selectOption(partialLotId);

  // Defaulted to what finishes the bag: 500 g nominal less the 300 g already in it.
  await expect(row(page, 0).locator('input[type="number"]').first()).toHaveValue("200");
  await expect(outcome(page, 0)).toContainText(/will become complete/i, { timeout: 60_000 });
});

// ── P11 ────────────────────────────────────────────────────────────────────
test("P11 — completing the top-up makes exactly one sellable unit from the same bag", async ({ page }) => {
  await loginAs(page, "packaging");
  const freeBefore = await freeUnits(SKU.id);
  const partialsBefore = await partialLots(SKU.id);

  await openPackaging(page, batchNumber);
  await row(page, 0).locator("select").first().selectOption("topUp");
  await row(page, 0).locator("select").nth(1).selectOption(partialLotId);
  await expect(confirmBtn(page)).toBeEnabled({ timeout: 60_000 });
  await confirmBtn(page).click();
  await expect(dialog(page)).toBeHidden({ timeout: 60_000 });

  await expect.poll(async () => freeUnits(SKU.id), { timeout: 60_000 }).toBe(freeBefore + 1);
  expect(await partialLots(SKU.id), "the package is no longer partial").toBe(partialsBefore - 1);
  expect(await unpackedGrams(batchNumber), "only the 200 g top-up was drawn").toBe(5500);

  // One bag, not two: the top-up consumed coffee but no second set of materials.
  const lot = await one<{ n: number }>(
    `SELECT COUNT(*)::int n FROM "PackagingSource" WHERE "finishedGoodsLotId"=$1`, [partialLotId]);
  expect(num(lot.n), "both contributions are recorded against the one package").toBe(2);
});

// ── P12 ────────────────────────────────────────────────────────────────────
test("P12 — a declared loss needs a reason before it counts as a line", async ({ page }) => {
  await loginAs(page, "packaging");
  await openPackaging(page, batchNumber);

  await row(page, 0).locator("select").first().selectOption("loss");
  await row(page, 0).locator('input[type="number"]').first().fill("150");

  // Grams alone is not a declaration. Without the reason the row is unfinished, and the
  // screen says so rather than quietly committing an unexplained write-off.
  await expect(dialog(page).getByText(/Complete or remove every line before confirming/i)).toBeVisible();
  await expect(confirmBtn(page)).toBeDisabled();

  await row(page, 0).locator('input[type="text"]').first().fill("spilled at the hopper");
  await expect(outcome(page, 0)).toContainText(/Declared loss/i, { timeout: 60_000 });
  await expect(confirmBtn(page)).toBeEnabled({ timeout: 60_000 });
});

// ── P13 ────────────────────────────────────────────────────────────────────
test("P13 — one operation states all four destinations and commits as a single act", async ({ page }) => {
  await loginAs(page, "packaging");
  const freeBefore = await freeUnits(SKU.id);
  const partialsBefore = await partialLots(SKU.id);

  await openPackaging(page, batchNumber);
  // Complete packages, a partial one, and a declared loss — in one sheet.
  await fillPackRow(row(page, 0), SKU.id, 4);
  await dialog(page).getByRole("button", { name: /Add line/i }).click();
  await fillPackRow(row(page, 1), SKU.id, 1, 200);
  await dialog(page).getByRole("button", { name: /Add line/i }).click();
  await row(page, 2).locator("select").first().selectOption("loss");
  await row(page, 2).locator('input[type="number"]').first().fill("100");
  await row(page, 2).locator('input[type="text"]').first().fill("dust and fines");

  const recon = dialog(page).getByTestId("packaging-reconciliation");
  await expect(recon).toBeVisible({ timeout: 60_000 });
  await expect(recon.getByText(/Into complete packages/i)).toBeVisible();
  await expect(recon.getByText(/Into partial packages/i)).toBeVisible();
  await expect(recon.getByText(/Declared loss/i)).toBeVisible();
  await expect(recon.getByText(/Left unpacked on the roast/i)).toBeVisible();
  await expect(recon.getByText(/Every gram is accounted for/i)).toBeVisible();

  await dialog(page).getByRole("checkbox").check();
  await expect(confirmBtn(page)).toBeEnabled({ timeout: 60_000 });
  await confirmBtn(page).click();
  await expect(dialog(page)).toBeHidden({ timeout: 60_000 });

  // 2000 g complete + 200 g partial + 100 g loss = 2300 g off a roast holding 5500 g.
  await expect.poll(async () => unpackedGrams(batchNumber), { timeout: 60_000 }).toBe(3200);
  expect(await freeUnits(SKU.id)).toBe(freeBefore + 4);
  expect(await partialLots(SKU.id)).toBe(partialsBefore + 1);

  const loss = await one<{ n: number; notes: string | null }>(
    `SELECT COUNT(*)::int n, MIN(notes) notes FROM "InventoryMovement"
      WHERE type='LOSS' AND category='ROASTED_COFFEE' AND notes LIKE '%dust and fines%'`);
  expect(num(loss.n), "the loss is its own ledger entry, with its reason").toBe(1);
});

// ── P14 ────────────────────────────────────────────────────────────────────
test("P14 — asking for more than the roast holds is refused on screen", async ({ page }) => {
  await loginAs(page, "packaging");
  await openPackaging(page, batchNumber);
  // 3200 g left; 20 x 500 g is 10000 g.
  await fillPackRow(row(page, 0), SKU.id, 20);

  await expect(dialog(page).getByText(/only 3200 g is unpacked on this roast/i)).toBeVisible({ timeout: 60_000 });
  await expect(confirmBtn(page)).toBeDisabled();
});

// ── P15 ────────────────────────────────────────────────────────────────────
test("P15 — a material shortage blocks confirmation and never rewrites the request", async ({ page }) => {
  // Setup only: empty the shelf of the bag this SKU needs. Draining it through the UI is
  // not the behaviour under test, and there is no screen that does it.
  const bom = await one<{ id: string; qty: number }>(
    `SELECT mi.id, mi."quantityOnHand" qty
       FROM "BomComponent" bc JOIN "MaterialItem" mi ON mi.id = bc."materialItemId"
      WHERE bc."productSkuId"=$1 LIMIT 1`, [SKU.id]);
  const restore = num(bom.qty);
  await exec(`UPDATE "MaterialItem" SET "quantityOnHand"=0 WHERE id=$1`, [bom.id]);

  try {
    await loginAs(page, "packaging");
    await openPackaging(page, batchNumber);
    await fillPackRow(row(page, 0), SKU.id, 2);

    await expect(dialog(page).getByText(/Materials short for this run/i)).toBeVisible({ timeout: 60_000 });
    await expect(dialog(page).getByText(/Missing material/i)).toBeVisible();
    // The number of packages the operator typed is still the number on screen. Quietly
    // packing fewer than asked is the one outcome that leaves the floor and the system
    // disagreeing about what was made.
    await expect(row(page, 0).locator('input[type="number"]').first()).toHaveValue("2");
    await expect(confirmBtn(page)).toBeDisabled();
  } finally {
    await exec(`UPDATE "MaterialItem" SET "quantityOnHand"=$2 WHERE id=$1`, [bom.id, restore]);
  }
});
