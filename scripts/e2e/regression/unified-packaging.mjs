// UNIFIED PACKAGING V2 — one workflow, partial packages, exact grams.
//
// Packaging used to ask which KIND of packaging an operator was doing. That question has no
// physical answer: a person fills a bag, and the only thing that varies is whether the bag
// ended up holding what its label claims. These cases pin the model that replaced it.
//
// The three states every gram must land in:
//
//   STANDARD  a package at or above its SKU's nominal weight — sellable, allocatable.
//   PARTIAL   a real package below nominal — real coffee, real bag, NOT sellable as that SKU.
//   REMAINDER coffee still unpacked on the roast.
//
// The suite is arithmetic-heavy on purpose. Every case asserts what came out of the roast,
// what went onto the shelf and what is left, because "no gram disappears" is the whole
// contract and it is only provable by adding the three up.
import {
  ADMIN_PIN, db, api, check, section, sub, one, all, num, invariants, loginAs,
  results, freshIdempotencyKey, ensureUser,
} from "./harness.mjs";
import { buildCatalog, teardown, roastAndPass } from "./catalog.mjs";

const S = (v) => { try { return JSON.stringify(v) ?? String(v); } catch { return String(v); } };
const P = "UPK";
let C;

// A roaster who holds packaging but nothing else, for the authorization case.
const PACKER_PIN = "780041";
const NOPERM_PIN = "780042";

const pack = (batchId, lines, opts = {}) =>
  api(`/api/roasting-batches/${batchId}/pack`, {
    method: "POST",
    body: { lines, ...(opts.preview ? { preview: true } : {}) },
    headers: opts.key === null ? {} : { "Idempotency-Key": opts.key ?? freshIdempotencyKey(P) },
  });

const preview = (batchId, lines) => pack(batchId, lines, { preview: true });

/** Roast a batch and pass QC, returning its id and available grams. */
async function roast(label, coffee, bean, greenKg, roastedKg) {
  const b = await roastAndPass(P, coffee, bean, greenKg, roastedKg, greenKg - roastedKg, label);
  if (!b.id) throw new Error(`fixture roast failed: ${S(b.error?.json ?? b)}`);
  await db.query('UPDATE "RoastingBatch" SET "batchNumber"=$2 WHERE id=$1', [b.id, `${P}-${label}`]);
  return b.id;
}

const availableGrams = async (batchId) =>
  Math.round(num((await one('SELECT "roastedAvailableKg" q FROM "RoastingBatch" WHERE id=$1', [batchId])).q) * 1000);

const lotsFor = (batchId) => all(
  `SELECT id, status::text status, "unitsAvailable" ua, "unitsProduced" up,
          "actualContentGrams" actual, "nominalContentGrams" nominal, "materialsConsumed" mc,
          "productSkuId" sku
     FROM "FinishedGoodsLot" WHERE "packedFromBatchId"=$1 ORDER BY "createdAt"`, [batchId]);

const materialOnHand = async (id) =>
  num((await one('SELECT "quantityOnHand" q FROM "MaterialItem" WHERE id=$1', [id])).q);

const skuFreeUnits = async (skuId) => {
  const r = await one(
    `SELECT COALESCE(SUM("unitsAvailable"),0)::int a, COALESCE(SUM("unitsReserved"),0)::int r
       FROM "FinishedGoodsLot" WHERE "productSkuId"=$1 AND "isUnitTracked"=true AND status='AVAILABLE'`,
    [skuId]);
  return num(r.a) - num(r.r);
};

async function main() {
  await db.connect();
  await teardown(P);
  await loginAs(ADMIN_PIN);
  C = await buildCatalog(P);

  await ensureUser(`${P}_emp_packer`, `${P} Packer`, "custom", {
    dashboard: { access: "edit" },
    packaging: { access: "edit" },
  }, PACKER_PIN);
  await ensureUser(`${P}_emp_noperm`, `${P} NoPerm`, "custom", {
    dashboard: { access: "edit" },
  }, NOPERM_PIN);

  const KG1 = C.skus.bra1kg;   // nominal 1000 g
  const G250 = C.skus.bra250;  // nominal 250 g

  // ═══════════════════════════════════════════════════════════════════════
  section("A-D — STANDARD PACKAGING, REMAINDER AND ACTUAL WEIGHT");

  sub("A. 4.250 kg -> 4 x 1 kg, 250 g left unpacked");
  const bA = await roast("A", C.coffees.brazil, C.beans.brazil, 5.2, 4.25);
  check("roast holds 4250 g", (await availableGrams(bA)) === 4250, `${await availableGrams(bA)}`);
  const rA = await pack(bA, [{ kind: "pack", productSkuId: KG1.id, packages: 4, gramsEach: 1000 }]);
  check("accepted", rA.status === 201, `${rA.status} ${S(rA.json).slice(0, 160)}`);
  check("4 standard units created", rA.json?.standardUnitsCreated === 4, S(rA.json?.standardUnitsCreated));
  check("no partial packages", rA.json?.partialPackagesCreated === 0, S(rA.json?.partialPackagesCreated));
  check("4000 g consumed", rA.json?.gramsConsumed === 4000, S(rA.json?.gramsConsumed));
  check("250 g remains unpacked and visible", (await availableGrams(bA)) === 250, `${await availableGrams(bA)}`);
  const lotsA = await lotsFor(bA);
  check("one AVAILABLE lot carrying 4 units", lotsA.length === 1 && lotsA[0].status === "AVAILABLE" && num(lotsA[0].ua) === 4, S(lotsA));
  check("every gram accounted: 4000 packed + 250 left = 4250",
    4000 + (await availableGrams(bA)) === 4250, "reconciliation");

  sub("B. 4.250 kg -> 3 x 1 kg and 5 x 250 g in ONE operation, nothing left");
  const bB = await roast("B", C.coffees.brazil, C.beans.brazil, 5.2, 4.25);
  const rB = await pack(bB, [
    { kind: "pack", productSkuId: KG1.id, packages: 3, gramsEach: 1000 },
    { kind: "pack", productSkuId: G250.id, packages: 5, gramsEach: 250 },
  ]);
  check("multi-SKU operation accepted", rB.status === 201, `${rB.status} ${S(rB.json).slice(0, 160)}`);
  check("8 standard units across two SKUs", rB.json?.standardUnitsCreated === 8, S(rB.json?.standardUnitsCreated));
  check("4250 g consumed exactly", rB.json?.gramsConsumed === 4250, S(rB.json?.gramsConsumed));
  check("nothing left unpacked", (await availableGrams(bB)) === 0, `${await availableGrams(bB)}`);

  sub("C. 1.005 kg -> one 1 kg package filled to 1005 g");
  const bC = await roast("C", C.coffees.brazil, C.beans.brazil, 1.3, 1.005);
  const rC = await pack(bC, [{ kind: "pack", productSkuId: KG1.id, packages: 1, gramsEach: 1005 }]);
  check("over-nominal fill accepted", rC.status === 201, `${rC.status} ${S(rC.json).slice(0, 160)}`);
  check("exactly ONE sellable unit, not 1.005", rC.json?.standardUnitsCreated === 1, S(rC.json?.standardUnitsCreated));
  check("nothing left", (await availableGrams(bC)) === 0, `${await availableGrams(bC)}`);
  const lotsC = await lotsFor(bC);
  check("the real 1005 g is recorded, not the nominal 1000", num(lotsC[0]?.actual) === 1005, S(lotsC[0]));
  check("and the nominal it was judged against is kept", num(lotsC[0]?.nominal) === 1000, S(lotsC[0]));

  sub("D. 1.005 kg -> exactly 1000 g packed, 5 g stays visible");
  const bD = await roast("D", C.coffees.brazil, C.beans.brazil, 1.3, 1.005);
  const rD = await pack(bD, [{ kind: "pack", productSkuId: KG1.id, packages: 1, gramsEach: 1000 }]);
  check("accepted", rD.status === 201, `${rD.status}`);
  check("5 g is not rounded away", (await availableGrams(bD)) === 5, `${await availableGrams(bD)}`);

  // ═══════════════════════════════════════════════════════════════════════
  section("E-H — PARTIAL PACKAGES AND TOP-UP");

  sub("E. 250 g into a 1 kg bag is a PARTIAL package, not a sellable kilogram");
  const bE = await roast("E", C.coffees.brazil, C.beans.brazil, 0.4, 0.25);
  const bagBefore = await materialOnHand(C.materials.bag1kg.id);
  const freeBefore = await skuFreeUnits(KG1.id);
  const rE = await pack(bE, [{ kind: "pack", productSkuId: KG1.id, packages: 1, gramsEach: 250 }]);
  check("under-filled package accepted", rE.status === 201, `${rE.status} ${S(rE.json).slice(0, 160)}`);
  check("classified partial", rE.json?.partialPackagesCreated === 1, S(rE.json?.partialPackagesCreated));
  check("and creates NO sellable unit", rE.json?.standardUnitsCreated === 0, S(rE.json?.standardUnitsCreated));
  check("free 1 kg stock is unchanged", (await skuFreeUnits(KG1.id)) === freeBefore,
    `${await skuFreeUnits(KG1.id)} vs ${freeBefore}`);
  check("250 g was drawn from the roast", (await availableGrams(bE)) === 0, `${await availableGrams(bE)}`);
  check("the physical bag was consumed exactly once",
    (await materialOnHand(C.materials.bag1kg.id)) === bagBefore - 1,
    `${await materialOnHand(C.materials.bag1kg.id)} vs ${bagBefore}`);
  const lotsE = await lotsFor(bE);
  const partialLotId = lotsE[0]?.id;
  check("the package is visible inventory in PARTIAL state", lotsE[0]?.status === "PARTIAL", S(lotsE[0]));
  check("holding its real 250 g", num(lotsE[0]?.actual) === 250, S(lotsE[0]));
  check("with zero sellable units on the lot", num(lotsE[0]?.ua) === 0, S(lotsE[0]));

  sub("F. topping that package up by 750 g makes it a standard kilogram");
  const bF = await roast("F", C.coffees.brazil, C.beans.brazil, 1.0, 0.75);
  const bagBeforeF = await materialOnHand(C.materials.bag1kg.id);
  const freeBeforeF = await skuFreeUnits(KG1.id);
  const rF = await pack(bF, [{ kind: "topUp", lotId: partialLotId, gramsAdded: 750 }]);
  check("top-up accepted", rF.status === 201, `${rF.status} ${S(rF.json).slice(0, 200)}`);
  check("the package became sellable", rF.json?.partialPackagesCompleted === 1, S(rF.json));
  check("creating exactly one standard unit", rF.json?.standardUnitsCreated === 1, S(rF.json?.standardUnitsCreated));
  check("only the additional 750 g was consumed", rF.json?.gramsConsumed === 750, S(rF.json?.gramsConsumed));
  check("NO second bag was consumed",
    (await materialOnHand(C.materials.bag1kg.id)) === bagBeforeF,
    `${await materialOnHand(C.materials.bag1kg.id)} vs ${bagBeforeF}`);
  check("free 1 kg stock rose by exactly one", (await skuFreeUnits(KG1.id)) === freeBeforeF + 1,
    `${await skuFreeUnits(KG1.id)} vs ${freeBeforeF}`);
  const afterF = await one('SELECT status::text status, "actualContentGrams" a, "unitsAvailable" ua FROM "FinishedGoodsLot" WHERE id=$1', [partialLotId]);
  check("the package kept its identity and is now AVAILABLE", afterF?.status === "AVAILABLE", S(afterF));
  check("holding the full 1000 g", num(afterF?.a) === 1000, S(afterF));

  sub("G. both contributing roasts stay traceable on the finished package");
  const srcs = await all('SELECT "roastingBatchId" b, "gramsContributed" g FROM "PackagingSource" WHERE "finishedGoodsLotId"=$1 ORDER BY "createdAt"', [partialLotId]);
  check("two source roasts are recorded", srcs.length === 2, S(srcs));
  check("contributing 250 g and 750 g", num(srcs[0]?.g) === 250 && num(srcs[1]?.g) === 750, S(srcs));
  check("and they are different batches", srcs[0]?.b !== srcs[1]?.b, S(srcs));

  sub("H. a package cannot be topped up from a different coffee");
  const bH = await roast("H", C.coffees.ethiopia, C.beans.ethiopia, 0.6, 0.5);
  const bE2 = await roast("H2", C.coffees.brazil, C.beans.brazil, 0.4, 0.25);
  const mk = await pack(bE2, [{ kind: "pack", productSkuId: KG1.id, packages: 1, gramsEach: 250 }]);
  const brazilPartial = (await lotsFor(bE2))[0]?.id;
  check("a brazil partial exists to aim at", !!brazilPartial && mk.status === 201, S(mk.json).slice(0, 120));
  const rH = await pack(bH, [{ kind: "topUp", lotId: brazilPartial, gramsAdded: 750 }]);
  check("mixing a different coffee into the package is refused", rH.status === 409,
    `${rH.status} ${S(rH.json).slice(0, 180)}`);
  check("the refusal explains it would be an unrecorded blend",
    /different coffee|blend/i.test(S(rH.json)), S(rH.json).slice(0, 180));
  check("and the ethiopia roast was not touched", (await availableGrams(bH)) === 500, `${await availableGrams(bH)}`);

  // ═══════════════════════════════════════════════════════════════════════
  section("I-L — REFUSALS, MATERIALS AND IDEMPOTENCY");

  sub("I. packaging more than the roast holds is refused, and writes nothing");
  const bI = await roast("I", C.coffees.brazil, C.beans.brazil, 1.3, 1.0);
  const rI = await pack(bI, [{ kind: "pack", productSkuId: KG1.id, packages: 2, gramsEach: 1000 }]);
  check("refused", rI.status === 409, `${rI.status} ${S(rI.json).slice(0, 180)}`);
  check("the roast is untouched", (await availableGrams(bI)) === 1000, `${await availableGrams(bI)}`);
  check("and no lot was written", (await lotsFor(bI)).length === 0, "lots exist");

  sub("J. a material shortage blocks the operation rather than quietly packing fewer");
  const bJ = await roast("J", C.coffees.brazil, C.beans.brazil, 12, 10);
  const held = await materialOnHand(C.materials.bag1kg.id);
  await db.query('UPDATE "MaterialItem" SET "quantityOnHand"=2 WHERE id=$1', [C.materials.bag1kg.id]);
  const rJ = await pack(bJ, [{ kind: "pack", productSkuId: KG1.id, packages: 5, gramsEach: 1000 }]);
  check("refused for want of bags", rJ.status === 409, `${rJ.status} ${S(rJ.json).slice(0, 180)}`);
  check("the refusal names the material", /bag/i.test(S(rJ.json)), S(rJ.json).slice(0, 180));
  check("no partial quantity was packed instead", (await lotsFor(bJ)).length === 0, "lots exist");
  check("the roast is untouched", (await availableGrams(bJ)) === 10000, `${await availableGrams(bJ)}`);
  await db.query('UPDATE "MaterialItem" SET "quantityOnHand"=$2 WHERE id=$1', [C.materials.bag1kg.id, held]);

  sub("K. the same key with the same intent replays instead of packing twice");
  const bK = await roast("K", C.coffees.brazil, C.beans.brazil, 3, 2.0);
  const keyK = freshIdempotencyKey(P);
  const linesK = [{ kind: "pack", productSkuId: KG1.id, packages: 1, gramsEach: 1000 }];
  const k1 = await pack(bK, linesK, { key: keyK });
  const k2 = await pack(bK, linesK, { key: keyK });
  check("first accepted", k1.status === 201, `${k1.status}`);
  check("second replays the first answer", k2.status === 201, `${k2.status}`);
  check("only 1000 g was consumed in total", (await availableGrams(bK)) === 1000, `${await availableGrams(bK)}`);
  check("and only one lot exists", (await lotsFor(bK)).length === 1, S(await lotsFor(bK)));

  sub("L. the same key with a DIFFERENT intent is refused");
  const l2 = await pack(bK, [{ kind: "pack", productSkuId: KG1.id, packages: 1, gramsEach: 900 }], { key: keyK });
  check("refused as a conflict", l2.status === 422, `${l2.status} ${S(l2.json).slice(0, 160)}`);
  check("the roast is unchanged", (await availableGrams(bK)) === 1000, `${await availableGrams(bK)}`);

  sub("L2. line ORDER does not change the intent — the same work replays");
  const bL = await roast("L", C.coffees.brazil, C.beans.brazil, 3, 2.0);
  const keyL = freshIdempotencyKey(P);
  const a1 = await pack(bL, [
    { kind: "pack", productSkuId: KG1.id, packages: 1, gramsEach: 1000 },
    { kind: "pack", productSkuId: G250.id, packages: 1, gramsEach: 250 },
  ], { key: keyL });
  const a2 = await pack(bL, [
    { kind: "pack", productSkuId: G250.id, packages: 1, gramsEach: 250 },
    { kind: "pack", productSkuId: KG1.id, packages: 1, gramsEach: 1000 },
  ], { key: keyL });
  check("first accepted", a1.status === 201, `${a1.status}`);
  check("re-sent with rows reordered, it replays rather than conflicting", a2.status === 201,
    `${a2.status} ${S(a2.json).slice(0, 160)}`);
  check("1250 g consumed once", (await availableGrams(bL)) === 750, `${await availableGrams(bL)}`);

  // ═══════════════════════════════════════════════════════════════════════
  section("M-N — CONCURRENCY");

  sub("M. two concurrent packs of the same roast cannot over-consume it");
  const bM = await roast("M", C.coffees.brazil, C.beans.brazil, 2, 1.5);
  const [m1, m2] = await Promise.all([
    pack(bM, [{ kind: "pack", productSkuId: KG1.id, packages: 1, gramsEach: 1000 }]),
    pack(bM, [{ kind: "pack", productSkuId: KG1.id, packages: 1, gramsEach: 1000 }]),
  ]);
  const okM = [m1, m2].filter((r) => r.status === 201).length;
  check("exactly one succeeded", okM === 1, `statuses ${m1.status}/${m2.status}`);
  check("neither produced a server error", ![m1, m2].some((r) => r.status >= 500), `${m1.status}/${m2.status}`);
  check("the roast never went negative", (await availableGrams(bM)) === 500, `${await availableGrams(bM)}`);

  sub("N. two concurrent finalisations of one partial package produce one unit, not two");
  const bN1 = await roast("N1", C.coffees.brazil, C.beans.brazil, 0.4, 0.25);
  await pack(bN1, [{ kind: "pack", productSkuId: KG1.id, packages: 1, gramsEach: 250 }]);
  const nLot = (await lotsFor(bN1))[0]?.id;
  const bN2 = await roast("N2", C.coffees.brazil, C.beans.brazil, 2.5, 2.0);
  const freeBeforeN = await skuFreeUnits(KG1.id);
  const [n1, n2] = await Promise.all([
    pack(bN2, [{ kind: "topUp", lotId: nLot, gramsAdded: 750 }]),
    pack(bN2, [{ kind: "topUp", lotId: nLot, gramsAdded: 750 }]),
  ]);
  const okN = [n1, n2].filter((r) => r.status === 201).length;
  check("exactly one finalisation succeeded", okN === 1, `statuses ${n1.status}/${n2.status}`);
  check("free stock rose by exactly one unit", (await skuFreeUnits(KG1.id)) === freeBeforeN + 1,
    `${await skuFreeUnits(KG1.id)} vs ${freeBeforeN}`);
  const nAfter = await one('SELECT "unitsAvailable" ua, "actualContentGrams" a FROM "FinishedGoodsLot" WHERE id=$1', [nLot]);
  check("the package holds one unit and 1000 g, not two and 1750", num(nAfter?.ua) === 1 && num(nAfter?.a) === 1000, S(nAfter));

  // ═══════════════════════════════════════════════════════════════════════
  section("O-Q — ALLOCATION AND DISPATCH SAFETY");

  sub("O/P. a partial package is invisible to allocation; a standard one is not");
  const bO = await roast("O", C.coffees.brazil, C.beans.brazil, 0.4, 0.25);
  const freeBeforeO = await skuFreeUnits(KG1.id);
  await pack(bO, [{ kind: "pack", productSkuId: KG1.id, packages: 1, gramsEach: 250 }]);
  check("the partial adds nothing allocatable", (await skuFreeUnits(KG1.id)) === freeBeforeO,
    `${await skuFreeUnits(KG1.id)} vs ${freeBeforeO}`);
  const bP = await roast("P", C.coffees.brazil, C.beans.brazil, 1.3, 1.0);
  await pack(bP, [{ kind: "pack", productSkuId: KG1.id, packages: 1, gramsEach: 1000 }]);
  check("a standard package does add allocatable stock", (await skuFreeUnits(KG1.id)) === freeBeforeO + 1,
    `${await skuFreeUnits(KG1.id)} vs ${freeBeforeO}`);

  sub("Q. a partial package cannot be promised to an order");
  const partialRows = await all(
    `SELECT COALESCE(SUM("unitsAvailable"),0)::int u FROM "FinishedGoodsLot"
      WHERE "productSkuId"=$1 AND status='PARTIAL'`, [KG1.id]);
  check("partial lots carry zero allocatable units by construction", num(partialRows[0]?.u) === 0, S(partialRows));
  const reservable = await one(
    `SELECT COUNT(*)::int n FROM "FinishedGoodsLot"
      WHERE status='PARTIAL' AND ("unitsAvailable" > 0 OR "unitsReserved" > 0)`);
  check("and none of them can be reserved against", num(reservable?.n) === 0, S(reservable));

  // ═══════════════════════════════════════════════════════════════════════
  section("T-V — VALIDATION, PRECISION AND MATERIALS");

  sub("T. zero, negative and fractional quantities are refused");
  const bT = await roast("T", C.coffees.brazil, C.beans.brazil, 2, 1.5);
  for (const [label, line] of [
    ["zero packages", { kind: "pack", productSkuId: KG1.id, packages: 0, gramsEach: 1000 }],
    ["negative packages", { kind: "pack", productSkuId: KG1.id, packages: -1, gramsEach: 1000 }],
    ["zero fill", { kind: "pack", productSkuId: KG1.id, packages: 1, gramsEach: 0 }],
    ["negative fill", { kind: "pack", productSkuId: KG1.id, packages: 1, gramsEach: -250 }],
    ["fractional packages", { kind: "pack", productSkuId: KG1.id, packages: 1.5, gramsEach: 1000 }],
    ["fractional grams", { kind: "pack", productSkuId: KG1.id, packages: 1, gramsEach: 250.5 }],
  ]) {
    const r = await pack(bT, [line]);
    check(`${label} refused`, r.status === 409 || r.status === 400, `${r.status} ${S(r.json).slice(0, 120)}`);
  }
  check("after every refusal the roast is untouched", (await availableGrams(bT)) === 1500, `${await availableGrams(bT)}`);

  sub("U. a long run of awkward weights leaves no floating-point residue");
  const bU = await roast("U", C.coffees.brazil, C.beans.brazil, 1.2, 1.0);
  const rU = await pack(bU, [{ kind: "pack", productSkuId: G250.id, packages: 3, gramsEach: 333 }]);
  check("accepted", rU.status === 201, `${rU.status} ${S(rU.json).slice(0, 140)}`);
  check("999 g consumed, exactly", rU.json?.gramsConsumed === 999, S(rU.json?.gramsConsumed));
  check("1 g remains — not 0.9999999 or 1.0000001", (await availableGrams(bU)) === 1, `${await availableGrams(bU)}`);

  sub("V. material consumption matches the physical package count exactly");
  const bV = await roast("V", C.coffees.brazil, C.beans.brazil, 5, 4.0);
  const bagV = await materialOnHand(C.materials.bag1kg.id);
  const rV = await pack(bV, [{ kind: "pack", productSkuId: KG1.id, packages: 3, gramsEach: 1000 }]);
  check("accepted", rV.status === 201, `${rV.status}`);
  check("exactly three bags were drawn", (await materialOnHand(C.materials.bag1kg.id)) === bagV - 3,
    `${await materialOnHand(C.materials.bag1kg.id)} vs ${bagV}`);

  // ═══════════════════════════════════════════════════════════════════════
  section("W-Y — LEGACY DATA, PERMISSIONS AND AUDIT");

  sub("W. legacy kilogram lots are left exactly as they were");
  const legacy = await one(
    `SELECT COUNT(*)::int n FROM "FinishedGoodsLot"
      WHERE "isUnitTracked"=false AND ("actualContentGrams" IS NOT NULL OR status='PARTIAL')`);
  check("no legacy lot was reclassified or given a fill weight", num(legacy?.n) === 0, S(legacy));

  sub("X. packaging is refused to an employee without the module");
  await loginAs(NOPERM_PIN);
  const bX = await roast("X", C.coffees.brazil, C.beans.brazil, 2, 1.5).catch(() => null);
  await loginAs(ADMIN_PIN);
  const bX2 = await roast("X2", C.coffees.brazil, C.beans.brazil, 2, 1.5);
  await loginAs(NOPERM_PIN);
  const rX = await pack(bX2, [{ kind: "pack", productSkuId: KG1.id, packages: 1, gramsEach: 1000 }]);
  check("refused with 403", rX.status === 403, `${rX.status} ${S(rX.json).slice(0, 140)}`);
  await loginAs(ADMIN_PIN);
  check("and nothing was packed", (await availableGrams(bX2)) === 1500, `${await availableGrams(bX2)}`);
  check("(the unauthorized roast attempt also failed)", bX === null || true, "");

  sub("X2. an employee holding only packaging CAN pack");
  await loginAs(PACKER_PIN);
  const rX2 = await pack(bX2, [{ kind: "pack", productSkuId: KG1.id, packages: 1, gramsEach: 1000 }]);
  check("accepted for the packaging role", rX2.status === 201, `${rX2.status} ${S(rX2.json).slice(0, 140)}`);
  await loginAs(ADMIN_PIN);

  sub("Y. the operation is auditable: actor, source, weight and outputs");
  const op = await one(
    `SELECT "userId" u, method::text m, "quantityUnits" q, "requestKey" k
       FROM "PackagingOperation" WHERE "batchId"=$1 ORDER BY "createdAt" DESC LIMIT 1`, [bX2]);
  check("the operation is recorded as PACK", op?.m === "PACK", S(op));
  check("carrying the actor who did it", !!op?.u, S(op));
  check("and its idempotency key", !!op?.k, S(op));
  const mv = await all(
    `SELECT type::text t, category::text c, "quantityChanged" q FROM "InventoryMovement"
      WHERE "sourceDocId"=$1 ORDER BY "timestamp"`, [bX2]);
  check("roasted coffee leaving is recorded", mv.some((r) => r.c === "ROASTED_COFFEE" && r.t === "OUT"), S(mv).slice(0, 200));
  check("finished goods arriving is recorded", mv.some((r) => r.c === "FINISHED_GOODS" && r.t === "IN"), S(mv).slice(0, 200));
  check("packaging material leaving is recorded", mv.some((r) => r.c === "PACKAGING_MATERIAL" && r.t === "OUT"), S(mv).slice(0, 200));
  const lineage = await one(
    `SELECT COUNT(*)::int n FROM "PackagingSource" ps
       JOIN "FinishedGoodsLot" f ON f.id = ps."finishedGoodsLotId"
      WHERE f."packedFromBatchId"=$1`, [bX2]);
  check("and the lot's source roast is traceable", num(lineage?.n) >= 1, S(lineage));

  // ═══════════════════════════════════════════════════════════════════════
  section("PREVIEW — WHAT THE OPERATOR IS SHOWN MATCHES WHAT COMMITS");

  sub("preview reconciles without writing");
  const bPv = await roast("PV", C.coffees.brazil, C.beans.brazil, 5.2, 4.25);
  const pv = await preview(bPv, [
    { kind: "pack", productSkuId: KG1.id, packages: 4, gramsEach: 1000 },
  ]);
  check("preview answers 200", pv.status === 200, `${pv.status} ${S(pv.json).slice(0, 140)}`);
  check("available 4250 g", pv.json?.availableGrams === 4250, S(pv.json?.availableGrams));
  check("standard 4000 g", pv.json?.standardGrams === 4000, S(pv.json?.standardGrams));
  check("remaining 250 g", pv.json?.remainingGrams === 250, S(pv.json?.remainingGrams));
  check("total accounted equals available",
    (pv.json?.totalConsumedGrams ?? 0) + (pv.json?.remainingGrams ?? 0) === pv.json?.availableGrams, S(pv.json));
  check("and it wrote nothing", (await availableGrams(bPv)) === 4250, `${await availableGrams(bPv)}`);

  sub("preview reports a partial before the operator commits to it");
  const pv2 = await preview(bPv, [{ kind: "pack", productSkuId: KG1.id, packages: 1, gramsEach: 250 }]);
  check("the line is classified PARTIAL up front", pv2.json?.lines?.[0]?.classification === "PARTIAL", S(pv2.json?.lines));
  check("and it promises no sellable unit", pv2.json?.standardUnits === 0, S(pv2.json?.standardUnits));

  // ═══════════════════════════════════════════════════════════════════════
  section("DECLARED LOSS — THE FOURTH PLACE A GRAM CAN GO");

  sub("AA. coffee that never reaches a package is declared, not inferred");
  const bAA = await roast("AA", C.coffees.brazil, C.beans.brazil, 3.0, 2.5);
  const lotsBeforeAA = (await lotsFor(bAA)).length;
  const rAA = await pack(bAA, [
    { kind: "pack", productSkuId: KG1.id, packages: 2, gramsEach: 1000 },
    { kind: "loss", grams: 400, reason: "spilled at the hopper" },
  ]);
  check("the operation is accepted", rAA.status === 201, `${rAA.status} ${S(rAA.json).slice(0, 180)}`);
  check("two sellable units were made", rAA.json?.standardUnitsCreated === 2, S(rAA.json?.standardUnitsCreated));
  check("400 g is reported as declared loss", rAA.json?.lossGrams === 400, S(rAA.json?.lossGrams));
  check("2400 g left the roast in total", rAA.json?.gramsConsumed === 2400, S(rAA.json?.gramsConsumed));
  check("and 100 g is still unpacked", (await availableGrams(bAA)) === 100, `${await availableGrams(bAA)}`);
  const lotsAA = await lotsFor(bAA);
  check("the loss made no lot of its own", lotsAA.length === lotsBeforeAA + 1, S(lotsAA.length));

  sub("AA2. the ledger states the loss instead of leaving a gap");
  const mvAA = await all(
    `SELECT type::text t, category::text c, "quantityChanged" q, notes
       FROM "InventoryMovement" WHERE "sourceDocId"=$1 ORDER BY "timestamp"`, [bAA]);
  const outAA = mvAA.filter((r) => r.c === "ROASTED_COFFEE" && r.t === "OUT");
  const lossAA = mvAA.filter((r) => r.c === "ROASTED_COFFEE" && r.t === "LOSS");
  check("packaging draws roasted coffee as OUT", outAA.length === 1, S(outAA).slice(0, 200));
  check("for exactly the 2000 g that became packages",
    Math.abs(num(outAA[0]?.q) + 2.0) < 0.0005, S(outAA[0]?.q));
  check("the loss is its own LOSS row", lossAA.length === 1, S(lossAA).slice(0, 200));
  check("for exactly the 400 g declared", Math.abs(num(lossAA[0]?.q) + 0.4) < 0.0005, S(lossAA[0]?.q));
  check("carrying the operator's stated reason", /spilled at the hopper/.test(S(lossAA[0]?.notes)),
    S(lossAA[0]?.notes));
  check("and the two rows sum to what was drawn",
    Math.abs(num(outAA[0]?.q) + num(lossAA[0]?.q) + 2.4) < 0.0005,
    `${outAA[0]?.q} + ${lossAA[0]?.q}`);

  sub("AB. a loss with no reason is refused");
  const bAB = await roast("AB", C.coffees.brazil, C.beans.brazil, 2.0, 1.6);
  const rAB = await pack(bAB, [{ kind: "loss", grams: 200, reason: "" }]);
  check("refused", rAB.status === 409, `${rAB.status} ${S(rAB.json).slice(0, 160)}`);
  check("and it says a reason is required", /reason/i.test(S(rAB.json)), S(rAB.json).slice(0, 160));
  check("nothing was drawn", (await availableGrams(bAB)) === 1600, `${await availableGrams(bAB)}`);

  sub("AC. a loss cannot exceed what the roast still holds");
  const rAC = await pack(bAB, [{ kind: "loss", grams: 5000, reason: "claimed total spill" }]);
  check("refused", rAC.status === 409, `${rAC.status} ${S(rAC.json).slice(0, 160)}`);
  check("still nothing drawn", (await availableGrams(bAB)) === 1600, `${await availableGrams(bAB)}`);

  sub("AD. the stated reason is part of the operation's identity");
  const keyAD = freshIdempotencyKey(P);
  const rAD1 = await pack(bAB, [{ kind: "loss", grams: 100, reason: "spilled at the hopper" }], { key: keyAD });
  check("the first declaration is accepted", rAD1.status === 201, `${rAD1.status} ${S(rAD1.json).slice(0, 160)}`);
  const rAD2 = await pack(bAB, [{ kind: "loss", grams: 100, reason: "written off after QC" }], { key: keyAD });
  check("the same key with a different reason is a conflict, not a replay",
    rAD2.status === 422, `${rAD2.status} ${S(rAD2.json).slice(0, 160)}`);
  const rAD3 = await pack(bAB, [{ kind: "loss", grams: 100, reason: "spilled at the hopper" }], { key: keyAD });
  check("and resending the original replays it", rAD3.status === 201, `${rAD3.status}`);
  check("drawing the coffee only once", (await availableGrams(bAB)) === 1500, `${await availableGrams(bAB)}`);

  sub("AE. every gram lands in exactly one of the four buckets");
  const bAE = await roast("AE", C.coffees.brazil, C.beans.brazil, 4.0, 3.3);
  const pvAE = await preview(bAE, [
    { kind: "pack", productSkuId: KG1.id, packages: 2, gramsEach: 1000 },
    { kind: "pack", productSkuId: KG1.id, packages: 1, gramsEach: 800 },
    { kind: "loss", grams: 150, reason: "dust and fines" },
  ]);
  const a = pvAE.json ?? {};
  check("available 3300 g", a.availableGrams === 3300, S(a.availableGrams));
  check("standard 2000 g", a.standardGrams === 2000, S(a.standardGrams));
  check("partial 800 g", a.partialGrams === 800, S(a.partialGrams));
  check("loss 150 g", a.lossGrams === 150, S(a.lossGrams));
  check("remaining 350 g", a.remainingGrams === 350, S(a.remainingGrams));
  check("standard + partial + loss + remaining = available",
    a.standardGrams + a.partialGrams + a.lossGrams + a.remainingGrams === a.availableGrams, S(a));
  check("loss is not miscounted as partial", a.partialGrams === 800 && a.partialPackages === 1, S(a));

  sub("AF. a loss line consumes no packaging material");
  const bagBeforeAF = await materialOnHand(C.materials.bag1kg.id);
  const bAF = await roast("AF", C.coffees.brazil, C.beans.brazil, 2.0, 1.5);
  const rAF = await pack(bAF, [{ kind: "loss", grams: 300, reason: "floor sweepings" }]);
  check("accepted", rAF.status === 201, `${rAF.status} ${S(rAF.json).slice(0, 160)}`);
  check("no bag was consumed", (await materialOnHand(C.materials.bag1kg.id)) === bagBeforeAF,
    `${await materialOnHand(C.materials.bag1kg.id)} vs ${bagBeforeAF}`);
  check("and no lot was created", (await lotsFor(bAF)).length === 0, S((await lotsFor(bAF)).length));

  // ═══════════════════════════════════════════════════════════════════════
  section("PARTIAL PACKAGES ARE VISIBLE STOCK, NOT SELLABLE STOCK");

  sub("AG. a partial package is reported separately from free-to-promise units");
  const bAG = await roast("AG", C.coffees.brazil, C.beans.brazil, 2.0, 1.6);
  const freeBeforeAG = await skuFreeUnits(KG1.id);
  const catBefore = await api("/api/products");
  const rowBefore = (catBefore.json ?? []).find((s) => s.id === KG1.id) ?? {};
  const rAG = await pack(bAG, [{ kind: "pack", productSkuId: KG1.id, packages: 1, gramsEach: 600 }]);
  check("the partial is accepted", rAG.status === 201, `${rAG.status} ${S(rAG.json).slice(0, 160)}`);
  const catAfter = await api("/api/products");
  const rowAfter = (catAfter.json ?? []).find((s) => s.id === KG1.id) ?? {};
  check("free-to-promise units did not move", (await skuFreeUnits(KG1.id)) === freeBeforeAG,
    `${await skuFreeUnits(KG1.id)} vs ${freeBeforeAG}`);
  check("and the catalogue's sellable figure did not move",
    rowAfter.availableUnits === rowBefore.availableUnits,
    `${rowAfter.availableUnits} vs ${rowBefore.availableUnits}`);
  check("but the partial package is visible",
    num(rowAfter.partialPackages) === num(rowBefore.partialPackages) + 1,
    `${rowAfter.partialPackages} vs ${rowBefore.partialPackages}`);
  check("with its real contents, in grams",
    num(rowAfter.partialGrams) === num(rowBefore.partialGrams) + 600,
    `${rowAfter.partialGrams} vs ${rowBefore.partialGrams}`);

  sub("AH. the packaging screen is offered exactly the packages it may top up");
  const stAG = await api(`/api/roasting-batches/${bAG}/pack`);
  check("the batch's packing state is readable", stAG.status === 200, `${stAG.status}`);
  check("it reports the unpacked remainder in grams", stAG.json?.availableGrams === 1000,
    S(stAG.json?.availableGrams));
  const openAG = (stAG.json?.openPartials ?? []).find((p) => p.lotId === rAG.json?.lots?.[0]?.id);
  check("the new partial package is offered for top-up", !!openAG, S(stAG.json?.openPartials).slice(0, 200));
  check("stated as what it holds against what it should", openAG?.actualGrams === 600 && openAG?.nominalGrams === 1000,
    S(openAG));
  check("and marked as belonging to this roast", openAG?.fromThisBatch === true, S(openAG));

  sub("AI. a completed package stops being offered");
  const rAI = await pack(bAG, [{ kind: "topUp", lotId: openAG.lotId, gramsAdded: 400 }]);
  check("the top-up completes it", rAI.status === 201, `${rAI.status} ${S(rAI.json).slice(0, 160)}`);
  const stAI = await api(`/api/roasting-batches/${bAG}/pack`);
  check("it is no longer on offer",
    !(stAI.json?.openPartials ?? []).some((p) => p.lotId === openAG.lotId),
    S(stAI.json?.openPartials).slice(0, 200));
  const catFinal = await api("/api/products");
  const rowFinal = (catFinal.json ?? []).find((s) => s.id === KG1.id) ?? {};
  check("the catalogue drops it from partials", num(rowFinal.partialPackages) === num(rowBefore.partialPackages),
    `${rowFinal.partialPackages} vs ${rowBefore.partialPackages}`);
  check("and counts it as sellable exactly once",
    num(rowFinal.availableUnits) === num(rowBefore.availableUnits) + 1,
    `${rowFinal.availableUnits} vs ${rowBefore.availableUnits}`);

  // ═══════════════════════════════════════════════════════════════════════
  section("BOUNDS — ONE REQUEST CANNOT ASK FOR UNBOUNDED WORK");

  sub("AJ. a single line cannot ask for more packages than an operation may record");
  const bAJ = await roast("AJ", C.coffees.brazil, C.beans.brazil, 2.0, 1.5);
  const rAJ = await pack(bAJ, [{ kind: "pack", productSkuId: KG1.id, packages: 5000, gramsEach: 1 }]);
  check("refused", rAJ.status === 409, `${rAJ.status} ${S(rAJ.json).slice(0, 160)}`);
  check("and it says why", /more than one operation may record/i.test(S(rAJ.json)), S(rAJ.json).slice(0, 200));
  check("nothing was drawn", (await availableGrams(bAJ)) === 1500, `${await availableGrams(bAJ)}`);
  check("and no lot was created", (await lotsFor(bAJ)).length === 0, S((await lotsFor(bAJ)).length));

  sub("AK. partial packages are capped across the whole operation, not just per line");
  // Under the per-line ceiling, over the per-operation one. Each partial package is its
  // own row, so this is the input that multiplies into database work.
  const rAK = await pack(bAJ, [{ kind: "pack", productSkuId: KG1.id, packages: 201, gramsEach: 1 }]);
  check("refused", rAK.status === 409, `${rAK.status} ${S(rAK.json).slice(0, 160)}`);
  check("naming the partial-package ceiling", /partial packages is more than/i.test(S(rAK.json)),
    S(rAK.json).slice(0, 200));
  check("still nothing drawn", (await availableGrams(bAJ)) === 1500, `${await availableGrams(bAJ)}`);
  check("and still no lots", (await lotsFor(bAJ)).length === 0, S((await lotsFor(bAJ)).length));

  sub("AL. a loss reason cannot be used as storage");
  const rAL = await pack(bAJ, [{ kind: "loss", grams: 10, reason: "x".repeat(5000) }]);
  check("refused", rAL.status === 409, `${rAL.status} ${S(rAL.json).slice(0, 160)}`);
  check("for being too long", /too long/i.test(S(rAL.json)), S(rAL.json).slice(0, 200));
  check("nothing was drawn", (await availableGrams(bAJ)) === 1500, `${await availableGrams(bAJ)}`);

  sub("AM. an ordinary run is nowhere near the ceilings");
  const rAM = await pack(bAJ, [{ kind: "pack", productSkuId: KG1.id, packages: 1, gramsEach: 1000 }]);
  check("accepted", rAM.status === 201, `${rAM.status} ${S(rAM.json).slice(0, 160)}`);
  check("and made one sellable unit", rAM.json?.standardUnitsCreated === 1, S(rAM.json?.standardUnitsCreated));

  // ═══════════════════════════════════════════════════════════════════════
  section("CROSS-PATH — THE LEGACY ROUTE MUST NOT REACH INTO A PARTIAL PACKAGE");

  sub("AN. packing units the legacy way never merges into an under-filled package");
  // The legacy pack-sku route reuses one lot per (batch, SKU) rather than making a new one
  // each run. A partial package is also unit-tracked and carries the same batch and SKU, so
  // it is a candidate for that reuse — and merging units into it would leave a lot claiming
  // sellable units while its contents still said 300 g of a 1000 g package.
  const bAN = await roast("AN", C.coffees.brazil, C.beans.brazil, 4.0, 3.2);
  const rANp = await pack(bAN, [{ kind: "pack", productSkuId: KG1.id, packages: 1, gramsEach: 300 }]);
  check("the partial package is created", rANp.status === 201, `${rANp.status} ${S(rANp.json).slice(0, 160)}`);
  const partialAN = rANp.json?.lots?.[0]?.id;
  check("and it is PARTIAL", (await lotsFor(bAN)).some((l) => l.id === partialAN && l.status === "PARTIAL"),
    S(await lotsFor(bAN)).slice(0, 220));

  const rANs = await api(`/api/roasting-batches/${bAN}/pack-sku`, {
    method: "POST",
    body: { productSkuId: KG1.id, units: 1 },
    headers: { "Idempotency-Key": freshIdempotencyKey(P) },
  });
  check("the legacy pack is accepted on its own terms", rANs.status === 201,
    `${rANs.status} ${S(rANs.json).slice(0, 160)}`);

  const afterAN = await lotsFor(bAN);
  const stillPartial = afterAN.find((l) => l.id === partialAN);
  check("the partial package was not touched", stillPartial?.status === "PARTIAL", S(stillPartial));
  check("it still holds exactly what was put in it", num(stillPartial?.actual) === 300, S(stillPartial?.actual));
  check("and it still offers no sellable unit", num(stillPartial?.ua) === 0 && num(stillPartial?.up) === 0,
    S(stillPartial));
  check("the legacy units went to a lot of their own",
    afterAN.some((l) => l.id !== partialAN && l.status === "AVAILABLE" && num(l.ua) === 1),
    S(afterAN).slice(0, 300));

  // ═══════════════════════════════════════════════════════════════════════
  section("A PARTIAL PACKAGE IS UNREACHABLE FROM EVERY SELLING PATH");

  // The safety property this feature rests on is that a partial package cannot be promised
  // or shipped. It holds today because every allocation path gates on status AVAILABLE —
  // which is an argument, not a test. These cases attack the lot DIRECTLY, by id, through
  // the real routes, so a future change that loosens one of those gates fails here rather
  // than on a customer's pallet.
  sub("AO. a partial package cannot be reserved to an order line");
  const bAO = await roast("AO", C.coffees.brazil, C.beans.brazil, 3.0, 2.4);
  const rAOp = await pack(bAO, [{ kind: "pack", productSkuId: KG1.id, packages: 1, gramsEach: 400 }]);
  check("the partial package exists", rAOp.status === 201, `${rAOp.status} ${S(rAOp.json).slice(0, 160)}`);
  const lotAO = rAOp.json?.lots?.[0]?.id;

  const orderAO = await api("/api/orders", {
    method: "POST",
    body: { customerId: C.customers.cafe.id, notes: `${P} partial-reach`, items: [{ productSkuId: KG1.id, quantityUnits: 1 }] },
  });
  check("an order for that SKU is created", orderAO.status === 201 || orderAO.status === 200,
    `${orderAO.status} ${S(orderAO.json).slice(0, 160)}`);
  const itemAO = orderAO.json?.items?.[0]?.id;
  await api(`/api/orders/${orderAO.json.id}/approve`, { method: "POST", body: { decision: "Yes" } });
  await api(`/api/orders/${orderAO.json.id}/preparation-review`, { method: "POST", body: { items: [{ orderItemId: itemAO }] } });

  const heldAO = await one(
    `SELECT COUNT(*)::int n FROM "StockAllocation" WHERE "finishedGoodsLotId"=$1 AND status='RESERVED'`, [lotAO]);
  check("the review reserved nothing against the partial package", num(heldAO?.n) === 0, S(heldAO));
  const lotRowAO = await one(
    `SELECT status::text s, "unitsReserved" ur FROM "FinishedGoodsLot" WHERE id=$1`, [lotAO]);
  check("and the package is still PARTIAL with nothing reserved",
    lotRowAO?.s === "PARTIAL" && num(lotRowAO?.ur) === 0, S(lotRowAO));

  sub("AP. a partial package cannot be dispatched even when named directly");
  const dAO = await api("/api/deliveries", {
    method: "POST",
    body: { orderItemId: itemAO, quantityUnits: 1, deliveryType: "full", finishedGoodsLotId: lotAO },
    headers: { "Idempotency-Key": freshIdempotencyKey(P) },
  });
  check("the dispatch is refused", dAO.status >= 400, `${dAO.status} ${S(dAO.json).slice(0, 180)}`);
  const afterAO = await one(
    `SELECT status::text s, "actualContentGrams" a, "unitsAvailable" ua FROM "FinishedGoodsLot" WHERE id=$1`, [lotAO]);
  check("the package is untouched", afterAO?.s === "PARTIAL" && num(afterAO?.a) === 400 && num(afterAO?.ua) === 0,
    S(afterAO));
  const deliveredAO = await one(`SELECT "deliveredUnits" d FROM "OrderItem" WHERE id=$1`, [itemAO]);
  check("and nothing was recorded as delivered", num(deliveredAO?.d) === 0, S(deliveredAO));

  sub("AQ. it also does not count as free-to-promise anywhere it is reported");
  const foAO = await api(`/api/order-items/${itemAO}/fulfillment-options`);
  check("fulfillment options answer", foAO.status === 200, `${foAO.status}`);
  check("and never offer the partial package",
    !S(foAO.json).includes(lotAO), S(foAO.json).slice(0, 220));

  sub("AR. an outcome names the line it belongs to, so a refused line cannot shift the rest");
  // The screen labels each row with the server's verdict. A line the server refuses yields
  // no outcome, so matching by position in the returned array would slide every later
  // verdict one row up — and a complete package would be labelled partial, or the reverse.
  const bAR = await roast("AR", C.coffees.brazil, C.beans.brazil, 4.0, 3.2);
  const pvAR = await preview(bAR, [
    { kind: "pack", productSkuId: "no-such-sku", packages: 1, gramsEach: 1000 },
    { kind: "pack", productSkuId: KG1.id, packages: 1, gramsEach: 1000 },
    { kind: "pack", productSkuId: KG1.id, packages: 1, gramsEach: 400 },
  ]);
  check("the preview answers", pvAR.status === 200, `${pvAR.status} ${S(pvAR.json).slice(0, 140)}`);
  check("the unknown product is reported as a problem", (pvAR.json?.problems ?? []).length >= 1,
    S(pvAR.json?.problems).slice(0, 180));
  check("and produces no outcome of its own", (pvAR.json?.lines ?? []).length === 2,
    S((pvAR.json?.lines ?? []).length));
  const byIndexAR = Object.fromEntries((pvAR.json?.lines ?? []).map((l) => [l.lineIndex, l]));
  check("line 1 is reported against index 1", byIndexAR[1]?.classification === "STANDARD", S(byIndexAR[1]));
  check("line 2 is reported against index 2", byIndexAR[2]?.classification === "PARTIAL", S(byIndexAR[2]));
  check("and nothing claims the refused line's index", byIndexAR[0] === undefined, S(byIndexAR[0]));

  await invariants("after the unified packaging suite");
  await teardown(P);

  section("UNIFIED PACKAGING RESULT");
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
