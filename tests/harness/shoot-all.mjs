/**
 * Screenshot every Sales / Commissions route from the real components, at a given width.
 *
 * Usage:  node tests/harness/shoot-all.mjs [width=1440] [suffix=""]
 *
 * Renders at the Sales CONTENT width, because the Figma frames are content-only and do not
 * include the ERP sidebar; a like-for-like comparison has to exclude it on both sides.
 */
import { chromium } from "@playwright/test";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ROUTES, REP } from "./routes.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const width = Number(process.argv[2] ?? 1440);
const suffix = process.argv[3] ?? "";
const dir = path.join(HERE, "shots");
fs.mkdirSync(dir, { recursive: true });

/** The record id a detail screen is mounted with — the fixtures key on it. */
const paramId = (screen) =>
  screen === "lead-detail" ? "l1" : screen.startsWith("quote") ? "q1" : "d1";

const browser = await chromium.launch({ channel: "chrome" });
const results = [];

for (const [name, spec] of Object.entries(ROUTES)) {
  const page = await browser.newPage({ viewport: { width, height: 1400 }, deviceScaleFactor: 2 });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e.message).slice(0, 140)));
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
  await page.waitForTimeout(800);

  const file = path.join(dir, `${name}${suffix}.png`);
  await page.locator("#root").screenshot({ path: file });

  // A screen that rendered its error state is not a visual pass, so say so here rather than
  // letting a red box slide through as a "captured" route.
  const text = await page.locator("#root").innerText().catch(() => "");
  const looksBroken = /تعذّر|Could not|no fixture/.test(text);
  const h = await page.locator("#root").evaluate((el) => el.scrollHeight).catch(() => 0);
  results.push({ route: name, height: h, errors: errors.length, looksBroken });
  await page.close();
}

await browser.close();
console.log(`width ${width}px`);
for (const r of results) {
  console.log(
    `  ${r.looksBroken || r.errors ? "!!" : "ok"}  ${r.route.padEnd(24)} h=${String(r.height).padStart(5)}` +
    `${r.errors ? `  jsErrors=${r.errors}` : ""}${r.looksBroken ? "  ERROR-STATE" : ""}`,
  );
}
