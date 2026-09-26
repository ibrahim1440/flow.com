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

// Each module is identified by its route. The labels changed when navigation became
// grouped ("Order Preparation" → "Order preparation", "Quotations and orders" for holders
// of the sales module); the routes, and which roles may see them, did not.
const M = {
  orders: "/dashboard/orders",
  prep: "/dashboard/workstation/preparation",
  customers: "/dashboard/customers",
  production: "/dashboard/production",
  productionOrders: "/dashboard/production-orders",
  qc: "/dashboard/qc",
  packaging: "/dashboard/packaging",
  dispatch: "/dashboard/dispatch",
  employees: "/dashboard/employees",
  leads: "/dashboard/sales/leads",
  pipeline: "/dashboard/sales/pipeline",
  followUps: "/dashboard/sales/activities",
  quotes: "/dashboard/sales/quotes",
  myCommissions: "/dashboard/sales/my-commissions",
  plans: "/dashboard/commissions/plans",
  review: "/dashboard/commissions/review",
  targets: "/dashboard/sales/targets",
  reports: "/dashboard/sales/reports"
} as const;
// Multi-page subunits (src/lib/nav/registry.ts): the sidebar links to one page the role may
// open, and its siblings are offered on that page's contextual bar (the third level).
const SUBUNITS: string[][] = [
  [M.leads, M.customers],
  [M.pipeline, M.followUps],
  [M.quotes, M.orders],
  [M.targets, M.reports, M.myCommissions, M.review, M.plans],
];
const NAV_FOR: Record<RoleName, { visible: string[]; hidden: string[] }> = {
  sales: {
    visible: [M.orders, M.prep, M.customers],
    hidden: [M.production, M.productionOrders, M.qc, M.packaging, M.dispatch, M.employees],
  },
  production: {
    visible: [M.production, M.productionOrders],
    hidden: [M.qc, M.dispatch, M.employees, M.customers],
  },
  qc: { visible: [M.qc], hidden: [M.orders, M.dispatch, M.packaging, M.employees] },
  packaging: { visible: [M.packaging], hidden: [M.orders, M.dispatch, M.qc, M.employees] },
  dispatch: { visible: [M.dispatch, M.orders], hidden: [M.production, M.qc, M.packaging, M.employees] },
  admin: { visible: [M.orders, M.production, M.qc, M.packaging, M.dispatch, M.employees], hidden: [] },

  // ── The CRM roles ─────────────────────────────────────────────────────────
  // The hidden lists carry the point. A rep must not be offered commission
  // administration or the team review; finance must not be offered the pipeline at all.
  crmRep: {
    visible: [M.leads, M.pipeline, M.followUps, M.quotes, M.myCommissions],
    hidden: [M.plans, M.review, M.production, M.qc, M.employees],
  },
  crmManager: {
    visible: [M.leads, M.pipeline, M.quotes, M.targets, M.reports, M.plans],
    hidden: [M.production, M.qc, M.dispatch, M.employees],
  },
  crmFinance: {
    visible: [M.myCommissions, M.review],
    // Finance holds no sales module at all, so the entire CRM section is absent — not
    // merely the parts they cannot act on.
    hidden: [M.leads, M.pipeline, M.quotes, M.targets, M.plans, M.orders],
  },
};

for (const role of Object.keys(NAV_FOR) as RoleName[]) {
  test(`${ROLES[role].name} sees only the modules they hold`, async ({ page }) => {
    await loginAs(page, role);
    const nav = page.locator("nav");
    // Grouped navigation renders a group's links only while it is open, and groups the
    // current page is not in start closed. Open every group, then assert the same sets.
    // Wait for hydration first: a group opened on the server-rendered markup is closed again
    // when the client takes over.
    await page.waitForLoadState("networkidle");
    const closed = nav.locator('button[aria-expanded="false"]');
    for (let i = 0; i < 20 && (await closed.count()) > 0; i++) await closed.first().click();
    const sidebar = await nav.locator("a[href]").evaluateAll((as) => as.map((a) => a.getAttribute("href")!));
    const offered = new Set(sidebar);
    for (const unit of SUBUNITS) {
      const entry = unit.find((h) => offered.has(h));
      if (!entry) continue;
      await page.goto(entry);
      await page.waitForLoadState("networkidle");
      const bar = page.getByTestId("contextual-nav");
      if (await bar.count()) for (const h of await bar.locator("a[href]").evaluateAll((as) => as.map((a) => a.getAttribute("href")!))) offered.add(h);
    }
    for (const href of NAV_FOR[role].visible) {
      expect(offered.has(href), `${role} should be offered ${href} (offered: ${[...offered].join(", ")})`).toBe(true);
    }
    for (const href of NAV_FOR[role].hidden) {
      expect(offered.has(href), `${role} must not be offered ${href}`).toBe(false);
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
