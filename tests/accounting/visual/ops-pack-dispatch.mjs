// Browser proof of packing and dispatch through their real forms, with the accounting side:
//  - packing form: a validation failure (more coffee than the roast holds) changes nothing; a normal
//    pack posts; a pack with loss above the approved band is HELD and posts only after an accountant
//    approves and posts its document (in the browser); a pack of a SKU whose accounting item is not
//    linked is BLOCKED, and posts after the accountant links the item in inventory setup and retries
//    it from the exception queue (in the browser);
//  - dispatch form: a quantity above what is outstanding is refused and changes nothing; dispatches
//    of both SKUs post to "delivered, not invoiced".
// Quantities, cost documents and journals are checked in the database after each step.
// Prerequisites made through the API (not the subject of this test): the operations-policy approval
// (a SYNTHETIC TEST STEP) and a QC-passed stock roast. Local fixture only, synthetic data.
//
//   BASE_URL=http://localhost:3040 FIN_PASSWORD=... RUNTIME_DATABASE_URL=... node tests/accounting/visual/ops-pack-dispatch.mjs [shotsDir]
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
const n = (v) => Number(v);
const journal = async (docId) => (await db.query(
  `select a.code, l.debit::text d, l.credit::text c from "JournalEntryLine" l join "Account" a on a.id = l."accountId" join "JournalEntry" j on j.id = l."journalEntryId"
     join "AccountingEvent" e on e.id = j."originEventId" where e."idempotencyKey" = $1 order by a.code, l.debit desc`, [`inventory:${docId}:inv.document.posted`])).rows.map((r) => `${r.code}:${n(r.d).toFixed(2)}:${n(r.c).toFixed(2)}`);
const lastEvent = (kind, batchOrSource) => one(`select * from "InvOpsEvent" where kind = $1 and ("sourceId" = $2 or payload->>'batchId' = $2) order by "createdAt" desc limit 1`, [kind, batchOrSource]);

const browser = await chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
const results = [];
const ok = (m) => { results.push(m); console.log(`ok - ${m}`); };
async function session(user) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "en-GB" });
  const page = await ctx.newPage();
  const errors = []; page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(`${BASE}/login`);
  const st = await page.evaluate(async ([u, p]) => (await fetch("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ method: "password", username: u, password: p }) })).status, [user, process.env.FIN_PASSWORD]);
  if (st !== 200) throw new Error(`login ${user}: ${st}`);
  const call = (path, init = {}) => page.evaluate(async ([p, i]) => { const r = await fetch(p, { ...i, headers: { "Content-Type": "application/json", ...(i.headers ?? {}) } }); return { status: r.status, body: await r.json().catch(() => null) }; }, [path, init]);
  return { ctx, page, errors, call };
}
const shot = async (page, name) => { if (out) await page.screenshot({ path: `${out}/${name}.png`, fullPage: true }); };

try {
  const ops = await session("ops.roastery.en");
  const acc = await session("acc.approver");
  const prep = await session("acc.preparer");
  const gb = await one(`select id from "GreenBean" where "serialNumber" = 'ACC-ETH-YRG-0412'`);
  const cp = await one(`select id from "CoffeeProduct" where "productNameEn" = 'Ethiopia Yirgacheffe (fixture)'`);
  const sku = await one(`select id from "ProductSKU" where "skuCode" = 'ACC-ETH-250'`);
  const sku500 = await one(`select id from "ProductSKU" where "skuCode" = 'ACC-ETH-500'`);

  // Prerequisites through the API: operations policy (synthetic test step), a stock roast and its QC.
  const pol = await one(`select id, status from "AccountingPolicy" where key = 'inventory.operations' order by version desc limit 1`);
  if (pol?.status !== "APPROVED") {
    const id = pol?.status === "DRAFT" ? pol.id : (await prep.call("/api/accounting/policies", { method: "POST", body: JSON.stringify({ key: "inventory.operations" }) })).body.id;
    assert.equal((await acc.call(`/api/accounting/policies/${id}/approve`, { method: "POST" })).status, 200);
  }
  const roast = await ops.call("/api/roasting-batches", { method: "POST", body: JSON.stringify({ greenBeanId: gb.id, productId: cp.id, greenBeanQuantity: 12, roastedBeanQuantity: 10.2, wasteQuantity: 1.8 }) });
  assert.equal(roast.status, 201, JSON.stringify(roast.body));
  const batchId = roast.body.id, batchNo = roast.body.batchNumber;
  assert.equal((await ops.call("/api/qc-records", { method: "POST", body: JSON.stringify({ batchId, decision: "Accept", coffeeOrigin: "Ethiopia", processing: "Washed" }) })).status, 201);
  assert.equal((await ops.call(`/api/qc/${batchId}/finalize`, { method: "POST", body: JSON.stringify({ outcome: "Passed" }) })).status, 200);
  assert.equal((await lastEvent("ROAST", batchId)).status, "POSTED");

  // ── Packing form ─────────────────────────────────────────────────────────────
  const p = ops.page;
  const dialog = () => p.getByTestId("packaging-dialog");
  const row = (i) => dialog().getByTestId(`pack-line-${i}`);
  const openPack = async () => {
    await p.goto(`${BASE}/dashboard/packaging`); await p.waitForLoadState("networkidle");
    await p.getByTestId(`pack-batch-${batchNo}`).getByRole("button", { name: /Start Packaging|Continue Packaging/i }).click();
    await dialog().waitFor();
  };
  const packRow = async (i, skuId, packages) => { await row(i).locator("select").nth(1).selectOption(skuId); await row(i).locator('input[type="number"]').first().fill(String(packages)); };
  const confirm = () => dialog().getByRole("button", { name: /Confirm packaging/i });
  const opsBefore = n((await one(`select count(*) c from "PackagingOperation" where "batchId" = $1`, [batchId])).c);

  // 1. Validation failure: 60 × 250 g = 15 kg from a roast holding 10.2 kg.
  await openPack(); await packRow(0, sku.id, 60); await p.waitForTimeout(1200);
  const refusedInForm = await confirm().isDisabled();
  if (!refusedInForm) { await confirm().click(); await p.waitForTimeout(1200); }
  assert.equal(n((await one(`select count(*) c from "PackagingOperation" where "batchId" = $1`, [batchId])).c), opsBefore, "nothing packed");
  assert.equal(n((await one(`select "roastedAvailableKg" k from "RoastingBatch" where id = $1`, [batchId])).k), 10.2, "roast untouched");
  await shot(p, "OPS-pack-refused");
  ok(`packing form refuses 15 kg from a 10.2 kg roast (${refusedInForm ? "confirm disabled" : "server refusal"}); nothing changed`);
  await p.keyboard.press("Escape").catch(() => undefined);

  // 2. A normal pack: 8 × 250 g.
  await openPack(); await packRow(0, sku.id, 8); await p.waitForTimeout(800);
  await confirm().click(); await p.waitForLoadState("networkidle"); await p.waitForTimeout(1200);
  const e1 = await lastEvent("PACK", batchId);
  assert.equal(e1.status, "POSTED", e1.lastError ?? "");
  const out1 = await one(`select l.quantity::text q, l."lotId" from "InvDocLine" l where l."documentId" = $1 and l.role = 'OUTPUT'`, [e1.documentId]);
  const lot1 = await one(`select id, "unitsAvailable" u from "FinishedGoodsLot" where id = $1`, [out1.lotId]);
  assert.deepEqual([out1.q, n(lot1.u)], ["8.0000", 8], "8 units made, in the lot the form created");
  assert.equal(n((await one(`select "roastedAvailableKg" k from "RoastingBatch" where id = $1`, [batchId])).k), 8.2);
  const j1 = await journal(e1.documentId);
  const v1 = j1.find((l) => l.startsWith("1174:")).split(":")[1];
  assert.ok(j1.some((l) => l.startsWith("1173:0.00:")) && j1.some((l) => l.startsWith("1172:0.00:")), j1.join(" "));
  await p.getByTestId(`pack-batch-${batchNo}`).getByText("In the accounts").waitFor({ timeout: 8000 });
  await shot(p, "OPS-pack-posted");
  ok(`packing form: 8 × 250 g posted (Dr 1174 ${v1} / Cr 1173 roasted, Cr 1172 bags); chip "In the accounts"`);

  // 3. Loss above the approved band (1%, synthetic): 4 × 250 g + 60 g declared loss → held.
  await openPack(); await packRow(0, sku.id, 4);
  await dialog().getByRole("button", { name: /Add line|add a line|\+/i }).first().click().catch(() => undefined);
  await row(1).locator("select").first().selectOption("loss");
  await row(1).locator('input[type="number"]').first().fill("60");
  await row(1).locator('input[type="text"]').first().fill("Spilled while filling (synthetic)");
  await p.waitForTimeout(800);
  await confirm().click(); await p.waitForLoadState("networkidle"); await p.waitForTimeout(1200);
  const e2 = await lastEvent("PACK", batchId);
  assert.equal(e2.status, "HELD", `expected HELD, got ${e2.status}: ${e2.lastError}`);
  assert.match(e2.lastError, /above the approved band/);
  await p.reload(); await p.waitForLoadState("networkidle");
  await p.getByTestId(`pack-batch-${batchNo}`).getByText("Awaiting accountant").waitFor({ timeout: 8000 });
  await shot(p, "OPS-pack-held");
  // The accountant finds it in the exception queue and approves and posts the document.
  const a = acc.page;
  await a.goto(`${BASE}/dashboard/accounting/inventory/exceptions`); await a.waitForLoadState("networkidle");
  const docNo = (await one(`select "docNo" from "InvDocument" where id = $1`, [e2.documentId])).docNo;
  await a.getByRole("link", { name: `#${docNo}` }).first().click(); await a.waitForLoadState("networkidle");
  await a.getByRole("button", { name: "اعتماد" }).first().click(); await a.waitForTimeout(1200);
  await a.getByRole("button", { name: "ترحيل المستند" }).first().click(); await a.waitForTimeout(1500);
  assert.equal((await one(`select status from "InvOpsEvent" where id = $1`, [e2.id])).status, "POSTED");
  const j2 = await journal(e2.documentId);
  assert.ok(j2.some((l) => l.startsWith("5300:")), `abnormal loss booked: ${j2.join(" ")}`);
  await shot(a, "ACC-held-pack-posted");
  await p.reload(); await p.waitForLoadState("networkidle");
  await p.getByTestId(`pack-batch-${batchNo}`).getByText("In the accounts").waitFor({ timeout: 8000 });
  ok(`packing with 5.66% loss held; accountant approved and posted document #${docNo} in the browser (abnormal loss to 5300); chip back to "In the accounts"`);

  // 4. Blocked: 2 × 500 g of a SKU whose accounting item is not linked.
  await openPack(); await packRow(0, sku500.id, 2); await p.waitForTimeout(800);
  await confirm().click(); await p.waitForLoadState("networkidle"); await p.waitForTimeout(1200);
  const e3 = await lastEvent("PACK", batchId);
  assert.equal(e3.status, "BLOCKED", `${e3.status}: ${e3.lastError}`);
  assert.match(e3.lastError, /not linked to an inventory item/);
  await p.reload(); await p.waitForLoadState("networkidle");
  await p.getByTestId(`pack-batch-${batchNo}`).getByText("Accounting exception").waitFor({ timeout: 8000 });
  await shot(p, "OPS-pack-blocked");
  // The accountant holding the master-data duty links SKU-ETH-500 to the SKU in inventory setup;
  // the approver (events duty) then retries it from the queue.
  const m = prep.page;
  await m.goto(`${BASE}/dashboard/accounting/inventory/setup`); await m.waitForLoadState("networkidle");
  assert.equal(await a.goto(`${BASE}/dashboard/accounting/inventory/setup`).then(() => a.locator("tr", { hasText: "SKU-ETH-500" }).getByRole("button", { name: "ربط…" }).count()), 0, "no link action without the master-data duty");
  await m.locator("tr", { hasText: "SKU-ETH-500" }).getByRole("button", { name: "ربط…" }).click();
  const linkDlg = m.getByRole("dialog");
  await linkDlg.locator("select").first().selectOption(sku500.id);
  await linkDlg.getByRole("button", { name: "ربط", exact: true }).click(); await m.waitForTimeout(1200);
  await shot(m, "ACC-item-linked");
  assert.equal((await one(`select "productSkuId" from "InvItem" where code = 'SKU-ETH-500'`)).productSkuId, sku500.id);
  await a.goto(`${BASE}/dashboard/accounting/inventory/exceptions`); await a.waitForLoadState("networkidle");
  await a.locator("tr", { hasText: "تعبئة" }).filter({ hasText: /غير مربوط/ }).getByRole("button", { name: "إعادة المحاولة" }).first().click();
  await a.waitForTimeout(1500);
  const e3b = await one(`select status, "documentId" from "InvOpsEvent" where id = $1`, [e3.id]);
  assert.equal(e3b.status, "POSTED");
  const out3 = await one(`select l.quantity::text q, l."lotId" from "InvDocLine" l join "InvItem" i on i.id = l."itemId" where l."documentId" = $1 and l.role = 'OUTPUT' and i.code = 'SKU-ETH-500'`, [e3b.documentId]);
  assert.equal(out3.q, "2.0000");
  await shot(a, "ACC-blocked-pack-recovered");
  ok("packing of an unlinked SKU blocked; accountant linked the item in setup and retried from the queue in the browser; 2 × 500 g posted");

  // ── Dispatch form ────────────────────────────────────────────────────────────
  const dispatch = async (orderNo, lotId, qty) => {
    await p.goto(`${BASE}/dashboard/dispatch`); await p.waitForLoadState("networkidle");
    const card = p.locator("div", { hasText: `#${orderNo}` }).filter({ has: p.getByRole("button", { name: /Deliver/ }) }).last();
    await card.getByRole("button", { name: /Deliver/ }).first().click();
    const form = p.locator("form").last();
    // The lot picker loads this line's fulfilment options after the form opens.
    await form.locator(`option[value="${lotId}"]`).waitFor({ state: "attached", timeout: 15000 });
    await form.locator("select").filter({ has: p.locator(`option[value="${lotId}"]`) }).selectOption(lotId);
    await form.locator('input[type="number"]').first().fill(String(qty));
    await p.waitForTimeout(500);
    const btn = form.getByRole("button", { name: /Confirm Delivery/i });
    if (await btn.isDisabled()) return "disabled";
    await btn.click();
    await p.waitForLoadState("networkidle"); await p.waitForTimeout(1200);
    return "submitted";
  };
  const oi = await one(`select i.id from "OrderItem" i join "Order" o on o.id = i."orderId" where o."orderNumber" = 7020`);
  const delBefore = n((await one(`select count(*) c from "Delivery" where "orderItemId" = $1`, [oi.id])).c);
  // 5. Validation failure: 20 units on a line that still needs 8.
  const how = await dispatch(7020, lot1.id, 20);
  assert.equal(n((await one(`select count(*) c from "Delivery" where "orderItemId" = $1`, [oi.id])).c), delBefore, "no delivery recorded");
  assert.equal(n((await one(`select "unitsAvailable" u from "FinishedGoodsLot" where id = $1`, [lot1.id])).u), 8, "lot untouched");
  await shot(p, "OPS-dispatch-refused");
  ok(`dispatch form refuses 20 units against 8 outstanding (${how === "disabled" ? "confirm disabled" : "server refusal"}); nothing changed`);
  await p.keyboard.press("Escape").catch(() => undefined);
  // 6. Dispatch 8 × 250 g and 2 × 500 g.
  await dispatch(7020, lot1.id, 8);
  const d1 = await one(`select id from "Delivery" where "orderItemId" = $1 order by "createdAt" desc limit 1`, [oi.id]);
  const de1 = await lastEvent("DISPATCH", d1.id);
  assert.equal(de1.status, "POSTED", de1.lastError ?? "");
  const dj1 = await journal(de1.documentId);
  // The 8 units leave at the item's cost by the method the document recorded (the fixture's D-1
  // setting is a synthetic assumption): FIFO takes the first pack's layer (v1); weighted average
  // takes 8/12 of the stock value, which includes the held pack's normal loss.
  const dd1 = await one(`select d."costMethod", m."itemId", m."locationId", min(m.seq) s from "InvDocument" d join "InvMove" m on m."documentId" = d.id where d.id = $1 and m.kind = 'OUT' group by 1, 2, 3`, [de1.documentId]);
  const pre = await one(`select sum(qty)::text q, sum(value)::text v from "InvMove" where "itemId" = $1 and "locationId" = $2 and seq < $3`, [dd1.itemId, dd1.locationId, dd1.s]);
  const expectOut = dd1.costMethod === "FIFO" ? v1 : (n(pre.q) === 8 ? n(pre.v) : Math.round(n(pre.v) * 8 / n(pre.q) * 100) / 100).toFixed(2);
  assert.deepEqual(dj1, [`1174:0.00:${expectOut}`, `1176:${expectOut}:0.00`], `8 units at ${dd1.costMethod} from ${pre.q} units worth ${pre.v}`);
  assert.equal(n((await one(`select "unitsAvailable" u from "FinishedGoodsLot" where id = $1`, [lot1.id])).u), 0);
  const oi500 = await one(`select i.id from "OrderItem" i join "Order" o on o.id = i."orderId" where o."orderNumber" = 7021`);
  await dispatch(7021, out3.lotId, 2);
  const d2 = await one(`select id from "Delivery" where "orderItemId" = $1 order by "createdAt" desc limit 1`, [oi500.id]);
  assert.equal((await lastEvent("DISPATCH", d2.id)).status, "POSTED");
  await p.goto(`${BASE}/dashboard/dispatch`); await p.waitForLoadState("networkidle"); await p.waitForTimeout(800);
  await shot(p, "OPS-dispatch-posted");
  ok(`dispatch form: 8 × 250 g (Dr 1176 ${expectOut} / Cr 1174, ${dd1.costMethod} over ${n(pre.q)} units worth ${pre.v}) and 2 × 500 g posted to delivered, not invoiced`);

  for (const s of [ops, acc, prep]) assert.deepEqual(s.errors, [], "no page errors");
  for (const s of [ops, acc, prep]) await s.ctx.close();
} finally { await browser.close(); await db.end(); }
console.log(`# pass ${results.length}\n# fail 0`);
