// H2A — DESTRUCTIVE PATHS, AUTHORIZATION AND AUDIT INTEGRITY.
//
// Five defects the Go-Live audit found, and one it could only suspect.
//
// ── A guard that could never fire ───────────────────────────────────────────
// Deleting a green coffee waited for a foreign-key error to protect roasting history. No
// such error exists: every reference to GreenBean is ON DELETE SET NULL or CASCADE, and two
// more are untyped strings with no constraint at all. The delete always succeeded and every
// batch roasted from that coffee quietly lost the record of what it was roasted from.
//
// ── Privilege mistaken for authorization ────────────────────────────────────
// `excess > 0 && user.role !== "admin"` let an administrator roast past the calculated
// ceiling in silence — no flag, no reason, nothing written down. Being allowed to do a thing
// is not the same as saying you meant to.
//
// ── A viewer who could write ────────────────────────────────────────────────
// Appending to an order's timeline was gated on module access, which "view" satisfies.
//
// ── A shape the system had decided to stop creating ─────────────────────────
// Order creation refuses a line without a SKU. The edit path could still make one, because
// omitting productSkuId reads as a legacy line rather than as an omission.
//
// ── An unexplained correction ───────────────────────────────────────────────
// A manual stock adjustment is the one movement with no document behind it, so the reason is
// the document. It was optional.
//
// ── And the suspicion: delivery retries ─────────────────────────────────────
// Section G does not fix anything. It measures what a retried dispatch actually does, so the
// idempotency decision is taken on evidence rather than on the comfort of knowing that a
// delivery cannot exceed the ordered quantity. Bounded damage is not idempotency.
import {
  ADMIN_PIN, db, api, check, issue, section, sub, one, all, num, near, invariants, loginAs,
  results, ensureUser, Client, DB_URL, BASE, getCookie, freshIdempotencyKey,
} from "./harness.mjs";
import { buildCatalog, teardown, roastAndPass } from "./catalog.mjs";

const S = (v) => { try { return JSON.stringify(v) ?? String(v); } catch { return String(v); } };
const P = "H2A";
let C;

const ROASTER_PIN = "770061";  // production, no admin role
const VIEWER_PIN  = "770062";  // orders: view only
const EDITOR_PIN  = "770063";  // orders: edit
const TEMPADM_PIN = "770064";  // starts admin, demoted mid-test

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function raw(path, { cookie, method = "GET", body } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "manual",
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, json, text };
}

const topUpGreen = (beanId, kg) =>
  db.query('UPDATE "GreenBean" SET "quantityKg" = "quantityKg" + $2 WHERE id=$1', [beanId, kg]);

/** An approved, preparation-reviewed order with one SKU line. */
async function skuOrder(note, sku, units) {
  const r = await api("/api/orders", {
    method: "POST",
    body: { customerId: C.customers.cafe.id, notes: `${P} ${note}`,
            items: [{ productSkuId: sku.id, quantityUnits: units }] },
  });
  if (r.status !== 201) throw new Error(`order create failed: ${S(r.json)}`);
  await api(`/api/orders/${r.json.id}/approve`, { method: "POST", body: { decision: "Yes" } });
  await api(`/api/orders/${r.json.id}/preparation-review`, {
    method: "POST", body: { items: r.json.items.map((i) => ({ orderItemId: i.id })) },
  });
  return { id: r.json.id, itemId: r.json.items[0].id, sku };
}

/** A green coffee created through the API, so nothing else points at it. */
async function freshBean(label, kg) {
  const r = await api("/api/green-beans", {
    method: "POST",
    body: { serialNumber: `${P}-${label}`, beanType: `${P} ${label}`, country: "Testland", quantityKg: kg },
  });
  if (r.status !== 201) throw new Error(`bean create failed: ${S(r.json)}`);
  return r.json;
}

const beanExists = async (id) =>
  (await one('SELECT id FROM "GreenBean" WHERE id=$1', [id])) !== undefined;

const overrideActivities = (orderId) => all(
  `SELECT id, "authorId", "authorName", metadata FROM "OrderActivity"
    WHERE "orderId"=$1 AND type='PRODUCTION_SURPLUS_OVERRIDDEN' ORDER BY "createdAt"`, [orderId]);

const auditRows = (action, targetId) => all(
  `SELECT "userId", action, result, metadata, "occurredAt" FROM "AuthAuditLog"
    WHERE action=$1 AND metadata->>'targetEmployeeId'=$2 ORDER BY "occurredAt"`, [action, targetId]);

async function main() {
  await db.connect();
  await teardown(P);
  await db.query(`DELETE FROM "Employee" WHERE id LIKE '${P}\\_%'`);
  await db.query(`DELETE FROM "AuthAuditLog" WHERE metadata->>'targetEmployeeId' LIKE '${P}\\_%'`);
  // The catalog is built through the API, so the session has to exist first.
  await loginAs(ADMIN_PIN);
  C = await buildCatalog(P);

  // The catalog builds no suppliers, and a green-coffee receipt needs one.
  const supplierRes = await api("/api/suppliers", {
    method: "POST", body: { name: `${P} Supplier`, contact: "n/a" },
  });
  if (supplierRes.status !== 201) throw new Error(`supplier create failed: ${S(supplierRes.json)}`);
  const SUPPLIER_ID = supplierRes.json.id;

  await ensureUser(`${P}_emp_roaster`, `${P} Roaster`, "production", {
    dashboard: { access: "edit" },
    orders: { access: "view" },
    inventory: { access: "edit", sub: { receive: true, adjust: true } },
    production: { access: "edit", sub: { start_batch: true, blend: true, cancel_batch: true } },
  }, ROASTER_PIN);
  await ensureUser(`${P}_emp_viewer`, `${P} Viewer`, "custom", {
    dashboard: { access: "edit" },
    orders: { access: "view", sub: { create: false, edit: false } },
  }, VIEWER_PIN);
  await ensureUser(`${P}_emp_editor`, `${P} Editor`, "custom", {
    dashboard: { access: "edit" },
    orders: { access: "edit", sub: { create: true, edit: true } },
  }, EDITOR_PIN);
  await ensureUser(`${P}_emp_tempadm`, `${P} Temp Admin`, "admin", {
    dashboard: { access: "edit" },
    orders: { access: "edit", sub: { create: true, edit: true } },
    production: { access: "edit", sub: { start_batch: true } },
  }, TEMPADM_PIN);

  await loginAs(ADMIN_PIN);

  // ═══════════════════════════════════════════════════════════════════════
  section("A — GREEN COFFEE CANNOT BE DELETED OUT FROM UNDER ITS HISTORY");

  sub("A1. a coffee nothing refers to is still deletable");
  // Zero opening stock on purpose: a bean entered by mistake, before anything was received
  // against it. Creating one WITH stock writes a receipt into the ledger, and that receipt is
  // itself history — which is why the next case refuses.
  const beanA = await freshBean("UNUSED", 0);
  const delA = await api(`/api/green-beans/${beanA.id}`, { method: "DELETE" });
  console.log(`    delete an unused coffee -> ${delA.status}`);
  check("the delete is accepted", delA.status === 200, `status=${delA.status} ${S(delA.json).slice(0, 90)}`);
  check("and the row is gone", !(await beanExists(beanA.id)), "bean survives");

  sub("A2. a coffee something was roasted from is refused");
  const beanB = await freshBean("ROASTED", 20);
  const rbB = await api("/api/roasting-batches", {
    method: "POST",
    body: { greenBeanId: beanB.id, productId: C.coffees.brazil.id,
            greenBeanQuantity: 6, roastedBeanQuantity: 5, wasteQuantity: 1 },
  });
  check("a roast against it is accepted", rbB.status === 201, `status=${rbB.status} ${S(rbB.json).slice(0, 100)}`);
  await db.query('UPDATE "RoastingBatch" SET "batchNumber"=$2 WHERE id=$1', [rbB.json.id, `${P}-A2`]);

  const delB = await api(`/api/green-beans/${beanB.id}`, { method: "DELETE" });
  const batchB = await one('SELECT "greenBeanId" g FROM "RoastingBatch" WHERE id=$1', [rbB.json.id]);
  console.log(`    delete a roasted-from coffee -> ${delB.status} ${S(delB.json).slice(0, 110)}`);
  check("refused with 409", delB.status === 409, `status=${delB.status}`);
  check("the coffee survives", await beanExists(beanB.id), "bean deleted");
  check("and the batch still knows what it was roasted from", batchB?.g === beanB.id,
    `greenBeanId=${S(batchB?.g)}`);
  check("the refusal names no foreign key and no Prisma error",
    !/fkey|constraint|P200|prisma/i.test(S(delB.json)), S(delB.json).slice(0, 120));

  sub("A3. a coffee with only ledger history is refused too");
  const beanC = await freshBean("LEDGER", 10);
  const adjC = await api("/api/inventory/adjust", {
    method: "POST",
    body: { entityId: beanC.id, newActualQuantity: 8, notes: `${P} opening stock count` },
  });
  check("an adjustment is booked against it", adjC.status === 201,
    `status=${adjC.status} ${S(adjC.json).slice(0, 90)}`);
  const delC = await api(`/api/green-beans/${beanC.id}`, { method: "DELETE" });
  console.log(`    delete a coffee with ledger rows -> ${delC.status}`);
  check("refused with 409", delC.status === 409, `status=${delC.status}`);
  check("the movement still points at a coffee that exists", await beanExists(beanC.id), "bean deleted");

  sub("A4. a delete racing a roast cannot strand the roast's provenance");
  const beanD = await freshBean("RACE", 30);
  const hold = new Client({ connectionString: DB_URL });
  await hold.connect();
  await hold.query("BEGIN");
  await hold.query('SELECT id FROM "GreenBean" WHERE id=$1 FOR UPDATE', [beanD.id]);

  // The roast queues on the green-stock decrement; the delete queues on the same row.
  const roastD = api("/api/roasting-batches", {
    method: "POST",
    body: { greenBeanId: beanD.id, productId: C.coffees.brazil.id,
            greenBeanQuantity: 8, roastedBeanQuantity: 7, wasteQuantity: 1 },
  });
  await sleep(1200);
  const deleteD = api(`/api/green-beans/${beanD.id}`, { method: "DELETE" });
  await sleep(1200);
  await hold.query("ROLLBACK");
  await hold.end();
  const [roastRes, deleteRes] = await Promise.all([roastD, deleteD]);

  const strayD = await one(
    `SELECT COUNT(*)::int n FROM "RoastingBatch"
      WHERE "greenBeanId" IS NULL AND "productId"=$1 AND "createdAt" > now() - interval '5 minutes'`,
    [C.coffees.brazil.id]);
  const beanStillThere = await beanExists(beanD.id);
  console.log(`    roast=${roastRes.status} delete=${deleteRes.status}; bean present=${beanStillThere}`);
  check("neither returned a server error",
    roastRes.status !== 500 && deleteRes.status !== 500, `${roastRes.status}/${deleteRes.status}`);
  check("neither deadlocked",
    !/deadlock|40P01/i.test(S(roastRes.json) + S(deleteRes.json)),
    (S(roastRes.json) + S(deleteRes.json)).slice(0, 130));
  check("they did not both succeed",
    !(roastRes.status === 201 && deleteRes.status === 200),
    `roast=${roastRes.status} delete=${deleteRes.status}`);
  check("no batch was left without the coffee it was roasted from", num(strayD.n) === 0,
    `${strayD.n} batches with a null green bean`);
  if (roastRes.status === 201) {
    await db.query('UPDATE "RoastingBatch" SET "batchNumber"=$2 WHERE id=$1', [roastRes.json.id, `${P}-A4`]);
    const provenance = await one('SELECT "greenBeanId" g FROM "RoastingBatch" WHERE id=$1', [roastRes.json.id]);
    check("the roast that won keeps its provenance", provenance?.g === beanD.id, `greenBeanId=${S(provenance?.g)}`);
  }

  sub("A5. a delete racing a purchase receipt cannot strand a loose reference");
  // The dangerous case is NOT the roast: RoastingBatch.greenBeanId is a real foreign key, so
  // its insert takes FOR KEY SHARE on the coffee and the delete's FOR UPDATE already blocks
  // it. PurchaseRecord.itemId and InventoryMovement.referenceEntityId are untyped strings
  // with no constraint at all — nothing in the database stops one naming a coffee that is
  // being deleted. The receipt path must therefore take the parent row itself.
  const beanE2 = await freshBean("RECEIPT", 0);
  const holdE = new Client({ connectionString: DB_URL });
  await holdE.connect();
  await holdE.query("BEGIN");
  await holdE.query('SELECT id FROM "GreenBean" WHERE id=$1 FOR UPDATE', [beanE2.id]);

  const receiptE = api("/api/purchases", {
    method: "POST",
    body: { supplierId: SUPPLIER_ID, type: "GREEN_BEAN", itemId: beanE2.id,
            quantity: 25, costPerUnit: 12, purchaseDate: new Date().toISOString(),
            notes: `${P} receipt race` },
  });
  await sleep(1200);
  const deleteE = api(`/api/green-beans/${beanE2.id}`, { method: "DELETE" });
  await sleep(1200);
  await holdE.query("ROLLBACK");
  await holdE.end();
  const [receiptRes, deleteRes2] = await Promise.all([receiptE, deleteE]);

  const beanE2Present = await beanExists(beanE2.id);
  const loosePurchases = num((await one(
    `SELECT COUNT(*)::int n FROM "PurchaseRecord" WHERE "itemId"=$1`, [beanE2.id])).n);
  const looseMovements = num((await one(
    `SELECT COUNT(*)::int n FROM "InventoryMovement" WHERE "referenceEntityId"=$1`, [beanE2.id])).n);
  console.log(`    receipt=${receiptRes.status} delete=${deleteRes2.status};` +
              ` bean present=${beanE2Present}, purchases=${loosePurchases}, movements=${looseMovements}`);
  check("neither returned a server error",
    receiptRes.status !== 500 && deleteRes2.status !== 500, `${receiptRes.status}/${deleteRes2.status}`);
  check("neither deadlocked",
    !/deadlock|40P01/i.test(S(receiptRes.json) + S(deleteRes2.json)),
    (S(receiptRes.json) + S(deleteRes2.json)).slice(0, 130));
  check("they did not both succeed",
    !(receiptRes.status === 201 && deleteRes2.status === 200),
    `receipt=${receiptRes.status} delete=${deleteRes2.status}`);
  // The invariant, stated both ways round so neither ordering can hide a dangling row.
  check("a receipt that committed left the coffee alive to explain it",
    receiptRes.status !== 201 || beanE2Present, "receipt committed but the coffee is gone");
  check("a delete that committed left no purchase behind it",
    deleteRes2.status !== 200 || loosePurchases === 0, `${loosePurchases} dangling purchases`);
  check("and no ledger row behind it",
    deleteRes2.status !== 200 || looseMovements === 0, `${looseMovements} dangling movements`);

  sub("A6. no dangling loose reference exists anywhere in the database");
  const danglingPurchases = num((await one(
    `SELECT COUNT(*)::int n FROM "PurchaseRecord" p
      WHERE p.type = 'GREEN_BEAN' AND p."itemId" IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM "GreenBean" g WHERE g.id = p."itemId")`)).n);
  const danglingMovements = num((await one(
    `SELECT COUNT(*)::int n FROM "InventoryMovement" m
      WHERE m.category = 'RAW_MATERIAL' AND m."referenceEntityId" IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM "GreenBean" g WHERE g.id = m."referenceEntityId")`)).n);
  const orphanProvenance = num((await one(
    `SELECT COUNT(*)::int n FROM "RoastingBatch"
      WHERE "greenBeanId" IS NULL AND NOT "isBlend" AND "createdAt" > now() - interval '20 minutes'`)).n);
  console.log(`    dangling purchases=${danglingPurchases}, movements=${danglingMovements},` +
              ` nulled provenance=${orphanProvenance}`);
  check("no purchase names a coffee that does not exist", danglingPurchases === 0,
    `${danglingPurchases} rows`);
  check("no stock movement names one either", danglingMovements === 0, `${danglingMovements} rows`);
  check("and no roast lost its provenance during this suite", orphanProvenance === 0,
    `${orphanProvenance} batches`);

  // ═══════════════════════════════════════════════════════════════════════
  section("B — SURPLUS PRODUCTION IS AUTHORIZED EXPLICITLY, AND RECORDED");

  const skuB = C.skus.eth250;                       // 250 g — a 4-unit line is 1.0 kg
  const REASON = "Drum minimum is 3kg; remainder to shelf";

  const overRoast = (itemId, extra = {}) => ({
    orderItemId: itemId, greenBeanId: C.beans.ethiopia.id,
    greenBeanQuantity: 5, roastedBeanQuantity: 3, wasteQuantity: 2, ...extra,
  });

  sub("B1. a non-admin over the ceiling is refused");
  const oB1 = await skuOrder("surplus non-admin", skuB, 4);
  await topUpGreen(C.beans.ethiopia.id, 20);
  await loginAs(ROASTER_PIN);
  const b1 = await api("/api/roasting-batches", { method: "POST", body: overRoast(oB1.itemId) });
  console.log(`    non-admin over ceiling -> ${b1.status} ${S(b1.json).slice(0, 110)}`);
  check("refused", b1.status === 422 || b1.status === 403, `status=${b1.status}`);
  check("and told that only an admin may authorize it", /admin/i.test(S(b1.json)), S(b1.json).slice(0, 110));

  sub("B2. an admin over the ceiling, without asking, is refused too");
  await loginAs(ADMIN_PIN);
  const b2 = await api("/api/roasting-batches", { method: "POST", body: overRoast(oB1.itemId) });
  console.log(`    admin, no override flag -> ${b2.status} ${S(b2.json).slice(0, 130)}`);
  check("refused", b2.status === 422, `status=${b2.status}`);
  check("and told what the request must carry", /surplusOverride/.test(S(b2.json)), S(b2.json).slice(0, 130));
  check("nothing was roasted",
    num((await one(`SELECT COUNT(*)::int n FROM "RoastingBatch" WHERE "orderItemId"=$1`, [oB1.itemId])).n) === 0,
    "a batch exists");

  sub("B3. asking without a reason is refused");
  const b3a = await api("/api/roasting-batches", {
    method: "POST", body: overRoast(oB1.itemId, { surplusOverride: true }),
  });
  const b3b = await api("/api/roasting-batches", {
    method: "POST", body: overRoast(oB1.itemId, { surplusOverride: true, surplusReason: "   " }),
  });
  const b3c = await api("/api/roasting-batches", {
    method: "POST", body: overRoast(oB1.itemId, { surplusOverride: true, surplusReason: "ok" }),
  });
  console.log(`    no reason=${b3a.status}, blank=${b3b.status}, too short=${b3c.status}`);
  check("a missing reason is refused", b3a.status === 400, `status=${b3a.status}`);
  check("a whitespace-only reason is refused", b3b.status === 400, `status=${b3b.status}`);
  check("a token reason is refused", b3c.status === 400, `status=${b3c.status}`);
  check("still nothing roasted",
    num((await one(`SELECT COUNT(*)::int n FROM "RoastingBatch" WHERE "orderItemId"=$1`, [oB1.itemId])).n) === 0,
    "a batch exists");

  sub("B4. an admin who asks explicitly, with a reason, may proceed");
  const b4 = await api("/api/roasting-batches", {
    method: "POST", body: overRoast(oB1.itemId, { surplusOverride: true, surplusReason: REASON }),
  });
  console.log(`    admin + override + reason -> ${b4.status}`);
  check("accepted", b4.status === 201, `status=${b4.status} ${S(b4.json).slice(0, 120)}`);
  if (b4.status === 201) {
    await db.query('UPDATE "RoastingBatch" SET "batchNumber"=$2 WHERE id=$1', [b4.json.id, `${P}-B4`]);
  }

  sub("B5. the override is recorded exactly once, with the numbers that justified it");
  const actsB = await overrideActivities(oB1.id);
  const meta = actsB[0]?.metadata ?? {};
  console.log(`    ${actsB.length} override activity row(s); metadata=${S(meta).slice(0, 150)}`);
  check("exactly one override event exists", actsB.length === 1, `${actsB.length} rows`);
  check("it names the actor", !!actsB[0]?.authorId && !!actsB[0]?.authorName, S(actsB[0]).slice(0, 90));
  check("it records the ceiling", near(num(meta.ceilingKg), 1.0), `ceilingKg=${S(meta.ceilingKg)}`);
  check("it records what was requested", near(num(meta.requestedKg), 3), `requestedKg=${S(meta.requestedKg)}`);
  check("it records the excess", near(num(meta.excessKg), 2), `excessKg=${S(meta.excessKg)}`);
  check("it records the reason", meta.reason === REASON, S(meta.reason));
  check("and it identifies the batch and the line",
    meta.batchId === b4.json?.id && meta.orderItemId === oB1.itemId, S(meta).slice(0, 120));

  sub("B6. the green-stock ledger row carries the same explanation");
  const movB = await one(
    `SELECT notes FROM "InventoryMovement" WHERE "sourceDocId"=$1 AND "sourceDocType"='ROASTING_BATCH'`,
    [b4.json?.id ?? ""]);
  console.log(`    movement note: ${S(movB?.notes).slice(0, 120)}`);
  check("the movement explains the larger draw",
    typeof movB?.notes === "string" && movB.notes.includes(REASON), S(movB?.notes).slice(0, 120));

  sub("B7. a roast that fails leaves no record of an override that never happened");
  const oB7 = await skuOrder("surplus rollback", skuB, 4);
  const before7 = (await overrideActivities(oB7.id)).length;
  const b7 = await api("/api/roasting-batches", {
    method: "POST",
    body: { orderItemId: oB7.itemId, greenBeanId: C.beans.ethiopia.id,
            greenBeanQuantity: 999999, roastedBeanQuantity: 3, wasteQuantity: 2,
            surplusOverride: true, surplusReason: REASON },
  });
  const after7 = (await overrideActivities(oB7.id)).length;
  console.log(`    roast with impossible green draw -> ${b7.status}; override rows ${before7} -> ${after7}`);
  check("the roast is refused", b7.status >= 400 && b7.status < 500, `status=${b7.status}`);
  check("and no override event was written", after7 === before7, `${before7} -> ${after7}`);
  check("no batch survives the rollback",
    num((await one(`SELECT COUNT(*)::int n FROM "RoastingBatch" WHERE "orderItemId"=$1`, [oB7.itemId])).n) === 0,
    "a batch exists");

  sub("B8. an ordinary roast inside the ceiling records no override");
  const oB8 = await skuOrder("within ceiling", skuB, 20);   // 5.0 kg of demand
  const b8 = await api("/api/roasting-batches", {
    method: "POST",
    body: { orderItemId: oB8.itemId, greenBeanId: C.beans.ethiopia.id,
            greenBeanQuantity: 4, roastedBeanQuantity: 3, wasteQuantity: 1 },
  });
  check("the roast is accepted", b8.status === 201, `status=${b8.status} ${S(b8.json).slice(0, 110)}`);
  if (b8.status === 201) {
    await db.query('UPDATE "RoastingBatch" SET "batchNumber"=$2 WHERE id=$1', [b8.json.id, `${P}-B8`]);
  }
  check("and writes no override event", (await overrideActivities(oB8.id)).length === 0, "an override was recorded");
  const movB8 = await one(
    `SELECT notes FROM "InventoryMovement" WHERE "sourceDocId"=$1 AND "sourceDocType"='ROASTING_BATCH'`,
    [b8.json?.id ?? ""]);
  check("its ledger row carries no surplus note", movB8?.notes === null, S(movB8?.notes));

  sub("B9. an admin demoted in the database cannot override with the token they still hold");
  const oB9 = await skuOrder("demoted admin", skuB, 4);
  await loginAs(TEMPADM_PIN);
  const tempCookie = getCookie();
  await db.query('UPDATE "Employee" SET role=$2 WHERE id=$1', [`${P}_emp_tempadm`, "production"]);
  const b9 = await raw("/api/roasting-batches", {
    cookie: tempCookie, method: "POST",
    body: overRoast(oB9.itemId, { surplusOverride: true, surplusReason: REASON }),
  });
  console.log(`    demoted admin, same token -> ${b9.status} ${S(b9.json).slice(0, 110)}`);
  check("the override is refused", b9.status === 403 || b9.status === 422, `status=${b9.status}`);
  check("no batch was created",
    num((await one(`SELECT COUNT(*)::int n FROM "RoastingBatch" WHERE "orderItemId"=$1`, [oB9.itemId])).n) === 0,
    "a batch exists");
  check("and no override was recorded", (await overrideActivities(oB9.id)).length === 0, "an override was recorded");
  await db.query('UPDATE "Employee" SET role=$2 WHERE id=$1', [`${P}_emp_tempadm`, "admin"]);

  // ═══════════════════════════════════════════════════════════════════════
  section("C — A VIEWER MAY READ AN ORDER AND MAY NOT WRITE TO IT");

  await loginAs(ADMIN_PIN);
  const oC = await skuOrder("authorization", C.skus.bra250, 4);

  sub("C1. read access still works");
  await loginAs(VIEWER_PIN);
  const viewerCookie = getCookie();
  // The activities route exposes no GET — the timeline is read through the order itself —
  // so read access is proved where it actually lives.
  const readC = await raw("/api/orders", { cookie: viewerCookie });
  check("a viewer can read orders", readC.status === 200, `status=${readC.status}`);

  sub("C2. writing to the timeline is refused");
  const noteC = await raw(`/api/orders/${oC.id}/activities`, {
    cookie: viewerCookie, method: "POST",
    body: { department: "Sales", message: `${P} viewer should not be able to write this` },
  });
  const viewerNotes = await one(
    `SELECT COUNT(*)::int n FROM "OrderActivity" WHERE "orderId"=$1 AND message LIKE '${P}%'`, [oC.id]);
  console.log(`    viewer POST activity -> ${noteC.status}`);
  check("refused with 403", noteC.status === 403, `status=${noteC.status} ${S(noteC.json).slice(0, 90)}`);
  check("and nothing was written", num(viewerNotes.n) === 0, `${viewerNotes.n} notes`);

  sub("C3. the read-only fulfilment preview stays available and writes nothing");
  const allocBefore = num((await one(`SELECT COUNT(*)::int n FROM "StockAllocation"`)).n);
  const previewC = await raw("/api/orders/fulfillment-preview", {
    cookie: viewerCookie, method: "POST",
    body: { lines: [{ productSkuId: C.skus.bra250.id, quantityUnits: 2 }] },
  });
  const allocAfter = num((await one(`SELECT COUNT(*)::int n FROM "StockAllocation"`)).n);
  console.log(`    viewer preview -> ${previewC.status}; allocations ${allocBefore} -> ${allocAfter}`);
  check("a viewer may still preview fulfilment", previewC.status === 200, `status=${previewC.status}`);
  check("and the preview reserved nothing", allocAfter === allocBefore, `${allocBefore} -> ${allocAfter}`);

  sub("C4. an editor retains the behaviour a viewer lost");
  await loginAs(EDITOR_PIN);
  const noteE = await raw(`/api/orders/${oC.id}/activities`, {
    cookie: getCookie(), method: "POST",
    body: { department: "Sales", message: `${P} editor note` },
  });
  check("an editor can write a note", noteE.status === 201 || noteE.status === 200,
    `status=${noteE.status} ${S(noteE.json).slice(0, 90)}`);

  // ═══════════════════════════════════════════════════════════════════════
  section("D — A FINISHED-PRODUCT LINE IS NOT EDITED BACK INTO A BULK LINE");

  await loginAs(ADMIN_PIN);

  sub("D1. a pristine SKU line cannot drop its product");
  const oD = await skuOrder("downgrade pristine", C.skus.bra1kg, 3);
  const downD = await api(`/api/orders/${oD.id}`, {
    method: "PUT",
    body: { items: [{ id: oD.itemId, beanTypeName: `${P} bulk`, quantityKg: 3 }] },
  });
  const rowD = await one(
    `SELECT "productSkuId" sku, "quantityUnits" u, "quantityKg" kg FROM "OrderItem" WHERE id=$1`, [oD.itemId]);
  console.log(`    drop productSkuId on a pristine line -> ${downD.status} ${S(downD.json).slice(0, 110)}`);
  check("refused", downD.status === 409 || downD.status === 400, `status=${downD.status}`);
  check("the line keeps its product", rowD?.sku === C.skus.bra1kg.id, `productSkuId=${S(rowD?.sku)}`);
  check("and keeps its unit axis", num(rowD?.u) === 3, `quantityUnits=${S(rowD?.u)}`);

  sub("D2. a SKU line with history cannot either");
  const batchD = await roastAndPass(P, C.coffees.indonesia, C.beans.indonesia, 6, 5, 1, "D2");
  if (!batchD.id) throw new Error(`fixture roast failed: ${S(batchD.error?.json ?? batchD)}`);
  await api(`/api/roasting-batches/${batchD.id}/pack-sku`, {
    method: "POST", body: { productSkuId: C.skus.idn250.id, units: 8 },
  });
  const oD2 = await skuOrder("downgrade with history", C.skus.idn250, 8);
  const reservedD2 = num((await one(
    `SELECT COALESCE(SUM("quantityUnits"),0)::int n FROM "StockAllocation"
      WHERE "orderItemId"=$1 AND status='RESERVED'`, [oD2.itemId])).n);
  const downD2 = await api(`/api/orders/${oD2.id}`, {
    method: "PUT",
    body: { items: [{ id: oD2.itemId, beanTypeName: `${P} bulk`, quantityKg: 2 }] },
  });
  console.log(`    line with ${reservedD2} units reserved -> ${downD2.status}`);
  check("the fixture line holds stock", reservedD2 > 0, `${reservedD2} units`);
  check("refused", downD2.status === 409 || downD2.status === 400, `status=${downD2.status}`);

  sub("D3. changing to a different SKU still follows the R2.6 rule");
  const swapPristine = await api(`/api/orders/${oD.id}`, {
    method: "PUT",
    body: { items: [{ id: oD.itemId, beanTypeName: `${P} swap`, productSkuId: C.skus.bra250.id, quantityUnits: 3 }] },
  });
  const swapWithHistory = await api(`/api/orders/${oD2.id}`, {
    method: "PUT",
    body: { items: [{ id: oD2.itemId, beanTypeName: `${P} swap`, productSkuId: C.skus.bra250.id, quantityUnits: 8 }] },
  });
  console.log(`    swap SKU: pristine=${swapPristine.status}, with history=${swapWithHistory.status}`);
  check("a pristine line may still change product", swapPristine.status === 200, `status=${swapPristine.status}`);
  check("a line with history still may not", swapWithHistory.status === 409, `status=${swapWithHistory.status}`);

  // ═══════════════════════════════════════════════════════════════════════
  section("E — A MANUAL STOCK ADJUSTMENT SAYS WHY");

  sub("E1. green coffee: an unexplained adjustment is refused");
  const beanE = await freshBean("ADJUST", 12);
  const movBeforeE = num((await one(
    `SELECT COUNT(*)::int n FROM "InventoryMovement" WHERE "referenceEntityId"=$1`, [beanE.id])).n);
  const e1 = await api("/api/inventory/adjust", { method: "POST", body: { entityId: beanE.id, newActualQuantity: 9 } });
  const e2 = await api("/api/inventory/adjust", {
    method: "POST", body: { entityId: beanE.id, newActualQuantity: 9, notes: "    " } });
  const e3 = await api("/api/inventory/adjust", {
    method: "POST", body: { entityId: beanE.id, newActualQuantity: 9, notes: "typo" } });
  const stockE = num((await one('SELECT "quantityKg" q FROM "GreenBean" WHERE id=$1', [beanE.id])).q);
  const movAfterE = num((await one(
    `SELECT COUNT(*)::int n FROM "InventoryMovement" WHERE "referenceEntityId"=$1`, [beanE.id])).n);
  console.log(`    no reason=${e1.status}, whitespace=${e2.status}, too short=${e3.status}; stock ${stockE}kg`);
  check("no reason is refused", e1.status === 400, `status=${e1.status}`);
  check("whitespace is refused", e2.status === 400, `status=${e2.status}`);
  check("a token reason is refused", e3.status === 400, `status=${e3.status}`);
  check("the stock was not touched", near(stockE, 12), `${stockE}kg`);
  check("and no ledger row was written", movAfterE === movBeforeE, `${movBeforeE} -> ${movAfterE}`);

  sub("E2. a real reason is accepted and kept");
  const REASON_E = "Stock count 14 Sep — two bags behind the pallet";
  const e4 = await api("/api/inventory/adjust", {
    method: "POST", body: { entityId: beanE.id, newActualQuantity: 9, notes: `  ${REASON_E}  ` } });
  const movE = await one(
    `SELECT notes, "previousQuantity" p, "newQuantity" nq, "quantityChanged" d, "userId" u, "sourceDocType" s
       FROM "InventoryMovement" WHERE "referenceEntityId"=$1 ORDER BY timestamp DESC LIMIT 1`, [beanE.id]);
  console.log(`    adjust -> ${e4.status}; movement ${movE?.p}kg -> ${movE?.nq}kg (${movE?.d})`);
  check("accepted", e4.status === 201, `status=${e4.status} ${S(e4.json).slice(0, 90)}`);
  check("the ledger row carries the trimmed reason", movE?.notes === REASON_E, S(movE?.notes));
  check("with before, after and delta", near(num(movE?.p), 12) && near(num(movE?.nq), 9) && near(num(movE?.d), -3),
    `${movE?.p}/${movE?.nq}/${movE?.d}`);
  check("and the actor and the kind of movement", !!movE?.u && movE?.s === "MANUAL_ADJUSTMENT",
    `${S(movE?.u)}/${S(movE?.s)}`);

  sub("E3. packaging material follows the same rule");
  const matE = C.materials.label;
  const m1 = await api(`/api/materials/${matE.id}`, { method: "PATCH", body: { newActualQuantity: 999 } });
  const m2 = await api(`/api/materials/${matE.id}`, {
    method: "PATCH", body: { newActualQuantity: 999, notes: "Counted 14 Sep, box damaged" } });
  const movM = await one(
    `SELECT notes FROM "InventoryMovement" WHERE "referenceEntityId"=$1 ORDER BY timestamp DESC LIMIT 1`, [matE.id]);
  console.log(`    material: no reason=${m1.status}, with reason=${m2.status}`);
  check("an unexplained material adjustment is refused", m1.status === 400, `status=${m1.status}`);
  check("an explained one is accepted", m2.status === 200, `status=${m2.status} ${S(m2.json).slice(0, 90)}`);
  check("and the reason reaches the ledger", movM?.notes === "Counted 14 Sep, box damaged", S(movM?.notes));

  sub("E4. editing a material that is not a count needs no reason");
  const m3 = await api(`/api/materials/${matE.id}`, { method: "PATCH", body: { reorderPoint: 42 } });
  check("a plain field edit is still accepted", m3.status === 200, `status=${m3.status} ${S(m3.json).slice(0, 90)}`);

  // ═══════════════════════════════════════════════════════════════════════
  section("F — EMPLOYEE ADMINISTRATION IS AUDITED, DURABLY AND EXACTLY");
  //
  // The audit is a control, not telemetry: it is written in the same transaction as the
  // change, so a change that happened always has a record of happening, and a record never
  // describes a change that did not.

  await loginAs(ADMIN_PIN);
  const TARGET_ID = `${P}_emp_audited`;
  await db.query('DELETE FROM "Employee" WHERE id=$1', [TARGET_ID]);

  sub("F1. creating an account is recorded");
  const created = await api("/api/employees", {
    method: "POST",
    body: { name: `${P} Audited`, username: `${P}_audited`, pin: "770065", role: "qc",
            permissions: { dashboard: { access: "edit" },
                           qc: { access: "edit", sub: { create_record: true, manage: false } } } },
  });
  check("the account is created", created.status === 201, `status=${created.status} ${S(created.json).slice(0, 100)}`);
  const newId = created.json?.id;
  const createdRows = newId ? await auditRows("EMPLOYEE_CREATED", newId) : [];
  console.log(`    EMPLOYEE_CREATED rows: ${createdRows.length}`);
  check("exactly one creation event", createdRows.length === 1, `${createdRows.length} rows`);
  check("naming the actor and the target", !!createdRows[0]?.userId &&
    createdRows[0]?.metadata?.targetEmployeeId === newId, S(createdRows[0]?.metadata).slice(0, 110));
  check("and the role it was created with", createdRows[0]?.metadata?.role === "qc",
    S(createdRows[0]?.metadata).slice(0, 110));
  check("recording which credential classes were set, not their values",
    JSON.stringify(createdRows[0]?.metadata?.credentials) === JSON.stringify(["pin"]),
    S(createdRows[0]?.metadata?.credentials));

  sub("F2. a role change records both values");
  await api(`/api/employees/${newId}`, { method: "PUT", body: { role: "dispatch" } });
  const roleRows = await auditRows("EMPLOYEE_ROLE_CHANGED", newId);
  console.log(`    role rows: ${roleRows.length}; ${S(roleRows[0]?.metadata).slice(0, 90)}`);
  check("exactly one role event", roleRows.length === 1, `${roleRows.length} rows`);
  check("with the old and the new role",
    roleRows[0]?.metadata?.oldRole === "qc" && roleRows[0]?.metadata?.newRole === "dispatch",
    S(roleRows[0]?.metadata));

  sub("F2b. a role-only edit does not erase the permission grant");
  // Found by the exact diff, which is the point of insisting on one: the PUT handler set
  // data.permissions unconditionally, so JSON.stringify(undefined || {}) wrote "{}" whenever
  // the field was absent. Changing only the role silently revoked every module the employee
  // had, leaving an account that could log in and do nothing. A fingerprint would have
  // recorded that something changed and hidden what.
  const permsRow = await one('SELECT permissions FROM "Employee" WHERE id=$1', [newId]);
  let permDoc = {};
  try { permDoc = JSON.parse(permsRow?.permissions ?? "{}"); } catch { permDoc = {}; }
  const permEventsAfterRole = (await auditRows("EMPLOYEE_PERMISSIONS_CHANGED", newId)).length;
  console.log(`    permissions after a role-only edit: ${S(Object.keys(permDoc))}`);
  check("the grant survived the role change", Object.keys(permDoc).length > 0,
    S(permsRow?.permissions).slice(0, 90));
  check("and still names the module it was created with", !!permDoc.qc, S(Object.keys(permDoc)));
  check("so a role-only edit records no permission change", permEventsAfterRole === 0,
    `${permEventsAfterRole} rows`);

  sub("F3. granting a privilege records the exact privilege granted");
  await api(`/api/employees/${newId}`, {
    method: "PUT",
    body: { permissions: { dashboard: { access: "edit" },
                           qc: { access: "edit", sub: { create_record: true, manage: true } } } },
  });
  const grantRows = await auditRows("EMPLOYEE_PERMISSIONS_CHANGED", newId);
  const grantChanges = grantRows[0]?.metadata?.changes ?? [];
  console.log(`    grant diff: ${S(grantChanges).slice(0, 160)}`);
  check("one permission event", grantRows.length === 1, `${grantRows.length} rows`);
  check("naming the privilege by path with both values",
    grantChanges.some((c) => c.path === "qc.manage" && c.from === false && c.to === true),
    S(grantChanges).slice(0, 150));
  check("and it is a diff, not a fingerprint",
    !("previousFingerprint" in (grantRows[0]?.metadata ?? {})), S(grantRows[0]?.metadata).slice(0, 110));

  sub("F4. revoking it records the exact inverse");
  await api(`/api/employees/${newId}`, {
    method: "PUT",
    body: { permissions: { dashboard: { access: "edit" },
                           qc: { access: "edit", sub: { create_record: true, manage: false } } } },
  });
  const revokeRows = await auditRows("EMPLOYEE_PERMISSIONS_CHANGED", newId);
  const revokeChanges = revokeRows[revokeRows.length - 1]?.metadata?.changes ?? [];
  console.log(`    revoke diff: ${S(revokeChanges).slice(0, 160)}`);
  check("a second permission event", revokeRows.length === 2, `${revokeRows.length} rows`);
  check("carrying the inverse change",
    revokeChanges.some((c) => c.path === "qc.manage" && c.from === true && c.to === false),
    S(revokeChanges).slice(0, 150));

  sub("F5. a request that changes nothing records nothing");
  const beforeNoop = (await auditRows("EMPLOYEE_ROLE_CHANGED", newId)).length +
                     (await auditRows("EMPLOYEE_PERMISSIONS_CHANGED", newId)).length;
  await api(`/api/employees/${newId}`, {
    method: "PUT",
    body: { role: "dispatch", name: `${P} Audited`,
            permissions: { dashboard: { access: "edit" },
                           qc: { access: "edit", sub: { create_record: true, manage: false } } } },
  });
  const afterNoop = (await auditRows("EMPLOYEE_ROLE_CHANGED", newId)).length +
                    (await auditRows("EMPLOYEE_PERMISSIONS_CHANGED", newId)).length;
  console.log(`    no-op edit: ${beforeNoop} -> ${afterNoop} events`);
  check("no new event", afterNoop === beforeNoop, `${beforeNoop} -> ${afterNoop}`);

  sub("F6. deactivation and reactivation each commit with their record");
  await api(`/api/employees/${newId}`, { method: "PUT", body: { active: false } });
  const deactRows = await auditRows("EMPLOYEE_DEACTIVATED", newId);
  const stateOff = await one('SELECT active FROM "Employee" WHERE id=$1', [newId]);
  check("the deactivation is recorded with both values",
    deactRows.length === 1 && deactRows[0].metadata?.oldActive === true &&
    deactRows[0].metadata?.newActive === false, S(deactRows[0]?.metadata));
  check("and the state actually changed with it", stateOff?.active === false, S(stateOff));

  await api(`/api/employees/${newId}`, { method: "PUT", body: { active: true } });
  const actRows = await auditRows("EMPLOYEE_ACTIVATED", newId);
  const stateOn = await one('SELECT active FROM "Employee" WHERE id=$1', [newId]);
  check("the reactivation is recorded too",
    actRows.length === 1 && actRows[0].metadata?.newActive === true, S(actRows[0]?.metadata));
  check("and committed", stateOn?.active === true, S(stateOn));

  sub("F7. a credential change is recorded, and the credential is not");
  await api(`/api/employees/${newId}`, { method: "PUT", body: { pin: "770066" } });
  const credRows = await auditRows("EMPLOYEE_CREDENTIAL_CHANGED", newId);
  const everything = S(await all(
    `SELECT metadata FROM "AuthAuditLog" WHERE metadata->>'targetEmployeeId'=$1`, [newId]));
  console.log(`    credential events: ${credRows.length}; ${S(credRows[0]?.metadata)}`);
  check("the change is recorded", credRows.length === 1, `${credRows.length} rows`);
  check("naming the class only",
    JSON.stringify(credRows[0]?.metadata?.credentials) === JSON.stringify(["pin"]),
    S(credRows[0]?.metadata));
  for (const [label, re] of [
    ["the new PIN", /770066/],
    ["the old PIN", /770065/],
    ["a bcrypt hash", /\$2[aby]\$/],
    ["a pinHash value", /[0-9a-f]{64}/],
  ]) {
    check(`no audit row contains ${label}`, !re.test(everything), "found in metadata");
  }

  sub("F8. a delete that cannot happen leaves no record saying it did");
  // QcRecord.employeeId is ON DELETE SET NULL, so an employee with QC history deletes
  // cleanly. CuppingScore.employeeId is the same. The reliable way to make the delete fail
  // is to remove the row underneath the transaction — which is also a real race: two admins
  // deleting the same account at once.
  const GHOST = `${P}_emp_ghost`;
  await ensureUser(GHOST, `${P} Ghost`, "qc", { dashboard: { access: "edit" } }, "770067");
  await db.query('DELETE FROM "Employee" WHERE id=$1', [GHOST]);
  const delGhost = await api(`/api/employees/${GHOST}`, { method: "DELETE" });
  const ghostRows = await auditRows("EMPLOYEE_DELETED", GHOST);
  console.log(`    delete an account that is already gone -> ${delGhost.status};` +
              ` EMPLOYEE_DELETED rows: ${ghostRows.length}`);
  check("the delete is refused", delGhost.status >= 400 && delGhost.status < 500,
    `status=${delGhost.status} ${S(delGhost.json).slice(0, 90)}`);
  check("and no successful deletion event survives", ghostRows.length === 0,
    `${ghostRows.length} rows`);

  sub("F9. a delete that does happen leaves exactly one record");
  const delF = await api(`/api/employees/${newId}`, { method: "DELETE" });
  const delRows = await auditRows("EMPLOYEE_DELETED", newId);
  const gone = (await one('SELECT id FROM "Employee" WHERE id=$1', [newId])) === undefined;
  console.log(`    delete -> ${delF.status}; gone=${gone}; EMPLOYEE_DELETED rows: ${delRows.length}`);
  check("the account is deleted", delF.status === 200, `status=${delF.status} ${S(delF.json).slice(0, 90)}`);
  check("the row is actually gone", gone, "employee survives");
  check("and the deletion is on the record exactly once", delRows.length === 1, `${delRows.length} rows`);
  check("with the role it held at the time", delRows[0]?.metadata?.role === "dispatch",
    S(delRows[0]?.metadata).slice(0, 110));

  sub("F10. live authorization state still behaves as H1 certified it");
  const LIVE = `${P}_emp_live`;
  await ensureUser(LIVE, `${P} Live`, "custom", {
    dashboard: { access: "edit" }, orders: { access: "view" },
  }, "770068");
  await loginAs("770068");
  const liveCookie = getCookie();
  const beforeLive = await raw("/api/orders", { cookie: liveCookie });
  await db.query('UPDATE "Employee" SET active=false WHERE id=$1', [LIVE]);
  const afterLive = await raw("/api/orders", { cookie: liveCookie });
  console.log(`    same token across deactivation: ${beforeLive.status} -> ${afterLive.status}`);
  check("an active account works", beforeLive.status === 200, `status=${beforeLive.status}`);
  check("and a deactivated one is refused on the next request", afterLive.status === 401,
    `status=${afterLive.status}`);
  await loginAs(ADMIN_PIN);
  // ═══════════════════════════════════════════════════════════════════════
  section("F2 — TWO ADMINISTRATORS, ONE EMPLOYEE");
  //
  // Being inside a transaction does not serialise anything on its own. A plain read takes no
  // lock, so two administrators could each read the same employee, each compute a diff
  // against that reading, and each write — leaving an audit trail describing transitions out
  // of states that no longer existed, and (because `permissions` is a single document) a
  // later write silently discarding an earlier grant.
  //
  // Each case below holds the Employee row on a side connection so both requests are
  // provably in flight before either can proceed, rather than hoping two calls overlap.

  const RACE_ID = `${P}_emp_race`;
  const racePerms = {
    dashboard: { access: "edit" },
    qc: { access: "edit", sub: { create_record: true, manage: false } },
  };

  const employeeRow = () => one(
    'SELECT role, active, permissions FROM "Employee" WHERE id=$1', [RACE_ID]);
  const subValue = (raw, mod, key) => {
    try { return JSON.parse(raw ?? "{}")?.[mod]?.sub?.[key] ?? null; } catch { return null; }
  };
  const auditChain = () => all(
    `SELECT action, metadata, "occurredAt" FROM "AuthAuditLog"
      WHERE metadata->>'targetEmployeeId'=$1 ORDER BY "occurredAt", action`, [RACE_ID]);

  const holdEmployee = async () => {
    const c = new Client({ connectionString: DB_URL });
    await c.connect();
    await c.query("BEGIN");
    await c.query('SELECT id FROM "Employee" WHERE id=$1 FOR UPDATE', [RACE_ID]);
    return c;
  };

  sub("F2a. a role change and a permission grant, at the same moment");
  await db.query(`DELETE FROM "AuthAuditLog" WHERE metadata->>'targetEmployeeId'=$1`, [RACE_ID]);
  await ensureUser(RACE_ID, `${P} Race`, "qc", racePerms, "770069");
  await db.query('UPDATE "Employee" SET role=$2, permissions=$3 WHERE id=$1',
    [RACE_ID, "qc", JSON.stringify(racePerms)]);

  let empHold = await holdEmployee();
  const editRole = api(`/api/employees/${RACE_ID}`, { method: "PUT", body: { role: "dispatch" } });
  await sleep(1200);
  const editPerms = api(`/api/employees/${RACE_ID}`, {
    method: "PUT",
    body: { permissions: { dashboard: { access: "edit" },
                           qc: { access: "edit", sub: { create_record: true, manage: true } } } },
  });
  await sleep(1200);
  await empHold.query("ROLLBACK");
  await empHold.end();
  const [roleRes, permsRes] = await Promise.all([editRole, editPerms]);

  const afterRace = await employeeRow();
  const chain = await auditChain();
  console.log(`    role=${roleRes.status} perms=${permsRes.status} -> role=${afterRace?.role},` +
              ` qc.manage=${subValue(afterRace?.permissions, "qc", "manage")}`);
  console.log(`    audit chain: ${S(chain.map((e) => e.action))}`);
  check("neither returned a server error", roleRes.status !== 500 && permsRes.status !== 500,
    `${roleRes.status}/${permsRes.status}`);
  check("neither deadlocked", !/deadlock|40P01/i.test(S(roleRes.json) + S(permsRes.json)),
    (S(roleRes.json) + S(permsRes.json)).slice(0, 130));
  check("the role change was not lost", afterRace?.role === "dispatch", `role=${S(afterRace?.role)}`);
  check("the permission grant was not lost either",
    subValue(afterRace?.permissions, "qc", "manage") === true,
    S(afterRace?.permissions).slice(0, 110));
  check("and permissions were not reset to nothing",
    Object.keys(JSON.parse(afterRace?.permissions ?? "{}")).length > 0,
    S(afterRace?.permissions).slice(0, 90));

  sub("F2b. and every audit event describes the state its own transaction locked");
  const roleEvent = chain.find((e) => e.action === "EMPLOYEE_ROLE_CHANGED");
  const permEvent = chain.find((e) => e.action === "EMPLOYEE_PERMISSIONS_CHANGED");
  console.log(`    role event: ${S(roleEvent?.metadata?.oldRole)} -> ${S(roleEvent?.metadata?.newRole)};` +
              ` perm diff: ${S(permEvent?.metadata?.changes)}`);
  check("exactly one role event", chain.filter((e) => e.action === "EMPLOYEE_ROLE_CHANGED").length === 1,
    S(chain.map((e) => e.action)));
  check("exactly one permission event",
    chain.filter((e) => e.action === "EMPLOYEE_PERMISSIONS_CHANGED").length === 1,
    S(chain.map((e) => e.action)));
  check("the role event describes the transition that committed",
    roleEvent?.metadata?.oldRole === "qc" && roleEvent?.metadata?.newRole === "dispatch",
    S(roleEvent?.metadata));
  check("the permission event describes exactly the privilege that moved",
    (permEvent?.metadata?.changes ?? []).some(
      (c) => c.path === "qc.manage" && c.from === false && c.to === true),
    S(permEvent?.metadata?.changes));
  // The second transaction derived its diff from the row it locked, so it reports no role
  // change — the role it saw was already the committed one.
  check("the second transaction invented no transition of its own",
    !(permEvent?.metadata?.changes ?? []).some((c) => c.path.endsWith(".role")),
    S(permEvent?.metadata?.changes));

  sub("F2c. a deactivation racing a permission edit");
  empHold = await holdEmployee();
  const deactivate = api(`/api/employees/${RACE_ID}`, { method: "PUT", body: { active: false } });
  await sleep(1200);
  const grantAgain = api(`/api/employees/${RACE_ID}`, {
    method: "PUT",
    body: { permissions: { dashboard: { access: "edit" },
                           qc: { access: "view", sub: { create_record: false, manage: false } } } },
  });
  await sleep(1200);
  await empHold.query("ROLLBACK");
  await empHold.end();
  const [deactRes, grantRes] = await Promise.all([deactivate, grantAgain]);
  const afterDeact = await employeeRow();
  console.log(`    deactivate=${deactRes.status} edit=${grantRes.status} -> active=${afterDeact?.active},` +
              ` qc.access=${S(JSON.parse(afterDeact?.permissions ?? "{}")?.qc?.access)}`);
  check("neither returned a server error", deactRes.status !== 500 && grantRes.status !== 500,
    `${deactRes.status}/${grantRes.status}`);
  check("the deactivation stuck", afterDeact?.active === false, S(afterDeact?.active));
  // Editing an inactive employee is permitted by the current administration policy — an
  // account is deactivated first and tidied up afterwards — so this records the behaviour
  // rather than inventing a new rule for the test.
  check("editing an inactive employee is allowed, and committed",
    grantRes.status !== 200 ||
    JSON.parse(afterDeact?.permissions ?? "{}")?.qc?.access === "view",
    S(afterDeact?.permissions).slice(0, 110));
  const deactEvents = (await auditChain()).filter((e) => e.action === "EMPLOYEE_DEACTIVATED");
  check("the deactivation is recorded once, truthfully",
    deactEvents.length === 1 && deactEvents[0].metadata?.oldActive === true &&
    deactEvents[0].metadata?.newActive === false, S(deactEvents[0]?.metadata));

  sub("F2d. a delete racing an edit");
  empHold = await holdEmployee();
  const deleteRace = api(`/api/employees/${RACE_ID}`, { method: "DELETE" });
  await sleep(1200);
  const editRace = api(`/api/employees/${RACE_ID}`, { method: "PUT", body: { role: "inventory" } });
  await sleep(1200);
  await empHold.query("ROLLBACK");
  await empHold.end();
  const [delRaceRes, editRaceRes] = await Promise.all([deleteRace, editRace]);
  const survivor = await employeeRow();
  const finalChain = await auditChain();
  const deletedEvents = finalChain.filter((e) => e.action === "EMPLOYEE_DELETED");
  console.log(`    delete=${delRaceRes.status} edit=${editRaceRes.status};` +
              ` employee present=${survivor !== undefined}; deleted events=${deletedEvents.length}`);
  check("neither returned a server error",
    delRaceRes.status !== 500 && editRaceRes.status !== 500, `${delRaceRes.status}/${editRaceRes.status}`);
  check("neither deadlocked", !/deadlock|40P01/i.test(S(delRaceRes.json) + S(editRaceRes.json)),
    (S(delRaceRes.json) + S(editRaceRes.json)).slice(0, 130));
  check("one serialization won: the employee is either gone or intact, never half-edited",
    delRaceRes.status !== 200 || survivor === undefined,
    `delete=${delRaceRes.status}, present=${survivor !== undefined}`);
  check("an edit that lost did not resurrect a deleted employee",
    delRaceRes.status !== 200 || editRaceRes.status !== 200,
    `delete=${delRaceRes.status} edit=${editRaceRes.status}`);
  check("a deletion event exists only if the deletion committed",
    (delRaceRes.status === 200) === (deletedEvents.length === 1),
    `delete=${delRaceRes.status}, events=${deletedEvents.length}`);
  check("and no audit event describes a mutation that did not commit",
    survivor !== undefined || finalChain.every((e) => e.action !== "EMPLOYEE_ROLE_CHANGED" ||
      e.metadata?.newRole !== "inventory" || editRaceRes.status === 200),
    S(finalChain.map((e) => `${e.action}:${S(e.metadata?.newRole ?? "")}`)));

  await db.query(`DELETE FROM "AuthAuditLog" WHERE metadata->>'targetEmployeeId'=$1`, [RACE_ID]);
  await db.query('DELETE FROM "Employee" WHERE id=$1', [RACE_ID]);

  // ═══════════════════════════════════════════════════════════════════════
  section("G — DELIVERY RETRY: WHAT ACTUALLY HAPPENS");
  //
  // Written as characterization: the question is not whether a delivery can exceed the
  // ordered quantity — it cannot — but whether repeating the SAME intended dispatch
  // repeats the operation. Those are different properties and only one of them is
  // idempotency. When this section was written the answer was no, and it recorded a
  // BLOCKER saying so.
  //
  // H2B gave a dispatch an identity, so "the same intended dispatch" now has a meaning it
  // did not have before: it is one carrying the same Idempotency-Key. These cases send
  // that — a retry, not a lookalike — and still measure rather than assume, so the
  // BLOCKER below stays armed and would fire again if the deduplication were lost.

  const batchG = await roastAndPass(P, C.coffees.brazil, C.beans.brazil, 12, 10, 2, "G1");
  if (!batchG.id) throw new Error(`fixture roast failed: ${S(batchG.error?.json ?? batchG)}`);
  await api(`/api/roasting-batches/${batchG.id}/pack-sku`, {
    method: "POST", body: { productSkuId: C.skus.bra250.id, units: 20 },
  });
  const lotG = await one('SELECT id FROM "FinishedGoodsLot" WHERE "packedFromBatchId"=$1', [batchG.id]);
  const oG = await skuOrder("delivery retry", C.skus.bra250, 12);

  const snapshotG = async () => ({
    deliveries: num((await one(
      `SELECT COUNT(*)::int n FROM "Delivery" WHERE "orderItemId"=$1`, [oG.itemId])).n),
    deliveredUnits: num((await one(
      `SELECT "deliveredUnits" n FROM "OrderItem" WHERE id=$1`, [oG.itemId])).n),
    reserved: num((await one(
      `SELECT COALESCE(SUM("quantityUnits"),0)::int n FROM "StockAllocation"
        WHERE "orderItemId"=$1 AND status='RESERVED'`, [oG.itemId])).n),
    lotAvailable: num((await one(
      `SELECT "unitsAvailable" n FROM "FinishedGoodsLot" WHERE id=$1`, [lotG.id])).n),
    movements: num((await one(
      `SELECT COUNT(*)::int n FROM "InventoryMovement" WHERE "sourceDocType"='DELIVERY'`)).n),
  });

  // One key per intended dispatch. Two calls sharing a key are a retry of one shipment;
  // two calls with different keys are two shipments, which is a different question.
  const dispatch = (key) => api("/api/deliveries", {
    method: "POST",
    headers: { "Idempotency-Key": key },
    body: { orderItemId: oG.itemId, quantityUnits: 4, deliveryType: "partial", finishedGoodsLotId: lotG.id },
  });

  sub("G1. the same dispatch, sent twice in sequence");
  const keyG1 = freshIdempotencyKey("h2a-g1");
  const g0 = await snapshotG();
  const first = await dispatch(keyG1);
  const g1 = await snapshotG();
  const second = await dispatch(keyG1);
  const g2 = await snapshotG();
  console.log(`    first=${first.status} second=${second.status}`);
  console.log(`    deliveries ${g0.deliveries} -> ${g1.deliveries} -> ${g2.deliveries};` +
              ` delivered ${g0.deliveredUnits} -> ${g1.deliveredUnits} -> ${g2.deliveredUnits};` +
              ` lot ${g0.lotAvailable} -> ${g1.lotAvailable} -> ${g2.lotAvailable}`);
  check("the first dispatch is accepted", first.status === 201, `status=${first.status}`);
  check("the retry is answered 200, not 201 — it is a replay, not a shipment",
    second.status === 200, `status=${second.status} ${S(second.json)}`);
  check("and it returns the delivery the first request created",
    second.json?.id === first.json?.id, `${second.json?.id} vs ${first.json?.id}`);

  const repeated = second.status === 201;
  if (repeated) {
    issue("BLOCKER", "Delivery has no request idempotency",
      `A repeat of the same dispatch was accepted: Delivery rows ${g0.deliveries}->${g2.deliveries}, ` +
      `deliveredUnits ${g0.deliveredUnits}->${g2.deliveredUnits}, lot units ${g0.lotAvailable}->${g2.lotAvailable}, ` +
      `delivery movements ${g0.movements}->${g2.movements}. Bounded by the ordered quantity, not deduplicated.`);
  }
  check("the retry either deduplicates or is recorded as a second real dispatch — never half of each",
    repeated
      ? (g2.deliveries === g1.deliveries + 1 && g2.deliveredUnits === g1.deliveredUnits + 4)
      : (g2.deliveries === g1.deliveries && g2.deliveredUnits === g1.deliveredUnits),
    `${S(g1)} -> ${S(g2)}`);
  check("stock moved exactly as much as the record says it did",
    g1.lotAvailable - g2.lotAvailable === (g2.deliveredUnits - g1.deliveredUnits),
    `lot ${g1.lotAvailable}->${g2.lotAvailable} vs delivered ${g1.deliveredUnits}->${g2.deliveredUnits}`);
  check("delivered never exceeds what was ordered", g2.deliveredUnits <= 12, `${g2.deliveredUnits} of 12`);
  check("no counter went negative", g2.lotAvailable >= 0 && g2.reserved >= 0,
    `lot=${g2.lotAvailable} reserved=${g2.reserved}`);

  sub("G2. the same dispatch, sent twice at once");
  const keyG2 = freshIdempotencyKey("h2a-g2");
  const g3 = await snapshotG();
  const [c1, c2] = await Promise.all([dispatch(keyG2), dispatch(keyG2)]);
  const g4 = await snapshotG();
  const accepted = [c1.status, c2.status].filter((s) => s === 201).length;
  console.log(`    concurrent: ${c1.status}/${c2.status}; deliveries ${g3.deliveries} -> ${g4.deliveries};` +
              ` delivered ${g3.deliveredUnits} -> ${g4.deliveredUnits}`);
  check("neither returned a server error", c1.status !== 500 && c2.status !== 500, `${c1.status}/${c2.status}`);
  check("neither deadlocked", !/deadlock|40P01/i.test(S(c1.json) + S(c2.json)),
    (S(c1.json) + S(c2.json)).slice(0, 120));
  check("the ledger agrees with the delivered total",
    g4.deliveredUnits - g3.deliveredUnits === accepted * 4,
    `${accepted} accepted, delivered +${g4.deliveredUnits - g3.deliveredUnits}`);
  check("and with the stock that actually left the lot",
    g3.lotAvailable - g4.lotAvailable === accepted * 4,
    `lot -${g3.lotAvailable - g4.lotAvailable}, expected -${accepted * 4}`);
  check("delivered still never exceeds what was ordered", g4.deliveredUnits <= 12, `${g4.deliveredUnits} of 12`);
  if (accepted === 2) {
    issue("BLOCKER", "Concurrent duplicate dispatches both commit",
      `Two identical concurrent requests were both accepted; deliveredUnits ${g3.deliveredUnits} -> ${g4.deliveredUnits}.`);
  }

  await invariants("after the H2A hardening suite");

  // ── teardown ──────────────────────────────────────────────────────────────
  await loginAs(ADMIN_PIN);
  await db.query(`DELETE FROM "AuthAuditLog" WHERE metadata->>'targetEmployeeId' LIKE '${P}\\_%'`);
  await db.query(`DELETE FROM "Employee" WHERE id LIKE '${P}\\_%' OR username LIKE '${P}\\_%'`);
  await db.query(`DELETE FROM "InventoryMovement" WHERE "referenceEntityId" IN
                    (SELECT id FROM "GreenBean" WHERE "serialNumber" LIKE '${P}-%')`);
  await db.query(`DELETE FROM "PurchaseRecord" WHERE "supplierId" IN
                    (SELECT id FROM "Supplier" WHERE name LIKE '${P}%')`);
  await db.query(`DELETE FROM "Supplier" WHERE name LIKE '${P}%'`);
  await db.query(`DELETE FROM "GreenBean" WHERE "serialNumber" LIKE '${P}-%'`);
  await teardown(P);

  section("H2A HARDENING RESULT");
  console.log(`${results.pass} passed, ${results.fail} failed`);
  if (results.issues.length) {
    console.log("RECORDED ISSUES:");
    for (const i of results.issues) console.log(`  [${i.severity}] ${i.title} — ${i.detail}`);
  }
  if (results.failures.length) console.log("FAILURES:\n  - " + results.failures.join("\n  - "));
  await db.end();
  process.exit(results.fail === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.log("FATAL:", e?.stack || e);
  try {
    await db.query(`DELETE FROM "Employee" WHERE id LIKE '${P}\\_%' OR username LIKE '${P}\\_%'`);
    await db.query(`DELETE FROM "GreenBean" WHERE "serialNumber" LIKE '${P}-%'`);
  } catch {}
  try { await db.end(); } catch {}
  process.exit(1);
});
