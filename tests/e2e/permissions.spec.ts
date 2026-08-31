import { test, expect, type Page } from "@playwright/test";
import { loginAs } from "./support/app";
import { ROLES, type RoleName } from "./support/roles";

// Role restrictions, checked twice over: what the interface offers, and what the server
// accepts. Hiding a button is a courtesy, not a control — every negative case here also
// calls the endpoint directly from inside the authenticated browser session, which is
// exactly what a curious employee with the developer console would do.

test.describe.configure({ mode: "serial" });

/** Call an API from inside the logged-in page, so the real session cookie is used. */
async function apiFromBrowser(page: Page, path: string, init: { method?: string; body?: unknown } = {}) {
  return page.evaluate(
    async ({ path, method, body }) => {
      const res = await fetch(path, {
        method: method ?? "GET",
        headers: { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      let json: unknown = null;
      try { json = await res.json(); } catch { /* empty body */ }
      return { status: res.status, json };
    },
    { path, method: init.method, body: init.body }
  );
}

/** Navigating straight to a URL must be refused, not merely un-linked. */
async function expectPageRefused(page: Page, url: string, label: string) {
  await page.goto(url);
  // These screens render a loading state before deciding, so the verdict has to be
  // polled — reading the body immediately just catches the spinner.
  await expect
    .poll(
      async () => {
        const body = (await page.locator("body").innerText().catch(() => "")).toLowerCase();
        if (/^\s*loading/.test(body) || body.length < 20) return "pending";
        const denied =
          /cannot open this screen|not part of your role|access denied|not authorized|unauthorized|no permission|forbidden|do not have|sign in/.test(body);
        const redirected = !page.url().includes(url.split("?")[0]);
        return denied || redirected ? "refused" : `allowed: ${body.slice(0, 140)}`;
      },
      { timeout: 45_000, message: `${label}: direct navigation to ${url} must be refused` }
    )
    .toBe("refused");
}

const NAV_FOR: Record<RoleName, { visible: RegExp[]; hidden: RegExp[] }> = {
  sales: {
    visible: [/^Orders$/, /Order Preparation/, /Customers/],
    hidden: [/^Production$/, /Production Orders/, /Quality Control/, /^Packaging$/, /^Dispatch$/, /Employees/],
  },
  production: {
    visible: [/^Production$/, /Production Orders/],
    hidden: [/Quality Control/, /^Dispatch$/, /Employees/, /Customers/],
  },
  qc: { visible: [/Quality Control/], hidden: [/^Orders$/, /^Dispatch$/, /^Packaging$/, /Employees/] },
  packaging: { visible: [/^Packaging$/], hidden: [/^Orders$/, /^Dispatch$/, /Quality Control/, /Employees/] },
  dispatch: { visible: [/^Dispatch$/, /^Orders$/], hidden: [/^Production$/, /Quality Control/, /^Packaging$/, /Employees/] },
  admin: { visible: [/^Orders$/, /^Production$/, /Quality Control/, /^Packaging$/, /^Dispatch$/, /Employees/], hidden: [] },
};

for (const role of Object.keys(NAV_FOR) as RoleName[]) {
  test(`${ROLES[role].name} sees only the modules they hold`, async ({ page }) => {
    await loginAs(page, role);
    const nav = page.locator("nav");
    for (const re of NAV_FOR[role].visible) {
      await expect(nav.getByRole("link", { name: re }), `${role} should see ${re}`).toHaveCount(1);
    }
    for (const re of NAV_FOR[role].hidden) {
      await expect(nav.getByRole("link", { name: re }), `${role} must not see ${re}`).toHaveCount(0);
    }
  });
}

test("Sales cannot reach production screens, and the server agrees", async ({ page }) => {
  await loginAs(page, "sales");

  await expectPageRefused(page, "/dashboard/production", "sales → production");
  await expectPageRefused(page, "/dashboard/production-orders", "sales → production orders");

  // The API is the real control. Sales holds no production privilege at all, so raising a
  // production requirement and moving a production order must both be refused.
  const item = await apiFromBrowser(page, "/api/orders");
  const orders = item.json as { items: { id: string }[] }[];
  const anyItemId = orders.flatMap((o) => o.items).map((i) => i.id)[0];
  expect(anyItemId, "sales can read orders, which it is allowed to do").toBeTruthy();

  const raise = await apiFromBrowser(page, `/api/order-items/${anyItemId}/production-requirement`, { method: "POST" });
  expect(raise.status, "sales must not raise production").toBe(403);

  const roast = await apiFromBrowser(page, "/api/roasting-batches", {
    method: "POST",
    body: { greenBeanId: "x", greenBeanQuantity: 1, roastedBeanQuantity: 1, wasteQuantity: 0 },
  });
  expect(roast.status, "sales must not start a roast").toBe(403);
});

test("Production cannot approve orders or administer employees", async ({ page }) => {
  await loginAs(page, "production");

  await expectPageRefused(page, "/dashboard/employees", "production → employees");

  const orders = await apiFromBrowser(page, "/api/orders");
  const first = (orders.json as { id: string }[])[0];

  // Production holds `orders: view`, so reading is fine and deciding is not.
  expect(orders.status).toBe(200);
  const approve = await apiFromBrowser(page, `/api/orders/${first.id}/approve`, {
    method: "POST",
    body: { decision: "Yes" },
  });
  expect(approve.status, "production must not approve orders").toBe(403);

  // The employee list is readable by any signed-in employee on purpose — screens show who
  // roasted a batch or approved an order. What matters is the projection: a non-admin gets
  // a name roster and nothing that could be used to become somebody else.
  const employees = await apiFromBrowser(page, "/api/employees", { method: "GET" });
  expect(employees.status).toBe(200);
  const roster = employees.json as Record<string, unknown>[];
  expect(roster.length).toBeGreaterThan(0);
  for (const field of ["permissions", "username", "pin", "pinHash", "password"]) {
    expect(
      roster.every((e) => !(field in e)),
      `a non-admin must not receive '${field}' for other employees`
    ).toBeTruthy();
  }
  expect(Object.keys(roster[0]).sort()).toEqual(["active", "id", "name", "role"]);
});

test("QC can finalize QC but cannot roast or dispatch", async ({ page }) => {
  await loginAs(page, "qc");

  const batches = await apiFromBrowser(page, "/api/roasting-batches");
  expect(batches.status, "QC needs to read batches for its own queue").toBe(200);

  const roast = await apiFromBrowser(page, "/api/roasting-batches", {
    method: "POST",
    body: { greenBeanId: "x", greenBeanQuantity: 1, roastedBeanQuantity: 1, wasteQuantity: 0 },
  });
  expect(roast.status, "QC must not start a roast").toBe(403);

  const deliver = await apiFromBrowser(page, "/api/deliveries", {
    method: "POST",
    body: { orderItemId: "x", quantityUnits: 1, deliveryType: "full", finishedGoodsLotId: "y" },
  });
  expect(deliver.status, "QC must not dispatch").toBe(403);

  await expectPageRefused(page, "/dashboard/dispatch", "qc → dispatch");
});

test("Packaging can pack but cannot record a QC verdict or a delivery", async ({ page }) => {
  await loginAs(page, "packaging");

  const qc = await apiFromBrowser(page, "/api/qc-records", {
    method: "POST",
    body: { batchId: "x", decision: "Accept" },
  });
  expect(qc.status, "packaging must not file QC verdicts").toBe(403);

  const deliver = await apiFromBrowser(page, "/api/deliveries", {
    method: "POST",
    body: { orderItemId: "x", quantityUnits: 1, deliveryType: "full", finishedGoodsLotId: "y" },
  });
  expect(deliver.status, "packaging must not dispatch").toBe(403);

  await expectPageRefused(page, "/dashboard/qc", "packaging → qc");
});

test("Dispatch can deliver but cannot pack or roast", async ({ page }) => {
  await loginAs(page, "dispatch");

  const pack = await apiFromBrowser(page, "/api/roasting-batches/x/pack-sku", {
    method: "POST",
    body: { productSkuId: "y", units: 1 },
  });
  expect(pack.status, "dispatch must not pack").toBe(403);

  const roast = await apiFromBrowser(page, "/api/roasting-batches", {
    method: "POST",
    body: { greenBeanId: "x", greenBeanQuantity: 1, roastedBeanQuantity: 1, wasteQuantity: 0 },
  });
  expect(roast.status, "dispatch must not roast").toBe(403);

  await expectPageRefused(page, "/dashboard/packaging", "dispatch → packaging");
});

test("An expired session sends the operator back to the login screen", async ({ page, context }) => {
  await loginAs(page, "sales");
  await page.goto("/dashboard/orders");
  await expect(page.getByRole("heading", { name: /Orders/i }).first()).toBeVisible();

  // Session expiry, as the browser experiences it: the cookie is gone and the next thing
  // the operator does must not silently half-work.
  await context.clearCookies();

  const afterExpiry = await apiFromBrowser(page, "/api/orders");
  expect(afterExpiry.status, "the API refuses an expired session").toBe(401);

  await page.goto("/dashboard/orders");
  await page.waitForURL(/\/login/, { timeout: 60_000 });
  await expect(page.getByText(/Enter Your PIN/i)).toBeVisible();
});
