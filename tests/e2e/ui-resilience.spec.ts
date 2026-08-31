import { test, expect } from "@playwright/test";
import {
  loginAs, openWorkstationOrder,
  orderCard, collectPageProblems, catalog,
} from "./support/app";
import { one, all, num } from "./support/db";

// What happens when the interface is used badly: buttons hammered, pages reloaded
// mid-operation, the same order open in two tabs, the server refusing, the network slow.
// The bar is not that nothing goes wrong — it is that nothing is written twice, nothing
// is left half-done, and whatever the operator is told makes sense to them.

test.describe.configure({ mode: "serial" });

const NOTE = "UAT-RESIL";
let orderNumber: number;

test("Double-clicking Create Order creates exactly one order", async ({ page }) => {
  const problems = collectPageProblems(page);
  await loginAs(page, "sales");

  await page.goto("/dashboard/orders");
  await page.getByRole("button", { name: /New Order/i }).click();
  const modal = page.locator("div.fixed").filter({ hasText: /New Order/i }).first();
  await modal.locator("select").first().selectOption({ label: catalog.customers.bakery.name });
  await modal.locator('input[type="text"]').first().fill(NOTE);
  await modal.getByPlaceholder(/Search Product/i).fill(catalog.skus.ken1kg.label);
  await modal.getByPlaceholder(/Quantity/i).fill("6");

  // Two clicks dispatched synchronously, before React can re-render and disable the
  // control. This is the case a disabled attribute alone does not cover, and it is what an
  // impatient operator on a slow connection actually produces.
  const submit = modal.getByRole("button", { name: /Create Order/i });
  await expect(submit).toBeEnabled();
  await submit.evaluate((b: HTMLElement) => { b.click(); b.click(); b.click(); });
  await expect(modal).toBeHidden({ timeout: 60_000 });

  const rows = await all<{ orderNumber: number }>(
    `SELECT "orderNumber" FROM "Order" WHERE "quotationNumber"=$1`, [NOTE]
  );
  expect(rows.length, "a double click must not create two orders").toBe(1);
  orderNumber = Number(rows[0].orderNumber);
  expect(problems.failedRequests).toEqual([]);
});

test("Hammering Approve does not approve twice or corrupt the status", async ({ page }) => {
  await loginAs(page, "sales");
  await page.goto("/dashboard/orders");

  const row = orderCard(page, orderNumber);
  await expect(row).toBeVisible({ timeout: 60_000 });
  await row.locator("div.cursor-pointer").first().click();

  const approve = row.getByRole("button", { name: /^Approve$/i }).first();
  await expect(approve).toBeVisible();
  // Five clicks in a row. Only the first can be legal; the rest must be absorbed.
  for (let i = 0; i < 5; i++) await approve.click({ force: true, timeout: 5_000 }).catch(() => {});

  await expect
    .poll(async () => (await one<{ s: string }>(`SELECT status s FROM "Order" WHERE "orderNumber"=$1`, [orderNumber])).s, { timeout: 60_000 })
    .toBe("Waiting Preparation Review");

  const activities = await all<{ type: string }>(
    `SELECT a.type FROM "OrderActivity" a JOIN "Order" o ON o.id=a."orderId"
      WHERE o."orderNumber"=$1 AND a.type='ORDER_APPROVED'`, [orderNumber]
  );
  expect(activities.length, "the approval is recorded once, not five times").toBe(1);
});

test("Hammering Save Preparation Review reserves stock only once", async ({ page }) => {
  await loginAs(page, "sales");
  const card = await openWorkstationOrder(page, orderNumber);

  const selects = card.locator("table select");
  for (let i = 0; i < (await selects.count()); i++) await selects.nth(i).selectOption("Available on Shelf");

  const save = card.getByRole("button", { name: /Save Preparation Review/i });
  await expect(save).toBeEnabled();
  for (let i = 0; i < 4; i++) await save.click({ force: true, timeout: 5_000 }).catch(() => {});

  await expect
    .poll(async () => (await one<{ d: string }>(
      `SELECT oi."preparationDecision" d FROM "OrderItem" oi JOIN "Order" o ON o.id=oi."orderId" WHERE o."orderNumber"=$1`,
      [orderNumber]
    )).d, { timeout: 60_000 })
    .toBeTruthy();

  // The line has no stock behind it, so nothing should be reserved; what matters is that
  // repeated saves did not stack allocations on top of each other.
  const reserved = await one<{ n: number; rows: number }>(
    `SELECT COALESCE(SUM(sa."quantityUnits"),0)::int n, COUNT(*)::int rows
       FROM "StockAllocation" sa JOIN "OrderItem" oi ON oi.id=sa."orderItemId"
       JOIN "Order" o ON o.id=oi."orderId"
      WHERE o."orderNumber"=$1 AND sa.status='RESERVED'`, [orderNumber]
  );
  const ordered = num((await one<{ q: number }>(
    `SELECT oi."quantityUnits" q FROM "OrderItem" oi JOIN "Order" o ON o.id=oi."orderId" WHERE o."orderNumber"=$1`,
    [orderNumber]
  )).q);
  expect(num(reserved.n), "repeated saves never reserve more than the line ordered").toBeLessThanOrEqual(ordered);
});

test("The same order in two tabs: the stale tab is refused, not silently obeyed", async ({ context }) => {
  const a = await context.newPage();
  const b = await context.newPage();
  await loginAs(a, "sales");

  // Both tabs look at the same order.
  await a.goto("/dashboard/workstation/preparation");
  await b.goto("/dashboard/workstation/preparation");
  await expect(a.getByText(`#${orderNumber}`).first()).toBeVisible({ timeout: 60_000 });
  await expect(b.getByText(`#${orderNumber}`).first()).toBeVisible({ timeout: 60_000 });

  // Tab A cancels the order. Tab B still shows it as live.
  const statusBefore = (await one<{ s: string }>(`SELECT status s FROM "Order" WHERE "orderNumber"=$1`, [orderNumber])).s;
  const cancel = await a.evaluate(
    async ({ n }) => {
      const orders = await (await fetch("/api/orders")).json();
      const o = orders.find((x: { orderNumber: number }) => x.orderNumber === n);
      const res = await fetch(`/api/orders/${o.id}/status`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "cancel", reason: "UAT two-tab test" }),
      });
      return { status: res.status, id: o.id };
    },
    { n: orderNumber }
  );
  expect(cancel.status, "tab A cancels the order").toBe(200);
  expect(statusBefore).not.toBe("Cancelled");

  // Tab B now acts on what it believes. The server must refuse rather than accept a
  // decision made against a state that no longer exists.
  const stale = await b.evaluate(
    async ({ id }) => {
      const res = await fetch(`/api/orders/${id}/status`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "complete" }),
      });
      return { status: res.status, body: await res.text() };
    },
    { id: cancel.id }
  );
  expect(stale.status, "the stale tab's action is refused").toBe(409);
  expect(stale.body, "and the reason is explained in words").toMatch(/not allowed from status|changed before/i);
  expect(stale.body, "no raw database error is exposed").not.toMatch(/prisma|P20\d\d|invocation/i);

  const after = (await one<{ s: string }>(`SELECT status s FROM "Order" WHERE "orderNumber"=$1`, [orderNumber])).s;
  expect(after, "the order is still exactly what tab A made it").toBe("Cancelled");
  await a.close();
  await b.close();
});

test("A refused server response is explained in plain words, never as a database error", async ({ page }) => {
  await loginAs(page, "sales");
  await page.goto("/dashboard/orders");

  // Force the create-order call to fail the way a server fault would.
  await page.route("**/api/orders", async (route) => {
    if (route.request().method() === "POST") {
      await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "Something went wrong. Please try again." }) });
    } else {
      await route.continue();
    }
  });

  // Errors from this form are raised as a native alert, so the dialog is captured rather
  // than read from the page body.
  const alerts: string[] = [];
  page.on("dialog", async (d) => { alerts.push(d.message()); await d.dismiss(); });

  await page.getByRole("button", { name: /New Order/i }).click();
  const modal = page.locator("div.fixed").filter({ hasText: /New Order/i }).first();
  await modal.locator("select").first().selectOption({ label: catalog.customers.hotel.name });
  await modal.locator('input[type="text"]').first().fill("UAT-FAIL");
  await modal.getByPlaceholder(/Search Product/i).fill(catalog.skus.col500.label);
  await modal.getByPlaceholder(/Quantity/i).fill("3");
  await modal.getByRole("button", { name: /Create Order/i }).click();

  // The operator must be told something, and it must not be a stack trace.
  await expect.poll(() => alerts.length, { timeout: 30_000 }).toBeGreaterThan(0);
  const shown = alerts.join(" | ");
  expect(shown, "a failure is surfaced to the operator").toMatch(/went wrong|error|failed|try again/i);
  expect(shown, "no database internals leak into the interface").not.toMatch(/PrismaClient|P20\d\d|invocation|at Object\./i);

  const created = await all(`SELECT id FROM "Order" WHERE "quotationNumber"='UAT-FAIL'`);
  expect(created.length, "a failed request writes nothing").toBe(0);
});

test("Reloading mid-flow and using Back leave the order exactly as it was", async ({ page }) => {
  await loginAs(page, "sales");

  const before = await one<{ s: string; items: number }>(
    `SELECT o.status s, (SELECT COUNT(*)::int FROM "OrderItem" WHERE "orderId"=o.id) items
       FROM "Order" o WHERE o."orderNumber"=$1`, [orderNumber]
  );

  // Open the new-order dialog, half-fill it, then reload out from under it.
  await page.goto("/dashboard/orders");
  await page.getByRole("button", { name: /New Order/i }).click();
  const modal = page.locator("div.fixed").filter({ hasText: /New Order/i }).first();
  await modal.locator('input[type="text"]').first().fill("UAT-ABANDONED");
  await page.reload();
  await expect(page.getByRole("button", { name: /New Order/i })).toBeVisible({ timeout: 60_000 });
  await expect(page.locator("div.fixed").filter({ hasText: /New Order/i }), "an abandoned dialog does not survive a reload").toHaveCount(0);

  // Navigate away and back.
  await page.goto("/dashboard/workstation/preparation");
  await page.waitForLoadState("domcontentloaded");
  await page.goBack();
  await expect(page.getByRole("button", { name: /New Order/i })).toBeVisible({ timeout: 60_000 });

  const after = await one<{ s: string; items: number }>(
    `SELECT o.status s, (SELECT COUNT(*)::int FROM "OrderItem" WHERE "orderId"=o.id) items
       FROM "Order" o WHERE o."orderNumber"=$1`, [orderNumber]
  );
  expect(after.s).toBe(before.s);
  expect(num(after.items)).toBe(num(before.items));
  expect(await all(`SELECT id FROM "Order" WHERE "quotationNumber"='UAT-ABANDONED'`)).toEqual([]);
});

test("Form validation refuses an empty or nonsensical order before it reaches the server", async ({ page }) => {
  await loginAs(page, "sales");
  await page.goto("/dashboard/orders");
  await page.getByRole("button", { name: /New Order/i }).click();
  const modal = page.locator("div.fixed").filter({ hasText: /New Order/i }).first();

  // Nothing chosen at all.
  await expect(modal.getByRole("button", { name: /Create Order/i }), "an empty order cannot be submitted").toBeDisabled();

  // A customer but no product.
  await modal.locator("select").first().selectOption({ label: catalog.customers.hotel.name });
  await expect(modal.getByRole("button", { name: /Create Order/i })).toBeDisabled();
  await expect(modal.getByText(/Select a product to add a line/i)).toBeVisible();

  // A product but a quantity of zero.
  await modal.getByPlaceholder(/Search Product/i).fill(catalog.skus.col500.label);
  await modal.getByPlaceholder(/Quantity/i).fill("0");
  await expect(modal.getByRole("button", { name: /Create Order/i }), "zero units is not an order").toBeDisabled();

  // A sane quantity unlocks it.
  await modal.getByPlaceholder(/Quantity/i).fill("2");
  await expect(modal.getByRole("button", { name: /Create Order/i })).toBeEnabled();
});

test("A slow server keeps the operator informed and the button un-clickable", async ({ page }) => {
  await loginAs(page, "sales");
  await page.goto("/dashboard/orders");

  // Hold the response for four seconds — long enough to see what the screen does.
  await page.route("**/api/orders", async (route) => {
    if (route.request().method() === "POST") {
      await new Promise((r) => setTimeout(r, 4000));
      await route.continue();
    } else {
      await route.continue();
    }
  });

  await page.getByRole("button", { name: /New Order/i }).click();
  const modal = page.locator("div.fixed").filter({ hasText: /New Order/i }).first();
  await modal.locator("select").first().selectOption({ label: catalog.customers.bakery.name });
  await modal.locator('input[type="text"]').first().fill("UAT-SLOW");
  await modal.getByPlaceholder(/Search Product/i).fill(catalog.skus.col1kg.label);
  await modal.getByPlaceholder(/Quantity/i).fill("2");

  const submit = modal.getByRole("button", { name: /Create Order/i });
  await submit.click();
  // While the write is in flight the control must not accept another one.
  await expect(submit, "the submit button locks during the write").toBeDisabled({ timeout: 3_000 });

  await expect(modal).toBeHidden({ timeout: 60_000 });
  const rows = await all(`SELECT id FROM "Order" WHERE "quotationNumber"='UAT-SLOW'`);
  expect(rows.length, "a slow write still lands exactly once").toBe(1);
});
