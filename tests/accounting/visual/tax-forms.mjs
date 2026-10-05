// Browser proof of the stage 6 screens through their real forms (Figma ACC-70..72), as the
// fixture's preparer and approver, with database checks. LOCAL ONLY: nothing is sent to ZATCA;
// the seller profile, addresses and documents are SYNTHETIC. Passing this is not ZATCA validation.
//  1. seller profile: a new version prepared in the form, not approvable by its preparer, approved
//     by the approver (the previous version retires);
//  2. a document that failed local validation (buyer without a national address): the address is
//     entered in the dialog and generation is retried → it takes the next ICV and the previous hash;
//  3. a debit note through the receivables form against a posted invoice: submitted, approved and
//     posted in the browser → an e-invoice of type 383 naming the invoice, valid locally;
//  4. "submit" on a LOCAL_ONLY profile records that nothing was sent; re-validation passes;
//  5. the VAT return page shows the boxes and the reconciliation computed from the database.
//
//   BASE_URL=http://localhost:3040 FIN_PASSWORD=... RUNTIME_DATABASE_URL=... node tests/accounting/visual/tax-forms.mjs [shotsDir]
import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";

const BASE = process.env.BASE_URL ?? "http://localhost:3040";
if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(BASE)) throw new Error("Refusing to run against a non-local server.");
const DB_URL = process.env.RUNTIME_DATABASE_URL;
if (!DB_URL || !/@(127\.0\.0\.1|localhost):\d+\//.test(DB_URL)) throw new Error("RUNTIME_DATABASE_URL must be a local database.");
const out = process.argv[2]; if (out) mkdirSync(out, { recursive: true });
const { Client } = createRequire(import.meta.url)("pg");
const db = new Client({ connectionString: DB_URL }); await db.connect();
const one = async (sql, args = []) => (await db.query(sql, args)).rows[0];

const browser = await chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
const results = [];
const ok = (m) => { results.push(m); console.log(`ok - ${m}`); };
async function session(user) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "ar-SA" });
  const page = await ctx.newPage();
  const errors = []; page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(`${BASE}/login`);
  const st = await page.evaluate(async ([u, p]) => (await fetch("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ method: "password", username: u, password: p }) })).status, [user, process.env.FIN_PASSWORD]);
  if (st !== 200) throw new Error(`login ${user}: ${st}`);
  return { ctx, page, errors };
}
const shot = async (page, name) => { if (out) await page.screenshot({ path: `${out}/${name}.png`, fullPage: true }); };
const go = async (page, path) => { await page.goto(`${BASE}${path}`); await page.waitForLoadState("networkidle"); };

try {
  const prep = await session("acc.preparer");
  const appr = await session("acc.approver");
  const P = prep.page, A = appr.page;

  // 1. Seller profile, new version, four-eyes.
  const v1 = await one(`select id, version from "EInvoiceProfile" where status = 'APPROVED'`);
  await go(P, "/dashboard/accounting/tax/profile");
  await P.getByRole("button", { name: "إصدار جديد" }).click();
  const form = P.getByTestId("profile-form");
  await form.getByLabel("المدينة").fill("الرياض (تجريبي)");
  await form.getByRole("button", { name: "إعداد الملف" }).click();
  await P.getByText("أُعدّ الملف؛ بانتظار اعتماد شخص آخر.").waitFor({ timeout: 10000 });
  await P.getByText("أنت أعددت هذا الإصدار؛ يعتمده شخص آخر.").waitFor();
  await shot(P, "ACC-71-draft");
  await go(A, "/dashboard/accounting/tax/profile");
  await A.getByRole("button", { name: "اعتماد الملف" }).click();
  await A.getByText("اعتُمد الملف.").waitFor({ timeout: 10000 });
  const v2 = await one(`select version, city, status from "EInvoiceProfile" where status = 'APPROVED'`);
  assert.deepEqual([v2.version, v2.city], [v1.version + 1, "الرياض (تجريبي)"]);
  assert.equal((await one(`select status from "EInvoiceProfile" where id = $1`, [v1.id])).status, "RETIRED");
  await shot(A, "ACC-71-approved");
  ok(`seller profile v${v2.version} prepared in the form, not approvable by its preparer, approved by the approver; v${v1.version} retired`);

  // 2. Fix a locally invalid document and retry.
  const inv = await one(`select j."salesInvoiceId" id, s."invoiceNo" no from "EInvoiceJob" j join "SalesInvoice" s on s.id = j."salesInvoiceId" where j.status = 'INVALID' order by s."invoiceNo" limit 1`);
  const lastIcv = Number((await one(`select coalesce(max(icv), 0) m from "EInvoice"`)).m);
  const lastHash = (await one(`select "invoiceHash" h from "EInvoice" where icv = $1`, [lastIcv]))?.h;
  await go(P, "/dashboard/accounting/tax");
  await shot(P, "ACC-70-list");
  const row = P.getByTestId(`einv-INV-${inv.no}`);
  await row.getByText(/LOCAL-BUYER-ADDR/).waitFor();
  await row.getByRole("button", { name: "عنوان المشتري…" }).click();
  const dlg = P.getByRole("dialog");
  for (const [label, v] of [["الشارع", "شارع التجربة"], ["رقم المبنى", "2468"], ["الحي", "حي التجربة"], ["المدينة", "الدمام"], ["الرمز البريدي", "34567"]]) await dlg.getByLabel(label, { exact: true }).fill(v);
  await dlg.getByRole("button", { name: "حفظ" }).click();
  await P.getByText("حُفظ العنوان؛ أعد محاولة الإنشاء.").waitFor({ timeout: 10000 });
  await row.getByRole("button", { name: "إنشاء / إعادة المحاولة" }).click();
  await P.getByText("أُنشئ المستند الإلكتروني.").waitFor({ timeout: 10000 });
  const e = await one(`select icv, "previousHash" p, validation from "EInvoice" where "salesInvoiceId" = $1`, [inv.id]);
  assert.equal(e.icv, lastIcv + 1);
  if (lastHash) assert.equal(e.p, lastHash);
  assert.deepEqual(e.validation.filter((x) => !x.ok), []);
  ok(`INV-${inv.no}: buyer address entered in the dialog, generation retried → ICV ${e.icv}, previous hash = ICV ${lastIcv}, valid locally`);

  // 3. Debit note through the receivables form.
  const base = await one(`select s.id, s."invoiceNo" no from "SalesInvoice" s join "EInvoice" e on e."salesInvoiceId" = s.id where s.kind = 'INVOICE' and s.status = 'POSTED' and s."debitNoteOfId" is null and e.subtype = '0100000' order by s."invoiceNo" limit 1`);
  await go(P, `/dashboard/accounting/receivables/${base.id}`);
  await P.getByRole("button", { name: "إصدار إشعار مدين…" }).click();
  await P.waitForURL(/debitFor=/); await P.waitForLoadState("networkidle");
  await P.getByText(`إشعار مدين جديد — يرفع INV-${base.no}`).waitFor({ timeout: 10000 });
  await P.getByLabel("سبب الإشعار المدين").fill("رسوم توصيل إضافية (تجريبي)");
  await P.getByLabel("نوع البند 1").selectOption("NON_STOCK");
  await P.getByLabel("وصف البند 1").fill("رسوم توصيل");
  await P.getByLabel("كمية البند 1").fill("1");
  await P.getByLabel("سعر البند 1").fill("150");
  await shot(P, "ACC-70-debit-note-editor");
  await P.getByRole("button", { name: "حفظ وتقديم للاعتماد" }).click();
  await P.waitForURL(/\/receivables\/c[a-z0-9]+$/, { timeout: 15000 }); await P.waitForLoadState("networkidle");
  const dnId = P.url().split("/").pop();
  assert.equal((await one(`select "debitNoteOfId" d, status from "SalesInvoice" where id = $1`, [dnId])).d, base.id);
  await go(A, `/dashboard/accounting/receivables/${dnId}`);
  await A.getByRole("button", { name: "اعتماد", exact: true }).click(); await A.waitForTimeout(1200);
  await A.getByRole("button", { name: "ترحيل الفاتورة" }).click(); await A.waitForTimeout(2000);
  const dn = await one(`select e."typeCode" t, e.xml, e.validation, s."invoiceNo" no from "EInvoice" e join "SalesInvoice" s on s.id = e."salesInvoiceId" where e."salesInvoiceId" = $1`, [dnId]);
  assert.equal(dn.t, "383");
  assert.match(dn.xml, new RegExp(`<cbc:ID>INV-${base.no}</cbc:ID>`));
  assert.match(dn.xml, /<cbc:InstructionNote>رسوم توصيل إضافية \(تجريبي\)<\/cbc:InstructionNote>/);
  assert.deepEqual(dn.validation.filter((x) => !x.ok), []);
  ok(`debit note DN-${dn.no} prepared in the receivables form against INV-${base.no}, approved and posted by the approver → e-invoice 383 referencing it, valid locally`);

  // 4. Detail: submit on LOCAL_ONLY records "not sent"; re-validation passes.
  const eid = (await one(`select id from "EInvoice" where "salesInvoiceId" = $1`, [dnId])).id;
  await go(P, "/dashboard/accounting/tax");
  await P.getByTestId(`einv-DN-${dn.no}`).getByRole("button", { name: "التفاصيل" }).click();
  await P.getByRole("button", { name: "إرسال (بيئة اختبار فقط)" }).click();
  await P.getByText(/سُجّلت المحاولة: غير مُرسل/).waitFor({ timeout: 10000 });
  const sub = await one(`select outcome, environment, response from "EInvoiceSubmission" where "eInvoiceId" = $1 order by attempt desc limit 1`, [eid]);
  assert.deepEqual([sub.outcome, sub.environment], ["NOT_SENT", "LOCAL_ONLY"]);
  await P.getByRole("button", { name: "إعادة التحقق محلياً" }).click();
  await P.getByText("أعيد التحقق محلياً: كل القواعد متحققة.").waitFor({ timeout: 10000 });
  await P.getByText("غير مطابق للمعيار — تحقق محلي فقط:").waitFor();
  await P.getByText("لم يُتحقق منه بأداة الهيئة (SDK) أو منصة فاتورة").waitFor();
  await shot(P, "ACC-70-detail");
  ok("e-invoice detail: submission on a LOCAL_ONLY profile recorded as not sent (nothing left the system); local re-validation passes; the screen states it is not standards-compliant (not SDK-validated)");

  // 4b. A simplified invoice: QR tag 6 is 32 bytes, 7 and 8 DER, no tag 9; the screen lists the missing ZATCA certificate and tag 9.
  const simp = await one(`select e.qr, s."invoiceNo" no, s.kind, s."debitNoteOfId" dn from "EInvoice" e join "SalesInvoice" s on s.id = e."salesInvoiceId" where e.subtype = '0200000' order by e.icv limit 1`);
  assert.ok(simp, "the fixture has a simplified e-invoice");
  const tlv = {}; const qb = Buffer.from(simp.qr, "base64");
  for (let i = 0; i < qb.length;) { tlv[qb[i]] = qb.subarray(i + 2, i + 2 + qb[i + 1]); i += 2 + qb[i + 1]; }
  assert.deepEqual([tlv[6]?.length, tlv[7]?.length, tlv[8]?.length, tlv[9]], [32, 64, 64, undefined]);
  await go(P, "/dashboard/accounting/tax");
  await P.getByTestId(`einv-${simp.kind === "CREDIT_NOTE" ? "CN" : simp.dn ? "DN" : "INV"}-${simp.no}`).getByRole("button", { name: "التفاصيل" }).click();
  await P.getByText(/الوسم 9 في QR .* غير موجود/).waitFor({ timeout: 10000 });
  await P.getByText(/مختوم بمفتاح اختبار محلي وليس بشهادة CSID/).waitFor();
  await P.getByText(/ترميز الوسوم 6–8 في QR يتبع الوثائق الرسمية/).waitFor();
  await P.getByText("غير مطابق للمعيار — تحقق محلي فقط:").scrollIntoViewIfNeeded();
  await shot(P, "ACC-70-simplified-gaps");
  ok(`simplified INV-${simp.no}: QR in the default OFFICIAL_DOCS layout (tag 6 = 32-byte hash, tag 7 = 64-byte P1363 signature, tag 8 = 64-byte public key), no tag 9; the detail lists the missing ZATCA certificate, the unconfirmed encodings and tag 9`);

  // 5. VAT return.
  await go(P, "/dashboard/accounting/tax/vat-return");
  const api = await P.evaluate(async () => { const inputs = [...document.querySelectorAll('input[type="date"]')].map((i) => i.value); return (await fetch(`/api/accounting/tax/vat-return?from=${inputs[0]}&to=${inputs[1]}`)).json(); });
  await P.getByTestId("box-1").waitFor();
  const shown = (await P.getByTestId("box-1").innerText()).replace(/[^\d.,()\-]/g, " ");
  assert.ok(shown.includes(Number(api.boxes["1"].vat).toLocaleString("en-US", { minimumFractionDigits: 2 })), `box 1 VAT ${api.boxes["1"].vat} shown in "${shown}"`);
  const out = api.reconciliation.find((x) => x.role === "OUTPUT_VAT");
  await P.getByTestId("recon-OUTPUT_VAT").waitFor();
  for (const c of api.reconciliation) assert.equal(c.unexplained, "0.00", `${c.role}: unexplained ${c.unexplained}`);
  await shot(P, "ACC-72-vat-return");
  ok(`VAT return page: box 1 VAT ${api.boxes["1"].vat}, net VAT ${api.boxes["13"].vat}; output VAT from documents ${out.fromDocuments} vs ledger ${out.ledger} (difference ${out.difference}, all of it journals from outside the documents; unexplained 0.00)`);

  for (const s of [prep, appr]) assert.deepEqual(s.errors, [], "no page errors");
  for (const s of [prep, appr]) await s.ctx.close();
} finally { await browser.close(); await db.end(); }
console.log(`# pass ${results.length}\n# fail 0`);
