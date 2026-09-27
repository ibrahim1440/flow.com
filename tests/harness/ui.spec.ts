/**
 * MOCKED BROWSER UI VERIFICATION.
 *
 * Read the label literally. These tests mount the real Sales components in a browser with a
 * fixture-backed `fetch`. They are evidence about LAYOUT and COMPONENT BEHAVIOUR — reflow at
 * three widths, RTL, overflow, keyboard reachability, and the states a screen derives from a
 * response.
 *
 * They are NOT evidence that anything is authorised, that anything persists, or that the
 * server would answer the way these fixtures do. A stubbed fetch cannot refuse a request, so
 * nothing here says anything about permissions — the components hide controls as a courtesy
 * and the API is what actually enforces. That distinction is the whole reason this file is
 * named the way it is.
 */
import { test, expect, type Page } from "@playwright/test";
import path from "node:path";
import { pathToFileURL } from "node:url";

const HARNESS = pathToFileURL(path.join(__dirname, "index.html")).href;

const WIDTHS = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "tablet-1024", width: 1024, height: 900 },
  { name: "mobile-390", width: 390, height: 844 },
] as const;

/** A deliberately punishing Arabic company name — long, unbroken, and realistic. */
const LONG_AR = "شركة مصانع القهوة المتخصصة للتحميص والتعبئة والتوزيع بالمنطقة الوسطى المحدودة";

/**
 * Permission fixtures use the application's real shape — `{ module: { access, sub } }`.
 *
 * An earlier draft of this file used a flat `{ sales: { lead_write: true } }`, which
 * `hasSubPrivilege` reads as no privileges at all. Every "the control is hidden" assertion
 * passed, for the wrong reason: BOTH users were powerless. The reader case is only meaningful
 * next to a writer case that actually renders the controls.
 */
const REP = {
  id: "u1", name: "فهد العتيبي", preferredLanguage: "ar",
  permissions: {
    sales: { access: "full", sub: { lead_write: true, lead_convert: true, deal_close: true, deal_reopen: true } },
  },
};
const READER = {
  id: "u2", name: "قارئ", preferredLanguage: "ar",
  permissions: { sales: { access: "view", sub: {} } },
};

async function mount(
  page: Page,
  screen: string,
  routes: Record<string, unknown>,
  user: unknown = REP,
  params: Record<string, string> = { id: "lead-1" },
) {
  await page.goto(HARNESS);
  await page.evaluate(
    ([r, u, p]) => {
      (window as never as Record<string, unknown>).__ROUTES__ = r;
      (window as never as Record<string, unknown>).__USER__ = u;
      (window as never as Record<string, unknown>).__PARAMS__ = p;
      (window as never as Record<string, unknown>).__LANG__ = "ar";
    },
    [routes, user, params] as const,
  );
  await page.evaluate((s) => (window as never as { mountScreen: (n: string) => void }).mountScreen(s), screen);
}

/** The page body itself must never scroll sideways. */
async function noHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(() => ({
    doc: document.documentElement.scrollWidth,
    win: window.innerWidth,
  }));
  expect(overflow.doc, `page scrollWidth ${overflow.doc} vs viewport ${overflow.win}`)
    .toBeLessThanOrEqual(overflow.win + 1);
}

// ─────────────────────────────────────────────────────────────────────────────
const stage = (id: string, code: string, nameAr: string, position: number) =>
  ({ id, code, nameAr, nameEn: code, position, probability: 20 });

const deal = (id: string, stageId: string, title: string, outcome = "OPEN") => ({
  id, title, stageId, outcome, lostReason: outcome === "LOST" ? "السعر أعلى من المنافس" : null,
  amount: "48000", currency: "SAR", expectedCloseAt: null, nextFollowUpAt: null, closedAt: null,
  customer: { id: "c1", name: "Coffee Co", nameAr: LONG_AR },
  owner: { id: "u1", name: "فهد العتيبي" },
  _count: { quotes: 2, samples: 1, activities: 3 }, quotes: [],
});

const PIPELINE_OK = {
  "/api/sales/opportunities": {
    body: {
      stages: [stage("s1", "QUALIFY", "تأهيل", 1), stage("s2", "QUOTE", "عرض سعر", 2), stage("s3", "CLOSE", "إغلاق", 3)],
      deals: [
        deal("d1", "s1", LONG_AR + " — تعاقد سنوي"),
        deal("d2", "s1", "كافيه ٢١"),
        deal("d3", "s2", "محمصة النخبة"),
        deal("d4", "s3", "مقهى الرصيف", "WON"),
        deal("d5", "s3", "مطعم السدرة", "LOST"),
      ],
      scope: "own",
      can: { close: true, reopen: true },
    },
  },
};

test.describe("mocked browser UI — pipeline", () => {
  for (const vp of WIDTHS) {
    test(`pipeline renders the right layout at ${vp.name}`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await mount(page, "pipeline", PIPELINE_OK);

      const board = page.locator('[data-testid="stage-QUALIFY"]');
      const accordion = page.locator('[data-testid="pipeline-accordion"]');

      if (vp.width >= 1024) {
        // lg is 64rem = 1024px, so the board is visible at exactly 1024.
        await expect(board).toBeVisible();
        await expect(accordion).toBeHidden();
      } else {
        await expect(accordion).toBeVisible();
        await expect(board).toBeHidden();
      }
      await noHorizontalOverflow(page);
    });
  }

  test("mobile accordion: first stage open, others collapsed, and they toggle", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await mount(page, "pipeline", PIPELINE_OK);

    const first = page.locator('[data-testid="m-stage-QUALIFY"] button[aria-expanded]').first();
    const second = page.locator('[data-testid="m-stage-QUOTE"] button[aria-expanded]').first();
    await expect(first).toHaveAttribute("aria-expanded", "true");
    await expect(second).toHaveAttribute("aria-expanded", "false");

    await second.click();
    await expect(second).toHaveAttribute("aria-expanded", "true");
    await expect(page.locator('[data-testid="m-deal-d3"]')).toBeVisible();
  });

  test("mobile accordion is keyboard reachable and toggles on Enter", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await mount(page, "pipeline", PIPELINE_OK);
    const second = page.locator('[data-testid="m-stage-QUOTE"] button[aria-expanded]').first();
    await second.focus();
    await expect(second).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(second).toHaveAttribute("aria-expanded", "true");
  });

  test("a long Arabic deal title wraps instead of widening the page", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await mount(page, "pipeline", PIPELINE_OK);
    const title = page.locator('[data-testid="m-open-deal-d1"]');
    await expect(title).toBeVisible();
    const box = await title.boundingBox();
    expect(box!.width).toBeLessThanOrEqual(390);
    expect(box!.height).toBeGreaterThan(20); // it wrapped onto more than one line
    await noHorizontalOverflow(page);
  });

  test("won and lost stay outside the stage sections", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await mount(page, "pipeline", PIPELINE_OK);
    await expect(page.locator('[data-testid="m-outcome-won"]')).toBeVisible();
    await expect(page.locator('[data-testid="m-outcome-lost"]')).toBeVisible();
    // The lost deal is not inside a stage section.
    await expect(page.locator('[data-testid="m-stage-CLOSE"] [data-testid="m-deal-d5"]')).toHaveCount(0);
  });

  test("empty pipeline shows the configure-stages message, not a blank board", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await mount(page, "pipeline", {
      "/api/sales/opportunities": { body: { stages: [], deals: [], scope: "own", can: { close: false, reopen: false } } },
    });
    await expect(page.getByText("لم يتم إعداد مراحل المسار بعد.")).toBeVisible();
  });

  test("a failed load shows an error rather than an empty board", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await mount(page, "pipeline", { "/api/sales/opportunities": { status: 500, body: { error: "boom" } } });
    await expect(page.getByRole("alert")).toContainText("تعذّر تحميل مسار الصفقات");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
const LEAD_OK = {
  "/api/sales/leads/": {
    body: {
      lead: {
        id: "lead-1", companyName: "Coffee Co", companyNameAr: LONG_AR, contactName: "سارة القحطاني",
        phone: "+966 55 214 8890", email: "s@example.com", city: "الرياض", address: null,
        source: "REFERRAL", sourceNote: null, status: "QUALIFIED", notes: null,
        nextFollowUpAt: null, createdAt: "2026-09-01T09:00:00Z", updatedAt: "2026-09-02T09:00:00Z",
        owner: { id: "u1", name: "فهد العتيبي" }, conversion: null,
        activities: [
          { id: "a1", type: "CALL", subject: "مكالمة أولى", body: null, dueAt: null, completedAt: null,
            createdAt: "2026-09-02T09:00:00Z", owner: { id: "u1", name: "فهد العتيبي" } },
        ],
      },
    },
  },
};

test.describe("mocked browser UI — lead detail and follow-up", () => {
  for (const vp of WIDTHS) {
    test(`lead detail lays out without overflow at ${vp.name}`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await mount(page, "lead-detail", LEAD_OK);
      await expect(page.locator('[data-testid="lead-detail-status"]')).toBeVisible();
      await expect(page.getByText(LONG_AR).first()).toBeVisible();
      await noHorizontalOverflow(page);
    });
  }

  test("the phone number renders left-to-right inside Arabic text", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await mount(page, "lead-detail", LEAD_OK);
    const dir = await page.getByText("+966 55 214 8890").evaluate((el) =>
      getComputedStyle(el as Element).direction);
    expect(dir).toBe("ltr");
  });

  test("a writer DOES get the controls — the guard for the reader test below", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await mount(page, "lead-detail", LEAD_OK, REP);
    await expect(page.locator('[data-testid="toggle-edit"]')).toBeVisible();
    await expect(page.locator('[data-testid="schedule-followup"]')).toBeVisible();
    await expect(page.locator('[data-testid="log-activity"]')).toBeVisible();
  });

  test("a reader without lead_write sees no edit or activity controls", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await mount(page, "lead-detail", LEAD_OK, READER);
    await expect(page.locator('[data-testid="toggle-edit"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="log-activity"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="schedule-followup"]')).toHaveCount(0);
    // And it says why, rather than simply offering nothing.
    await expect(page.getByText(/دورك يسمح بالاطلاع فقط/)).toBeVisible();
  });

  test("scheduling: a failed activity leaves the date alone and does not claim success", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await mount(page, "lead-detail", {
      ...LEAD_OK,
      "POST /api/sales/activities": { status: 400, body: { error: "نشاط مرفوض" } },
    });
    await page.locator("#scheduleAt").fill("2026-10-01T10:00");
    await page.locator('[data-testid="schedule-followup"]').click();

    await expect(page.getByTestId("alert-error")).toContainText("نشاط مرفوض");
    await expect(page.getByTestId("alert-success")).toHaveCount(0);
    const patches = await page.evaluate(() =>
      (window as never as { __CALLS__: { method: string; url: string }[] }).__CALLS__
        .filter((c) => c.method === "PATCH"));
    expect(patches, "the date must not be written when the activity failed").toHaveLength(0);
  });

  test("scheduling: a half-write warns, and the retry does not create a second activity", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await mount(page, "lead-detail", {
      ...LEAD_OK,
      "POST /api/sales/activities": { body: { id: "new" } },
      "PATCH /api/sales/leads/": { status: 500, body: { error: "patch refused" } },
    });
    await page.locator("#scheduleAt").fill("2026-10-01T10:00");
    await page.locator('[data-testid="schedule-followup"]').click();

    // Not a success, and it explains the half-written state.
    await expect(page.getByTestId("alert-error")).toContainText("سُجِّلت المهمة");
    await expect(page.getByTestId("alert-success")).toHaveCount(0);

    // Retry with the same instant.
    await page.locator('[data-testid="schedule-followup"]').click();
    await page.waitForTimeout(200);
    const posts = await page.evaluate(() =>
      (window as never as { __CALLS__: { method: string; url: string }[] }).__CALLS__
        .filter((c) => c.method === "POST" && c.url.includes("/api/sales/activities")));
    expect(posts, "the retry must not write a second activity").toHaveLength(1);
  });

  test("scheduling: a double click produces exactly one activity", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await mount(page, "lead-detail", {
      ...LEAD_OK,
      "POST /api/sales/activities": { body: { id: "new" }, delayMs: 120 },
      "PATCH /api/sales/leads/": { body: { ok: true }, delayMs: 60 },
    });
    await page.locator("#scheduleAt").fill("2026-10-01T10:00");
    const btn = page.locator('[data-testid="schedule-followup"]');
    await btn.click();
    await btn.click({ force: true }).catch(() => {});
    await page.waitForTimeout(600);
    const posts = await page.evaluate(() =>
      (window as never as { __CALLS__: { method: string; url: string }[] }).__CALLS__
        .filter((c) => c.method === "POST" && c.url.includes("/api/sales/activities")));
    expect(posts).toHaveLength(1);
  });

  test("a lead that does not exist says so instead of rendering an empty shell", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await mount(page, "lead-detail", { "/api/sales/leads/": { status: 404, body: { error: "x" } } });
    await expect(page.getByTestId("alert-error")).toContainText("غير موجود أو ليس ضمن نطاقك");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
const COMMISSIONS_OK = {
  "/api/commissions/me": {
    body: {
      periodStart: "2026-09-01", periodEnd: "2026-09-30",
      statement: { accrued: "1530.00", adjustments: "0.00", paid: "200.00", outstanding: "1330.00" },
      accruals: [{
        id: "ac1", qualifyingBase: "110000.00", sharePercent: "100", effectiveRatePercent: "1.045455",
        amount: "1150.00", currency: "SAR", status: "ACCRUED", approvedAt: null, createdAt: "2026-09-20T09:00:00Z",
        collectionEvent: {
          externalRef: "SBX-1", sourceSystem: "SANDBOX", collectedAt: "2026-09-20T09:00:00Z",
          amountGross: "126500.00", amountTax: "16500.00", amountNonQualifying: "0.00",
          customer: { id: "c1", name: LONG_AR },
        },
        planVersion: { version: 3, baseRatePercent: "1.00", tierMode: "INCREMENTAL", plan: { code: "REPS", name: "Reps", nameAr: "المندوبين" } },
      }],
      ledger: [], target: null, collectionSources: ["SANDBOX"], sandbox: true, notice: "sandbox",
    },
  },
};

test.describe("mocked browser UI — commissions", () => {
  for (const vp of WIDTHS) {
    test(`commissions: calculation collapsed by default at ${vp.name}`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await mount(page, "commissions", COMMISSIONS_OK);
      const toggle = page.locator('[data-testid="toggle-calc-ac1"]');
      await expect(toggle).toBeVisible();
      await expect(toggle).toHaveAttribute("aria-expanded", "false");
      await noHorizontalOverflow(page);
    });
  }

  test("expanding reveals the arithmetic, and it is keyboard operable", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await mount(page, "commissions", COMMISSIONS_OK);
    const toggle = page.locator('[data-testid="toggle-calc-ac1"]');
    await toggle.focus();
    await expect(toggle).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(page.locator("#calc-ac1")).toBeVisible();
    // Latin digits, as every Sales screen now renders them — the interface is Arabic, the
    // numerals are 0-9. The digit audit in digits.spec.ts is what enforces that generally;
    // this asserts the two figures a reader of this panel is actually checking.
    await expect(page.locator("#calc-ac1")).toContainText("1.045455%");
    await expect(page.locator("#calc-ac1")).toContainText("1,150.00");
    await noHorizontalOverflow(page);
  });

  test("the sandbox notice is present and short", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await mount(page, "commissions", COMMISSIONS_OK);
    const banner = page.getByTestId("sandbox-banner");
    await expect(banner).toBeVisible();
    const text = (await banner.innerText()).trim();
    expect(text.length, "the notice should be a sentence, not a paragraph").toBeLessThan(220);
  });

  test("a failed load shows an error", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    // The server's own message, not a generic one — the screen only falls back to
    // "تعذّر تحميل العمولات" when the response carries nothing to show.
    await mount(page, "commissions", {
      "/api/commissions/me": { status: 500, body: { error: "الفترة غير متاحة" } },
    });
    await expect(page.getByRole("alert")).toContainText("الفترة غير متاحة");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
const quoteLine = (id: string, discount: string) => ({
  id, productSkuId: null, description: "كولومبيا هويلا", quantity: "800", unit: "KG",
  unitPrice: "45.00", discountPercent: discount, taxRatePercent: "15",
  lineSubtotal: "36000.00", lineTax: "5400.00", lineTotal: "41400.00", position: 1, productSku: null,
});

const quotePayload = (discount: string) => ({
  "/api/sales/quotes/": {
    body: {
      quote: {
        id: "q1", quoteNumber: "OF-1042", revision: 2, status: "DRAFT", currency: "SAR",
        validUntil: "2026-09-30", subtotal: "36000.00", discountTotal: "0.00", taxTotal: "5400.00",
        grandTotal: "41400.00", issuedAt: null, issuedSnapshot: null, acceptedAt: null,
        rejectedAt: null, rejectionNote: null, discountApprovedAt: null,
        supersedes: null, supersededBy: null,
        customer: { id: "c1", name: "Coffee", nameAr: LONG_AR },
        opportunity: { id: "d1", title: LONG_AR, outcome: "OPEN", owner: { id: "u1", name: "فهد" } },
        lines: [quoteLine("l1", discount)], orderLinks: [],
      },
      state: { editable: true, revisable: false, expired: false, orderable: false },
      can: { write: true, approveDiscount: false, createOrder: false },
      discountThresholdPercent: "10",
    },
  },
  "/api/products": { body: [] },
});

test.describe("mocked browser UI — quotation discounts", () => {
  for (const vp of WIDTHS) {
    test(`quote editor lays out without overflow at ${vp.name}`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await mount(page, "quote-editor", quotePayload("0"), REP, { id: "q1" });
      await expect(page.locator('[data-testid="quote-status"]')).toBeVisible();
      await noHorizontalOverflow(page);
    });
  }

  test("a discount under the threshold shows no approval warning", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await mount(page, "quote-editor", quotePayload("5"), REP, { id: "q1" });
    await expect(page.getByTestId("discount-approval-notice")).toHaveCount(0);
  });

  test("a discount over the threshold warns that a manager must issue it", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await mount(page, "quote-editor", quotePayload("25"), REP, { id: "q1" });
    const notice = page.getByTestId("discount-approval-notice");
    await expect(notice).toBeVisible();
    // A reader without the privilege is told the issue will be refused, not merely that
    // the discount is large.
    await expect(notice).toContainText("يتجاوز صلاحيتك");
    await expect(notice).toContainText("حدّ الاعتماد");
  });

  test("the warning survives the mobile layout", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await mount(page, "quote-editor", quotePayload("25"), REP, { id: "q1" });
    await expect(page.getByTestId("discount-approval-notice")).toBeVisible();
    await noHorizontalOverflow(page);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
/**
 * Every Sales and Commissions screen, at every width, against the one rule that a
 * screenshot of the top of a page cannot show: the DOCUMENT must not scroll sideways.
 *
 * This exists because of a one-pixel bug. An action column's heading is an `sr-only`
 * span, `sr-only` is absolutely positioned, and without a positioned ancestor it lands
 * against the initial containing block — off the left edge of an RTL page — dragging the
 * whole document ninety pixels wide on the quotations list at 1024. Invisible in a
 * capture, obvious to anyone using the screen.
 *
 * Driven from the same route fixtures the screenshots use, so a screen added there is
 * covered here without anyone remembering to add it twice.
 */
test.describe("mocked browser UI — no screen scrolls the document sideways", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { ROUTES, REP: FIXTURE_REP } = require("./routes.mjs") as {
    ROUTES: Record<string, { screen: string; api: Record<string, unknown> }>;
    REP: unknown;
  };
  const paramId = (screen: string) =>
    screen === "lead-detail" ? "l1" : screen.startsWith("quote") ? "q1" : "d1";

  for (const vp of WIDTHS) {
    for (const [name, spec] of Object.entries(ROUTES)) {
      test(`${name} at ${vp.name}`, async ({ page }) => {
        await page.setViewportSize({ width: vp.width, height: vp.height });
        await mount(page, spec.screen, spec.api, FIXTURE_REP, { id: paramId(spec.screen) });
        await noHorizontalOverflow(page);
      });
    }
  }
});
