// PACKAGING COFFEE IDENTITY + SKU AUTO-RESERVATION — R2.3.
//
// Two defects, and they share a root cause: nothing in the packaging routes ever asks the
// backend what coffee a roast actually is.
//
// ── Why the coffee guard fails open ─────────────────────────────────────────
// An order-backed roast is created with productId left undefined — see
// roasting-batches/route.ts, "Stock batches carry the product on the batch itself;
// order-backed ones keep inheriting it from their order item at packaging time". So
// batch.productId is NULL for every order-backed batch, and pack-sku's guard reads
//
//     coffeeLines.find((r) => r.coffeeProductId && batch.productId && r.coffeeProductId !== batch.productId)
//
// which short-circuits on the null and matches nothing. The check that exists to stop an
// Ethiopian SKU being packed out of a Brazilian roast cannot fire on the batches it was
// written for. The kilogram path has the mirror problem from the other direction: when the
// backend cannot prove the coffee it accepts body.productId from the request and stamps the
// lot with whatever the caller said.
//
// ── Why freshly packed units never reach their own order ────────────────────
// pack-sku creates a unit lot and stops. It never looks at the order line the batch was
// roasted for, so coffee produced to fulfil a specific order lands on the shelf
// free-to-promise, preparation review still reports the line as needing production, and
// another order can be promised the units first.
//
// Every case below is written against behaviour the routes do not have yet, so the failures
// it records on a pre-fix run are the defects themselves rather than a description of them.
import {
  ADMIN_PIN, BASE, db, api, check, section, sub, one, all, num, near, invariants, loginAs,
  results, getCookie,
} from "./harness.mjs";
import { buildCatalog, teardown, roastAndPass } from "./catalog.mjs";

const S = (v) => { try { return JSON.stringify(v) ?? String(v); } catch { return String(v); } };
const P = "PKI2";
let C;

let keySeq = 0;
const newKey = (tag) => `${P}-${tag}-${++keySeq}`;

/** A request carrying an Idempotency-Key. Same reasoning as in packaging-idempotency. */
async function keyed(path, { method = "POST", body, key } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      "content-type": "application/json",
      ...(getCookie() ? { cookie: getCookie() } : {}),
      ...(key === undefined ? {} : { "Idempotency-Key": key }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "manual",
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, json, replay: res.headers.get("x-idempotent-replay") };
}

const packSku = (batchId, body, key) =>
  keyed(`/api/roasting-batches/${batchId}/pack-sku`, { method: "POST", body, key });
const packKg = (batchId, body, key) =>
  keyed(`/api/roasting-batches/${batchId}/package`, { method: "PUT", body, key });

// ── readers ────────────────────────────────────────────────────────────────
const batchRow = (id) => one(
  `SELECT "productId" pid, "orderItemId" oid, "productionOrderId" poid,
          "roastedAvailableKg" rak, status FROM "RoastingBatch" WHERE id=$1`, [id]);

const unitLot = (batchId) => one(
  `SELECT id, "productSkuId" sku, "unitsProduced" p, "unitsAvailable" a, "unitsReserved" r
     FROM "FinishedGoodsLot" WHERE "packedFromBatchId"=$1`, [batchId]);

const reservedUnits = async (orderItemId) => num((await one(
  `SELECT COALESCE(SUM("quantityUnits"),0)::int n FROM "StockAllocation"
    WHERE "orderItemId"=$1 AND status='RESERVED' AND "quantityUnits" IS NOT NULL`,
  [orderItemId])).n);

const allocLots = (orderItemId) => all(
  `SELECT "finishedGoodsLotId" lot, "quantityUnits" u FROM "StockAllocation"
    WHERE "orderItemId"=$1 AND status='RESERVED' AND "quantityUnits" IS NOT NULL
    ORDER BY "createdAt"`, [orderItemId]);

const movementsFor = async (batchId) => num((await one(
  `SELECT COUNT(*)::int n FROM "InventoryMovement" WHERE "sourceDocId"=$1`, [batchId])).n);

const opsFor = async (batchId) => num((await one(
  `SELECT COUNT(*)::int n FROM "PackagingOperation" WHERE "batchId"=$1`, [batchId])).n);

const materialQty = async (id) => num((await one(
  `SELECT "quantityOnHand" q FROM "MaterialItem" WHERE id=$1`, [id])).q);

// ── fixtures ───────────────────────────────────────────────────────────────
const topUpGreen = (beanId, kg) =>
  db.query('UPDATE "GreenBean" SET "quantityKg" = "quantityKg" + $2 WHERE id=$1', [beanId, kg]);

/** An approved order with one SKU line, reviewed so production is permitted. */
async function orderFor(skuId, units, note) {
  const r = await api("/api/orders", {
    method: "POST",
    body: { customerId: C.customers.cafe.id, notes: `${P} ${note}`,
            items: [{ productSkuId: skuId, quantityUnits: units }] },
  });
  if (r.status !== 201) throw new Error(`order create failed: ${S(r.json)}`);
  await api(`/api/orders/${r.json.id}/approve`, { method: "POST", body: { decision: "Yes" } });
  await api(`/api/orders/${r.json.id}/preparation-review`, {
    method: "POST", body: { items: r.json.items.map((i) => ({ orderItemId: i.id })) },
  });
  return r.json;
}

/**
 * A QC-passed roast raised AGAINST an order line — the shape that actually exposes the
 * defect, because the route leaves productId null on exactly these.
 */
async function orderBackedRoast(orderItem, bean, label, greenKg = 12, roastedKg = 10) {
  await topUpGreen(bean.id, greenKg);
  const r = await api("/api/roasting-batches", {
    method: "POST",
    body: { orderItemId: orderItem.id, greenBeanId: bean.id,
            greenBeanQuantity: greenKg, roastedBeanQuantity: roastedKg,
            wasteQuantity: greenKg - roastedKg },
  });
  if (r.status !== 201) throw new Error(`order-backed roast failed: ${S(r.json)}`);
  await db.query('UPDATE "RoastingBatch" SET "batchNumber"=$2, status=$3 WHERE id=$1',
    [r.json.id, `${P}-${label}`, "Passed"]);
  return r.json.id;
}

/** A QC-passed stock roast; carries productId on the batch itself. */
async function stockRoast(coffee, bean, label, greenKg = 12, roastedKg = 10) {
  await topUpGreen(bean.id, greenKg);
  const b = await roastAndPass(P, coffee, bean, greenKg, roastedKg, greenKg - roastedKg, label);
  if (!b.id) throw new Error(`stock roast failed: ${S(b.error?.json ?? b)}`);
  return b.id;
}

async function main() {
  await db.connect();
  await teardown(P);
  await loginAs(ADMIN_PIN);
  C = await buildCatalog(P);

  // ═══════════════════════════════════════════════════════════════════════
  section("A — IDENTITY PROVED FROM BACKEND RELATIONS, NOT FROM A NULL FIELD");

  sub("A1. an order-backed roast has no productId of its own, yet its coffee is knowable");
  const oA = await orderFor(C.skus.bra1kg.id, 6, "identity from order line");
  const bA = await orderBackedRoast(oA.items[0], C.beans.brazil, "A01");
  const rowA = await batchRow(bA);
  console.log(`    batch.productId=${rowA.pid}  orderItemId=${rowA.oid ? "set" : "null"}`);
  check("the batch genuinely carries no productId", rowA.pid === null, `productId=${rowA.pid}`);
  check("but it is attributed to an order line", rowA.oid !== null, `orderItemId=${rowA.oid}`);

  const packA = await packSku(bA, { productSkuId: C.skus.bra1kg.id, units: 3 }, newKey("a"));
  const lotA = await unitLot(bA);
  console.log(`    pack -> ${packA.status} ${S(packA.json).slice(0, 110)}`);
  check("packing the coffee's own SKU succeeds", packA.status === 201,
    `status=${packA.status} ${S(packA.json).slice(0, 120)}`);
  check("and produces a unit lot", num(lotA?.p) === 3, `unitsProduced=${lotA?.p}`);

  // ═══════════════════════════════════════════════════════════════════════
  section("B — A FOREIGN COFFEE'S SKU IS REFUSED, AND REFUSED BEFORE ANY WRITE");

  sub("B1. an Ethiopian SKU cannot be packed out of a Brazilian order-backed roast");
  const oB = await orderFor(C.skus.bra1kg.id, 6, "wrong coffee");
  const bB = await orderBackedRoast(oB.items[0], C.beans.brazil, "B01");
  const bagsBefore = await materialQty(C.materials.bag250.id);
  const labelsBefore = await materialQty(C.materials.label.id);
  const movesBefore = await movementsFor(bB);

  const wrong = await packSku(bB, { productSkuId: C.skus.eth250.id, units: 4 }, newKey("b"));
  const afterB = await batchRow(bB);
  console.log(`    Ethiopian SKU on a Brazilian roast -> ${wrong.status} ${S(wrong.json).slice(0, 120)}`);
  check("refused with a 4xx", wrong.status >= 400 && wrong.status < 500, `status=${wrong.status}`);
  check("the roasted balance was not drawn", near(num(afterB.rak), 10), `roastedAvailableKg=${afterB.rak}`);
  check("no packaging materials were consumed",
    (await materialQty(C.materials.bag250.id)) === bagsBefore
    && (await materialQty(C.materials.label.id)) === labelsBefore,
    `bag250 ${bagsBefore}->${await materialQty(C.materials.bag250.id)}, label ${labelsBefore}->${await materialQty(C.materials.label.id)}`);
  check("no lot was created", (await unitLot(bB)) === undefined, S(await unitLot(bB)));
  check("no inventory movement was written", (await movementsFor(bB)) === movesBefore,
    `${movesBefore} -> ${await movementsFor(bB)}`);
  check("no packaging operation was recorded", (await opsFor(bB)) === 0, `${await opsFor(bB)} rows`);
  check("nothing was reserved to the order line", (await reservedUnits(oB.items[0].id)) === 0,
    `${await reservedUnits(oB.items[0].id)} units`);
  check("no raw database error leaked", !/constraint|violates|prisma|23503/i.test(S(wrong.json)),
    S(wrong.json).slice(0, 140));

  // ═══════════════════════════════════════════════════════════════════════
  section("C — BACKEND SOURCES THAT DISAGREE ARE A CONFLICT, NOT A VOTE");

  sub("C1. batch.productId says Ethiopia, the owning order line says Brazil");
  // Both are backend state and both are authoritative, so there is no correct way to pick
  // one. Packaging must stop rather than guess which record is the lie.
  const oC = await orderFor(C.skus.bra1kg.id, 6, "identity conflict");
  const bC = await orderBackedRoast(oC.items[0], C.beans.brazil, "C01");
  await db.query('UPDATE "RoastingBatch" SET "productId"=$2 WHERE id=$1',
    [bC, C.coffees.ethiopia.id]);
  const conflictRow = await batchRow(bC);
  check("the conflicting state is really in place",
    conflictRow.pid === C.coffees.ethiopia.id && conflictRow.oid === oC.items[0].id,
    `productId=${conflictRow.pid}`);

  const cRes = await packSku(bC, { productSkuId: C.skus.bra1kg.id, units: 2 }, newKey("c"));
  console.log(`    conflicting identity -> ${cRes.status} ${S(cRes.json).slice(0, 130)}`);
  check("packing is refused", cRes.status >= 400 && cRes.status < 500, `status=${cRes.status}`);
  check("nothing was packed", (await unitLot(bC)) === undefined && near(num((await batchRow(bC)).rak), 10),
    `lot=${S(await unitLot(bC))} rak=${(await batchRow(bC)).rak}`);
  // The Ethiopian SKU must not be accepted either — a conflict is unresolvable in BOTH
  // directions, and answering "well, one of the sources agrees with you" would be choosing.
  const cRes2 = await packSku(bC, { productSkuId: C.skus.eth1kg.id, units: 2 }, newKey("c2"));
  check("and the other candidate's SKU is refused too", cRes2.status >= 400 && cRes2.status < 500,
    `status=${cRes2.status} ${S(cRes2.json).slice(0, 110)}`);

  // ═══════════════════════════════════════════════════════════════════════
  section("D — AN UNPROVABLE IDENTITY IS A REFUSAL, NOT A CLIENT QUESTION");

  sub("D1. a batch with no product, no order line and no production order");
  const bD = await stockRoast(C.coffees.brazil, C.beans.brazil, "D01");
  await db.query('UPDATE "RoastingBatch" SET "productId"=NULL WHERE id=$1', [bD]);
  const rowD = await batchRow(bD);
  check("the batch has no attribution at all",
    rowD.pid === null && rowD.oid === null && rowD.poid === null,
    `pid=${rowD.pid} oid=${rowD.oid} poid=${rowD.poid}`);

  const dRes = await packSku(bD, { productSkuId: C.skus.bra1kg.id, units: 2 }, newKey("d"));
  console.log(`    unprovable identity -> ${dRes.status} ${S(dRes.json).slice(0, 130)}`);
  check("unit packing is refused", dRes.status >= 400 && dRes.status < 500, `status=${dRes.status}`);
  check("nothing was packed", (await unitLot(bD)) === undefined, S(await unitLot(bD)));

  sub("D2. and the client cannot supply the missing identity itself");
  // The kilogram route used to accept body.productId as the answer whenever the backend
  // had none. That is precisely the fail-open this wave closes: a caller may assert an
  // identity, never establish one.
  const dKg = await packKg(bD, { bags1kg: 2, productId: C.coffees.brazil.id }, newKey("d2"));
  console.log(`    client-supplied identity -> ${dKg.status} ${S(dKg.json).slice(0, 130)}`);
  check("kilogram packing is refused as well", dKg.status >= 400 && dKg.status < 500,
    `status=${dKg.status}`);
  check("and no kilogram lot appeared",
    (await one(`SELECT id FROM "FinishedGoodsLot" WHERE "roastingBatchId"=$1`, [bD])) === undefined,
    "lot exists");

  // ═══════════════════════════════════════════════════════════════════════
  section("E — A CLIENT'S COFFEE CLAIM IS CHECKED AGAINST THE BACKEND'S");

  sub("E1. body.productId that contradicts a provable identity is refused");
  const bE = await stockRoast(C.coffees.brazil, C.beans.brazil, "E01");
  const beforeE = await batchRow(bE);
  const eRes = await packKg(bE, { bags1kg: 2, productId: C.coffees.ethiopia.id }, newKey("e"));
  const afterE = await batchRow(bE);
  console.log(`    backend=Brazil, client claims Ethiopia -> ${eRes.status} ${S(eRes.json).slice(0, 120)}`);
  check("refused with a 4xx", eRes.status >= 400 && eRes.status < 500, `status=${eRes.status}`);
  check("no bags were counted and no roasted coffee drawn",
    near(num(afterE.rak), num(beforeE.rak)), `rak ${beforeE.rak} -> ${afterE.rak}`);
  check("no lot was created",
    (await one(`SELECT id FROM "FinishedGoodsLot" WHERE "roastingBatchId"=$1`, [bE])) === undefined,
    "lot exists");
  check("no packaging operation was recorded", (await opsFor(bE)) === 0, `${await opsFor(bE)} rows`);

  sub("E2. the same claim, agreeing with the backend, is accepted");
  const eOk = await packKg(bE, { bags1kg: 2, productId: C.coffees.brazil.id }, newKey("e2"));
  check("an agreeing assertion packs normally", eOk.status === 200,
    `status=${eOk.status} ${S(eOk.json).slice(0, 110)}`);

  sub("E3. a SKU belonging to another coffee is still refused on the kilogram path");
  const bE3 = await stockRoast(C.coffees.brazil, C.beans.brazil, "E03");
  const e3 = await packKg(bE3, { bags1kg: 1, productSkuId: C.skus.eth250.id }, newKey("e3"));
  check("SEC-1 protection is preserved", e3.status >= 400 && e3.status < 500,
    `status=${e3.status} ${S(e3.json).slice(0, 110)}`);

  // ═══════════════════════════════════════════════════════════════════════
  section("F — FRESHLY PACKED UNITS ARE CLAIMED BY THE ORDER THEY WERE ROASTED FOR");

  sub("F1. 10 ordered, 2 already reserved, 5 newly packed -> 5 newly reserved");
  const oF = await orderFor(C.skus.eth1kg.id, 10, "auto reserve");
  // Two units on the shelf before the review, so the line starts with 2 reserved and 8
  // outstanding. Packed from a stock roast of the same coffee, which is ordinary supply.
  const pre = await stockRoast(C.coffees.ethiopia, C.beans.ethiopia, "F00");
  const preRes = await packSku(pre, { productSkuId: C.skus.eth1kg.id, units: 2 }, newKey("f0"));
  check("shelf stock prepared", preRes.status === 201, S(preRes.json).slice(0, 110));
  await api(`/api/orders/${oF.id}/preparation-review`, {
    method: "POST", body: { items: oF.items.map((i) => ({ orderItemId: i.id })) },
  });
  const reservedBeforeF = await reservedUnits(oF.items[0].id);
  check("the line starts with 2 units reserved from existing stock", reservedBeforeF === 2,
    `${reservedBeforeF} units`);

  const bF = await orderBackedRoast(oF.items[0], C.beans.ethiopia, "F01");
  const packF = await packSku(bF, { productSkuId: C.skus.eth1kg.id, units: 5 }, newKey("f"));
  const lotF = await unitLot(bF);
  const reservedAfterF = await reservedUnits(oF.items[0].id);
  console.log(`    pack 5 -> ${packF.status}  reserved ${reservedBeforeF} -> ${reservedAfterF}, lot r=${lotF?.r}/${lotF?.a}`);
  check("the pack succeeds", packF.status === 201, `status=${packF.status} ${S(packF.json).slice(0, 120)}`);
  check("all 5 newly packed units are reserved to the owning line", reservedAfterF === 7,
    `total reserved ${reservedAfterF}, expected 7`);
  check("the response reports the reservation", num(packF.json?.reservedUnits) === 5,
    `reservedUnits=${packF.json?.reservedUnits}`);
  check("the reservation sits on the lot this operation produced",
    (await allocLots(oF.items[0].id)).some((a) => a.lot === lotF?.id && num(a.u) === 5),
    S(await allocLots(oF.items[0].id)));
  check("the lot's own counters agree", num(lotF?.r) === 5 && num(lotF?.a) === 5,
    `unitsReserved=${lotF?.r} unitsAvailable=${lotF?.a}`);
  check("units reserved never exceed units available", num(lotF?.r) <= num(lotF?.a),
    `${lotF?.r} <= ${lotF?.a}`);

  // ═══════════════════════════════════════════════════════════════════════
  section("G — RESERVATION STOPS AT OUTSTANDING DEMAND");

  sub("G1. only 3 outstanding, 5 packed -> 3 reserved and 2 left free");
  const oG = await orderFor(C.skus.idn250.id, 10, "over supply");
  const preG = await stockRoast(C.coffees.indonesia, C.beans.indonesia, "G00");
  await packSku(preG, { productSkuId: C.skus.idn250.id, units: 7 }, newKey("g0"));
  await api(`/api/orders/${oG.id}/preparation-review`, {
    method: "POST", body: { items: oG.items.map((i) => ({ orderItemId: i.id })) },
  });
  const reservedBeforeG = await reservedUnits(oG.items[0].id);
  check("7 of the 10 units are already reserved", reservedBeforeG === 7, `${reservedBeforeG} units`);

  const bG = await orderBackedRoast(oG.items[0], C.beans.indonesia, "G01");
  const packG = await packSku(bG, { productSkuId: C.skus.idn250.id, units: 5 }, newKey("g"));
  const lotG = await unitLot(bG);
  const reservedAfterG = await reservedUnits(oG.items[0].id);
  console.log(`    pack 5 with 3 outstanding -> reserved ${reservedBeforeG} -> ${reservedAfterG}, lot r=${lotG?.r}/${lotG?.a}`);
  check("the pack succeeds", packG.status === 201, `status=${packG.status}`);
  check("exactly the outstanding 3 are reserved", reservedAfterG === 10, `total ${reservedAfterG}, expected 10`);
  check("the response says 3", num(packG.json?.reservedUnits) === 3, `reservedUnits=${packG.json?.reservedUnits}`);
  check("the other 2 stay free on the shelf", num(lotG?.a) - num(lotG?.r) === 2,
    `available=${lotG?.a} reserved=${lotG?.r}`);
  check("the line is not over-reserved", reservedAfterG <= 10, `${reservedAfterG} <= 10`);

  // ═══════════════════════════════════════════════════════════════════════
  section("H — A STOCK ROAST RESERVES NOTHING");

  sub("H1. roasting to stock still produces free-to-promise units");
  const bH = await stockRoast(C.coffees.brazil, C.beans.brazil, "H01");
  const packH = await packSku(bH, { productSkuId: C.skus.bra250.id, units: 8 }, newKey("h"));
  const lotH = await unitLot(bH);
  check("the pack succeeds", packH.status === 201, `status=${packH.status} ${S(packH.json).slice(0, 110)}`);
  check("nothing is reserved", num(lotH?.r) === 0, `unitsReserved=${lotH?.r}`);
  check("every unit is free", num(lotH?.a) === 8, `unitsAvailable=${lotH?.a}`);
  check("the response reports no reservation", num(packH.json?.reservedUnits) === 0,
    `reservedUnits=${packH.json?.reservedUnits}`);

  // ═══════════════════════════════════════════════════════════════════════
  section("I — THE SAME COFFEE IN A DIFFERENT PACK SIZE IS NOT THE SAME PRODUCT");

  sub("I1. packing 250 g units does not fulfil a 1 kg line");
  // Identity matches, so packaging is allowed — this is real coffee and belongs on the
  // shelf. What must not happen is the units being promised to a line that ordered a
  // different SKU.
  const oI = await orderFor(C.skus.bra1kg.id, 5, "sku mismatch");
  const bI = await orderBackedRoast(oI.items[0], C.beans.brazil, "I01");
  const packI = await packSku(bI, { productSkuId: C.skus.bra250.id, units: 4 }, newKey("i"));
  const lotI = await unitLot(bI);
  const reservedI = await reservedUnits(oI.items[0].id);
  console.log(`    packed 4 x 250g against a 1kg line -> ${packI.status}, reserved=${reservedI}`);
  check("the coffee is the same, so packing is allowed", packI.status === 201,
    `status=${packI.status} ${S(packI.json).slice(0, 120)}`);
  check("but nothing is reserved to the 1 kg line", reservedI === 0, `${reservedI} units`);
  check("the units land free on the shelf", num(lotI?.a) === 4 && num(lotI?.r) === 0,
    `available=${lotI?.a} reserved=${lotI?.r}`);
  check("and the response says so", num(packI.json?.reservedUnits) === 0,
    `reservedUnits=${packI.json?.reservedUnits}`);

  // ═══════════════════════════════════════════════════════════════════════
  section("J — AN INELIGIBLE ORDER TAKES NO STOCK");

  sub("J1. packing for a cancelled order still packs, but promises nothing");
  const oJ = await orderFor(C.skus.eth250.id, 6, "ineligible");
  const bJ = await orderBackedRoast(oJ.items[0], C.beans.ethiopia, "J01");
  await api(`/api/orders/${oJ.id}/status`, { method: "POST", body: { action: "cancel", reason: `${P} test` } });
  const statusJ = (await one('SELECT status FROM "Order" WHERE id=$1', [oJ.id])).status;
  check("the order is in a terminal state", statusJ === "Cancelled", statusJ);

  const packJ = await packSku(bJ, { productSkuId: C.skus.eth250.id, units: 4 }, newKey("j"));
  const lotJ = await unitLot(bJ);
  const reservedJ = await reservedUnits(oJ.items[0].id);
  console.log(`    pack for a cancelled order -> ${packJ.status}, reserved=${reservedJ}`);
  check("packaging itself completes", packJ.status === 201,
    `status=${packJ.status} ${S(packJ.json).slice(0, 120)}`);
  check("no units are reserved to the dead order", reservedJ === 0, `${reservedJ} units`);
  check("the units are free for somebody else", num(lotJ?.a) - num(lotJ?.r) === 4,
    `available=${lotJ?.a} reserved=${lotJ?.r}`);

  // ═══════════════════════════════════════════════════════════════════════
  section("K — A CANCELLATION RACING A PACK LEAVES NO STOCK ON A DEAD ORDER");

  sub("K1. pack and cancel together, in either order");
  const oK = await orderFor(C.skus.eth250.id, 8, "concurrent cancel");
  const bK = await orderBackedRoast(oK.items[0], C.beans.ethiopia, "K01");
  const [packK, cancelK] = await Promise.all([
    packSku(bK, { productSkuId: C.skus.eth250.id, units: 5 }, newKey("k")),
    api(`/api/orders/${oK.id}/status`, { method: "POST", body: { action: "cancel", reason: `${P} race` } }),
  ]);
  const statusK = (await one('SELECT status FROM "Order" WHERE id=$1', [oK.id])).status;
  const reservedK = await reservedUnits(oK.items[0].id);
  const lotK = await unitLot(bK);
  console.log(`    pack=${packK.status} cancel=${cancelK.status} order=${statusK} reserved=${reservedK}`);
  check("neither side returned a server error", packK.status !== 500 && cancelK.status !== 500,
    `${packK.status}/${cancelK.status}`);
  check("neither side deadlocked", !/deadlock|40P01/i.test(S(packK.json) + S(cancelK.json)),
    S(packK.json).slice(0, 100));
  check("if the order ended Cancelled, it holds no reserved units",
    statusK !== "Cancelled" || reservedK === 0, `status=${statusK} reserved=${reservedK}`);
  check("lot counters stay coherent",
    lotK === undefined || (num(lotK.r) >= 0 && num(lotK.r) <= num(lotK.a)),
    S(lotK));

  // ═══════════════════════════════════════════════════════════════════════
  section("L — A REPLAY RESERVES NOTHING FURTHER");

  sub("L1. the same key twice reserves once");
  const oL = await orderFor(C.skus.bra1kg.id, 8, "replay");
  const bL = await orderBackedRoast(oL.items[0], C.beans.brazil, "L01");
  const keyL = newKey("l");
  const bodyL = { productSkuId: C.skus.bra1kg.id, units: 4 };
  const bagsL0 = await materialQty(C.materials.bag1kg.id);

  const l1 = await packSku(bL, bodyL, keyL);
  const reserved1 = await reservedUnits(oL.items[0].id);
  const allocs1 = (await allocLots(oL.items[0].id)).length;
  const moves1 = await movementsFor(bL);
  const rak1 = num((await batchRow(bL)).rak);

  const l2 = await packSku(bL, bodyL, keyL);
  const reserved2 = await reservedUnits(oL.items[0].id);
  const allocs2 = (await allocLots(oL.items[0].id)).length;
  const moves2 = await movementsFor(bL);
  const rak2 = num((await batchRow(bL)).rak);
  const lotL = await unitLot(bL);
  const bagsL1 = await materialQty(C.materials.bag1kg.id);

  console.log(`    first ${l1.status} reserved=${reserved1}; replay ${l2.status} (replay=${l2.replay}) reserved=${reserved2}`);
  check("the first pack reserves 4", reserved1 === 4, `${reserved1} units`);
  check("the replay is recognised", l2.status === 201 && l2.replay === "true",
    `status=${l2.status} replay=${l2.replay}`);
  check("the stored response repeats the original reservation",
    num(l2.json?.reservedUnits) === num(l1.json?.reservedUnits),
    `${l1.json?.reservedUnits} vs ${l2.json?.reservedUnits}`);
  check("no further units were reserved", reserved2 === reserved1, `${reserved1} -> ${reserved2}`);
  check("no second allocation row", allocs2 === allocs1, `${allocs1} -> ${allocs2}`);
  check("the lot was not incremented again", num(lotL?.p) === 4 && num(lotL?.r) === 4,
    `produced=${lotL?.p} reserved=${lotL?.r}`);
  check("no further roasted coffee was drawn", near(rak2, rak1), `${rak1} -> ${rak2}`);
  check("no further materials were consumed", bagsL1 === bagsL0 - 4, `${bagsL0} -> ${bagsL1}`);
  check("no second ledger row", moves2 === moves1, `${moves1} -> ${moves2}`);
  check("exactly one packaging operation", (await opsFor(bL)) === 1, `${await opsFor(bL)} rows`);

  await invariants("after the packaging identity suite");

  section("PACKAGING IDENTITY RESULT");
  console.log(`${results.pass} passed, ${results.fail} failed`);
  if (results.failures.length) console.log("FAILURES:\n  - " + results.failures.join("\n  - "));
  await db.end();
  process.exit(results.fail === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.log("FATAL:", e?.stack || e);
  try { await db.end(); } catch {}
  process.exit(1);
});
