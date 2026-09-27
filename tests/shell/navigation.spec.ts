/**
 * THE APPLICATION SHELL — the navigation, in a real browser, against the running app.
 *
 * The registry's own suite (`scripts/e2e/regression/navigation.ts`) proves the tree: who
 * may see what, that nothing was lost, that a detail route resolves to its list. It cannot
 * prove that any of it is rendered, that a link navigates without reloading the document,
 * that the drawer closes behind you, or that a phone does not scroll sideways. That is
 * what this is for.
 *
 * ── Running it ──
 *   npm run test:shell
 *
 * ── Identities ──
 * Three disposable `NAV_` fixtures built from the same ROLES the other suites use, created
 * by the config's global setup and deleted by its teardown however the run ends. Never the
 * `RVW_` reviewer accounts: their PINs are issued once and somebody may be holding a
 * session. Nothing here writes business data.
 */
import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { NAV_PEOPLE } from "../../scripts/sales-preview/preview-guard";

const SHOTS = path.join(process.cwd(), "docs/sales/nav-shots");
fs.mkdirSync(SHOTS, { recursive: true });

// One definition, shared with the provisioning script, so the suite and the accounts it
// signs in as cannot drift apart.
const PIN = Object.fromEntries(
  NAV_PEOPLE.map((p) => [p.id.replace(/^NAV_/, ""), p.pin]),
) as Record<"rep" | "manager" | "finance", string>;

const WIDTHS = [
  { name: "desktop-1440", width: 1440, height: 900 },
  { name: "tablet-1024", width: 1024, height: 900 },
  { name: "mobile-390", width: 390, height: 844 },
] as const;

/** Sign in through the real endpoint, then land on `to`. */
async function signIn(page: Page, pin: string, to = "/dashboard") {
  await page.goto("/login");
  const res = await page.evaluate(async (p) => {
    await fetch("/api/auth/me", { method: "DELETE" });
    const r = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ method: "pin", pin: p }),
    });
    return r.status;
  }, pin);
  expect(res, "the fixture login must succeed").toBe(200);
  await page.goto(to);
  await page.waitForSelector("aside nav", { timeout: 60_000 });
}

/** Nothing on the page may make the DOCUMENT scroll sideways. */
async function documentOverflow(page: Page) {
  return page.evaluate(() =>
    Math.max(
      document.documentElement.scrollWidth - document.documentElement.clientWidth,
      document.body.scrollWidth - document.body.clientWidth,
    ),
  );
}

test.describe("the sidebar groups what used to be a flat list", () => {
  test("a rep sees modules, not every page at the top level", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await signIn(page, PIN.rep, "/dashboard/sales/leads");

    // The module, disclosed and open because the current page is inside it.
    const sales = page.getByTestId("navgroup-sales");
    await expect(sales).toBeVisible();
    await expect(sales, "the group holding the page opens itself").toHaveAttribute("aria-expanded", "true");

    // Its subunits — and NOT its leaves, which is the whole point.
    for (const id of ["sales.customers", "sales.pipeline", "sales.quotes", "sales.collections", "sales.performance"]) {
      await expect(page.getByTestId(`nav-${id}`), `${id} in the sidebar`).toBeVisible();
    }
    await expect(
      page.getByTestId("nav-sales.customers.leads"),
      "a leaf must NOT also be a sidebar entry — that is the clutter this replaces",
    ).toHaveCount(0);

    // A rep holds no stage_manage, so the settings subunit is simply absent.
    await expect(page.getByTestId("nav-sales.settings")).toHaveCount(0);
  });

  test("a collapsed group can be opened and closed from the keyboard", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await signIn(page, PIN.rep, "/dashboard/sales/leads");

    const ops = page.getByTestId("navgroup-operations");
    await expect(ops).toHaveAttribute("aria-expanded", "false");
    await expect(page.getByTestId("nav-operations.preparation")).toHaveCount(0);

    await ops.focus();
    await page.keyboard.press("Enter");
    await expect(ops).toHaveAttribute("aria-expanded", "true");
    await expect(page.getByTestId("nav-operations.preparation")).toBeVisible();

    await page.keyboard.press("Enter");
    await expect(ops).toHaveAttribute("aria-expanded", "false");
  });
});

test.describe("contextual navigation", () => {
  test("a subunit with several pages offers them, and marks the current one", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await signIn(page, PIN.rep, "/dashboard/sales/leads");

    const ctx = page.getByTestId("contextual-nav");
    await expect(ctx, "this is what the reference design had and the app did not").toBeVisible();
    await expect(page.getByTestId("ctx-sales.customers.leads")).toHaveAttribute("aria-current", "page");
    await expect(page.getByTestId("ctx-sales.customers.accounts")).toBeVisible();
    await expect(page.getByTestId("ctx-sales.customers.accounts")).not.toHaveAttribute("aria-current", "page");

    // Real links, not tabs: separate URLs that survive a refresh and the Back button.
    await expect(ctx.locator("[role=tablist]"), "tab semantics would promise arrow-keys").toHaveCount(0);
    await expect(page.getByTestId("ctx-sales.customers.accounts")).toHaveAttribute("href", "/dashboard/customers");
  });

  test("a single-destination subunit shows no bar at all", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await signIn(page, PIN.rep, "/dashboard/sales/collections");
    await expect(
      page.getByTestId("contextual-nav"),
      "one tab is decoration pretending to be navigation",
    ).toHaveCount(0);
    await expect(page.getByTestId("nav-sales.collections")).toHaveAttribute("aria-current", "page");
  });

  test("moving between pages does not reload the document", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await signIn(page, PIN.rep, "/dashboard/sales/leads");

    // A marker that only survives if the document is never thrown away.
    await page.evaluate(() => { (window as unknown as Record<string, unknown>).__shellAlive = true; });
    await page.getByTestId("ctx-sales.customers.accounts").click();
    await page.waitForURL("**/dashboard/customers");
    const survived = await page.evaluate(() => (window as unknown as Record<string, unknown>).__shellAlive === true);
    expect(survived, "a client-side navigation keeps the document").toBe(true);
    await expect(page.getByTestId("ctx-sales.customers.accounts")).toHaveAttribute("aria-current", "page");
  });
});

test.describe("deep links, refresh and history", () => {
  test("a detail page resolves to the list it came from", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await signIn(page, PIN.rep, "/dashboard/sales/pipeline");
    // The board's own subunit is marked even though the deal page has no entry of its own.
    await expect(page.getByTestId("nav-sales.pipeline")).toHaveAttribute("aria-current", "true");

    await page.goto("/dashboard/sales/deals/does-not-exist");
    await page.waitForSelector("aside nav");
    await expect(page.getByTestId("nav-sales.pipeline"), "a deal belongs to the pipeline")
      .toHaveAttribute("aria-current", "true");
    await expect(page.getByTestId("ctx-sales.pipeline.board")).toHaveAttribute("aria-current", "page");
    await expect(page.getByTestId("breadcrumbs")).toContainText("مسار الصفقات");
  });

  test("Back and Forward move the active markers with them", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await signIn(page, PIN.rep, "/dashboard/sales/leads");
    await page.getByTestId("ctx-sales.customers.accounts").click();
    await page.waitForURL("**/dashboard/customers");

    await page.goBack();
    await page.waitForURL("**/dashboard/sales/leads");
    await expect(page.getByTestId("ctx-sales.customers.leads")).toHaveAttribute("aria-current", "page");

    await page.goForward();
    await page.waitForURL("**/dashboard/customers");
    await expect(page.getByTestId("ctx-sales.customers.accounts")).toHaveAttribute("aria-current", "page");
  });

  test("a refresh keeps you where you were", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await signIn(page, PIN.rep, "/dashboard/sales/activities");
    await page.reload();
    await page.waitForSelector("aside nav");
    await expect(page.getByTestId("navgroup-sales")).toHaveAttribute("aria-expanded", "true");
    await expect(page.getByTestId("ctx-sales.pipeline.activities")).toHaveAttribute("aria-current", "page");
  });
});

test.describe("who sees what", () => {
  test("Finance reaches collections without ever seeing the pipeline", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await signIn(page, PIN.finance, "/dashboard");

    const finance = page.getByTestId("navgroup-finance");
    await expect(finance, "the Finance module").toBeVisible();
    await expect(page.getByTestId("navgroup-sales"), "and no Sales module").toHaveCount(0);

    // Closed on arrival, because the dashboard is not inside it. Opening it is the
    // disclosure doing its job, not a workaround.
    await expect(finance).toHaveAttribute("aria-expanded", "false");
    await finance.click();
    await expect(finance).toHaveAttribute("aria-expanded", "true");
    await page.getByTestId("nav-finance.collections").click();
    await page.waitForURL("**/dashboard/sales/collections");
    await expect(page.getByTestId("breadcrumbs")).toContainText("المالية");
    // Navigation did not grant the ability; the ability was already theirs.
    await expect(page.getByTestId("collections-table")).toBeVisible();
  });

  test("a sales manager sees collections and no Finance module", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await signIn(page, PIN.manager, "/dashboard/sales/collections");
    await expect(page.getByTestId("navgroup-sales")).toBeVisible();
    await expect(page.getByTestId("navgroup-finance"), "seeing is not deciding").toHaveCount(0);
    await expect(page.getByTestId("nav-sales.collections")).toHaveAttribute("aria-current", "page");
  });

  test("a refused route still refuses, whatever the menu shows", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await signIn(page, PIN.finance, "/dashboard");
    await page.goto("/dashboard/sales/pipeline");
    await page.waitForSelector("aside nav");
    // The shell refuses it rather than rendering a working-looking screen with no data.
    await expect(page.locator("main")).toContainText(/صلاحي|permission|Access/i);
    await expect(page.getByTestId("contextual-nav")).toHaveCount(0);
  });
});

test.describe("the phone", () => {
  test("the drawer opens, navigates, closes behind you and returns focus", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await signIn(page, PIN.rep, "/dashboard/sales/leads");

    const opener = page.getByRole("button", { name: /فتح القائمة|Open menu/ });
    await expect(opener).toBeVisible();
    await expect(opener).toHaveAttribute("aria-expanded", "false");

    await opener.click();
    await expect(opener).toHaveAttribute("aria-expanded", "true");
    // Focus moved into the drawer rather than being left behind the overlay.
    const closeFocused = await page.evaluate(() =>
      document.activeElement?.getAttribute("aria-label") ?? "");
    expect(closeFocused, "focus enters the drawer").toMatch(/إغلاق القائمة|Close menu/);

    await page.getByTestId("nav-sales.pipeline").click();
    await page.waitForURL("**/dashboard/sales/pipeline");
    await expect(opener, "a drawer covering the page you asked for is a bug")
      .toHaveAttribute("aria-expanded", "false");

    // And Escape closes it, putting focus back on the control that opened it.
    await opener.click();
    await page.keyboard.press("Escape");
    await expect(opener).toHaveAttribute("aria-expanded", "false");
    const backOnOpener = await page.evaluate(() =>
      document.activeElement?.getAttribute("aria-label") ?? "");
    expect(backOnOpener, "focus returns to the opener").toMatch(/فتح القائمة|Open menu/);
  });
});

test.describe("no screen scrolls the document sideways", () => {
  const PAGES = [
    ["/dashboard/sales/leads", "leads"],
    ["/dashboard/sales/pipeline", "pipeline"],
    ["/dashboard/sales/collections", "collections"],
    ["/dashboard/sales/quotes", "quotes"],
  ] as const;

  for (const vp of WIDTHS) {
    for (const [url, name] of PAGES) {
      test(`${name} at ${vp.name}`, async ({ page }) => {
        await page.setViewportSize({ width: vp.width, height: vp.height });
        await signIn(page, PIN.rep, url);
        await page.waitForTimeout(600);
        const overflow = await documentOverflow(page);
        expect(overflow, `${name} overflows the document by ${overflow}px at ${vp.width}`).toBeLessThanOrEqual(0);
      });
    }
  }

  test("and the contextual bar scrolls inside itself rather than widening the page", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await signIn(page, PIN.rep, "/dashboard/sales/leads");
    const bar = page.getByTestId("contextual-nav");
    await expect(bar).toBeVisible();
    const barWidth = await bar.evaluate((el) => el.getBoundingClientRect().width);
    expect(barWidth, "the bar stays within the viewport").toBeLessThanOrEqual(390);
    expect(await documentOverflow(page)).toBeLessThanOrEqual(0);
  });
});

test.describe("the record, for the report", () => {
  for (const vp of WIDTHS) {
    test(`screenshot at ${vp.name}`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await signIn(page, PIN.rep, "/dashboard/sales/leads");
      if (vp.width < 1024) {
        await page.getByRole("button", { name: /فتح القائمة|Open menu/ }).click();
        await page.waitForTimeout(400);
      }
      await page.waitForTimeout(500);
      await page.screenshot({ path: path.join(SHOTS, `sales-leads-${vp.name}.png`), fullPage: false });
    });
  }

  test("screenshot of the Finance view", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await signIn(page, PIN.finance, "/dashboard/sales/collections");
    await page.waitForTimeout(1200);
    await page.screenshot({ path: path.join(SHOTS, "finance-collections-desktop-1440.png"), fullPage: false });
  });
});

test.describe("unsaved work is not discarded silently", () => {
  /**
   * The lead detail page's edit panel is the case that matters: it is INLINE, so every
   * navigation control stays clickable while a draft is on screen. The create form on the
   * leads list is a fixed overlay — nothing behind it can be clicked — so the click guard
   * is not what protects it, and this suite does not pretend otherwise.
   *
   * Uses an isolated synthetic lead it creates and deletes itself. It never touches a lead
   * anybody is reviewing.
   */
  const SYNTHETIC = "SHELL_GUARD مقهى";

  async function makeLead(page: Page): Promise<string> {
    const id = await page.evaluate(async (name) => {
      const r = await fetch("/api/sales/leads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ companyName: name, contactName: "Guard Test", source: "REFERRAL" }),
      });
      const j = await r.json().catch(() => ({}));
      return j?.lead?.id ?? null;
    }, SYNTHETIC);
    expect(id, "the synthetic lead must be created").toBeTruthy();
    return id as string;
  }
  async function removeLead(page: Page, id: string) {
    await page.evaluate(async (leadId) => {
      await fetch(`/api/sales/leads/${leadId}`, { method: "DELETE" });
    }, id);
  }

  test("an edited lead asks before a navigation throws the edits away", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await signIn(page, PIN.rep, "/dashboard/sales/leads");
    const id = await makeLead(page);
    try {
      await page.goto(`/dashboard/sales/leads/${id}`);
      await page.waitForSelector("aside nav");
      await page.waitForLoadState("networkidle");
      await page.getByTestId("toggle-edit").click();
      const company = page.locator("#companyName");
      await expect(company).toBeVisible();
      await company.fill("SHELL_GUARD تم التعديل");

      let asked = 0;
      const decline = (d: import("@playwright/test").Dialog) => { asked++; void d.dismiss(); };
      page.on("dialog", decline);
      await page.getByTestId("nav-sales.pipeline").click();
      await page.waitForTimeout(700);
      expect(asked, "leaving an edited form must ask").toBeGreaterThan(0);
      expect(page.url(), "declining keeps you on the page").toContain(`/leads/${id}`);
      await expect(company, "and keeps the typing").toHaveValue("SHELL_GUARD تم التعديل");
      page.off("dialog", decline);

      page.on("dialog", (d) => void d.accept());
      await page.getByTestId("nav-sales.pipeline").click();
      await page.waitForURL("**/dashboard/sales/pipeline");
    } finally {
      await page.goto("/dashboard/sales/leads");
      await removeLead(page, id);
    }
  });

  test("an untouched edit panel does not nag", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await signIn(page, PIN.rep, "/dashboard/sales/leads");
    const id = await makeLead(page);
    try {
      await page.goto(`/dashboard/sales/leads/${id}`);
      await page.waitForSelector("aside nav");
      await page.waitForLoadState("networkidle");
      await page.getByTestId("toggle-edit").click();
      await expect(page.locator("#companyName")).toBeVisible();

      let asked = 0;
      page.on("dialog", (d) => { asked++; void d.accept(); });
      await page.getByTestId("nav-sales.pipeline").click();
      await page.waitForURL("**/dashboard/sales/pipeline");
      expect(asked, "a prompt nobody needs is a prompt people learn to ignore").toBe(0);
    } finally {
      await page.goto("/dashboard/sales/leads");
      await removeLead(page, id);
    }
  });

  test("a refresh with unsaved edits is guarded by the browser's own prompt", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await signIn(page, PIN.rep, "/dashboard/sales/leads");
    const id = await makeLead(page);
    try {
      await page.goto(`/dashboard/sales/leads/${id}`);
      await page.waitForSelector("aside nav");
      await page.waitForLoadState("networkidle");
      await page.getByTestId("toggle-edit").click();
      await page.locator("#companyName").fill("SHELL_GUARD معدَّل");

      // Playwright auto-dismisses beforeunload, so what is asserted is that the handler is
      // registered and armed — the browser owns the dialog and its wording.
      const armed = await page.evaluate(() => {
        const e = new Event("beforeunload", { cancelable: true });
        window.dispatchEvent(e);
        return e.defaultPrevented;
      });
      expect(armed, "beforeunload must be armed while the draft is dirty").toBe(true);
    } finally {
      await page.goto("/dashboard/sales/leads");
      await removeLead(page, id);
    }
  });
});

test.describe("the shell renders Latin digits", () => {
  /**
   * The Sales digit audit mounts page COMPONENTS against fixtures. The shell — header,
   * breadcrumb, sidebar, contextual bar — is not in it, which is how the header date went
   * on rendering "السبت، ٢٦ سبتمبر ٢٠٢٦" through every previous green run.
   */
  const ARABIC_INDIC = /[٠-٩۰-۹]/;

  for (const vp of WIDTHS) {
    test(`no Arabic-Indic digit in the chrome at ${vp.name}`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await signIn(page, PIN.rep, "/dashboard/sales/leads");
      if (vp.width < 1024) {
        await page.getByRole("button", { name: /فتح القائمة|Open menu/ }).click();
        await page.waitForTimeout(300);
      }
      const offenders = await page.evaluate(() => {
        const bad: string[] = [];
        for (const sel of ["header", "aside", "[data-testid=contextual-nav]", "[data-testid=breadcrumbs]"]) {
          for (const el of document.querySelectorAll(sel)) {
            const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
            let n: Node | null;
            while ((n = walk.nextNode())) {
              const t = (n.textContent ?? "").trim();
              if (/[٠-٩۰-۹]/.test(t)) bad.push(t.slice(0, 60));
            }
          }
        }
        return bad;
      });
      expect(offenders, `chrome shows Arabic-Indic digits: ${offenders.join(" | ")}`).toEqual([]);
      expect(ARABIC_INDIC.test("٢٠٢٦"), "the detector must actually detect").toBe(true);
    });
  }
});
test.describe("the mobile drawer is modal, and keyboard-provably so", () => {
  // Real key presses, not dispatched events. A synthetic KeyboardEvent does not move
  // focus, so it can only ever confirm what the script already did by hand — which is why
  // the earlier pass could not answer this question.
  test("Tab cannot walk out of the open drawer, and the page behind it is inert", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await signIn(page, PIN.rep, "/dashboard/sales/leads");
    expect(await page.evaluate(() => window.innerWidth), "a real 390px viewport").toBe(390);

    const opener = page.getByRole("button", { name: "فتح القائمة" });
    await expect(opener, "the drawer is a drawer at this width").toBeVisible();

    // Before: the content behind is reachable.
    await expect(page.locator("main")).toBeVisible();
    const inertBefore = await page.evaluate(() =>
      (document.querySelector("main")?.closest("[inert]") ?? null) !== null);
    expect(inertBefore, "nothing is inert while the drawer is shut").toBe(false);

    await opener.click();
    const aside = page.locator("aside");
    await expect(aside).toBeVisible();

    // Focus went in, on its own.
    const landed = await page.evaluate(() => document.activeElement?.getAttribute("aria-label"));
    expect(landed, "focus moves into the drawer when it opens").toBe("إغلاق القائمة");

    // The page behind is inert — which is what takes it out of the tab order.
    const inertNow = await page.evaluate(() =>
      (document.querySelector("main")?.closest("[inert]") ?? null) !== null);
    expect(inertNow, "the content column is inert while the drawer is open").toBe(true);

    // Now walk the whole drawer with REAL Tab presses and a few more besides. Focus must
    // never land outside the aside.
    const inDrawer: boolean[] = [];
    for (let i = 0; i < 20; i++) {
      await page.keyboard.press("Tab");
      inDrawer.push(await page.evaluate(() => {
        const a = document.activeElement;
        return !!a && (a === document.body || !!a.closest("aside"));
      }));
    }
    expect(inDrawer.every(Boolean), "20 real Tab presses never left the drawer").toBe(true);

    // And backwards.
    const back: boolean[] = [];
    for (let i = 0; i < 8; i++) {
      await page.keyboard.press("Shift+Tab");
      back.push(await page.evaluate(() => {
        const a = document.activeElement;
        return !!a && (a === document.body || !!a.closest("aside"));
      }));
    }
    expect(back.every(Boolean), "and neither does Shift+Tab").toBe(true);

    // Escape closes it and gives focus back.
    await page.keyboard.press("Escape");
    await expect(aside).not.toBeInViewport();
    const restored = await page.evaluate(() => document.activeElement?.getAttribute("aria-label"));
    expect(restored, "focus returns to the control that opened it").toBe("فتح القائمة");
    const inertAfter = await page.evaluate(() =>
      (document.querySelector("main")?.closest("[inert]") ?? null) !== null);
    expect(inertAfter, "and the page is interactive again").toBe(false);
  });

  test("no focusable control is left stranded under the drawer", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await signIn(page, PIN.rep, "/dashboard/sales/leads");
    await page.getByRole("button", { name: "فتح القائمة" }).click();
    await expect(page.locator("aside")).toBeVisible();

    // Geometry: anything behind the drawer that is still focusable would be a control a
    // keyboard user can reach and nobody can see.
    const stranded = await page.evaluate(() => {
      const aside = document.querySelector("aside")!;
      const r = aside.getBoundingClientRect();
      const focusable = [...document.querySelectorAll<HTMLElement>(
        'a[href],button,input,select,textarea,[tabindex]:not([tabindex="-1"])')];
      return focusable
        .filter((e) => !aside.contains(e) && e.offsetParent !== null)
        .filter((e) => {
          const b = e.getBoundingClientRect();
          return b.width > 0 && b.height > 0 &&
            b.left < r.right && b.right > r.left && b.top < r.bottom && b.bottom > r.top;
        })
        .filter((e) => e.closest("[inert]") === null)   // inert ones are out of the tab order
        .map((e) => (e.getAttribute("aria-label") || e.textContent || e.tagName).trim().slice(0, 30));
    });
    expect(stranded, `covered but still reachable: ${JSON.stringify(stranded)}`).toEqual([]);
  });

  test("above lg the sidebar is permanent and nothing is inert", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await signIn(page, PIN.rep, "/dashboard/sales/leads");
    await page.getByRole("button", { name: "فتح القائمة" }).click();
    expect(await page.evaluate(() =>
      (document.querySelector("main")?.closest("[inert]") ?? null) !== null)).toBe(true);

    // Widening while the drawer is open must not leave the whole application inert.
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect.poll(() => page.evaluate(() =>
      (document.querySelector("main")?.closest("[inert]") ?? null) !== null),
      { message: "the drawer flag is cleared on the way up to a permanent sidebar" },
    ).toBe(false);
    await expect(page.locator("aside")).toBeVisible();
  });
});
