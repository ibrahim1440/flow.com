// Stage 4b over HTTP: the operational screens' own API calls (purchase, roast, QC, pack, dispatch,
// adjustment, batch cancellation) drive the inventory accounts, with nobody re-entering quantities;
// the invoice for the dispatched order line takes its cost from the goods dispatched. Server runs as
// the restricted runtime role on the synthetic fixture (decision D-1 undecided → provisional, under
// the isolated-test switch). The operations policy approval is a SYNTHETIC TEST STEP, not a decision.
//
//   BASE_URL=http://localhost:3040 FIN_PASSWORD=... RUNTIME_DATABASE_URL=... \
//     node --test --test-concurrency=1 tests/accounting/http/ops-integration.test.mjs
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";

const BASE = process.env.BASE_URL ?? "http://localhost:3040";
if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(BASE)) throw new Error("Refusing to run against a non-local server.");
const DB_URL = process.env.RUNTIME_DATABASE_URL;
if (!DB_URL || !/@(127\.0\.0\.1|localhost):\d+\//.test(DB_URL)) throw new Error("RUNTIME_DATABASE_URL must be a local database.");
const { Client } = createRequire(import.meta.url)("pg");
let db;
before(async () => { db = new Client({ connectionString: DB_URL }); await db.connect(); });
after(async () => { await db?.end(); });

async function session(username) {
  const r = await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ method: "password", username, password: process.env.FIN_PASSWORD }) });
  assert.equal(r.status, 200, `login ${username}`);
  const cookie = r.headers.get("set-cookie").split(";")[0];
  return async (path, init = {}) => {
    const res = await fetch(`${BASE}${path}`, { ...init, headers: { cookie, "Content-Type": "application/json", ...(init.headers ?? {}) }, body: init.json ? JSON.stringify(init.json) : undefined });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
}
const one = async (sql, args = []) => (await db.query(sql, args)).rows[0];
const today = () => new Date(Date.now() + 3 * 3600_000).toISOString().slice(0, 10);
const eventOf = (kind, sourceId) => one(`select * from "InvOpsEvent" where kind = $1 and ("sourceId" = $2 or payload->>'batchId' = $2) order by "createdAt" desc limit 1`, [kind, sourceId]);
const journal = async (docId) => (await db.query(
  `select a.code, l.debit::text d, l.credit::text c from "JournalEntryLine" l join "Account" a on a.id = l."accountId" join "JournalEntry" j on j.id = l."journalEntryId"
     join "AccountingEvent" e on e.id = j."originEventId" where e."idempotencyKey" = $1 order by a.code, l.debit desc`, [`inventory:${docId}:inv.document.posted`])).rows.map((r) => `${r.code}:${Number(r.d).toFixed(2)}:${Number(r.c).toFixed(2)}`);

test("operations drive the inventory accounts: purchase → roast → QC → pack → dispatch → invoice, and the exceptions", async () => {
  const ops = await session("ops.roastery");
  const prep = await session("acc.preparer");
  const appr = await session("acc.approver");
  const viewer = await session("acc.viewer");
  const gb = await one(`select id, "quantityKg" from "GreenBean" where "serialNumber" = 'ACC-ETH-YRG-0412'`);
  const cp = await one(`select id from "CoffeeProduct" where "productNameEn" = 'Ethiopia Yirgacheffe (fixture)'`);
  const sku = await one(`select id from "ProductSKU" where "skuCode" = 'ACC-ETH-250'`);
  const supplier = await one(`select id from "Supplier" where name = 'محمصة الوادي للتوريد'`);

  // The operations user has no accounting access, and cannot reach the accounting queue.
  assert.equal((await ops("/api/accounting/inventory/ops-events")).status, 403);

  // SYNTHETIC TEST STEP: the accountant approves automatic posting of operational events.
  const pol = await one(`select id, status from "AccountingPolicy" where key = 'inventory.operations' order by version desc limit 1`);
  if (pol?.status !== "APPROVED") {
    const d = pol?.status === "DRAFT" ? { body: pol } : await prep("/api/accounting/policies", { method: "POST", json: { key: "inventory.operations" } });
    assert.equal((await prep(`/api/accounting/policies/${d.body.id}/approve`, { method: "POST" })).status, 403, "the preparer cannot approve");
    assert.equal((await appr(`/api/accounting/policies/${d.body.id}/approve`, { method: "POST" })).status, 200);
  }

  // Purchase screen → goods receipt at the recorded cost.
  const pur = await ops("/api/purchases", { method: "POST", json: { supplierId: supplier.id, itemId: gb.id, quantity: 30, costPerUnit: 31, purchaseDate: today(), notes: "fixture:accounting http" } });
  assert.equal(pur.status, 201, JSON.stringify(pur.body));
  const pe = await eventOf("PURCHASE", pur.body.purchase.id);
  assert.equal(pe.status, "POSTED", pe.lastError ?? "");
  assert.deepEqual(await journal(pe.documentId), ["1171:930.00:0.00", "2120:0.00:930.00"]);

  // Roasting screen → production; the approved synthetic overhead pool (0.50/kg out) is absorbed.
  const roast = await ops("/api/roasting-batches", { method: "POST", json: { greenBeanId: gb.id, productId: cp.id, greenBeanQuantity: 12, roastedBeanQuantity: 10.2, wasteQuantity: 1.8 } });
  assert.equal(roast.status, 201, JSON.stringify(roast.body));
  const re = await eventOf("ROAST", roast.body.id);
  assert.equal(re.status, "POSTED", re.lastError ?? "");
  const rj = await journal(re.documentId);
  assert.ok(rj.some((l) => l.startsWith("1171:0.00:")) && rj.some((l) => l.startsWith("1173:")) && rj.includes("6790:0.00:5.10"), rj.join(" "));
  const chip = await ops(`/api/inventory/accounting-status?ids=${roast.body.id}`);
  assert.deepEqual(chip.body[roast.body.id].map((e) => e.status), ["POSTED"], "the operational screen sees the accounting state");

  // QC, then the packing screen → 8 units made from 2 kg of that roast.
  const qc = await ops("/api/qc-records", { method: "POST", json: { batchId: roast.body.id, decision: "Accept", coffeeOrigin: "Ethiopia", processing: "Washed" } });
  assert.equal(qc.status, 201, JSON.stringify(qc.body));
  assert.equal((await ops(`/api/qc/${roast.body.id}/finalize`, { method: "POST", json: { outcome: "Passed" } })).status, 200);
  const pack = await ops(`/api/roasting-batches/${roast.body.id}/pack`, { method: "POST", headers: { "Idempotency-Key": randomUUID() }, json: { lines: [{ productSkuId: sku.id, packages: 8 }] } });
  assert.equal(pack.status, 201, JSON.stringify(pack.body));
  const ke = await eventOf("PACK", roast.body.id);
  assert.equal(ke.status, "POSTED", ke.lastError ?? "");
  const kd = await one(`select l.quantity::text q, l."lotId" from "InvDocLine" l where l."documentId" = $1 and l.role = 'OUTPUT'`, [ke.documentId]);
  assert.deepEqual([kd.q, kd.lotId], ["8.0000", pack.body.lots[0].id], "whole units, traced to the packed lot");

  // Dispatch screen → goods leave for the customer at cost ("delivered, not invoiced").
  const oi = await one(`select i.id from "OrderItem" i join "Order" o on o.id = i."orderId" where o."orderNumber" = 7020`);
  const del = await ops("/api/deliveries", { method: "POST", headers: { "Idempotency-Key": randomUUID() }, json: { orderItemId: oi.id, finishedGoodsLotId: pack.body.lots[0].id, quantityUnits: 8, deliveryType: "full" } });
  assert.equal(del.status, 201, JSON.stringify(del.body));
  const de = await eventOf("DISPATCH", del.body.id);
  assert.equal(de.status, "POSTED", de.lastError ?? "");
  const dj = await journal(de.documentId);
  const dispatched = dj.find((l) => l.startsWith("1176:")).split(":")[1];
  assert.deepEqual(dj, [`1174:0.00:${dispatched}`, `1176:${dispatched}:0.00`]);

  // The invoice for that order line (from the order, as the invoice editor builds it) takes that cost.
  const draft = await prep(`/api/accounting/receivables/from-order/${await one(`select id from "Order" where "orderNumber" = 7020`).then((r) => r.id)}`);
  assert.equal(draft.status, 200, JSON.stringify(draft.body));
  const vat = await one(`select id from "TaxCategory" where "isDefault" limit 1`);
  const lines = draft.body.lines.map(({ priceSource, ...l }) => (void priceSource, { ...l, unitPrice: "25", taxCategoryId: vat.id }));
  const customerId = draft.body.order.customerId;
  const inv = await prep("/api/accounting/receivables/invoices", { method: "POST", json: { customerId, orderId: draft.body.order.id, issueDate: today(), lines } });
  assert.equal(inv.status, 201, JSON.stringify(inv.body));
  for (const [who, step] of [[prep, "submit"], [appr, "approve"], [appr, "post"]]) assert.equal((await who(`/api/accounting/receivables/invoices/${inv.body.id}/${step}`, { method: "POST" })).status, 200, step);
  const cost = await one(`select status, "lastError" from "InvCosting" where "invoiceId" = $1`, [inv.body.id]);
  assert.equal(cost.status, "COSTED", cost.lastError ?? "");
  const issue = await one(`select id from "InvDocument" where type = 'SALE_ISSUE' and "salesInvoiceId" = $1`, [inv.body.id]);
  assert.deepEqual(await journal(issue.id), [`1176:0.00:${dispatched}`, `5100:${dispatched}:0.00`]);

  // A price credit on that invoice (no goods back) and a supplier price reduction on the purchase:
  // the stage 4b fields travel through the HTTP parsers.
  const cn = await prep("/api/accounting/receivables/invoices", { method: "POST", json: { kind: "CREDIT_NOTE", originalInvoiceId: inv.body.id, creditType: "PRICE_ADJUSTMENT", customerId, issueDate: today(), reason: "خصم تعويضي عن تأخر التسليم", lines: [{ description: "خصم", quantity: "1", unitPrice: "5", taxCategoryId: vat.id }] } });
  assert.equal(cn.status, 201, JSON.stringify(cn.body));
  assert.equal((await one(`select "creditType"::text t from "SalesInvoice" where id = $1`, [cn.body.id])).t, "PRICE_ADJUSTMENT");
  const noType = await prep("/api/accounting/receivables/invoices", { method: "POST", json: { kind: "CREDIT_NOTE", originalInvoiceId: inv.body.id, customerId, issueDate: today(), reason: "بلا نوع", lines: [{ description: "x", quantity: "1", unitPrice: "1", taxCategoryId: vat.id }] } });
  assert.equal(noType.status, 400, "a credit note says what it is for");
  const rcptLine = await one(`select id from "InvDocLine" where "documentId" = $1`, [pe.documentId]);
  const bill = await one(`select id from "SupplierBill" where "supplierId" = $1 and status = 'POSTED' and kind = 'BILL' limit 1`, [supplier.id]);
  const scn = await prep("/api/accounting/bills", { method: "POST", json: { kind: "CREDIT_NOTE", originalBillId: bill.id, reason: "خصم سعر على شحنة البن", supplierId: supplier.id, supplierInvoiceNo: `CN-HTTP-${Date.now()}`, billDate: today(),
    lines: [{ kind: "STOCK_PRICE_ADJUSTMENT", description: "خصم 0.50 للكيلو", quantity: "30", unitPrice: "0.5", taxCategoryId: vat.id, invDocLineId: rcptLine.id }] } });
  assert.equal(scn.status, 201, JSON.stringify(scn.body));
  const scnRow = await one(`select b.kind::text k, l.kind::text lk, l."invDocLineId" from "SupplierBill" b join "SupplierBillLine" l on l."billId" = b.id where b.id = $1`, [scn.body.id]);
  assert.deepEqual([scnRow.k, scnRow.lk, scnRow.invDocLineId], ["CREDIT_NOTE", "STOCK_PRICE_ADJUSTMENT", rcptLine.id]);

  // Count screen → an adjustment; a cancelled batch with restock → reversed at the green cost.
  const adj = await ops("/api/inventory/adjust", { method: "POST", json: { entityId: gb.id, newActualQuantity: Number(gb.quantityKg) + 30 - 12 - 0.5, notes: "جرد أسبوعي — نقص نصف كيلو" } });
  assert.equal(adj.status, 201, JSON.stringify(adj.body));
  const ae = await one(`select * from "InvOpsEvent" where kind = 'ADJUST' and payload->>'greenBeanId' = $1 order by "createdAt" desc limit 1`, [gb.id]);
  assert.equal(ae.status, "POSTED", ae.lastError ?? "");
  const r2 = await ops("/api/roasting-batches", { method: "POST", json: { greenBeanId: gb.id, productId: cp.id, greenBeanQuantity: 5, roastedBeanQuantity: 4.3, wasteQuantity: 0.7 } });
  assert.equal(r2.status, 201);
  assert.equal((await ops(`/api/roasting-batches/${r2.body.id}?restock=true`, { method: "DELETE" })).status, 200);
  const ce = await eventOf("ROAST_CANCEL", r2.body.id);
  assert.equal(ce.status, "POSTED", ce.lastError ?? "");

  // The accountant's queue: the exceptions the fixture left are there, with reasons; the viewer can read, not act.
  const q = await viewer("/api/accounting/inventory/ops-events?status=BLOCKED,HELD,FAILED");
  assert.equal(q.status, 200);
  assert.ok(q.body.rows.some((r) => r.kind === "UNINTEGRATED" && /without an accounting integration record/.test(r.lastError)));
  assert.equal((await viewer(`/api/accounting/inventory/ops-events/${q.body.rows[0].id}/retry`, { method: "POST" })).status, 403);
  const rec = await viewer("/api/accounting/inventory/reports/ops-reconciliation");
  assert.equal(rec.status, 200);
  assert.ok(rec.body.rows.some((r) => r.code === "GRN-ETH"));
});
