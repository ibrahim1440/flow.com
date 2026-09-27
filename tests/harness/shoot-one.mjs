/**
 * Screenshot ONE element of one route, optionally after clicking something first.
 *
 * For checking a detail — an expanded panel, a single card — without re-reading a
 * three-thousand-pixel page capture.
 *
 * Usage: node tests/harness/shoot-one.mjs <route> <selector> <out.png> [width] [clickSelector]
 */
import { chromium } from "@playwright/test";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ROUTES, REP } from "./routes.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const [route, selector, out, widthArg, clickSelector] = process.argv.slice(2);
const spec = ROUTES[route];
if (!spec) {
  console.error(`no such route: ${route}. known: ${Object.keys(ROUTES).join(", ")}`);
  process.exit(1);
}

const dir = path.join(HERE, "shots");
fs.mkdirSync(dir, { recursive: true });

/** The record id a detail screen is mounted with — the fixtures key on it. */
const paramId = (screen) =>
  screen === "lead-detail" ? "l1" : screen.startsWith("quote") ? "q1" : "d1";

const browser = await chromium.launch({ channel: "chrome" });
const page = await browser.newPage({
  viewport: { width: Number(widthArg ?? 1440), height: 1400 },
  deviceScaleFactor: 2,
});
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
await page.waitForTimeout(600);
if (clickSelector) {
  await page.locator(clickSelector).first().click();
  await page.waitForTimeout(200);
}
await page.locator(selector).first().screenshot({ path: path.join(dir, out) });
await browser.close();
console.log("ok", out);
