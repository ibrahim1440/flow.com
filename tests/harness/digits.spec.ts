/**
 * ARABIC-INDIC DIGIT AUDIT.
 *
 * Every Sales and Commissions screen is rendered at three widths and its text is scanned
 * for `٠١٢٣٤٥٦٧٨٩` (Arabic-Indic) and `۰۱۲۳۴۵۶۷۸۹` (Extended Arabic-Indic, used for
 * Persian). The interface is Arabic and right-to-left; its digits are 0–9.
 *
 * ── Why this is a rendered-text audit and not a grep ──
 * A grep over the source finds the literals somebody typed. It does not find the ones a
 * formatter produces, and the formatters are where this goes wrong: `toLocaleString("ar")`
 * emits Arabic-Indic on one platform and Latin on another, so the same source renders
 * differently for different people. Only reading the rendered DOM catches that.
 *
 * ── What is excluded, and why ──
 * Customer-entered free text. A company name, a note, an address, a lost reason or a
 * rejection reason is the customer's or the salesperson's own writing, and rewriting their
 * numerals would be changing what they said. Those fields are excluded BY FIXTURE: the
 * audit fixtures deliberately contain no Arabic-Indic digits in free-text values, so any
 * that appear in the DOM came from the application. That is a stronger exclusion than a
 * selector blocklist, which would also hide a formatter bug that happened to render into
 * the same element.
 *
 * The one structural exclusion is listed in EXCLUDED_SELECTORS below, with its reason.
 */
import { test, expect, type Page } from "@playwright/test";
import path from "node:path";
import { pathToFileURL } from "node:url";

const HARNESS = pathToFileURL(path.join(__dirname, "index.html")).href;

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { ROUTES, REP, CUSTOMER_TEXT } = require("./routes.mjs") as {
  ROUTES: Record<string, { screen: string; api: Record<string, unknown> }>;
  REP: unknown;
  CUSTOMER_TEXT: string[];
};

const WIDTHS = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "tablet-1024", width: 1024, height: 900 },
  { name: "mobile-390", width: 390, height: 844 },
] as const;

const ARABIC_INDIC = /[٠-٩]/; // ٠-٩
const PERSIAN = /[۰-۹]/; // ۰-۹

/**
 * No structural exclusions. There is no element on any of these screens where an
 * Arabic-Indic digit is acceptable, so there is no selector to skip.
 *
 * The one real exclusion is per-VALUE and lives in the fixtures: `CUSTOMER_TEXT` lists the
 * free-text strings that are somebody's own writing. Those substrings are subtracted from a
 * text node before it is scanned, so a company called «كافيه ٢١» passes while a formatter
 * rendering "٥ عروض" into the same cell still fails.
 */
const EXCLUDED_SELECTORS: string[] = [];

const paramId = (screen: string) =>
  screen === "lead-detail" ? "l1" : screen.startsWith("quote") ? "q1" : "d1";

async function mount(page: Page, screen: string, api: Record<string, unknown>, id: string) {
  await page.goto(HARNESS);
  await page.evaluate(
    ([r, u, routeId]) => {
      (window as never as Record<string, unknown>).__ROUTES__ = r;
      (window as never as Record<string, unknown>).__USER__ = u;
      (window as never as Record<string, unknown>).__LANG__ = "ar";
      (window as never as Record<string, unknown>).__PARAMS__ = { id: routeId };
      document.documentElement.setAttribute("dir", "rtl");
      document.documentElement.setAttribute("lang", "ar");
    },
    [api, REP, id] as const,
  );
  await page.evaluate((s) => (window as never as { mountScreen: (s: string) => void }).mountScreen(s), screen);
  await page.waitForTimeout(500);
}

/**
 * Every text node that contains a non-Latin digit, with enough of its context to find it.
 *
 * Reported per node rather than as a count, because "3 Arabic-Indic digits somewhere on the
 * reports screen" is not something anybody can act on.
 */
async function nonLatinDigits(page: Page, excluded: string[]) {
  return page.evaluate(({ exclude, customerText }) => {
    const skip = new Set<Node>();
    for (const sel of exclude) {
      for (const el of document.querySelectorAll(sel)) {
        const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        let n: Node | null;
        while ((n = walk.nextNode())) skip.add(n);
      }
    }

    const bad: { text: string; where: string }[] = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node: Node | null;
    while ((node = walker.nextNode())) {
      if (skip.has(node)) continue;
      const raw = node.textContent ?? "";
      // Subtract the customer's own writing, then look at what the application produced.
      let text = raw;
      for (const own of customerText) text = text.split(own).join("");
      if (!/[٠-٩۰-۹]/.test(text)) continue;
      const el = node.parentElement;
      const where = el
        ? `${el.tagName.toLowerCase()}${el.getAttribute("data-testid") ? `[${el.getAttribute("data-testid")}]` : ""}.${String(el.className).slice(0, 40)}`
        : "?";
      bad.push({ text: raw.trim().slice(0, 80), where });
    }
    return bad;
  }, { exclude: excluded, customerText: CUSTOMER_TEXT });
}

test.describe("Arabic interface, Latin digits", () => {
  for (const vp of WIDTHS) {
    for (const [name, spec] of Object.entries(ROUTES)) {
      test(`${name} at ${vp.name}`, async ({ page }) => {
        await page.setViewportSize({ width: vp.width, height: vp.height });
        await mount(page, spec.screen, spec.api, paramId(spec.screen));

        const offenders = await nonLatinDigits(page, EXCLUDED_SELECTORS);
        expect(
          offenders,
          `Arabic-Indic or Persian digits rendered on ${name}:\n` +
            offenders.map((o) => `  "${o.text}"  in ${o.where}`).join("\n"),
        ).toEqual([]);
      });
    }
  }

  test("the audit can actually see a violation", async ({ page }) => {
    // A test that only ever passes proves nothing. This plants one Arabic-Indic digit and
    // checks the scanner reports it, so a green run above means "none found" rather than
    // "the scanner is broken".
    await page.setViewportSize({ width: 1440, height: 900 });
    const first = Object.values(ROUTES)[0];
    await mount(page, first.screen, first.api, paramId(first.screen));
    await page.evaluate(() => {
      const p = document.createElement("p");
      p.textContent = "١٢٣";
      document.body.appendChild(p);
    });
    const offenders = await nonLatinDigits(page, EXCLUDED_SELECTORS);
    expect(offenders.length, "the scanner must detect a planted violation").toBeGreaterThan(0);
  });

  test("the audit also catches Persian digits", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const first = Object.values(ROUTES)[0];
    await mount(page, first.screen, first.api, paramId(first.screen));
    await page.evaluate(() => {
      const p = document.createElement("p");
      p.textContent = "۴۵۶";
      document.body.appendChild(p);
    });
    const offenders = await nonLatinDigits(page, EXCLUDED_SELECTORS);
    expect(offenders.length, "the scanner must detect Persian digits too").toBeGreaterThan(0);
  });
});

// Referenced so the regexes above are not merely decorative in a review.
test("the patterns match the digit ranges they claim to", () => {
  expect(ARABIC_INDIC.test("٠١٢٣٤٥٦٧٨٩")).toBe(true);
  expect(PERSIAN.test("۰۱۲۳۴۵۶۷۸۹")).toBe(true);
  expect(ARABIC_INDIC.test("0123456789")).toBe(false);
  expect(PERSIAN.test("0123456789")).toBe(false);
});
