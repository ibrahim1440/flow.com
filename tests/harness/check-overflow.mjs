/**
 * Does any Sales/Commissions screen make the page itself scroll sideways?
 *
 * A table that is genuinely too wide scrolls inside its own box; the document must not.
 * On a phone a horizontally scrolling body puts every other control out of reach, and it
 * is the one responsive failure that is invisible in a screenshot of the top of the page.
 *
 * Usage: node tests/harness/check-overflow.mjs [width=390]
 */
import { chromium } from "@playwright/test";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ROUTES, REP } from "./routes.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const width = Number(process.argv[2] ?? 390);
const paramId = (screen) =>
  screen === "lead-detail" ? "l1" : screen.startsWith("quote") ? "q1" : "d1";

const browser = await chromium.launch({ channel: "chrome" });
let worst = 0;

for (const [name, spec] of Object.entries(ROUTES)) {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  await page.goto(pathToFileURL(path.join(HERE, "index.html")).href);
  await page.evaluate(
    ([api, user, routeId]) => {
      window.__ROUTES__ = api;
      window.__USER__ = user;
      window.__LANG__ = "ar";
      window.__PARAMS__ = { id: routeId };
      document.documentElement.setAttribute("dir", "rtl");
      document.documentElement.setAttribute("lang", "ar");
    },
    [spec.api, REP, paramId(spec.screen)],
  );
  await page.evaluate((s) => window.mountScreen(s), spec.screen);
  await page.waitForTimeout(500);

  const over = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  // Which element is sticking out, when one is — otherwise the number alone is a puzzle.
  const culprit = over > 1
    ? await page.evaluate((w) => {
        for (const el of document.querySelectorAll("*")) {
          const r = el.getBoundingClientRect();
          if (r.width > w + 1 && getComputedStyle(el).overflowX !== "auto") {
            return `${el.tagName.toLowerCase()}.${String(el.className).slice(0, 60)} (${Math.round(r.width)}px)`;
          }
        }
        return "unknown";
      }, width)
    : "";

  worst = Math.max(worst, over);
  console.log(`  ${over > 1 ? "!!" : "ok"}  ${name.padEnd(22)} overflow=${String(over).padStart(4)}  ${culprit}`);
  await page.close();
}

await browser.close();
console.log(`\nwidth ${width}px — worst overflow ${worst}px`);
process.exit(worst > 1 ? 1 : 0);
