// Side-by-side and pixel-diff for Figma frames vs application captures.
//
//   node tests/finance/visual/compare.mjs <dir> FIN-01:FIN-01-app-1440.png FIN-07a:FIN-07a-app-1440.png:32 ...
//
// An optional third field trims that many pixels from every edge of the Figma image (dialog
// exports include their drop-shadow bleed; the app capture is the dialog element only).
//
// For each pair <id>-figma.png / <app file> it writes <id>-side.png (Figma | app) and
// <id>-diff.png (app dimmed, differing pixels in magenta) and prints the share of differing
// pixels over the overlapping area. Uses the Chrome canvas — no image library is added.
import { chromium } from "@playwright/test";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const dir = process.argv[2];
const pairs = process.argv.slice(3).map((a) => a.split(":"));
const browser = await chromium.launch({ channel: "chrome" });
const page = await browser.newPage();
await page.setContent("<html><body></body></html>");
for (const [id, appFile, trim = "0"] of pairs) {
  const fig = "data:image/png;base64," + readFileSync(path.join(dir, `${id}-figma.png`)).toString("base64");
  const app = "data:image/png;base64," + readFileSync(path.join(dir, appFile)).toString("base64");
  const res = await page.evaluate(async ([a, b, t]) => {
    const load = (src) => new Promise((r) => { const i = new Image(); i.onload = () => r(i); i.src = src; });
    const [fr, ai] = await Promise.all([load(a), load(b)]);
    const fi = document.createElement("canvas"); fi.width = fr.width - 2 * t; fi.height = fr.height - 2 * t; fi.getContext("2d").drawImage(fr, -t, -t);
    const w = Math.max(fi.width, ai.width), h = Math.max(fi.height, ai.height);
    const side = document.createElement("canvas"); side.width = fi.width + ai.width + 24; side.height = h;
    const sc = side.getContext("2d"); sc.fillStyle = "#fff"; sc.fillRect(0, 0, side.width, h); sc.drawImage(fi, 0, 0); sc.drawImage(ai, fi.width + 24, 0);
    const c1 = document.createElement("canvas"); c1.width = w; c1.height = h; const x1 = c1.getContext("2d"); x1.drawImage(fi, 0, 0);
    const c2 = document.createElement("canvas"); c2.width = w; c2.height = h; const x2 = c2.getContext("2d"); x2.drawImage(ai, 0, 0);
    const oh = Math.min(fi.height, ai.height), ow = Math.min(fi.width, ai.width);
    const d1 = x1.getImageData(0, 0, ow, oh).data, d2 = x2.getImageData(0, 0, ow, oh).data;
    const diff = document.createElement("canvas"); diff.width = ow; diff.height = oh; const dx = diff.getContext("2d");
    const out = dx.createImageData(ow, oh); let n = 0;
    for (let i = 0; i < d1.length; i += 4) {
      const delta = Math.abs(d1[i] - d2[i]) + Math.abs(d1[i + 1] - d2[i + 1]) + Math.abs(d1[i + 2] - d2[i + 2]);
      if (delta > 60) { out.data[i] = 236; out.data[i + 1] = 0; out.data[i + 2] = 140; out.data[i + 3] = 255; n++; }
      else { const g = 255 - (255 - (d2[i] + d2[i + 1] + d2[i + 2]) / 3) * 0.35; out.data[i] = out.data[i + 1] = out.data[i + 2] = g; out.data[i + 3] = 255; }
    }
    dx.putImageData(out, 0, 0);
    return { side: side.toDataURL("image/png"), diff: diff.toDataURL("image/png"), ratio: n / (ow * oh), fig: [fi.width, fi.height], app: [ai.width, ai.height] };
  }, [fig, app, Number(trim)]);
  writeFileSync(path.join(dir, `${id}-side.png`), Buffer.from(res.side.split(",")[1], "base64"));
  writeFileSync(path.join(dir, `${id}-diff.png`), Buffer.from(res.diff.split(",")[1], "base64"));
  console.log(`${id}: figma ${res.fig.join("x")} · app ${res.app.join("x")} · differing pixels ${(res.ratio * 100).toFixed(1)}%`);
}
await browser.close();
