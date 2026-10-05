// Composes Figma exports and app captures into side-by-side comparison images (design | app).
//
//   PW_CHROMIUM=/opt/pw-browsers/chromium node tests/accounting/visual/side-by-side.mjs \
//     docs/accounting/evidence ACC-30:ACC-30-app-1440 ACC-36:ACC-36-app-390 ...
import { chromium } from "playwright";
import { readFileSync, mkdirSync } from "node:fs";
import path from "node:path";

const [dir, ...pairs] = process.argv.slice(2);
if (!dir || !pairs.length) throw new Error("usage: side-by-side.mjs <evidence dir> <FRAME:app-file-stem>...");
mkdirSync(path.join(dir, "side"), { recursive: true });
const uri = (f) => `data:image/png;base64,${readFileSync(f).toString("base64")}`;
const browser = await chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
for (const pair of pairs) {
  const [frame, app] = pair.split(":");
  const mobile = /-390$/.test(app);
  const w = mobile ? 390 : 1440;
  await page.setViewportSize({ width: w * 2 + 72, height: 900 });
  await page.setContent(`<body style="margin:0;background:#e5e7eb;font:600 15px system-ui">
    <div style="display:flex;gap:24px;padding:24px;align-items:flex-start">
      ${[["Figma " + frame, uri(path.join(dir, "figma", `${frame}-figma.png`))], ["App " + app, uri(path.join(dir, "app", `${app}.png`))]].map(([t, src]) =>
        `<figure style="margin:0;width:${w}px"><figcaption style="padding:0 0 8px">${t}</figcaption><img src="${src}" style="width:${w}px;display:block;box-shadow:0 1px 4px #0003"></figure>`).join("")}
    </div></body>`);
  await page.waitForFunction(() => [...document.images].every((i) => i.complete));
  const out = path.join(dir, "side", `${frame}-side.png`);
  await page.screenshot({ path: out, fullPage: true });
  console.log(out);
}
await browser.close();
