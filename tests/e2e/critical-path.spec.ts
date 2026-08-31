import { test, expect } from "@playwright/test";
import { loginAs, createOrder, approveOrder, openWorkstationOrder, openProductionOrder, submitPreparationReview, qcBatch, packBatch, dispatchRow, roastItem, collectPageProblems, catalog } from "./support/app";
import { one, all, num, near } from "./support/db";

// Scenario B — nothing on the shelf, so the whole order must be produced.
//
// This is the critical path, and it is driven end to end through the interface by five
// different employees signing in one after another. No step here calls the API; the
// database is read only to confirm that what the screen said matches what was stored.

test.describe.configure({ mode: "serial" });

const NOTE = "UAT-CRIT";

let orderNumber: number;
let productionNumber: string;
let batchNumber: string;

test("Sales raises and approves an order for a product with no stock", async ({ page }) => {
  const problems = collectPageProblems(page);
  await loginAs(page, "sales");

  orderNumber = await createOrder(page, "roastery", NOTE, [{ sku: "yem500", units: 24 }]);
  expect(orderNumber).toBeGreaterThan(0);

  const created = await one<{ status: string; qty: number }>(
    `SELECT o.status, oi."quantityUnits" qty FROM "Order" o JOIN "OrderItem" oi ON oi."orderId"=o.id WHERE o."orderNumber"=$1`,
    [orderNumber]
  );
  expect(created.status).toBe("Waiting Approval");
  expect(num(created.qty)).toBe(24);

  await approveOrder(page, orderNumber);
  const approved = await one<{ status: string }>(`SELECT status FROM "Order" WHERE "orderNumber"=$1`, [orderNumber]);
  expect(approved.status).toBe("Waiting Preparation Review");

  expect(problems.failedRequests, "no server faults").toEqual([]);
});

test("Sales reviews preparation and the screen reports the shortfall", async ({ page }) => {
  const problems = collectPageProblems(page);
  await loginAs(page, "sales");
  const card = await openWorkstationOrder(page, orderNumber);

  await submitPreparationReview(card);
  // The decision is shown as the value of the row select, so that is what is asserted —
  // matching the text would hit the hidden <option> elements instead.
  await expect(card.locator("table select").first()).toHaveValue("Needs Production", { timeout: 60_000 });

  const item = await one<{ decision: string; status: string }>(
    `SELECT oi."preparationDecision" decision, o.status FROM "OrderItem" oi JOIN "Order" o ON o.id=oi."orderId" WHERE o."orderNumber"=$1`,
    [orderNumber]
  );
  expect(item.decision).toBe("Needs Production");
  expect(item.status).toBe("Preparing");

  // Sales has no production privilege, so the panel that raises production must not offer
  // its button to this employee.
  await expect(card.getByRole("button", { name: /Create production order/i })).toHaveCount(0);
  expect(problems.failedRequests).toEqual([]);
});

test("Production raises the requirement and releases the production order", async ({ page }) => {
  const problems = collectPageProblems(page);
  await loginAs(page, "production");
  const card = await openWorkstationOrder(page, orderNumber);

  const raise = card.getByRole("button", { name: /Create production order/i }).first();
  await expect(raise, "the production requirement panel offers its action").toBeVisible({ timeout: 60_000 });
  await expect(raise).toContainText("24");
  await raise.click();
  await expect(card.getByText(/Production order created/i)).toBeVisible({ timeout: 60_000 });

  const po = await one<{ productionNumber: string; targetUnits: number; status: string; green: number }>(
    `SELECT po."productionNumber", po."targetUnits", po.status, po."expectedGreenBeanKg" green
       FROM "ProductionOrder" po JOIN "OrderItem" oi ON oi.id=po."sourceOrderItemId"
       JOIN "Order" o ON o.id=oi."orderId" WHERE o."orderNumber"=$1`,
    [orderNumber]
  );
  productionNumber = po.productionNumber;
  expect(num(po.targetUnits)).toBe(24);
  expect(po.status).toBe("PENDING");
  // 24 × 500 g = 12 kg finished; Yemen loses 16 %, so 12 / 0.84 = 14.286 kg green.
  expect(near(num(po.green), 14.286, 0.002)).toBeTruthy();

  await openProductionOrder(page, productionNumber);
  await expect(page.getByText("Planned", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: /Release to production/i }).click();
  await expect(page.getByText("In production", { exact: true })).toBeVisible({ timeout: 60_000 });

  const released = await one<{ status: string }>(`SELECT status FROM "ProductionOrder" WHERE "productionNumber"=$1`, [productionNumber]);
  expect(released.status).toBe("IN_PRODUCTION");
  expect(problems.failedRequests).toEqual([]);
});

test("Production roasts a batch, entering real green input and roasted output", async ({ page }) => {
  const problems = collectPageProblems(page);
  await loginAs(page, "production");

  const greenBefore = num((await one<{ q: number }>(`SELECT "quantityKg" q FROM "GreenBean" WHERE id=$1`, [catalog.beans.yemen.id])).q);

  await page.goto("/dashboard/production");
  // The roast form for an order-backed line lives on the pending item card.
  const roastCard = roastItem(page, orderNumber);
  await expect(roastCard).toBeVisible({ timeout: 60_000 });

  await roastCard.getByRole("button", { name: /Start Production|Continue/i }).click();

  // The roast form labels are not associated with their inputs, so each field is reached
  // through the label a roaster actually reads on screen.
  const modal = page.locator("div.fixed").last();
  const field = (label: string) =>
    modal.locator(`xpath=.//label[contains(., "` + label + `")]/following::input[1]`);
  // On target: 24 x 500 g needs 12 kg of roasted coffee, which at a 16 % loss takes
  // 14.3 kg of green. A roast that hits its target must not be treated as surplus.
  await field("Green Bean Qty").fill("14.3");
  await field("Roasted Qty").fill("12");
  // Waste is derived from green minus roasted and shown read-only, so it is checked
  // rather than typed — the roaster should be able to see the loss the entry implies.
  await expect(field("Waste")).toHaveValue("2.3");
  await modal.getByRole("button", { name: /Record Batch/i }).click();

  // A roast that exactly meets the requirement must go straight through. The guard used
  // to compare green input against finished kilograms, so it fired here every time and
  // then refused the non-admin roaster outright — this assertion is what holds that fixed.
  await expect(
    page.getByRole("button", { name: /Add as Surplus/i }),
    "an on-target roast raises no overproduction warning"
  ).toHaveCount(0);
  await page.waitForTimeout(4000);
  const banner = await page.locator("body").innerText();
  const notable = banner
    .split(/\r?\n/)
    .filter((l) => /exceed|surplus|permission|admin/i.test(l))
    .slice(0, 3)
    .join(" | ");
  if (notable) console.log("      [observed] after confirming: " + notable);

  await expect.poll(async () => {
    const r = await all<{ id: string }>(
      `SELECT rb.id FROM "RoastingBatch" rb JOIN "OrderItem" oi ON oi.id=rb."orderItemId" JOIN "Order" o ON o.id=oi."orderId" WHERE o."orderNumber"=$1`,
      [orderNumber]
    );
    return r.length;
  }, { timeout: 60_000 }).toBe(1);

  const batch = await one<{ batchNumber: string; green: number; roasted: number; status: string }>(
    `SELECT rb."batchNumber", rb."greenBeanQuantity" green, rb."roastedBeanQuantity" roasted, rb.status
       FROM "RoastingBatch" rb JOIN "OrderItem" oi ON oi.id=rb."orderItemId" JOIN "Order" o ON o.id=oi."orderId"
      WHERE o."orderNumber"=$1`,
    [orderNumber]
  );
  batchNumber = batch.batchNumber;
  expect(num(batch.green)).toBe(14.3);
  expect(num(batch.roasted)).toBe(12);
  expect(batch.status).toBe("Pending QC");

  const greenAfter = num((await one<{ q: number }>(`SELECT "quantityKg" q FROM "GreenBean" WHERE id=$1`, [catalog.beans.yemen.id])).q);
  expect(near(greenBefore - greenAfter, 14.3), "the roast drew exactly 14.3 kg of green coffee").toBeTruthy();
  expect(problems.failedRequests).toEqual([]);
});

test("QC records a verdict and passes the batch", async ({ page }) => {
  const problems = collectPageProblems(page);
  await loginAs(page, "qc");
  await page.goto("/dashboard/qc");

  // The QC queue holds every batch awaiting a verdict, so each control must be scoped to
  // our own card. Clicking the first "Add My Record" on the page would file the verdict
  // against somebody else's coffee.
  const batchCard = qcBatch(page, batchNumber);
  await expect(batchCard).toBeVisible({ timeout: 60_000 });

  await batchCard.getByRole("button", { name: /Add My Record/i }).click();
  const form = page.locator("div.fixed").last();
  await expect(form.getByText(/Submit QC Record/i)).toBeVisible();
  await expect(form.locator("select").first(), "the form opens on the right batch").toContainText(batchNumber);
  await form.getByRole("button", { name: /^Accepted$/i }).click();
  await form.getByRole("button", { name: /Save Record/i }).click();
  await expect(form).toBeHidden({ timeout: 60_000 });

  await batchCard.getByRole("button", { name: /Finalize QC/i }).click();
  const finalize = page.locator("div.fixed").last();
  await finalize.getByRole("button", { name: /^Passed$/i }).click();
  await finalize.getByRole("button", { name: /^Confirm$/i }).click();

  await expect.poll(async () => {
    const r = await one<{ status: string }>(`SELECT status FROM "RoastingBatch" WHERE "batchNumber"=$1`, [batchNumber]);
    return r.status;
  }, { timeout: 60_000 }).toBe("Passed");
  expect(problems.failedRequests).toEqual([]);
});

test("Packaging packs the batch into finished goods through the bill of materials", async ({ page }) => {
  const problems = collectPageProblems(page);
  await loginAs(page, "packaging");

  const bagBefore = num((await one<{ q: number }>(`SELECT "quantityOnHand" q FROM "MaterialItem" WHERE id=$1`, [catalog.materials.bag500.id])).q);
  const lblBefore = num((await one<{ q: number }>(`SELECT "quantityOnHand" q FROM "MaterialItem" WHERE id=$1`, [catalog.materials.label.id])).q);

  await page.goto("/dashboard/packaging");
  await expect(page.getByText(batchNumber).first()).toBeVisible({ timeout: 60_000 });

  const packCard = packBatch(page, batchNumber);
  await packCard.getByRole("button", { name: /Pack as product/i }).click();

  const modal = page.locator("div.fixed").last();
  await expect(modal.getByText(/Pack into finished product/i)).toBeVisible();
  // The picker defaults to the first product in the catalogue, which is not necessarily
  // this batch's coffee — choosing by SKU id is what selecting the right row does.
  await modal.locator("select").first().selectOption(catalog.skus.yem500.id);
  await modal.locator('input[type="number"]').first().fill("24");

  // The modal states what the pack will consume before it is committed.
  await expect(modal.getByText(/Will consume/i)).toBeVisible();
  const pack = modal.getByRole("button", { name: /Pack as product/i });
  await expect(pack, "24 x 500 g is exactly the 12 kg this batch holds").toBeEnabled();
  await pack.click();

  await expect.poll(async () => {
    const r = await one<{ u: number }>(
      `SELECT COALESCE(SUM("unitsProduced"),0)::int u FROM "FinishedGoodsLot" WHERE "productSkuId"=$1`,
      [catalog.skus.yem500.id]
    );
    return num(r.u);
  }, { timeout: 60_000 }).toBe(24);

  const bagAfter = num((await one<{ q: number }>(`SELECT "quantityOnHand" q FROM "MaterialItem" WHERE id=$1`, [catalog.materials.bag500.id])).q);
  const lblAfter = num((await one<{ q: number }>(`SELECT "quantityOnHand" q FROM "MaterialItem" WHERE id=$1`, [catalog.materials.label.id])).q);
  expect(bagBefore - bagAfter, "24 bags consumed").toBe(24);
  expect(lblBefore - lblAfter, "24 labels consumed").toBe(24);
  expect(problems.failedRequests).toEqual([]);
});

test("Sales re-reviews and the finished goods are reserved to the order", async ({ page }) => {
  const problems = collectPageProblems(page);
  await loginAs(page, "sales");
  const card = await openWorkstationOrder(page, orderNumber);

  await submitPreparationReview(card);
  await expect(card.locator("table select").first()).toHaveValue("Available on Shelf", { timeout: 60_000 });

  const state = await one<{ status: string; decision: string; reserved: number }>(
    `SELECT o.status, oi."preparationDecision" decision,
            COALESCE((SELECT SUM(sa."quantityUnits") FROM "StockAllocation" sa WHERE sa."orderItemId"=oi.id AND sa.status='RESERVED'),0)::int reserved
       FROM "Order" o JOIN "OrderItem" oi ON oi."orderId"=o.id WHERE o."orderNumber"=$1`,
    [orderNumber]
  );
  expect(state.decision).toBe("Available on Shelf");
  expect(state.status).toBe("Ready for Shipping");
  expect(num(state.reserved)).toBe(24);
  expect(problems.failedRequests).toEqual([]);
});

test("Dispatch ships the order in full and it completes", async ({ page }) => {
  const problems = collectPageProblems(page);
  page.on("response", (r) => { if (/fulfillment-options/.test(r.url())) console.log("      [net] " + r.status() + " " + r.url().split("/api")[1]); });
  page.on("requestfailed", (r) => { if (/fulfillment-options/.test(r.url())) console.log("      [net] FAILED " + (r.failure()?.errorText ?? "") + " " + r.url().split("/api")[1]); });
  await loginAs(page, "dispatch");
  await page.goto("/dashboard/dispatch");

  const row = dispatchRow(page, orderNumber);
  await expect(row, "the order appears in the ready-to-deliver list").toBeVisible({ timeout: 60_000 });
  await row.getByRole("button", { name: /^Deliver$/i }).click();

  // Scoped by the dialog heading: several fixed-position containers exist on this page
  // and picking "the last one" landed on the wrong control entirely.
  const modal = page.locator("div.fixed").filter({ hasText: /Record Delivery/i }).first();
  await expect(modal).toBeVisible();
  // A SKU line must be offered in UNITS, not kilograms. Until GET /api/orders carried the
  // productSku relation the dispatch screen could not tell the two apart and offered
  // "Quantity (kg) — Max: 0", which no operator could ship from.
  await expect(modal.getByText(/Units/i).first(), "the form asks for units, not kilograms").toBeVisible();
  // The lot list is fetched when the dialog opens and takes a few seconds against a
  // remote database; until it lands the field is a spinner, not a select. Wait for the
  // real control rather than racing it — the earlier version silently picked up the
  // Delivery Type dropdown instead.
  const lotSelect = modal.locator('xpath=.//label[contains(., "Finished Goods Lot")]/following::select[1]');
  await expect(modal.getByText(/Loading lots/i)).toBeHidden({ timeout: 60_000 });
  await expect(lotSelect).toBeVisible({ timeout: 60_000 });
  await expect(
    lotSelect.locator("option"),
    "the picker offers the lot the review reserved, not just a placeholder"
  ).not.toHaveCount(1);
  await lotSelect.selectOption({ index: 1 });
  await expect(modal.locator('input[type="number"]').first()).toHaveValue("24");
  await modal.getByRole("button", { name: /Confirm Delivery|Record Delivery/i }).click();

  await expect.poll(async () => {
    const r = await one<{ d: number }>(
      `SELECT oi."deliveredUnits" d FROM "OrderItem" oi JOIN "Order" o ON o.id=oi."orderId" WHERE o."orderNumber"=$1`,
      [orderNumber]
    );
    return num(r.d);
  }, { timeout: 60_000 }).toBe(24);

  expect(problems.failedRequests).toEqual([]);
});

test("Reconciliation: what the screens showed matches the database", async () => {
  const green = num((await one<{ q: number }>(`SELECT "quantityKg" q FROM "GreenBean" WHERE id=$1`, [catalog.beans.yemen.id])).q);
  expect(near(green, catalog.beans.yemen.openingKg - 14.3), "green: opening 150 less the 14.3 kg roasted").toBeTruthy();

  const fg = await one<{ produced: number; available: number }>(
    `SELECT COALESCE(SUM("unitsProduced"),0)::int produced, COALESCE(SUM("unitsAvailable"),0)::int available
       FROM "FinishedGoodsLot" WHERE "productSkuId"=$1`,
    [catalog.skus.yem500.id]
  );
  expect(num(fg.produced)).toBe(24);
  expect(num(fg.available), "everything produced was shipped").toBe(0);

  const bad = await all(
    `SELECT id FROM "FinishedGoodsLot" WHERE "unitsReserved" > "unitsAvailable" OR "unitsAvailable" > "unitsProduced" OR "unitsReserved" < 0`
  );
  expect(bad, "no finished-goods balance is out of order").toEqual([]);
});
