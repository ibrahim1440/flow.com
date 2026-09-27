// The six resolved decisions on the running candidate, read-only (fresh fixture), with a
// screenshot of each changed screen area for the Figma comparison.
//
//   BASE_URL=http://localhost:3080 FIN_PASSWORD=... node tests/finance/visual/uat-decisions-ui.mjs <shotDir>
import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdirSync } from "node:fs";

const BASE = process.env.BASE_URL ?? "http://localhost:3080";
if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(BASE)) throw new Error("Refusing to run against a non-local server.");
const out = process.argv[2] ?? "uat-shots"; mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ channel: "chrome" });
async function as(user) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/login`);
  const st = await page.evaluate(async ([u, p]) => (await fetch("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ method: "password", username: u, password: p }) })).status, [user, process.env.FIN_PASSWORD]);
  assert.equal(st, 200, `login ${user}`);
  return { ctx, page };
}
const card = (page, text) => page.locator("div.bg-white.rounded-2xl", { hasText: text }).first();
const shot = async (loc, name) => { await loc.scrollIntoViewIfNeeded(); await loc.screenshot({ path: path.join(out, `${name}.png`) }); };
const ok = (s) => console.log("✔", s);

try {
  const m = await as("fin.manager");
  const p = m.page;

  // D2 — review panel: status + primary action visible, extra sections closed.
  await p.goto(`${BASE}/dashboard/finance/transactions`);
  await p.getByText("TRANSFER AL QASR CAFE").click();
  const panel = card(p, "مراجعة سطر بنكي");
  await panel.getByTestId("collection-suggestion").waitFor();
  await panel.getByTestId("review-status").waitFor();
  await panel.getByRole("button", { name: "حفظ ووضع علامة مُراجعة" }).waitFor();
  const open = await panel.locator("details").evaluateAll((ds) => ds.map((d) => [d.dataset.testid, d.open]));
  assert.ok(open.length >= 3 && open.every(([, o]) => o === false), `sections closed: ${JSON.stringify(open)}`);
  const box = await panel.boundingBox();
  await shot(panel, "D2-review-panel-app");
  ok(`D2 review panel: status and primary action visible, ${open.length} sections collapsed (panel ${Math.round(box.height)} px tall)`);

  // D3a/D3b — allocation categories: New category for preparers; hint next to the profit-like category only.
  await p.goto(`${BASE}/dashboard/finance/allocation`);
  const cats = card(p, "فئات التخصيص");
  await cats.getByText("حصة أرباح المالك").waitFor();
  assert.equal(await cats.getByTestId("profit-hint").count(), 1, "one profit-like category, one hint");
  assert.ok((await p.locator("tr", { hasText: "حصة أرباح المالك" }).getByTestId("profit-hint").count()) === 1);
  assert.equal(await cats.getByText("اسم الفئة لا يعني ربحاً").count(), 0, "no footnote under every table");
  assert.ok(await cats.getByRole("button", { name: "فئة جديدة" }).isVisible());
  await shot(cats, "D3-categories-app");
  await cats.getByRole("button", { name: "فئة جديدة" }).click();
  const cd = p.locator("[role=dialog]");
  await cd.getByLabel("الاسم بالعربية").fill("توزيعات الشركاء");
  await cd.getByText("ليس بالضرورة ربحاً قابلاً للتوزيع").waitFor();
  await shot(cd, "D3-category-form-app");
  await cd.getByRole("button", { name: "إلغاء" }).click();
  const v = await as("fin.viewer");
  await v.page.goto(`${BASE}/dashboard/finance/allocation`);
  await v.page.waitForLoadState("networkidle");
  assert.equal(await v.page.getByRole("button", { name: "فئة جديدة" }).count(), 0, "viewer has no New category");
  ok("D3a New category for preparers only (same form and permission as edits); D3b hint next to the profit-like category and in the form");

  // D4a — budget: owner kept; zero rows say verified or what is outstanding.
  await p.goto(`${BASE}/dashboard/finance/budget`);
  const cmp = card(p, "المقارنة الشهرية");
  await cmp.waitFor();
  assert.ok((await cmp.getByText("سارة العتيبي — المالية").count()) > 0, "line owner shown");
  const unverified = await cmp.getByTestId("zero-unverified").allTextContents();
  assert.ok(unverified.length > 0 && unverified.every((t) => /للمراجعة|معلّق|غير مُسوّى/.test(t)), `each warning names its indicator: ${JSON.stringify(unverified)}`);
  assert.equal(await cmp.getByText("قد تكون البيانات ناقصة").count(), 0, "the unconditional note is gone");
  await shot(cmp, "D4-comparison-app");
  ok(`D4a zero rows: ${unverified.length} not yet verified, each with its indicator; owner shown`);

  // D5 — obligations: counterparty, show all, export, cancel with reason.
  await p.goto(`${BASE}/dashboard/finance/obligations`);
  const obs = card(p, "مرتبة حسب الاستحقاق");
  await obs.getByText("العليا العقارية").first().waitFor();
  assert.ok(await card(p, "التوقع النقدي المتجدد").getByText("تصدير").isVisible(), "export");
  assert.ok(await obs.getByRole("button", { name: /عرض الكل/ }).isVisible(), "show all");
  await shot(obs, "D5-obligations-app");
  await p.locator("tr", { hasText: "بن أخضر — كولومبيا هويلا" }).getByRole("button", { name: "إلغاء" }).click();
  const dlg = p.locator("[role=dialog]", { hasText: "إلغاء الالتزام" });
  await dlg.getByTestId("cancel-effects").waitFor();
  const confirm = dlg.getByRole("button", { name: "تأكيد الإلغاء" });
  assert.equal(await confirm.isDisabled(), true, "no reason → cannot confirm");
  await dlg.locator("textarea").fill("لا");
  assert.equal(await confirm.isDisabled(), true, "too short a reason → cannot confirm");
  await dlg.locator("textarea").fill("");
  await shot(dlg, "D5-cancel-dialog-app");
  await dlg.getByRole("button", { name: "رجوع" }).click();
  ok("D5 counterparty, Show all, Export present; Cancel opens a dialog showing its effects and requires a reason");

  // D6 — settings: account fields; branch access only for administrators; suggestions optional.
  await p.goto(`${BASE}/dashboard/finance/reports`);
  const br = card(p, "الفروع والوصول");
  await br.getByTestId("access-admin-only").waitFor();
  assert.equal(await br.getByRole("button", { name: "منح" }).count(), 0, "preparer cannot grant");
  await shot(br, "D6-branches-preparer-app");
  await shot(card(p, "الحسابات البنكية والنقدية"), "D6-accounts-app");
  const bc = card(p, "بنود الميزانية النقدية");
  assert.ok(await bc.getByRole("button", { name: "إضافة المقترحة (اختياري)" }).isVisible());
  await shot(bc, "D6-budget-categories-app");
  const a = await as("fin.admin");
  await a.page.goto(`${BASE}/dashboard/finance/reports`);
  const abr = card(a.page, "الفروع والوصول");
  await abr.getByRole("button", { name: "منح" }).waitFor();
  const people = await abr.getByLabel("الموظف").locator("option").allTextContents();
  assert.ok(!people.some((x) => x.includes("مسؤول النظام — المالية")), "an administrator cannot pick themselves");
  await shot(abr, "D6-branches-admin-app");
  ok("D6 branch access controls only for the administrator (not themselves); suggested categories marked optional");

  await m.ctx.close(); await v.ctx.close(); await a.ctx.close();
  console.log("\nall decision checks passed");
} finally {
  await browser.close();
}
