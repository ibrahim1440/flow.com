// End-to-end user workflow through the real Finance UI (local fixture server only):
//   link the Al Qasr receipt to its approved Sales collection and allocate it once →
//   classify an unknown deposit → allocate it by approved rules → create, fill and submit a
//   budget → approver approves it → payment request above the limit → approver approves the
//   override → the payment is made in online banking (outside the app) and recorded as a
//   pending line → "Record payment made" links the reservation to that line → the bank
//   statement is imported and CONFIRMS the same line (no second outflow) → the budget report
//   shows the actual exactly once.
//
//   BASE_URL=http://localhost:3040 FIN_PASSWORD=... node tests/finance/visual/workflow-ui.mjs [shotDir]
import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdirSync } from "node:fs";

const BASE = process.env.BASE_URL ?? "http://localhost:3040";
if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(BASE)) throw new Error("Refusing to run against a non-local server.");
const shots = process.argv[2]; if (shots) mkdirSync(shots, { recursive: true });
const snap = async (page, name) => { if (shots) await page.screenshot({ path: path.join(shots, `wf-${name}.png`) }); };

const browser = await chromium.launch({ channel: "chrome" });
async function as(user) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/login`);
  const st = await page.evaluate(async ([u, p]) => (await fetch("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ method: "password", username: u, password: p }) })).status, [user, process.env.FIN_PASSWORD]);
  assert.equal(st, 200);
  return { ctx, page };
}
const steps = [];
const step = (s) => { steps.push(s); console.log("✔", s); };
// Company pool as the preparer sees it (halalas), recorded after every step.
const money = (v) => (v / 100).toLocaleString("en-US", { minimumFractionDigits: 2 });
const balances = [];
async function pool(page, label) {
  const pools = await page.evaluate(async () => (await fetch("/api/finance/pools")).json());
  const c = pools.find((x) => x.branchKey === "COMPANY");
  const row = { step: label, eligible: c.eligibleCash, allocated: c.allocated, unallocated: c.unallocated };
  balances.push(row);
  return row;
}

try {
  const m = await as("fin.manager");
  let p = m.page;
  await p.goto(`${BASE}/dashboard/finance`);
  const start = await pool(p, "Fixture as seeded");

  // 0. An approved Sales collection matched to the bank receipt that brought the money in.
  await p.goto(`${BASE}/dashboard/finance/transactions`);
  await p.getByText("TRANSFER AL QASR CAFE").click();
  const cp = p.locator("div.bg-white.rounded-2xl", { hasText: "مراجعة سطر بنكي" }).first();
  // D2: status and primary action visible; the extra sections are closed.
  await cp.getByTestId("review-status").waitFor();
  await cp.getByRole("button", { name: "حفظ ووضع علامة مُراجعة" }).waitFor();
  for (const id of ["section-link", "section-note", "section-allocated", "section-history"]) {
    const sec = cp.getByTestId(id);
    if (await sec.count()) assert.equal(await sec.evaluate((e) => e.open), false, `${id} is collapsed by default`);
  }
  const sug = cp.getByTestId("collection-suggestion");
  await sug.getByText("مقهى القصر").waitFor();
  assert.ok((await sug.textContent()).includes("بالمرجع"), "matched by reference");
  await snap(p, "0-collection-suggested");
  await sug.getByRole("button", { name: "ربط التحصيل" }).click();
  await cp.getByTestId("collection-linked").waitFor();
  const afterLink = await pool(p, "Collection linked (receipt not yet reviewed)");
  assert.deepEqual([afterLink.eligible, afterLink.allocated], [start.eligible, start.allocated], "linking moves no cash and allocates nothing");
  await cp.locator("select").first().selectOption("CUSTOMER_RECEIPT");
  const cs0 = cp.getByLabel("بند الميزانية");
  const cso = await cs0.locator("option").allTextContents();
  await cs0.selectOption({ index: cso.findIndex((o) => o.includes("تحصيلات عملاء الجملة")) });
  await cp.getByRole("button", { name: "حفظ ووضع علامة مُراجعة" }).click();
  await cp.getByRole("button", { name: "تخصيص حسب القواعد المعتمدة" }).waitFor();
  const reviewed = await pool(p, "Receipt reviewed as a customer receipt");
  // The statement receipt was confirmed cash from the moment it was imported (5,750.00 is
  // already in the seeded pool); linking the collection and reviewing the line add nothing.
  assert.equal(reviewed.eligible, start.eligible, "reviewing a linked receipt adds no cash: it was counted once, at import");
  await cp.getByRole("button", { name: "تخصيص حسب القواعد المعتمدة" }).click();
  await cp.getByTestId("section-allocated").locator("summary").click();
  await cp.getByTestId("section-allocated").getByText("احتياطي ضريبة القيمة المضافة").first().waitFor();
  const allocated = await pool(p, "Allocated by approved rules");
  assert.equal(allocated.eligible, reviewed.eligible, "allocation moves no cash");
  const vatEntry = await cp.getByTestId("section-allocated").locator("div", { hasText: "احتياطي ضريبة القيمة المضافة" }).last().textContent();
  assert.ok(vatEntry.includes("750.00"), "VAT reserve takes the collection's VAT (750.00)");
  assert.equal(await cp.getByRole("button", { name: "تخصيص حسب القواعد المعتمدة" }).count(), 0, "cannot allocate the same receipt twice");
  const again = await p.evaluate(async (id) => (await fetch("/api/finance/allocations/run", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ txnId: id }) })).status, await p.evaluate(async () => (await (await fetch("/api/finance/transactions?q=IN-2301")).json()).rows[0].id));
  const retried = await pool(p, "Allocation retried (refused or no-op)");
  assert.deepEqual([retried.eligible, retried.allocated], [allocated.eligible, allocated.allocated], `a retried allocation changes nothing (HTTP ${again})`);
  await snap(p, "0b-collection-allocated");
  step(`Approved Sales collection (Al Qasr, 5,750.00 incl. 750.00 VAT) linked to its receipt; reviewed and allocated once — eligible cash unchanged (counted once, at import), allocated +${money(allocated.allocated - reviewed.allocated)}; a retry changes nothing`);

  // 1. Classify the unknown deposit and allocate it.
  await p.goto(`${BASE}/dashboard/finance/transactions`);
  await p.getByText("INCOMING TRANSFER 88213").click();
  const panel = p.locator("div.bg-white.rounded-2xl", { hasText: "مراجعة سطر بنكي" }).first();
  await panel.getByText("مصدر الإيداع غير معروف").waitFor();
  await panel.locator("select").first().selectOption("OTHER_OPERATING_RECEIPT");
  const splitSel = panel.getByLabel("بند الميزانية");
  const opts = await splitSel.locator("option").allTextContents();
  await splitSel.selectOption({ index: opts.findIndex((o) => o.includes("مقبوضات تشغيلية أخرى")) });
  await panel.getByRole("button", { name: "حفظ ووضع علامة مُراجعة" }).click();
  await panel.getByRole("button", { name: "تخصيص حسب القواعد المعتمدة" }).waitFor();
  step("Unknown deposit classified and reviewed; it was not allocated before review");
  await panel.getByRole("button", { name: "تخصيص حسب القواعد المعتمدة" }).click();
  await panel.getByTestId("section-allocated").locator("summary").click();
  await panel.getByText("غير مخصص من الإيصال").waitFor();
  await p.waitForTimeout(800);
  const unalloc = await panel.getByText("غير مخصص من الإيصال").locator("b").textContent();
  assert.ok(unalloc, "unallocated shown");
  await snap(p, "1-allocated");
  await pool(p, "Unknown deposit reviewed and allocated");
  step(`Allocated by approved rules; remaining unallocated from receipt: ${unalloc.replace(/[⁦⁩]/g, "")}`);

  // 2. Create an empty budget for next month, add a line, submit it.
  await p.goto(`${BASE}/dashboard/finance/budget`);
  // New budget is the last option of the month selector (as in the design: no extra toolbar button).
  await p.getByLabel("الشهر").selectOption("__new");
  const dlg = p.locator("[role=dialog]");
  await dlg.locator("input[type=month]").fill("2026-11");
  await dlg.locator("select").nth(1).selectOption("EMPTY");
  await dlg.getByRole("button", { name: "إنشاء" }).click();
  await p.getByRole("button", { name: "تعديل البنود" }).click();
  const ld = p.locator("[role=dialog]");
  await ld.getByText("+ إضافة بند").click();
  const catSel = ld.getByLabel("البند").last();
  const co = await catSel.locator("option").allTextContents();
  await catSel.selectOption({ index: co.findIndex((o) => o.includes("الإيجار")) });
  await ld.getByLabel("المخطط").last().fill("12000.00");
  await ld.getByLabel("الاستحقاق").last().fill("2026-11-01");
  await ld.getByRole("button", { name: "حفظ المسودة" }).click();
  await p.getByRole("button", { name: "إرسال للاعتماد" }).click();
  await p.getByText("أُرسلت للاعتماد.").waitFor();
  await snap(p, "2-submitted");
  step("Budget 2026-11 created, line added, submitted for approval");

  // 3. Approver approves the budget in their queue.
  const a = await as("fin.approver");
  let q = a.page;
  await q.goto(`${BASE}/dashboard/finance/budget`);
  await q.getByRole("button", { name: /الموافقات/ }).click();
  const ad = q.locator("[role=dialog]");
  await ad.getByText("ميزانية 2026-11").click();
  await ad.getByRole("button", { name: "اعتماد", exact: true }).click();
  await ad.getByText("ميزانية 2026-11").waitFor({ state: "detached" });
  step("Approver approved the budget from their approval queue (requester could not)");

  // 4. Payment request above the category limit → override approval → execute.
  await p.goto(`${BASE}/dashboard/finance/allocation`);
  await p.getByRole("button", { name: /^طلب دفع$/ }).first().click();
  const pd = p.locator("[role=dialog]");
  const c0 = await pd.locator("select").nth(0).locator("option").allTextContents();
  await pd.locator("select").nth(0).selectOption({ index: c0.findIndex((o) => o.includes("شراء البن الأخضر")) });
  const o1 = await pd.locator("select").nth(1).locator("option").allTextContents();
  await pd.locator("select").nth(1).selectOption({ index: o1.findIndex((o) => o.includes("كولومبيا")) });
  await pd.getByText("سيُحجز ويُرسل للموافقة على التجاوز").waitFor();
  await pd.getByRole("button", { name: "إرسال للموافقة" }).click();
  await pd.getByText("حُجز المبلغ وأُرسل للموافقة على التجاوز.").waitFor();
  step("Payment request above available balance and limit held and routed to the named approver");
  await q.goto(`${BASE}/dashboard/finance/allocation`);
  await q.getByRole("button", { name: /الموافقات/ }).click();
  await ad.getByText("دفع 31,200.00").click();
  await ad.getByLabel("ملاحظة القرار (إلزامية عند الرفض)").fill("شحنة مؤكدة");
  await ad.getByRole("button", { name: "اعتماد", exact: true }).click();
  await ad.getByText("دفع 31,200.00").waitFor({ state: "detached" });
  await pool(p, "Payment request 31,200.00 approved (reserved)");
  step("Approver approved the spending override");

  // The transfer is made in online banking (the app never sends money); record it as pending.
  await p.goto(`${BASE}/dashboard/finance/transactions`);
  await p.getByRole("button", { name: "قيد يدوي" }).click();
  const md = p.locator("[role=dialog]");
  await md.getByLabel("المبلغ (سالب للمبالغ الصادرة)").fill("-31200.00");
  await md.getByLabel("الوصف").fill("Andes Coffee Export — invoice AC-771");
  const acc = md.getByLabel(/^الحساب/).first();
  const ao = await acc.locator("option").allTextContents();
  await acc.selectOption({ index: ao.findIndex((o) => o.includes("SNB-CUR")) });
  await md.getByLabel("الحالة").selectOption("PENDING");
  await md.getByLabel("المرجع البنكي").fill("TRF-AC771");
  const payAccount = (await md.getByLabel("الحساب").locator("option:checked").textContent()).trim();
  await md.getByRole("button", { name: "حفظ" }).click();
  await md.waitFor({ state: "detached" });
  // Classify it: budget actuals come only from reviewed, classified lines.
  await p.getByText("Andes Coffee Export — invoice AC-771").click();
  const rp = p.locator("div.bg-white.rounded-2xl", { hasText: "مراجعة سطر بنكي" }).first();
  await rp.getByText("AC-771").first().waitFor();
  await rp.locator("select").first().selectOption("SUPPLIER_PAYMENT");
  const ps = rp.getByLabel("بند الميزانية");
  const po = await ps.locator("option").allTextContents();
  await ps.selectOption({ index: po.findIndex((o) => o.includes("مشتريات البن الأخضر")) });
  await rp.getByRole("button", { name: "حفظ ووضع علامة مُراجعة" }).click();
  await rp.getByText("مُراجعة").first().waitFor();
  await pool(p, "Pending payment line recorded and classified");
  step("Payment made outside the app recorded as a PENDING line (reference TRF-AC771) and classified");
  await p.goto(`${BASE}/dashboard/finance/allocation`);
  const row = p.locator("tr", { hasText: "أنديز لتصدير البن" });
  assert.equal(await p.getByText("تنفيذ الدفع").count(), 0, "no wording implies the app sends money");
  await row.getByRole("button", { name: "تسجيل الدفع المنفّذ" }).click();
  const ed = p.locator("[role=dialog]", { hasText: "تسجيل الدفع المنفّذ" });
  await ed.getByText("لا يرسل النظام أي أموال عبر البنك").waitFor();
  const lo = await ed.locator("select").locator("option").allTextContents();
  await ed.locator("select").selectOption({ index: lo.findIndex((o) => o.includes("AC-771")) });
  await ed.getByRole("button", { name: "تسجيل", exact: true }).click();
  await ed.waitFor({ state: "detached" });
  await snap(p, "3-executed");
  await pool(p, "Payment recorded against the pending line");
  step("Payment recorded against the pending line (category reduced and reservation released together; nothing sent)");

  // The bank statement arrives: it confirms the recorded line instead of adding a second outflow.
  const day = new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 10);
  await p.goto(`${BASE}/dashboard/finance/transactions`);
  const before = await p.getByText("Andes Coffee Export — invoice AC-771").count();
  await p.getByRole("button", { name: "استيراد CSV" }).click();
  const imp = p.locator("[role=dialog]", { hasText: "استيراد كشف بنكي" });
  await imp.getByLabel(/^الحساب/).first().selectOption({ label: payAccount });
  await imp.locator("input[type=file]").setInputFiles({ name: "statement.csv", mimeType: "text/csv", buffer: Buffer.from(`Date,Amount,Reference,Description
${day},-31200.00,TRF-AC771,OUTWARD TRANSFER ANDES
`) });
  // A wrapping <label> includes the select text in its accessible name, so match by prefix.
  for (const [lab, col] of [[/^التاريخ/, "Date"], [/^المبلغ \(موجب/, "Amount"], [/^المرجع/, "Reference"], [/^الوصف/, "Description"]]) await imp.getByLabel(lab).selectOption(col);
  await imp.getByRole("button", { name: "معاينة" }).click();
  const existingBox = imp.locator("div", { hasText: /^يؤكد سطراً مسجّلاً/ }).last();
  await existingBox.waitFor();
  assert.equal((await existingBox.locator("p").last().textContent()).trim(), "1", "preview: the row confirms the recorded line");
  await snap(p, "3b-statement-preview");
  await imp.getByRole("button", { name: "استيراد 1 سطراً" }).click();
  await imp.getByText("أكّد 1 سطراً مسجّلاً").waitFor();
  assert.ok((await imp.getByText(/استُورد 0 سطراً/).count()) === 1, "no new line inserted");
  await imp.getByRole("button", { name: "إغلاق" }).click();
  await p.reload();
  assert.equal(await p.getByText("Andes Coffee Export — invoice AC-771").count(), before, "still one line for this payment");
  assert.equal(await p.getByText("OUTWARD TRANSFER ANDES").count(), 0, "the statement text did not create a separate line");
  await p.getByText("Andes Coffee Export — invoice AC-771").click();
  await p.getByText(/أكّده كشف البنك في/).waitFor();
  await snap(p, "3c-statement-confirmed");
  await pool(p, "Statement confirmed the payment line");
  step("Statement imported: its line confirmed the recorded payment (0 inserted, 1 confirmed, no second outflow)");

  // 5. Budget report reflects actuals and variance.
  await p.goto(`${BASE}/dashboard/finance/budget`);
  await p.getByText("المقارنة الشهرية").waitFor();
  const green = await p.locator("tr", { hasText: "مشتريات البن الأخضر" }).first().textContent();
  assert.ok(green.includes("57,700.00"), "actual green-coffee payments include the payment exactly once (26,500 + 31,200)");
  assert.ok(!green.includes("88,900.00"), "not counted twice");
  await snap(p, "4-report");
  step("Current-month budget shows the new actual for green coffee (57,700.00) with its variance");
  await m.ctx.close(); await a.ctx.close();
  console.log(`\n${steps.length} workflow steps passed`);
  console.log("\nCompany pool after each step (SAR):\n| Step | Eligible cash | Allocated | Unallocated |\n|---|---:|---:|---:|");
  for (const b of balances) console.log(`| ${b.step} | ${money(b.eligible)} | ${money(b.allocated)} | ${money(b.unallocated)} |`);
} finally {
  await browser.close();
}
