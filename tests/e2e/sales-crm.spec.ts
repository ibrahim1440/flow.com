import { test, expect, type Page } from "@playwright/test";
import { loginAs, logout, catalog, collectPageProblems } from "./support/app";
import { one, all, num } from "./support/db";
import { TAG } from "./support/global-setup";

/**
 * Sales CRM & Commissions — browser UAT.
 *
 * These tests drive the real screens as real employees: they sign in through the keypad,
 * fill the real forms and click the real buttons. Every assertion that matters is then
 * checked against the DATABASE, not against what the screen says — a green toast over a row
 * that was never written is the failure this suite exists to catch.
 *
 * ── Where the API is used instead of the UI, and why ──
 * Two places, both marked at the point of use:
 *
 *   1. **Sandbox collection events.** There is deliberately no screen for these. The
 *      collection source is an adapter behind three server-side gates, and building an
 *      operator-facing way to type in payments would be building the thing the module
 *      explicitly does not claim to have. The suite calls the endpoint from inside the
 *      logged-in browser session — the real session cookie, the real authorization — and
 *      then verifies the RESULT through the screens.
 *
 *   2. **Negative permission checks.** Every one of those also calls the endpoint from the
 *      browser, because a hidden button is a courtesy and the handler is the control.
 *
 * Nothing external is mocked, because there is nothing external: no email, no SMS, no
 * payment provider. The commission input is synthetic and says so on every screen.
 */

test.describe.configure({ mode: "serial" });

const SUITE = `${TAG}-CRM`;

/** Call an API from inside the logged-in page, so the real session cookie is used. */
async function apiFromBrowser(
  page: Page,
  path: string,
  init: { method?: string; body?: unknown } = {},
) {
  return page.evaluate(
    async ({ path, method, body }) => {
      const res = await fetch(path, {
        method: method ?? "GET",
        headers: { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      let json: unknown = null;
      try { json = await res.json(); } catch { /* empty body */ }
      return { status: res.status, json: json as never };
    },
    { path, method: init.method, body: init.body },
  );
}

/** The current Riyadh month, the way the API's `month` parameter wants it. */
function riyadhMonth(): string {
  const r = new Date(Date.now() + 3 * 3600_000);
  return `${r.getUTCFullYear()}-${String(r.getUTCMonth() + 1).padStart(2, "0")}`;
}
/** A collection date on a given day of the current Riyadh month. */
function dayOfMonthISO(day: number): string {
  const r = new Date(Date.now() + 3 * 3600_000);
  return new Date(Date.UTC(r.getUTCFullYear(), r.getUTCMonth(), day, 9, 0, 0)).toISOString();
}

/**
 * Wait until the browser is on a real quotation, and return its id.
 *
 * `/quotes/new` is a staging route: it raises the draft and then replaces the URL with the
 * quotation's own. Waiting for "a quotes URL with one more segment" is satisfied by
 * /quotes/new?opportunityId=… immediately, and the id read out of it is the word "new" —
 * which then fails much later, in a database lookup, as an undefined row.
 */
async function waitForQuoteId(page: Page): Promise<string> {
  // The whole path has to be checked, not just its last segment. Reading "the last
  // segment is not 'new'" is already true on the deal page the click started from, so the
  // poll returned instantly and handed back the DEAL's id — which then failed three
  // assertions later as an undefined row, naming nothing useful.
  await expect
    .poll(() => page.url().split("?")[0].replace(/\/$/, ""), {
      timeout: 60_000,
      message: "the draft quotation should open on its own URL",
    })
    .toMatch(/\/dashboard\/sales\/quotes\/(?!new$)[^/]+$/);
  return page.url().split("?")[0].replace(/\/$/, "").split("/").pop()!;
}

/** Ids discovered as the suite runs, so later tests act on what earlier ones actually made. */
const state: {
  leadId?: string;
  dealId?: string;
  quoteId?: string;
  revisionId?: string;
  orderNumber?: number;
} = {};

const COMPANY = `${SUITE} Rawabi Cafe`;
const TWIN = `${SUITE} Rawabi Second Branch`;

// ═══════════════════════════════════════════════════════════════════════════
test.describe("1 — Sign-in and what each role is shown", () => {
  test("a rep signs in and lands on a session that survives a reload", async ({ page }) => {
    const problems = collectPageProblems(page);
    await loginAs(page, "crmRep");

    await page.goto("/dashboard/sales/leads");
    await expect(page.getByRole("heading", { name: /Leads|العملاء المحتملون/ })).toBeVisible();

    // The session is a cookie, not page state: a full reload must not sign anybody out.
    await page.reload();
    await expect(page.getByRole("heading", { name: /Leads|العملاء المحتملون/ })).toBeVisible();
    expect(page.url()).toContain("/dashboard/sales/leads");

    expect(problems.failedRequests, "no server faults while signing in").toEqual([]);
  });

  test("signing out ends the session, and a protected page then refuses", async ({ page }) => {
    await loginAs(page, "crmRep");
    await page.goto("/dashboard/sales/leads");
    await logout(page);

    await page.goto("/dashboard/sales/leads");
    // The screen either redirects to the login page or refuses; either is a refusal, and
    // showing the lead list is not.
    await expect
      .poll(async () => {
        if (page.url().includes("/login")) return "refused";
        const body = (await page.locator("body").innerText().catch(() => "")).toLowerCase();
        return /sign in|enter your pin|not authenticated/.test(body) ? "refused" : `allowed: ${body.slice(0, 80)}`;
      }, { timeout: 30_000 })
      .toBe("refused");
  });

  test("a deactivated employee is signed out on their very next request", async ({ page }) => {
    await loginAs(page, "crmRep");
    await page.goto("/dashboard/sales/leads");

    // Deactivation is the control an operations manager reaches for when somebody leaves.
    // It has to bite immediately, not when a token happens to expire.
    const { exec } = await import("./support/db");
    await exec(`UPDATE "Employee" SET active = false WHERE id = $1`, [`${TAG}_emp_crmRep`]);
    try {
      const r = await apiFromBrowser(page, "/api/sales/leads");
      expect(r.status, "a revoked account is unauthenticated, not merely forbidden").toBe(401);
    } finally {
      await exec(`UPDATE "Employee" SET active = true WHERE id = $1`, [`${TAG}_emp_crmRep`]);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
test.describe("2 — Leads: creation, duplicates, conversion", () => {
  test("a rep creates a lead through the form and owns it", async ({ page }) => {
    await loginAs(page, "crmRep");
    await page.goto("/dashboard/sales/leads");

    await page.getByRole("button", { name: /New lead|عميل محتمل جديد/i }).click();

    const dialog = page.getByTestId("lead-form");
    await expect(dialog).toBeVisible();

    // By label, not by position. Addressing "the fourth input" passes just as happily with
    // no labels at all, and breaks silently the moment a field is added above it.
    await dialog.getByLabel(/Company/).fill(COMPANY);
    await dialog.getByLabel(/Contact/).fill("Layla Hassan");
    await dialog.getByLabel(/Phone/).fill("0533330001");

    await dialog.getByRole("button", { name: /^Save$/ }).click();
    await expect(dialog).toBeHidden({ timeout: 30_000 });

    const row = await one<{ id: string; ownerId: string; normalizedPhone: string; status: string }>(
      `SELECT id, "ownerId", "normalizedPhone", status FROM "Lead" WHERE "companyName" = $1`,
      [COMPANY],
    );
    expect(row, "the lead reached the database").toBeTruthy();
    expect(row.ownerId, "owned by whoever created it, never by the request body").toBe(`${TAG}_emp_crmRep`);
    expect(row.normalizedPhone, "the duplicate key was normalised on the way in").toBe("533330001");
    state.leadId = row.id;

    // And it is on the screen after a reload, which is the part an operator actually needs.
    await page.reload();
    await expect(page.getByText(COMPANY)).toBeVisible({ timeout: 30_000 });
  });

  test("the same phone in another format is reported, not silently merged", async ({ page }) => {
    await loginAs(page, "crmRep");
    await page.goto("/dashboard/sales/leads");
    await page.getByRole("button", { name: /New lead|عميل محتمل جديد/i }).click();

    const dialog = page.getByTestId("lead-form");
    await dialog.getByLabel(/Company/).fill(TWIN);
    await dialog.getByLabel(/Contact/).fill("Layla Hassan");
    await dialog.getByLabel(/Phone/).fill("+966 53 333 0001");
    await dialog.getByRole("button", { name: /^Save$/ }).click();

    // The screen reports the clash and keeps the form open.
    await expect(
      dialog.getByText(/already exists|موجود/i),
      "the operator is told, rather than the record being merged",
    ).toBeVisible({ timeout: 30_000 });
    await expect(
      dialog.getByText(COMPANY),
      "and the lead it clashes with is named, so the operator can go and look",
    ).toBeVisible();

    const n = await one<{ n: number }>(
      `SELECT COUNT(*)::int n FROM "Lead" WHERE "companyName" = $1`, [TWIN]);
    expect(num(n.n), "nothing was created on the first attempt").toBe(0);

    // Proceeding is deliberate, and possible: several buyers at one cafe is the normal
    // case, so the system surfaces the clash and a person decides.
    await dialog.getByRole("button", { name: /Create anyway/i }).click();
    await expect(dialog).toBeHidden({ timeout: 30_000 });

    const after = await one<{ n: number }>(
      `SELECT COUNT(*)::int n FROM "Lead" WHERE "normalizedPhone" = '533330001'`);
    expect(num(after.n), "both leads exist; nothing was merged").toBe(2);
  });

  test("a rep cannot see or reach another rep's lead", async ({ page }) => {
    // A lead belonging to the manager, created directly so the rep never had sight of it.
    const { exec } = await import("./support/db");
    const foreignId = `${TAG}_foreign_lead`;
    await exec(
      `INSERT INTO "Lead" (id,"companyName","contactName","ownerId",status,source,"createdAt","updatedAt")
       VALUES ($1,$2,'Someone Else',$3,'NEW','OTHER',now(),now())
       ON CONFLICT (id) DO NOTHING`,
      [foreignId, `${SUITE} Not Yours`, `${TAG}_emp_crmManager`],
    );

    await loginAs(page, "crmRep");
    await page.goto("/dashboard/sales/leads");
    await expect(page.getByText(COMPANY)).toBeVisible({ timeout: 30_000 });
    await expect(
      page.getByText(`${SUITE} Not Yours`),
      "the colleague's lead is not on the rep's list",
    ).toHaveCount(0);

    // And the server agrees, which is the part that matters: hiding a row in the browser
    // is a leak with a stylesheet over it.
    const direct = await apiFromBrowser(page, `/api/sales/leads/${foreignId}`);
    expect(direct.status, "404, not 403 — confirming it exists would name a customer").toBe(404);

    const edit = await apiFromBrowser(page, `/api/sales/leads/${foreignId}`, {
      method: "PATCH", body: { city: "Riyadh" },
    });
    expect(edit.status).toBe(404);
  });

  test("a manager sees the whole pipeline, because that is a separate privilege", async ({ page }) => {
    await loginAs(page, "crmManager");
    await page.goto("/dashboard/sales/leads");
    await expect(page.getByText(`${SUITE} Not Yours`)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(COMPANY)).toBeVisible();
  });

  test("converting the lead makes one customer and one deal, however many times it is clicked", async ({ page }) => {
    await loginAs(page, "crmRep");
    await page.goto("/dashboard/sales/leads");

    const card = page.getByTestId(`lead-${state.leadId}`);
    await expect(card).toBeVisible({ timeout: 30_000 });
    await card.getByRole("button", { name: /Convert to customer|تحويل إلى عميل/i }).click();

    await expect
      .poll(async () =>
        num((await one<{ n: number }>(
          `SELECT COUNT(*)::int n FROM "LeadConversion" WHERE "leadId" = $1`, [state.leadId!])).n),
        { timeout: 30_000 })
      .toBe(1);

    const conv = await one<{ customerId: string; opportunityId: string }>(
      `SELECT "customerId","opportunityId" FROM "LeadConversion" WHERE "leadId" = $1`, [state.leadId!]);
    state.dealId = conv.opportunityId;

    const customer = await one<{ name: string }>(
      `SELECT name FROM "Customer" WHERE id = $1`, [conv.customerId]);
    expect(customer.name, "the customer carries the lead's company name").toBe(COMPANY);

    // The button people double-click. The second press must find the first conversion,
    // not make a second customer.
    const replay = await apiFromBrowser(page, `/api/sales/leads/${state.leadId}/convert`, {
      method: "POST", body: {},
    });
    expect(replay.status, "a replay answers 200, not 201").toBe(200);
    const after = await one<{ n: number }>(
      `SELECT COUNT(*)::int n FROM "LeadConversion" WHERE "leadId" = $1`, [state.leadId!]);
    expect(num(after.n), "still exactly one conversion").toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
test.describe("3 — The deal: stages, loss reasons, reopening", () => {
  test("the deal page opens and shows what the rep needs next", async ({ page }) => {
    await loginAs(page, "crmRep");
    await page.goto(`/dashboard/sales/deals/${state.dealId}`);

    await expect(page.getByRole("heading", { name: new RegExp(COMPANY) })).toBeVisible({ timeout: 30_000 });
    await expect(
      page.getByTestId("deal-outcome"),
      "the stage or outcome is stated, not left to be inferred",
    ).toBeVisible();
    // The provisional banner is part of the deliverable: a screen that looks finished when
    // it is not stops anybody reviewing it.
    await expect(page.getByText(/provisional|مبدئية/i).first()).toBeVisible();
  });

  test("moving a stage writes an event, and survives a reload", async ({ page }) => {
    await loginAs(page, "crmRep");
    await page.goto(`/dashboard/sales/deals/${state.dealId}`);

    const proposal = catalog.crm.stages.find((s) => s.code.endsWith("_PROPOSAL"))!;
    await page.getByTestId(`stage-${proposal.code}`).click();

    await expect
      .poll(async () =>
        (await one<{ stageId: string }>(
          `SELECT "stageId" FROM "Opportunity" WHERE id = $1`, [state.dealId!])).stageId,
        { timeout: 30_000 })
      .toBe(proposal.id);

    const events = await all<{ n: number }>(
      `SELECT COUNT(*)::int n FROM "OpportunityStageEvent" WHERE "opportunityId" = $1`, [state.dealId!]);
    expect(num(events[0].n), "the move is on the deal's timeline").toBeGreaterThan(1);

    await page.reload();
    await expect(page.getByTestId(`stage-${proposal.code}`)).toHaveAttribute("aria-pressed", "true");
  });

  test("a rep cannot close a deal at all", async ({ page }) => {
    await loginAs(page, "crmRep");
    await page.goto(`/dashboard/sales/deals/${state.dealId}`);

    await expect(page.getByTestId("win-deal"), "the control is not offered").toHaveCount(0);
    await expect(page.getByTestId("lose-deal")).toHaveCount(0);

    const r = await apiFromBrowser(page, `/api/sales/opportunities/${state.dealId}/transition`, {
      method: "POST", body: { toOutcome: "LOST", lostReason: "trying it on" },
    });
    expect(r.status, "and the server refuses it too").toBe(403);
    const row = await one<{ outcome: string }>(
      `SELECT outcome FROM "Opportunity" WHERE id = $1`, [state.dealId!]);
    expect(row.outcome).toBe("OPEN");
  });

  test("a manager marking a deal lost must give a reason", async ({ page }) => {
    await loginAs(page, "crmManager");
    await page.goto(`/dashboard/sales/deals/${state.dealId}`);

    await page.getByTestId("lose-deal").click();
    const dialog = page.getByTestId("lost-dialog");
    await expect(dialog).toBeVisible();

    // The confirm button stays disabled until a reason is typed. A pipeline of lost deals
    // with no reasons teaches nobody anything, so the rule is enforced in both places.
    await expect(
      dialog.getByTestId("confirm-lost"),
      "no reason, no close",
    ).toBeDisabled();

    await dialog.locator("textarea").fill("Chose a competitor on price");
    await expect(dialog.getByTestId("confirm-lost")).toBeEnabled();
    await dialog.getByTestId("confirm-lost").click();
    await expect(dialog).toBeHidden({ timeout: 30_000 });

    const row = await one<{ outcome: string; lostReason: string; closedAt: string | null }>(
      `SELECT outcome,"lostReason","closedAt" FROM "Opportunity" WHERE id = $1`, [state.dealId!]);
    expect(row.outcome).toBe("LOST");
    expect(row.lostReason).toBe("Chose a competitor on price");
    expect(row.closedAt, "and the close is dated").not.toBeNull();
  });

  test("the server refuses a close with no reason even when the dialog is bypassed", async ({ page }) => {
    // Reopen first, so the refusal being tested is the missing reason and not the terminal
    // state — a test that passes for the wrong reason is worse than one that fails.
    await loginAs(page, "crmManager");
    await page.goto(`/dashboard/sales/deals/${state.dealId}`);
    await page.getByTestId("reopen-deal").click();
    await expect
      .poll(async () =>
        (await one<{ outcome: string }>(`SELECT outcome FROM "Opportunity" WHERE id=$1`, [state.dealId!])).outcome,
        { timeout: 30_000 })
      .toBe("OPEN");

    const r = await apiFromBrowser(page, `/api/sales/opportunities/${state.dealId}/transition`, {
      method: "POST", body: { toOutcome: "LOST" },
    });
    expect(r.status).toBe(400);
    expect(String((r.json as { error?: string })?.error ?? "")).toMatch(/reason/i);
  });

  test("reopening is its own privilege", async ({ page }) => {
    // Close it again so there is something to reopen.
    await loginAs(page, "crmManager");
    await apiFromBrowser(page, `/api/sales/opportunities/${state.dealId}/transition`, {
      method: "POST", body: { toOutcome: "LOST", lostReason: "parked for now" },
    });

    await loginAs(page, "crmRep");
    const denied = await apiFromBrowser(page, `/api/sales/opportunities/${state.dealId}/transition`, {
      method: "POST", body: { toOutcome: "OPEN" },
    });
    expect(denied.status, "a rep may not resurrect a closed deal").toBe(403);

    await loginAs(page, "crmManager");
    await page.goto(`/dashboard/sales/deals/${state.dealId}`);
    await page.getByTestId("reopen-deal").click();

    await expect
      .poll(async () =>
        (await one<{ outcome: string; lostReason: string | null }>(
          `SELECT outcome,"lostReason" FROM "Opportunity" WHERE id=$1`, [state.dealId!])).outcome,
        { timeout: 30_000 })
      .toBe("OPEN");

    const row = await one<{ lostReason: string | null }>(
      `SELECT "lostReason" FROM "Opportunity" WHERE id=$1`, [state.dealId!]);
    expect(row.lostReason, "and the stale loss reason is cleared, not left to mislead").toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
test.describe("4 — Quotations, and the order one becomes", () => {
  test("a rep builds a quotation and the server prices it", async ({ page }) => {
    await loginAs(page, "crmRep");
    await page.goto(`/dashboard/sales/deals/${state.dealId}`);

    await page.getByTestId("new-quote").click();
    state.quoteId = await waitForQuoteId(page);

    await page.getByTestId("add-line").click();
    const sku = catalog.skus.ken1kg;
    await page.getByTestId("line-0").locator("select").first().selectOption({ label: sku.name });
    await page.getByTestId("line-0").locator("input").first().fill("10");

    // The page shows a preview, and says it is a preview. The figures that count are the
    // server's, which is what the reload below actually checks.
    await page.getByTestId("save-quote").click();

    await expect
      .poll(async () =>
        (await one<{ grandTotal: string }>(
          `SELECT "grandTotal" FROM "Quote" WHERE id=$1`, [state.quoteId!])).grandTotal,
        { timeout: 30_000 })
      .toBe("1552.50");
    // 10 x 135.00 = 1,350.00; the form's default 15% VAT adds 202.50.

    await page.reload();
    // Grouped and padded for the reader; the stored figure asserted above is the exact one.
    await expect(page.getByTestId("quote-totals")).toContainText("1,552.50");
  });

  test("a rep cannot issue a quotation discounted past the threshold", async ({ page }) => {
    await loginAs(page, "crmRep");
    await page.goto(`/dashboard/sales/quotes/${state.quoteId}`);

    // 25% off, well past the 10% a rep may give unilaterally.
    await page.getByTestId("line-0").locator("input").nth(2).fill("25");
    await page.getByTestId("save-quote").click();

    await expect(
      page.getByText(/above the 10%|أعلى من 10/i),
      "the screen warns before the refusal, rather than after it",
    ).toBeVisible({ timeout: 30_000 });

    await page.getByTestId("issue-quote").click();
    await expect(page.getByTestId("alert-error")).toContainText(/discount approval|اعتماد الخصم/i, {
      timeout: 30_000,
    });

    const row = await one<{ status: string }>(`SELECT status FROM "Quote" WHERE id=$1`, [state.quoteId!]);
    expect(row.status, "and it is still a draft").toBe("DRAFT");
  });

  test("a manager issues it, and the approval is recorded on the document", async ({ page }) => {
    await loginAs(page, "crmManager");
    await page.goto(`/dashboard/sales/quotes/${state.quoteId}`);
    await page.getByTestId("issue-quote").click();

    await expect
      .poll(async () =>
        (await one<{ status: string }>(`SELECT status FROM "Quote" WHERE id=$1`, [state.quoteId!])).status,
        { timeout: 30_000 })
      .toBe("ISSUED");

    const row = await one<{ discountApprovedById: string | null; frozen: boolean }>(
      `SELECT "discountApprovedById", ("issuedSnapshot" IS NOT NULL) AS frozen FROM "Quote" WHERE id=$1`,
      [state.quoteId!]);
    expect(row.discountApprovedById, "who approved the discount is on the quotation").toBe(`${TAG}_emp_crmManager`);
    expect(row.frozen, "and the lines and prices were frozen as sent").toBe(true);
  });

  test("an issued quotation is read-only on the screen and on the server", async ({ page }) => {
    await loginAs(page, "crmManager");
    await page.goto(`/dashboard/sales/quotes/${state.quoteId}`);

    await expect(page.getByTestId("add-line"), "no way to add a line").toHaveCount(0);
    await expect(page.getByTestId("line-0").locator("input").first()).toBeDisabled();

    const r = await apiFromBrowser(page, `/api/sales/quotes/${state.quoteId}`, {
      method: "PUT",
      body: { lines: [{ productSkuId: catalog.skus.ken1kg.id, quantity: "1", unit: "UNIT", unitPrice: "1" }] },
    });
    expect(r.status).toBe(409);
  });

  test("revising supersedes the original and carries the lines over", async ({ page }) => {
    await loginAs(page, "crmManager");
    await page.goto(`/dashboard/sales/quotes/${state.quoteId}`);
    await page.getByTestId("revise-quote").click();

    await expect
      .poll(() => page.url().split("?")[0].replace(/\/$/, "").split("/").pop(), { timeout: 60_000 })
      .not.toBe(state.quoteId);
    state.revisionId = await waitForQuoteId(page);

    const old = await one<{ status: string }>(`SELECT status FROM "Quote" WHERE id=$1`, [state.quoteId!]);
    expect(old.status).toBe("SUPERSEDED");

    const nu = await one<{ revision: number; supersedesId: string; lines: number }>(
      `SELECT q.revision, q."supersedesId", COUNT(l.id)::int lines
         FROM "Quote" q LEFT JOIN "QuoteLine" l ON l."quoteId" = q.id
        WHERE q.id = $1 GROUP BY q.id`, [state.revisionId!]);
    expect(num(nu.revision)).toBe(2);
    expect(nu.supersedesId).toBe(state.quoteId);
    expect(num(nu.lines), "the lines came with it").toBe(1);
  });

  test("the revision is issued at a corrected price and accepted", async ({ page }) => {
    await loginAs(page, "crmManager");
    await page.goto(`/dashboard/sales/quotes/${state.revisionId}`);

    await page.getByTestId("line-0").locator("input").nth(2).fill("5");
    await page.getByTestId("save-quote").click();
    await expect(page.getByTestId("alert-success")).toBeVisible({ timeout: 30_000 });

    await page.getByTestId("issue-quote").click();
    await expect
      .poll(async () =>
        (await one<{ status: string }>(`SELECT status FROM "Quote" WHERE id=$1`, [state.revisionId!])).status,
        { timeout: 30_000 })
      .toBe("ISSUED");

    await page.getByTestId("accept-quote").click();
    await expect
      .poll(async () =>
        (await one<{ status: string }>(`SELECT status FROM "Quote" WHERE id=$1`, [state.revisionId!])).status,
        { timeout: 30_000 })
      .toBe("ACCEPTED");

    const row = await one<{ grandTotal: string }>(
      `SELECT "grandTotal" FROM "Quote" WHERE id=$1`, [state.revisionId!]);
    // 1,350 less 5% = 1,282.50; VAT 15% = 192.38 (half-up on 192.375); total 1,474.88.
    expect(row.grandTotal).toBe("1474.88");
  });

  test("the accepted quotation becomes exactly one order", async ({ page }) => {
    await loginAs(page, "crmManager");
    const before = await one<{ n: number }>(`SELECT COUNT(*)::int n FROM "Order"`);

    await page.goto(`/dashboard/sales/quotes/${state.revisionId}`);
    await page.getByTestId("create-order").click();
    const dialog = page.getByTestId("order-dialog");
    await expect(dialog).toBeVisible();
    await dialog.getByTestId("confirm-order").click();
    await expect(dialog).toBeHidden({ timeout: 60_000 });

    await expect
      .poll(async () =>
        num((await one<{ n: number }>(`SELECT COUNT(*)::int n FROM "Order"`)).n),
        { timeout: 30_000 })
      .toBe(num(before.n) + 1);

    const link = await one<{ orderNumber: number; units: number; kg: string; status: string; quotationNumber: string }>(
      `SELECT o."orderNumber", o.status, o."quotationNumber",
              SUM(i."quantityUnits")::int units, SUM(i."quantityKg")::numeric kg
         FROM "OpportunityOrder" oo
         JOIN "Order" o ON o.id = oo."orderId"
         JOIN "OrderItem" i ON i."orderId" = o.id
        WHERE oo."quoteId" = $1 GROUP BY o.id`, [state.revisionId!]);
    state.orderNumber = num(link.orderNumber);

    expect(num(link.units), "ten units, taken from the quotation").toBe(10);
    // Derived by the order service from the SKU, never supplied by the CRM: 10 x 1 kg.
    expect(num(link.kg), "kilograms were derived, not sent").toBe(10);
    expect(link.status).toBe("Waiting Preparation Review");
    expect(link.quotationNumber?.startsWith("Q-"), "the order carries the quotation reference").toBe(true);
  });

  test("and clicking again does not make a second one", async ({ page }) => {
    await loginAs(page, "crmManager");
    const before = await one<{ n: number }>(`SELECT COUNT(*)::int n FROM "Order"`);

    await page.goto(`/dashboard/sales/quotes/${state.revisionId}`);
    const r = await apiFromBrowser(page, `/api/sales/quotes/${state.revisionId}/create-order`, {
      method: "POST", body: {},
    });
    expect(r.status, "the replay succeeds rather than erroring").toBe(200);
    expect((r.json as { replayed?: boolean })?.replayed).toBe(true);
    expect((r.json as { orderNumber?: number })?.orderNumber).toBe(state.orderNumber);

    const after = await one<{ n: number }>(`SELECT COUNT(*)::int n FROM "Order"`);
    expect(num(after.n), "no second order").toBe(num(before.n));
  });

  test("the order appears on the operational Orders screen", async ({ page }) => {
    // The join between the CRM and the ERP is only real if the warehouse can see it.
    await loginAs(page, "admin");
    await page.goto("/dashboard/orders");
    await expect(page.getByTestId(`order-card-${state.orderNumber}`)).toBeVisible({ timeout: 60_000 });
  });

  test("the deal can now be won, and the win is on its timeline", async ({ page }) => {
    await loginAs(page, "crmManager");
    await page.goto(`/dashboard/sales/deals/${state.dealId}`);
    await page.getByTestId("win-deal").click();

    await expect
      .poll(async () =>
        (await one<{ outcome: string }>(`SELECT outcome FROM "Opportunity" WHERE id=$1`, [state.dealId!])).outcome,
        { timeout: 30_000 })
      .toBe("WON");

    const ev = await one<{ n: number }>(
      `SELECT COUNT(*)::int n FROM "OpportunityStageEvent" WHERE "opportunityId"=$1 AND "toOutcome"='WON'`,
      [state.dealId!]);
    expect(num(ev.n)).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
test.describe("5 — Commission: two plans, instalments, approval, refund", () => {
  // Collection events are recorded through the sandbox endpoint from inside the logged-in
  // session. There is deliberately no screen for them — see the note at the top of this
  // file — so what the browser proves here is that the RESULT reaches the screens, and that
  // the boundaries around who may record one hold.

  test("a rep cannot record a collection, whatever they try", async ({ page }) => {
    await loginAs(page, "crmRep");
    const r = await apiFromBrowser(page, "/api/commissions/sandbox-collections", {
      method: "POST",
      body: { externalRef: `${TAG}-FAKE-1`, amountGross: "999999", opportunityId: state.dealId },
    });
    expect(r.status, "a rep must not be able to manufacture money they are paid on").toBe(403);

    const n = await one<{ n: number }>(
      `SELECT COUNT(*)::int n FROM "CollectionEvent" WHERE "externalRef" = $1`, [`${TAG}-FAKE-1`]);
    expect(num(n.n), "and nothing was recorded").toBe(0);
  });

  test("a partial collection accrues once, and a re-delivery changes nothing", async ({ page }) => {
    await loginAs(page, "crmManager");

    const post = () => apiFromBrowser(page, "/api/commissions/sandbox-collections", {
      method: "POST",
      body: {
        externalRef: `${TAG}-PAY-1`, opportunityId: state.dealId,
        amountGross: "5750", amountTax: "750", collectedAt: dayOfMonthISO(5),
      },
    });

    const first = await post();
    expect(first.status).toBe(201);

    // 5,750 less 750 VAT = 5,000 qualifying, at the rep's 1% = 50.00.
    const led = () => one<{ total: string; n: number }>(
      `SELECT COALESCE(SUM(amount),0)::numeric total, COUNT(*)::int n
         FROM "CommissionLedgerEntry" WHERE "employeeId"=$1 AND type IN ('ACCRUAL','REVERSAL')`,
      [`${TAG}_emp_crmRep`]);
    expect(num((await led()).total)).toBe(50);

    const again = await post();
    expect((again.json as { replayed?: boolean })?.replayed, "a re-delivered payment is recognised").toBe(true);
    const after = await led();
    expect(num(after.total), "still 50, not 100").toBe(50);
    expect(num(after.n), "and no second ledger entry").toBe(1);
  });

  test("the rep sees their own figure on their own screen, marked as sandbox", async ({ page }) => {
    await loginAs(page, "crmRep");
    await page.goto(`/dashboard/sales/my-commissions?month=${riyadhMonth()}`);

    await expect(page.getByText("50.00").first()).toBeVisible({ timeout: 30_000 });
    await expect(
      page.getByText(/sandbox|no real payment|تجريبي|لم يُستلم/i).first(),
      "and the screen says where the money came from",
    ).toBeVisible();

    // Not the team's.
    const team = await apiFromBrowser(page, `/api/commissions/review?month=${riyadhMonth()}`);
    expect(team.status).toBe(403);
  });

  test("the second instalment adds the difference, and the rows sum to the period", async ({ page }) => {
    await loginAs(page, "crmManager");
    const r = await apiFromBrowser(page, "/api/commissions/sandbox-collections", {
      method: "POST",
      body: {
        externalRef: `${TAG}-PAY-2`, opportunityId: state.dealId,
        amountGross: "5750", amountTax: "750", collectedAt: dayOfMonthISO(6),
      },
    });
    expect(r.status).toBe(201);

    const led = await one<{ total: string }>(
      `SELECT COALESCE(SUM(amount),0)::numeric total FROM "CommissionLedgerEntry"
        WHERE "employeeId"=$1 AND type IN ('ACCRUAL','REVERSAL')`, [`${TAG}_emp_crmRep`]);
    expect(num(led.total), "the second payment added 50, not another 100").toBe(100);

    const rows = await all<{ amount: string }>(
      `SELECT amount::numeric amount FROM "CommissionAccrual" WHERE "employeeId"=$1`, [`${TAG}_emp_crmRep`]);
    expect(rows.length).toBe(2);
    expect(
      rows.reduce((a, x) => a + num(x.amount), 0),
      "each row carries its own event's share, so they sum to the period",
    ).toBe(100);
  });

  test("two people on different plans are paid differently for the same money", async ({ page }) => {
    await loginAs(page, "crmManager");

    // A second deal, owned by the manager, who is on the 2% plan.
    const { exec } = await import("./support/db");
    const mgrDeal = `${TAG}_mgr_deal`;
    await exec(
      `INSERT INTO "Opportunity" (id,title,"stageId",outcome,amount,currency,probability,"ownerId","createdAt","updatedAt")
       VALUES ($1,$2,$3,'OPEN',0,'SAR',50,$4,now(),now()) ON CONFLICT (id) DO NOTHING`,
      [mgrDeal, `${SUITE} Manager's own deal`, catalog.crm.stages[0].id, `${TAG}_emp_crmManager`],
    );

    const r = await apiFromBrowser(page, "/api/commissions/sandbox-collections", {
      method: "POST",
      body: {
        externalRef: `${TAG}-PAY-MGR`, opportunityId: mgrDeal,
        amountGross: "5750", amountTax: "750", collectedAt: dayOfMonthISO(7),
      },
    });
    expect(r.status).toBe(201);

    const mgr = await one<{ total: string }>(
      `SELECT COALESCE(SUM(amount),0)::numeric total FROM "CommissionLedgerEntry"
        WHERE "employeeId"=$1 AND type IN ('ACCRUAL','REVERSAL')`, [`${TAG}_emp_crmManager`]);
    // The same 5,000 qualifying base, at 2% instead of 1%.
    expect(num(mgr.total), "the senior plan pays 100 where the standard plan paid 50").toBe(100);
  });

  test("finance reviews the team, and the ledger reconciles with the rows", async ({ page }) => {
    await loginAs(page, "crmFinance");
    await page.goto(`/dashboard/commissions/review?month=${riyadhMonth()}`);

    const row = page.getByTestId(`review-row-${TAG}_emp_crmRep`);
    await expect(row).toBeVisible({ timeout: 30_000 });
    await expect(row).toContainText("100.00");
    await expect(
      page.getByTestId(`reconciled-${TAG}_emp_crmRep`),
      "the two sources of the figure agree, and the screen says so",
    ).toContainText(/matches|متطابق/i);
  });

  test("finance cannot approve their own commission", async ({ page }) => {
    await loginAs(page, "crmFinance");
    await page.goto(`/dashboard/commissions/review?month=${riyadhMonth()}`);

    const r = await apiFromBrowser(page, "/api/commissions/review/actions", {
      method: "POST", body: { action: "approve", employeeId: `${TAG}_emp_crmFinance`, month: riyadhMonth() },
    });
    expect(r.status, "nobody signs off their own pay").toBe(403);
  });

  test("finance approves the rep's period, and the rows are then immutable", async ({ page }) => {
    await loginAs(page, "crmFinance");
    await page.goto(`/dashboard/commissions/review?month=${riyadhMonth()}`);

    await page.getByTestId(`approve-${TAG}_emp_crmRep`).click();
    await expect(page.getByTestId("alert-success")).toBeVisible({ timeout: 30_000 });

    const rows = await all<{ status: string; approvedById: string }>(
      `SELECT status,"approvedById" FROM "CommissionAccrual" WHERE "employeeId"=$1`, [`${TAG}_emp_crmRep`]);
    expect(rows.every((r) => r.status === "APPROVED"), "every accrual is approved").toBe(true);
    expect(rows.every((r) => r.approvedById === `${TAG}_emp_crmFinance`), "and carries the approver").toBe(true);
  });

  test("a refund after approval corrects the ledger and leaves the approved rows alone", async ({ page }) => {
    const before = await all<{ id: string; amount: string; status: string }>(
      `SELECT id, amount::numeric amount, status FROM "CommissionAccrual"
        WHERE "employeeId"=$1 ORDER BY id`, [`${TAG}_emp_crmRep`]);

    await loginAs(page, "crmManager");
    const r = await apiFromBrowser(page, "/api/commissions/sandbox-collections", {
      method: "PATCH", body: { externalRef: `${TAG}-PAY-2` },
    });
    expect(r.status).toBe(200);

    const led = await one<{ total: string }>(
      `SELECT COALESCE(SUM(amount),0)::numeric total FROM "CommissionLedgerEntry"
        WHERE "employeeId"=$1 AND type IN ('ACCRUAL','REVERSAL')`, [`${TAG}_emp_crmRep`]);
    expect(num(led.total), "the ledger drops back to 50").toBe(50);

    const rev = await one<{ amount: string }>(
      `SELECT amount::numeric amount FROM "CommissionLedgerEntry"
        WHERE "employeeId"=$1 AND type='REVERSAL' ORDER BY "createdAt" DESC LIMIT 1`,
      [`${TAG}_emp_crmRep`]);
    expect(num(rev.amount), "recorded as a negative entry, not as an edit").toBe(-50);

    const after = await all<{ id: string; amount: string; status: string }>(
      `SELECT id, amount::numeric amount, status FROM "CommissionAccrual"
        WHERE "employeeId"=$1 ORDER BY id`, [`${TAG}_emp_crmRep`]);
    for (const b of before) {
      const a = after.find((x) => x.id === b.id)!;
      expect(num(a.amount), `accrual ${b.id} was approved and must not move`).toBe(num(b.amount));
      expect(a.status).toBe(b.status);
    }
  });

  test("and the correction is visible on the rep's own screen", async ({ page }) => {
    await loginAs(page, "crmRep");
    await page.goto(`/dashboard/sales/my-commissions?month=${riyadhMonth()}`);
    await expect(page.getByText("50.00").first()).toBeVisible({ timeout: 30_000 });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
test.describe("6 — Arabic, mobile, keyboard and validation", () => {
  test("the interface renders right-to-left in Arabic", async ({ page }) => {
    // The language is baked into the session token at sign-in — the root layout reads it
    // from the JWT rather than querying the employee on every render — so the preference
    // has to be set BEFORE logging in. Changing it afterwards and reloading leaves the old
    // token in place and tests nothing.
    const { exec } = await import("./support/db");
    await exec(`UPDATE "Employee" SET "preferredLanguage" = 'ar' WHERE id = $1`, [`${TAG}_emp_crmRep`]);
    try {
      await loginAs(page, "crmRep");
      await page.goto("/dashboard/sales/leads");

      await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
      await expect(
        page.getByRole("heading", { name: /العملاء المحتملون/ }),
        "and the heading is in Arabic, not an untranslated key",
      ).toBeVisible({ timeout: 30_000 });

      // The page must not scroll sideways: on a narrow screen that puts half the controls
      // out of reach, and it is the classic RTL regression.
      await page.setViewportSize({ width: 390, height: 844 });
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow, "no horizontal overflow at phone width").toBeLessThanOrEqual(1);
    } finally {
      await exec(`UPDATE "Employee" SET "preferredLanguage" = 'en' WHERE id = $1`, [`${TAG}_emp_crmRep`]);
    }
  });

  test("the follow-ups screen works at phone width", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await loginAs(page, "crmRep");
    await page.goto("/dashboard/sales/activities");

    await expect(page.getByRole("heading", { name: /Follow-ups|المتابعات/ })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("filter-overdue")).toBeVisible();

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, "the body does not scroll sideways").toBeLessThanOrEqual(1);
  });

  test("a form can be completed with the keyboard alone", async ({ page }) => {
    await loginAs(page, "crmRep");
    await page.goto(`/dashboard/sales/deals/${state.dealId}`);
    await page.getByTestId("log-activity").click();

    const dialog = page.getByTestId("activity-dialog");
    await expect(dialog).toBeVisible();

    // Reached by its label, which is what a screen reader announces and what makes the
    // label clickable. Addressing it by position would pass just as well with no label at
    // all — which is the bug this is checking for.
    const subject = dialog.getByLabel(/Subject|الموضوع/);
    await subject.focus();
    await expect(subject, "the label is wired to the field").toBeFocused();
    await page.keyboard.type(`${SUITE} keyboard-only note`);

    await dialog.getByTestId("save-activity").click();
    await expect(dialog).toBeHidden({ timeout: 30_000 });

    const row = await one<{ subject: string; ownerId: string }>(
      `SELECT subject,"ownerId" FROM "Activity" WHERE subject = $1`, [`${SUITE} keyboard-only note`]);
    expect(row, "and it was saved").toBeTruthy();
    expect(row.ownerId).toBe(`${TAG}_emp_crmRep`);
  });

  test("Escape closes a dialog without saving", async ({ page }) => {
    await loginAs(page, "crmRep");
    await page.goto(`/dashboard/sales/deals/${state.dealId}`);
    const before = await one<{ n: number }>(
      `SELECT COUNT(*)::int n FROM "Activity" WHERE "opportunityId" = $1`, [state.dealId!]);

    await page.getByTestId("log-activity").click();
    const dialog = page.getByTestId("activity-dialog");
    await expect(dialog).toBeVisible();
    await dialog.getByLabel(/Subject|الموضوع/).fill("discarded");
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden({ timeout: 15_000 });

    const after = await one<{ n: number }>(
      `SELECT COUNT(*)::int n FROM "Activity" WHERE "opportunityId" = $1`, [state.dealId!]);
    expect(num(after.n), "nothing was written").toBe(num(before.n));
  });

  test("an invalid form cannot be submitted at all, and the server agrees", async ({ page }) => {
    await loginAs(page, "crmRep");
    await page.goto("/dashboard/sales/leads");
    await page.getByRole("button", { name: /New lead|عميل محتمل جديد/i }).click();

    const dialog = page.getByTestId("lead-form");
    const save = dialog.getByRole("button", { name: /^Save$/ });
    await expect(save, "an empty form offers nothing to press").toBeDisabled();

    // One character each: the rule is that both names are at least two.
    await dialog.getByLabel(/Company/).fill("X");
    await dialog.getByLabel(/Contact/).fill("Y");
    await expect(save, "and a one-character name still does not").toBeDisabled();

    await dialog.getByLabel(/Company/).fill("Xy");
    await dialog.getByLabel(/Contact/).fill("Yz");
    await expect(save, "two characters is enough").toBeEnabled();

    // The disabled button is a courtesy. The rule that matters is the server's, so it is
    // checked directly — which is what anybody with a developer console would do.
    const r = await apiFromBrowser(page, "/api/sales/leads", {
      method: "POST", body: { companyName: "X", contactName: "Y" },
    });
    expect(r.status).toBe(400);
    const n = await one<{ n: number }>(`SELECT COUNT(*)::int n FROM "Lead" WHERE "companyName" = 'X'`);
    expect(num(n.n), "and nothing reached the database").toBe(0);
  });

  test("the CSV importer previews before it writes", async ({ page }) => {
    await loginAs(page, "crmRep");
    await page.goto("/dashboard/sales/leads");
    const before = await one<{ n: number }>(
      `SELECT COUNT(*)::int n FROM "Lead" WHERE "companyName" LIKE '${SUITE} Imported%'`);

    await page.getByTestId("import-leads").click();
    const dialog = page.getByTestId("import-dialog");
    await expect(dialog).toBeVisible();

    await dialog.getByTestId("import-paste").fill(
      `companyName,contactName,phone\n${SUITE} Imported One,Dana,0577770001\n${SUITE} Imported Two,Rami,0577770002\nX,Bad,\n`,
    );
    await dialog.getByTestId("import-check").click();

    const preview = dialog.getByTestId("import-preview");
    await expect(preview).toBeVisible({ timeout: 30_000 });
    await expect(preview, "two of the three rows would import").toContainText("2 of 3");
    await expect(dialog.getByTestId("import-problems"), "and the bad row is named by its number")
      .toContainText(/Row 4/i);

    const during = await one<{ n: number }>(
      `SELECT COUNT(*)::int n FROM "Lead" WHERE "companyName" LIKE '${SUITE} Imported%'`);
    expect(num(during.n), "the preview wrote nothing").toBe(num(before.n));

    await dialog.getByTestId("import-commit").click();
    await expect(dialog).toBeHidden({ timeout: 30_000 });

    await expect
      .poll(async () => num((await one<{ n: number }>(
        `SELECT COUNT(*)::int n FROM "Lead" WHERE "companyName" LIKE '${SUITE} Imported%'`)).n),
        { timeout: 30_000 })
      .toBe(num(before.n) + 2);

    const owners = await all<{ ownerId: string }>(
      `SELECT "ownerId" FROM "Lead" WHERE "companyName" LIKE '${SUITE} Imported%'`);
    expect(owners.every((o) => o.ownerId === `${TAG}_emp_crmRep`), "owned by the importer").toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
test.describe("7 — Reports and targets", () => {
  test("a manager sets a target and the progress bar reflects real collections", async ({ page }) => {
    await loginAs(page, "crmManager");
    await page.goto(`/dashboard/sales/targets?month=${riyadhMonth()}`);

    await page.getByTestId("new-target").click();
    const dialog = page.getByTestId("target-dialog");
    await expect(dialog).toBeVisible();

    await dialog.getByLabel(/Employee|الموظف/).selectOption({ label: "UAT Sales Rep" });
    await dialog.getByLabel(/Target \(SAR\)|الهدف/).fill("10000");
    await dialog.getByTestId("save-target").click();
    await expect(dialog).toBeHidden({ timeout: 30_000 });

    const row = page.getByTestId(`target-${TAG}_emp_crmRep`);
    await expect(row).toBeVisible({ timeout: 30_000 });
    // 5,000 collected and still standing, against a 10,000 target.
    await expect(row, "progress is measured from collections, not from pipeline value")
      .toContainText("50%");
  });

  test("a manager cannot set their own target", async ({ page }) => {
    await loginAs(page, "crmManager");
    await page.goto(`/dashboard/sales/targets?month=${riyadhMonth()}`);
    const r = await apiFromBrowser(page, "/api/sales/targets", {
      method: "PUT",
      body: { employeeId: `${TAG}_emp_crmManager`, month: riyadhMonth(), targetAmount: "1" },
    });
    expect(r.status).toBe(403);
  });

  test("the reports screen states the denominator of its conversion rate", async ({ page }) => {
    await loginAs(page, "crmManager");
    await page.goto(`/dashboard/sales/reports?month=${riyadhMonth()}`);

    await expect(page.getByTestId("stat-conversion")).toBeVisible({ timeout: 30_000 });
    await expect(
      page.getByTestId("stat-conversion"),
      "a conversion rate with no stated denominator is a number people quote for years",
    ).toContainText(/of the leads that arrived|من العملاء المحتملين الذين وصلوا/i);

    await expect(page.getByTestId("stat-winrate")).toBeVisible();
    await expect(page.getByTestId("stage-breakdown")).toBeVisible();
  });

  test("a rep's reports are scoped to their own work", async ({ page }) => {
    await loginAs(page, "crmRep");
    await page.goto(`/dashboard/sales/reports?month=${riyadhMonth()}`);
    await expect(page.getByText(/your own performance only|أداؤك أنت فقط/i)).toBeVisible({ timeout: 30_000 });
  });
});
