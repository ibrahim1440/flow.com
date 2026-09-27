/**
 * Screenshot the real Sales components for visual comparison against the Figma frames.
 *
 * Usage:  node tests/harness/shoot.mjs <label> [screen=leads-list] [width=1440]
 *
 * Writes tests/harness/shots/<label>.png. The label is the caller's; "before" and "after" are
 * just filenames, and the REFERENCE is always the Figma frame, never a previous screenshot of
 * this application.
 *
 * Renders at the Sales CONTENT width rather than a whole browser window, because the design
 * frames are content-only — the ERP sidebar is not in them. Comparing a 1440 frame against a
 * 1440 browser window would be comparing the design to the app minus its sidebar.
 */
import { chromium } from "@playwright/test";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { LEADS_ROUTES, REP } from "./fixtures.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const [, , label = "shot", screen = "leads-list", widthArg = "1440"] = process.argv;
const width = Number(widthArg);

const ROUTES = { ...LEADS_ROUTES };

fs.mkdirSync(path.join(HERE, "shots"), { recursive: true });

const browser = await chromium.launch({ channel: "chrome" });
const page = await browser.newPage({ viewport: { width, height: 1200 }, deviceScaleFactor: 2 });

await page.goto(pathToFileURL(path.join(HERE, "index.html")).href);
await page.evaluate(
  ([r, u]) => {
    window.__ROUTES__ = r;
    window.__USER__ = u;
    window.__LANG__ = "ar";
    window.__PARAMS__ = { id: "l1" };
    // The application sets dir on <html> from the user's language; the harness must too, or
    // every RTL judgement made from these screenshots is wrong.
    document.documentElement.setAttribute("dir", "rtl");
    document.documentElement.setAttribute("lang", "ar");
  },
  [ROUTES, REP],
);
await page.evaluate((s) => window.mountScreen(s), screen);
await page.waitForTimeout(900);

const out = path.join(HERE, "shots", `${label}.png`);
await page.locator("#root").screenshot({ path: out });
console.log("wrote", path.relative(path.resolve(HERE, "../.."), out), `(${width}px content width)`);
await browser.close();
