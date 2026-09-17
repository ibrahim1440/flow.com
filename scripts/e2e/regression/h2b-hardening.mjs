// H2B — DISPATCH IDEMPOTENCY, PIN CREDENTIALS AND PIN-SPACE THROTTLING.
//
// Three defects, one migration (#18), and the contract changes that follow from them.
//
// ── A dispatch with no identity ─────────────────────────────────────────────
// POST /api/deliveries had no request identity at all. A retry after an ambiguous outcome —
// the transaction committed, the response never arrived — created a second Delivery, applied
// the quantity again and drew the stock again. The ordered-quantity ceiling bounded how much
// damage that could do; it never noticed that the retry WAS the first request. H2A measured
// this rather than fixing it, and section G of that suite recorded the result. Bounded
// damage is not idempotency.
//
// ── A lookup column that was the credential ─────────────────────────────────
// `Employee.pinHash` was an unsalted SHA-256 of the PIN, unique-indexed so login could find a
// row in one query. Over a six-digit space that is not a hash: the whole candidate space
// hashes in one pass, and with no salt the resulting table matches every row at once. bcrypt
// on `Employee.pin` slows an attacker holding only that column and does nothing at all when
// the answer is printed in the next one. `pinLookup` is the same idea under a key the
// database does not contain.
//
// ── A throttle that could never accumulate ──────────────────────────────────
// On PIN-only login the identifier IS the candidate, so 000000, 000001, 000002 each hash
// differently and no per-identifier threshold ever reaches its limit. Per-IP and
// per-(IP, candidate) counting bounds one address and one guess; neither bounds a
// distributed walk of the PIN space. The PIN_GLOBAL marker gives that walk a countable
// identity — and the accounting around it has to stay exact, because the same
// isIpRateLimited() serves login, both destructive resets and the self-service PIN change.
//
// ── What this suite is ──────────────────────────────────────────────────────
// D1–D15 prove the dispatch contract, P1–P18 the PIN rule and its cutover, R1–R13 the
// rate-limit accounting. The pure halves import the SHIPPED modules directly rather than
// restating their rules, so a change to either side shows up here.
import {
  ADMIN_PIN, db, api, check, section, sub, one, all, num, invariants, loginAs,
  results, BASE, finish, freshIdempotencyKey, pinLookupValue, pinVerifierInput, PIN_LOOKUP_SECRET,
} from "./harness.mjs";
import { buildCatalog, teardown, roastAndPass } from "./catalog.mjs";
import { createRequire } from "node:module";
import { createHash, createHmac } from "node:crypto";
// The application's own modules. Node strips the types, so this needs no build step — and
// it means these cases exercise the rules the server runs, not copies of them.
import { PIN_LENGTH, PIN_FORMAT_MESSAGE, validatePin, isValidPin } from "../../../src/lib/pin-policy.ts";
import { evaluatePinLookupSecret, pinLookup } from "../../../src/lib/pin-lookup.ts";
import {
  readDeliveryRequestKey, normalizeDeliveryIntent, deliveryIntentHash,
} from "../../../src/lib/services/delivery-idempotency.ts";

// bcrypt, to prove the stored verifier accepts the derived input and rejects the raw PIN.
const bcrypt = createRequire(import.meta.url)("bcryptjs");

const S = (v) => { try { return JSON.stringify(v) ?? String(v); } catch { return String(v); } };
const P = "H2B";
let C;

const sha256 = (v) => createHash("sha256").update(v).digest("hex");

// ─────────────────────────────────────────────────────────────────────────────
//  Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** A dispatch. `key === null` sends no header at all; otherwise the key is exact. */
const dispatch = (body, key) =>
  api("/api/deliveries", {
    method: "POST",
    body,
    ...(key === null ? { noIdempotencyKey: true } : { headers: { "Idempotency-Key": key } }),
  });

/**
 * A login that does NOT touch the shared cookie jar and can claim any address.
 *
 * Both properties matter. The rate-limit cases need many logins from many addresses without
 * losing the administrator session the rest of the suite runs under, and extractIp() reads
 * x-forwarded-for — which is how one test client can stand in for a distributed walk.
 */
async function rawLogin(ip, body) {
  const res = await fetch(BASE + "/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json", ...(ip ? { "x-forwarded-for": ip } : {}) },
    body: JSON.stringify(body),
    redirect: "manual",
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, json };
}

/** A Request carrying only the header under test — the argument the route actually passes. */
const keyRequest = (value) =>
  new Request("http://localhost/api/deliveries", {
    method: "POST",
    headers: value === undefined ? {} : { "Idempotency-Key": value },
  });

/** An approved, preparation-reviewed order with one SKU line. */
async function skuOrder(note, sku, units) {
  const r = await api("/api/orders", {
    method: "POST",
    body: {
      customerId: C.customers.cafe.id,
      notes: `${P} ${note}`,
      items: [{ productSkuId: sku.id, quantityUnits: units }],
    },
  });
  if (r.status !== 201) throw new Error(`order create failed: ${S(r.json)}`);
  await api(`/api/orders/${r.json.id}/approve`, { method: "POST", body: { decision: "Yes" } });
  await api(`/api/orders/${r.json.id}/preparation-review`, {
    method: "POST", body: { items: r.json.items.map((i) => ({ orderItemId: i.id })) },
  });
  return { id: r.json.id, itemId: r.json.items[0].id, sku };
}

const snapshot = async (itemId, lotId) => ({
  deliveries: num((await one(
    `SELECT COUNT(*)::int n FROM "Delivery" WHERE "orderItemId"=$1`, [itemId])).n),
  deliveredUnits: num((await one(
    `SELECT "deliveredUnits" n FROM "OrderItem" WHERE id=$1`, [itemId])).n),
  lotUnits: num((await one(
    `SELECT "unitsAvailable" n FROM "FinishedGoodsLot" WHERE id=$1`, [lotId])).n),
  movements: num((await one(
    `SELECT COUNT(*)::int n FROM "InventoryMovement"
      WHERE "sourceDocType"='DELIVERY' AND "referenceEntityId"=$1`, [lotId])).n),
});

const same = (a, b) =>
  a.deliveries === b.deliveries && a.deliveredUnits === b.deliveredUnits &&
  a.lotUnits === b.lotUnits && a.movements === b.movements;

// pinHash is not selected: migration #19 dropped the column. The assertions that used to
// read it checked that Version B never wrote it — a property the schema now enforces
// outright, and which P13b below proves once by asserting the column is gone.
const employeeCreds = (id) => one(
  `SELECT pin, "pinLookup" FROM "Employee" WHERE id=$1`, [id]);

const attemptRows = () => all(
  `SELECT "ipHash", "identifierHash" FROM "LoginAttempt" ORDER BY "createdAt"`);

const clearAttempts = () => db.query(`DELETE FROM "LoginAttempt"`);

/** PIN_GLOBAL, discovered empirically in R1 rather than recomputed from the pepper. */
let marker = null;

// ─────────────────────────────────────────────────────────────────────────────
//  D — DISPATCH IDEMPOTENCY
// ─────────────────────────────────────────────────────────────────────────────

async function sectionD() {
  section("D — DISPATCH IDEMPOTENCY (D1-D15)");

  const batch = await roastAndPass(P, C.coffees.brazil, C.beans.brazil, 36, 30, 6, "D");
  if (!batch.id) throw new Error(`fixture roast failed: ${S(batch.error?.json ?? batch)}`);
  const packed = await api(`/api/roasting-batches/${batch.id}/pack-sku`, {
    method: "POST", body: { productSkuId: C.skus.bra250.id, units: 90 },
  });
  if (packed.status !== 201 && packed.status !== 200) {
    throw new Error(`fixture packing failed: ${S(packed.json)}`);
  }
  const lot = await one('SELECT id FROM "FinishedGoodsLot" WHERE "packedFromBatchId"=$1', [batch.id]);

  const oA = await skuOrder("idempotency A", C.skus.bra250, 12);
  const oB = await skuOrder("idempotency B", C.skus.bra250, 8);
  const oC = await skuOrder("idempotency C", C.skus.bra250, 6);

  const bodyA = {
    orderItemId: oA.itemId, quantityUnits: 4, deliveryType: "partial",
    finishedGoodsLotId: lot.id, notes: `${P} first dispatch`,
  };

  // ── The key grammar, before anything is shipped ──────────────────────────
  sub("D1. a dispatch without a key is refused, and ships nothing");
  const before1 = await snapshot(oA.itemId, lot.id);
  const d1 = await dispatch(bodyA, null);
  const after1 = await snapshot(oA.itemId, lot.id);
  check("a missing Idempotency-Key is a 400", d1.status === 400, `status=${d1.status} ${S(d1.json)}`);
  check("and the refusal names the header", /idempotency-key/i.test(S(d1.json)), S(d1.json).slice(0, 120));
  check("nothing was dispatched", same(before1, after1), `${S(before1)} -> ${S(after1)}`);
  check("the pure reader agrees a missing header is refused",
    readDeliveryRequestKey(keyRequest(undefined)).ok === false);

  sub("D2. a blank or whitespace-only key is refused");
  const d2 = await dispatch(bodyA, "   ");
  check("whitespace is not a key", d2.status === 400, `status=${d2.status}`);
  check("nor is the empty string", readDeliveryRequestKey(keyRequest("")).ok === false);
  check("the pure reader refuses whitespace too",
    readDeliveryRequestKey(keyRequest("  \t ")).ok === false);

  sub("D3. a key outside the certified charset is refused");
  // Not a newline: the Headers API refuses one outright, so such a value can never reach
  // the route at all — the transport rejects that shape before the application sees it.
  const illegal = ["has space", "slash/es", "semi;colon", "quote\"d", "comma,d", "brace{s}"];
  let illegalRefused = 0;
  for (const bad of illegal) if (readDeliveryRequestKey(keyRequest(bad)).ok === false) illegalRefused++;
  check("every illegal character is refused by the reader",
    illegalRefused === illegal.length, `${illegalRefused}/${illegal.length}`);
  const d3 = await dispatch(bodyA, "has space");
  check("and the route refuses one over HTTP", d3.status === 400, `status=${d3.status}`);
  check("the certified dialect is still accepted",
    readDeliveryRequestKey(keyRequest("aZ0._:-")).ok === true);

  sub("D4. an over-length key is refused");
  const long = "k".repeat(201);
  check("201 characters is too long", readDeliveryRequestKey(keyRequest(long)).ok === false);
  check("200 characters is not", readDeliveryRequestKey(keyRequest("k".repeat(200))).ok === true);
  const d4 = await dispatch(bodyA, long);
  check("the route refuses it too", d4.status === 400, `status=${d4.status}`);

  // ── One dispatch, one key ────────────────────────────────────────────────
  sub("D6. the first dispatch is created and the key is recorded on it");
  const keyA = `${P}-A-${freshIdempotencyKey()}`;
  const beforeA = await snapshot(oA.itemId, lot.id);
  const first = await dispatch(bodyA, keyA);
  const afterFirst = await snapshot(oA.itemId, lot.id);
  check("a fresh dispatch is 201", first.status === 201, `status=${first.status} ${S(first.json)}`);
  const row = await one(
    `SELECT id, "requestKey", "intentHash", "quantityUnits" FROM "Delivery" WHERE "orderItemId"=$1`,
    [oA.itemId]);
  check("the Delivery carries the key it was created under", row?.requestKey === keyA, S(row?.requestKey));
  check("and the hash of the intent it executed",
    row?.intentHash === deliveryIntentHash(normalizeDeliveryIntent(bodyA).intent),
    `${row?.intentHash}`);
  check("four units left the lot", beforeA.lotUnits - afterFirst.lotUnits === 4,
    `${beforeA.lotUnits} -> ${afterFirst.lotUnits}`);

  sub("D5. a padded key is the same key");
  const padded = await dispatch(bodyA, `  ${keyA}  `);
  check("surrounding whitespace is trimmed, not rejected", padded.status === 200, `status=${padded.status}`);
  check("and it replays the original row", padded.json?.id === row.id, `${padded.json?.id} vs ${row.id}`);

  sub("D7. an exact replay returns the original dispatch");
  const replay = await dispatch(bodyA, keyA);
  check("a replay is 200, not 201", replay.status === 200, `status=${replay.status} ${S(replay.json)}`);
  check("and it is the same delivery", replay.json?.id === row.id, `${replay.json?.id} vs ${row.id}`);

  sub("D8. the replay created no second delivery");
  const afterReplay = await snapshot(oA.itemId, lot.id);
  check("still exactly one Delivery for the line", afterReplay.deliveries === 1, String(afterReplay.deliveries));
  check("delivered units did not move", afterReplay.deliveredUnits === afterFirst.deliveredUnits,
    `${afterFirst.deliveredUnits} -> ${afterReplay.deliveredUnits}`);

  sub("D9. and drew no second unit and wrote no second ledger row");
  check("the lot is untouched by the replay", afterReplay.lotUnits === afterFirst.lotUnits,
    `${afterFirst.lotUnits} -> ${afterReplay.lotUnits}`);
  check("one delivery movement, not two", afterReplay.movements === afterFirst.movements,
    `${afterFirst.movements} -> ${afterReplay.movements}`);

  sub("D10. the same key with a different quantity is refused");
  const beforeMismatch = await snapshot(oA.itemId, lot.id);
  const mismatchQty = await dispatch({ ...bodyA, quantityUnits: 5 }, keyA);
  const afterMismatch = await snapshot(oA.itemId, lot.id);
  check("a changed quantity under a used key is 422", mismatchQty.status === 422,
    `status=${mismatchQty.status} ${S(mismatchQty.json)}`);
  check("nothing moved", same(beforeMismatch, afterMismatch), `${S(beforeMismatch)} -> ${S(afterMismatch)}`);

  sub("D11. and so is the same key with different notes");
  const mismatchNotes = await dispatch({ ...bodyA, notes: `${P} something else` }, keyA);
  check("notes are part of what the key promised", mismatchNotes.status === 422,
    `status=${mismatchNotes.status}`);
  check("an absent note differs from a present one",
    deliveryIntentHash(normalizeDeliveryIntent({ ...bodyA, notes: undefined }).intent) !==
    deliveryIntentHash(normalizeDeliveryIntent(bodyA).intent));

  sub("D12. property order is not part of the identity");
  const reordered = {
    notes: bodyA.notes, finishedGoodsLotId: bodyA.finishedGoodsLotId,
    deliveryType: bodyA.deliveryType, quantityUnits: bodyA.quantityUnits,
    orderItemId: bodyA.orderItemId,
  };
  check("the same values in any order hash the same",
    deliveryIntentHash(normalizeDeliveryIntent(reordered).intent) ===
    deliveryIntentHash(normalizeDeliveryIntent(bodyA).intent));
  const reorderedReplay = await dispatch(reordered, keyA);
  check("so a reordered body still replays", reorderedReplay.status === 200,
    `status=${reorderedReplay.status} ${S(reorderedReplay.json)}`);
  check("and returns the same delivery", reorderedReplay.json?.id === row.id, S(reorderedReplay.json?.id));

  sub("D13. a dispatch may name exactly one quantity axis");
  const both = normalizeDeliveryIntent({ ...bodyA, quantityKg: 1 });
  check("both axes at once is refused by the normalizer", both.ok === false, S(both.message));
  check("neither axis is refused too",
    normalizeDeliveryIntent({ orderItemId: "x", finishedGoodsLotId: "y", deliveryType: "full" }).ok === false);
  const d13 = await dispatch({ ...bodyA, quantityKg: 1 }, `${P}-D13-${freshIdempotencyKey()}`);
  check("and by the route", d13.status === 400, `status=${d13.status} ${S(d13.json)}`);

  sub("D14. the wrong axis is refused, and a refused dispatch does not bind its key");
  const keyB = `${P}-B-${freshIdempotencyKey()}`;
  const wrongAxis = await dispatch({
    orderItemId: oB.itemId, quantityKg: 1, deliveryType: "partial", finishedGoodsLotId: lot.id,
  }, keyB);
  check("kilograms on a unit line is a 400", wrongAxis.status === 400,
    `status=${wrongAxis.status} ${S(wrongAxis.json)}`);
  const boundAfterRefusal = await one('SELECT id FROM "Delivery" WHERE "requestKey"=$1', [keyB]);
  check("the key was not consumed by the refusal", boundAfterRefusal === undefined, S(boundAfterRefusal));
  const retryOnSameKey = await dispatch({
    orderItemId: oB.itemId, quantityUnits: 3, deliveryType: "partial", finishedGoodsLotId: lot.id,
  }, keyB);
  check("so a corrected retry on that key succeeds", retryOnSameKey.status === 201,
    `status=${retryOnSameKey.status} ${S(retryOnSameKey.json)}`);

  sub("D15. two identical requests at once ship exactly once");
  const keyC = `${P}-C-${freshIdempotencyKey()}`;
  const bodyC = {
    orderItemId: oC.itemId, quantityUnits: 3, deliveryType: "partial", finishedGoodsLotId: lot.id,
  };
  const beforeC = await snapshot(oC.itemId, lot.id);
  const [c1, c2] = await Promise.all([dispatch(bodyC, keyC), dispatch(bodyC, keyC)]);
  const afterC = await snapshot(oC.itemId, lot.id);
  const codes = [c1.status, c2.status].sort();
  console.log(`    concurrent: ${c1.status}/${c2.status}`);
  check("neither returned a server error", c1.status !== 500 && c2.status !== 500, S(codes));
  check("neither deadlocked", !/deadlock|40P01/i.test(S(c1.json) + S(c2.json)),
    (S(c1.json) + S(c2.json)).slice(0, 140));
  check("one created the dispatch and the other replayed it",
    codes[0] === 200 && codes[1] === 201, S(codes));
  check("both answers describe the same delivery", c1.json?.id === c2.json?.id,
    `${c1.json?.id} vs ${c2.json?.id}`);
  check("exactly one Delivery row exists for the line", afterC.deliveries === 1, String(afterC.deliveries));
  check("three units were delivered, not six",
    afterC.deliveredUnits - beforeC.deliveredUnits === 3,
    `${beforeC.deliveredUnits} -> ${afterC.deliveredUnits}`);
  check("and three units left the lot, not six", beforeC.lotUnits - afterC.lotUnits === 3,
    `${beforeC.lotUnits} -> ${afterC.lotUnits}`);
  check("one ledger row for one shipment", afterC.movements - beforeC.movements === 1,
    `${beforeC.movements} -> ${afterC.movements}`);

  sub("D16. authorization precedes key handling — an unauthenticated dispatch discloses no key state");
  // No cookie at all: requireSub("dispatch","mark_delivered") runs before readDeliveryRequestKey,
  // so the caller is refused by authorization and never learns whether a key exists or is missing.
  const noAuth = await fetch(BASE + "/api/deliveries", {
    method: "POST",
    headers: { "content-type": "application/json" }, // deliberately no cookie and no Idempotency-Key
    body: JSON.stringify({ orderItemId: "x", finishedGoodsLotId: "x", quantityUnits: 1 }),
    redirect: "manual",
  });
  const noAuthBody = await noAuth.text();
  check("it is rejected by authorization (401/403)", noAuth.status === 401 || noAuth.status === 403,
    `status=${noAuth.status}`);
  check("the missing-key 400 is never reached, so key state is not disclosed",
    noAuth.status !== 400 && !/idempotency-key/i.test(noAuthBody), noAuthBody.slice(0, 120));

  await invariants("after the dispatch idempotency cases");
}

// ─────────────────────────────────────────────────────────────────────────────
//  P — PIN POLICY, LOOKUP AND CUTOVER
// ─────────────────────────────────────────────────────────────────────────────

async function sectionP() {
  section("P — PIN POLICY, KEYED LOOKUP AND CUTOVER (P1-P18)");

  const GOOD = "A".repeat(32);

  sub("P1. exactly six digits, and nothing else, is a PIN");
  check("the policy length is six", PIN_LENGTH === 6, String(PIN_LENGTH));
  check("a six-digit string is accepted", validatePin("123456").ok === true);
  check("the accepted value is returned unchanged", validatePin("123456").pin === "123456");
  check("isValidPin agrees with validatePin",
    isValidPin("123456") === true && isValidPin("12345") === false);

  sub("P2. five or seven digits are not");
  for (const bad of ["12345", "1234567", "1", ""]) {
    check(`"${bad}" is refused`, validatePin(bad).ok === false);
  }
  check("the message names the rule", validatePin("12345").message === PIN_FORMAT_MESSAGE,
    S(validatePin("12345").message));
  const short = await rawLogin(null, { method: "pin", pin: "12345" });
  check("and login refuses a five-digit candidate with 400", short.status === 400,
    `status=${short.status} ${S(short.json)}`);

  sub("P3. non-digits are not");
  for (const bad of ["12345a", "abcdef", "12-456", "12 456", "+12345"]) {
    check(`"${bad}" is refused`, validatePin(bad).ok === false);
  }
  const alpha = await rawLogin(null, { method: "pin", pin: "abcdef" });
  check("login refuses a non-numeric candidate with 400", alpha.status === 400, `status=${alpha.status}`);

  sub("P4. digits means ASCII digits");
  check("Arabic-Indic digits are not ASCII digits", validatePin("١٢٣٤٥٦").ok === false);
  check("nor are fullwidth digits", validatePin("１２３４５６").ok === false);

  sub("P5. surrounding whitespace is refused, not trimmed");
  check("a leading space is refused", validatePin(" 123456").ok === false);
  check("a trailing space is refused", validatePin("123456 ").ok === false);
  check("a padded six-digit PIN is not silently accepted as six digits",
    validatePin(" 12345 ").ok === false);

  sub("P6. a PIN is a string");
  for (const bad of [123456, null, undefined, {}, ["123456"], true]) {
    check(`${S(bad)} is refused`, validatePin(bad).ok === false);
  }

  sub("P7. leading zeros survive");
  check("012345 is a valid PIN", validatePin("012345").ok === true);
  check("and it stays six characters long", validatePin("012345").pin.length === 6);
  check("it is never parsed into a number", validatePin("012345").pin === "012345");
  check("and it is a different credential from 12345",
    pinLookup("012345", GOOD) !== pinLookup("12345", GOOD));

  sub("P8. a missing lookup secret is refused");
  check("unset is refused", evaluatePinLookupSecret({}).ok === false);
  check("empty is refused", evaluatePinLookupSecret({ PIN_LOOKUP_SECRET: "" }).ok === false);
  check("whitespace is refused", evaluatePinLookupSecret({ PIN_LOOKUP_SECRET: "   " }).ok === false);

  sub("P9. a short lookup secret is refused");
  check("31 characters is too short",
    evaluatePinLookupSecret({ PIN_LOOKUP_SECRET: "x".repeat(31) }).ok === false);
  check("32 characters is not",
    evaluatePinLookupSecret({ PIN_LOOKUP_SECRET: "x".repeat(32) }).ok === true);

  sub("P10. a placeholder lookup secret is refused");
  for (const weak of ["hiqbah-fallback-secret", "replace-this-with-a-strong-random-secret-min-32-chars"]) {
    check(`"${weak.slice(0, 24)}..." is refused`,
      evaluatePinLookupSecret({ PIN_LOOKUP_SECRET: weak }).ok === false);
  }

  sub("P11. a good secret is accepted, and no refusal ever quotes one");
  const ok = evaluatePinLookupSecret({ PIN_LOOKUP_SECRET: GOOD });
  check("a strong value is accepted", ok.ok === true && ok.secret === GOOD);
  const refusals = [
    evaluatePinLookupSecret({}),
    evaluatePinLookupSecret({ PIN_LOOKUP_SECRET: "x".repeat(31) }),
    evaluatePinLookupSecret({ PIN_LOOKUP_SECRET: "hiqbah-fallback-secret" }),
  ];
  check("no reason contains the value it refused",
    refusals.every((r) => !r.reason.includes("x".repeat(8)) && !r.reason.includes("hiqbah")),
    S(refusals.map((r) => r.reason)));

  sub("P12. the lookup is deterministic and keyed");
  check("the same PIN and secret always give the same value",
    pinLookup("123456", GOOD) === pinLookup("123456", GOOD));
  check("a different secret gives a different value",
    pinLookup("123456", GOOD) !== pinLookup("123456", "B".repeat(32)));
  check("it is not the legacy unsalted hash", pinLookup("123456", GOOD) !== sha256("123456"));

  sub("P13. the lookup is domain-separated");
  check("it is not a bare HMAC of the PIN",
    pinLookup("123456", GOOD) !== createHmac("sha256", GOOD).update("123456").digest("base64"));
  check("different PINs give different values",
    pinLookup("123456", GOOD) !== pinLookup("123457", GOOD));
  check("the harness computes the same value the module does",
    pinLookupValue("123456", GOOD) === pinLookup("123456", GOOD));
  check("and the suite is running with the server's own secret",
    typeof PIN_LOOKUP_SECRET === "string" && PIN_LOOKUP_SECRET.trim().length >= 32);

  // ── Live credential paths ────────────────────────────────────────────────
  await loginAs(ADMIN_PIN);

  sub("P13b. the legacy PIN selector is gone from the schema, not merely unused");
  // Migration #19 dropped Employee.pinHash. It was an unsalted SHA-256 of a six-digit PIN —
  // a keyspace of one million — so while the column existed a stolen table still yielded
  // every PIN regardless of what the application did with it. The cases below therefore no
  // longer check it is null; there is nothing left to be null.
  const pinHashCol = await one(
    `SELECT count(*)::int n FROM information_schema.columns
      WHERE table_name='Employee' AND column_name='pinHash'`);
  check("Employee.pinHash no longer exists", num(pinHashCol?.n) === 0, `columns=${pinHashCol?.n}`);

  sub("P14. creating an employee writes the verifier and the keyed lookup");
  const created = await api("/api/employees", {
    method: "POST",
    body: {
      name: `${P} Credential`, username: `${P}_cred`, pin: "661001", role: "qc",
      permissions: { dashboard: { access: "edit" }, qc: { access: "edit" } },
    },
  });
  check("the account is created", created.status === 201, `status=${created.status} ${S(created.json)}`);
  const empId = created.json?.id;
  const c14 = await employeeCreds(empId);
  check("pin holds a bcrypt hash", /^\$2[aby]\$/.test(c14?.pin ?? ""), String(c14?.pin).slice(0, 7));
  check("and it is bcrypt over the derived verifier input, which the PIN produces",
    bcrypt.compareSync(pinVerifierInput("661001"), c14?.pin ?? ""));
  check("the raw PIN does NOT verify against it — no offline verifier survives",
    bcrypt.compareSync("661001", c14?.pin ?? "") === false);
  check("pinLookup holds the keyed selector", c14?.pinLookup === pinLookupValue("661001"),
    String(c14?.pinLookup));
  check("and the PIN logs in", (await rawLogin(null, { method: "pin", pin: "661001" })).status === 200);

  sub("P15. an admin PIN change rewrites the verifier and the lookup and retires the old PIN");
  const edited = await api(`/api/employees/${empId}`, {
    method: "PUT", body: { name: `${P} Credential`, role: "qc", pin: "661002" },
  });
  check("the edit is accepted", edited.status === 200, `status=${edited.status} ${S(edited.json)}`);
  const c15 = await employeeCreds(empId);
  check("the verifier changed", c15?.pin !== c14?.pin);
  check("and it is bcrypt over the new PIN's verifier input",
    bcrypt.compareSync(pinVerifierInput("661002"), c15?.pin ?? ""));
  check("the new raw PIN still does not verify directly",
    bcrypt.compareSync("661002", c15?.pin ?? "") === false);
  check("the lookup is the new PIN's", c15?.pinLookup === pinLookupValue("661002"), String(c15?.pinLookup));
  check("the old PIN no longer authenticates",
    (await rawLogin(null, { method: "pin", pin: "661001" })).status === 401);
  check("the new PIN does", (await rawLogin(null, { method: "pin", pin: "661002" })).status === 200);

  sub("P16. a self-service change rewrites the verifier and the lookup");
  await loginAs("661002");
  const selfChange = await api("/api/profile", {
    method: "PUT", body: { currentPin: "661002", newPin: "661003" },
  });
  check("the change is accepted", selfChange.status === 200, `status=${selfChange.status} ${S(selfChange.json)}`);
  const c16 = await employeeCreds(empId);
  check("the verifier is bcrypt over the new PIN's verifier input",
    bcrypt.compareSync(pinVerifierInput("661003"), c16?.pin ?? ""));
  check("the lookup follows the new PIN", c16?.pinLookup === pinLookupValue("661003"), String(c16?.pinLookup));
  check("and the new PIN logs in", (await rawLogin(null, { method: "pin", pin: "661003" })).status === 200);
  const selfBadShape = await api("/api/profile", {
    method: "PUT", body: { currentPin: "661003", newPin: "1234" },
  });
  check("a four-digit new PIN is refused", selfBadShape.status === 400,
    `status=${selfBadShape.status} ${S(selfBadShape.json)}`);
  await loginAs(ADMIN_PIN);

  sub("P17. login is by keyed lookup only: no lookup, no login");
  await db.query('UPDATE "Employee" SET "pinLookup"=NULL WHERE id=$1', [empId]);
  const inert = await employeeCreds(empId);
  check("the row still carries a valid verifier", /^\$2[aby]\$/.test(inert?.pin ?? ""));
  const noLookup = await rawLogin(null, { method: "pin", pin: "661003" });
  check("but with no lookup the PIN is refused", noLookup.status === 401,
    `status=${noLookup.status} ${S(noLookup.json)}`);
  check("which is exactly the state migration #18 leaves every pre-existing employee in",
    noLookup.status === 401);
  await db.query('UPDATE "Employee" SET "pinLookup"=$2 WHERE id=$1', [empId, pinLookupValue("661003")]);
  check("restoring the lookup restores access",
    (await rawLogin(null, { method: "pin", pin: "661003" })).status === 200);

  sub("P18. a PIN belongs to one employee");
  const dupCreate = await api("/api/employees", {
    method: "POST",
    body: {
      name: `${P} Duplicate`, username: `${P}_dup`, pin: "661003", role: "qc",
      permissions: { dashboard: { access: "view" } },
    },
  });
  check("creating a second employee with that PIN is 409", dupCreate.status === 409,
    `status=${dupCreate.status} ${S(dupCreate.json)}`);
  const other = await api("/api/employees", {
    method: "POST",
    body: {
      name: `${P} Other`, username: `${P}_other`, pin: "661004", role: "qc",
      permissions: { dashboard: { access: "view" } },
    },
  });
  check("a distinct PIN is accepted", other.status === 201, `status=${other.status} ${S(other.json)}`);
  const dupEdit = await api(`/api/employees/${other.json?.id}`, {
    method: "PUT", body: { name: `${P} Other`, role: "qc", pin: "661003" },
  });
  check("editing an employee onto a taken PIN is 409", dupEdit.status === 409,
    `status=${dupEdit.status} ${S(dupEdit.json)}`);
  const uniqueIndex = await one(
    `SELECT indexdef FROM pg_indexes WHERE tablename='Employee' AND indexname='Employee_pinLookup_key'`);
  check("and a unique index is what finally decides",
    /UNIQUE/i.test(uniqueIndex?.indexdef ?? ""), S(uniqueIndex?.indexdef));
}

// ─────────────────────────────────────────────────────────────────────────────
//  R — RATE-LIMIT ACCOUNTING AND PIN-SPACE THROTTLING
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A candidate that is not anybody's PIN.
 *
 * Distinct per call so the per-(address, candidate) limit never fires while the per-address
 * one is under test, and explicitly stepped past the administrator's own PIN — a "miss" that
 * happened to be the real credential would turn a 401 into a 200 and quietly invalidate
 * every count below.
 */
let candidateSeq = 0;
function missPin() {
  for (;;) {
    const p = String(900000 + (candidateSeq++ % 99999));
    if (p !== ADMIN_PIN) return p;
  }
}

/**
 * Make the system-wide burst true, now.
 *
 * R7 proves that real failures produce markers. These three cases are about what happens
 * WHILE the burst is on, and the burst is judged over the last sixty seconds — so a slow
 * database could let the evidence expire between establishing it and measuring it. Topping
 * the marker count up with freshly stamped rows makes the precondition a fact rather than a
 * race. The addresses are synthetic: nothing reads them back, they only have to be distinct.
 */
async function ensureBurst() {
  const live = num((await one(
    `SELECT COUNT(*)::int n FROM "LoginAttempt"
      WHERE "identifierHash"=$1 AND "createdAt" > now() - interval '30 seconds'`, [marker])).n);
  const shortfall = 35 - live;
  for (let i = 0; i < shortfall; i++) {
    await db.query(
      `INSERT INTO "LoginAttempt" ("id","ipHash","identifierHash","createdAt")
       VALUES (gen_random_uuid()::text, $1, $2, now())`,
      [sha256(`${P}-burst-${burstSeq++}`), marker]);
  }
}
let burstSeq = 0;

async function sectionR() {
  section("R — RATE-LIMIT ACCOUNTING AND PIN-SPACE THROTTLING (R1-R13)");

  await clearAttempts();

  sub("R1. the PIN-space marker is a hash, not a readable name");
  await rawLogin("198.51.100.1", { method: "pin", pin: missPin() });
  await rawLogin("198.51.100.1", { method: "pin", pin: missPin() });
  const seed = await attemptRows();
  const counts = new Map();
  for (const r of seed) counts.set(r.identifierHash, (counts.get(r.identifierHash) ?? 0) + 1);
  // Two failures, two different candidates. The identifier they SHARE can only be the
  // synthetic bucket — which is how this suite learns PIN_GLOBAL without being told the
  // pepper that produced it.
  marker = [...counts.entries()].find(([, n]) => n === 2)?.[0];
  check("two different candidates share exactly one identifier — the marker",
    typeof marker === "string", S([...counts.values()]));
  check("the marker is a 64-character hex digest", /^[0-9a-f]{64}$/.test(marker ?? ""),
    String(marker).slice(0, 20));
  check("it is not the readable bucket name", marker !== "bucket:pin-login");
  check("and it is not the unkeyed hash of that name either", marker !== sha256("bucket:pin-login"));

  sub("R2. one failed PIN writes exactly two rows");
  await clearAttempts();
  await rawLogin("198.51.100.2", { method: "pin", pin: missPin() });
  const two = await attemptRows();
  check("two rows, not one and not three", two.length === 2, String(two.length));
  check("both belong to the same address", two[0].ipHash === two[1].ipHash);
  check("one is the candidate and one is the marker",
    two[0].identifierHash !== two[1].identifierHash &&
    two.some((r) => r.identifierHash === marker), S(two.map((r) => r.identifierHash.slice(0, 8))));

  sub("R3. the marker is excluded from the per-address count");
  await clearAttempts();
  const ipA = "198.51.100.10";
  const codesA = [];
  for (let i = 0; i < 30; i++) {
    codesA.push((await rawLogin(ipA, { method: "pin", pin: missPin() })).status);
  }
  const firstThrottled = codesA.indexOf(429);
  check("thirty failures in a row are all answered 401, never 429",
    codesA.every((s) => s === 401),
    firstThrottled >= 0 ? `first 429 at attempt ${firstThrottled + 1}` : S(codesA.slice(0, 8)));
  const rowsA = await all(
    `SELECT "identifierHash" FROM "LoginAttempt" WHERE "identifierHash" <> $1`, [marker]);
  const markersA = await all(
    `SELECT id FROM "LoginAttempt" WHERE "identifierHash" = $1`, [marker]);
  check("thirty candidate rows and thirty markers were written",
    rowsA.length === 30 && markersA.length === 30, `${rowsA.length}/${markersA.length}`);
  check("had markers been counted, the limit would have been hit at attempt 16",
    firstThrottled === -1, String(firstThrottled));

  sub("R4. the per-address PIN allowance still ends at thirty");
  const thirtyFirst = await rawLogin(ipA, { method: "pin", pin: missPin() });
  check("the thirty-first attempt from that address is 429", thirtyFirst.status === 429,
    `status=${thirtyFirst.status}`);
  const otherIp = await rawLogin("198.51.100.11", { method: "pin", pin: ADMIN_PIN });
  check("while a different address is still served", otherIp.status === 200,
    `status=${otherIp.status} ${S(otherIp.json)}`);

  sub("R5. and the password budget for an address is not halved by its PIN markers");
  await clearAttempts();
  const ipB = "198.51.100.20";
  for (let i = 0; i < 20; i++) await rawLogin(ipB, { method: "pin", pin: missPin() });
  const rowsB = num((await one(`SELECT COUNT(*)::int n FROM "LoginAttempt"`)).n);
  check("twenty PIN failures left forty rows for that address", rowsB === 40, String(rowsB));
  const pwd = await rawLogin(ipB, { method: "password", username: `${P}_nobody`, password: "wrong-password" });
  check("a password attempt from it is still judged, not throttled", pwd.status === 401,
    `status=${pwd.status} ${S(pwd.json)}`);

  sub("R6. the per-address, per-candidate allowance still ends at ten");
  await clearAttempts();
  const ipC = "198.51.100.30";
  const oneCandidate = "987654";
  const codesC = [];
  for (let i = 0; i < 11; i++) {
    codesC.push((await rawLogin(ipC, { method: "pin", pin: oneCandidate })).status);
  }
  check("the first ten repeats of one candidate are judged",
    codesC.slice(0, 10).every((s) => s === 401), S(codesC));
  check("the eleventh is throttled", codesC[10] === 429, String(codesC[10]));

  sub("R7. thirty single failures from thirty addresses constrain the PIN space");
  await clearAttempts();
  for (let i = 0; i < 30; i++) {
    await rawLogin(`203.0.113.${i + 1}`, { method: "pin", pin: missPin() });
  }
  const globalMarkers = num((await one(
    `SELECT COUNT(*)::int n FROM "LoginAttempt" WHERE "identifierHash"=$1`, [marker])).n);
  const distinctIps = num((await one(
    `SELECT COUNT(DISTINCT "ipHash")::int n FROM "LoginAttempt"`)).n);
  check("thirty markers, from thirty distinct addresses",
    globalMarkers === 30 && distinctIps === 30, `${globalMarkers} markers / ${distinctIps} addresses`);
  check("no single address is anywhere near its own limit",
    num((await one(`SELECT MAX(c)::int n FROM (
        SELECT COUNT(*) c FROM "LoginAttempt" GROUP BY "ipHash") s`)).n) === 2);

  sub("R8. under constraint a quiet address with the right PIN still gets in");
  await ensureBurst();
  const quiet = await rawLogin("203.0.113.200", { method: "pin", pin: ADMIN_PIN });
  check("an operator who has not just failed is unaffected", quiet.status === 200,
    `status=${quiet.status} ${S(quiet.json)}`);

  sub("R9. under constraint an address that just failed is refused");
  await ensureBurst();
  const ipD = "203.0.113.201";
  const failedOnce = await rawLogin(ipD, { method: "pin", pin: missPin() });
  check("its failure is answered normally", failedOnce.status === 401, String(failedOnce.status));
  const thenCorrect = await rawLogin(ipD, { method: "pin", pin: ADMIN_PIN });
  check("but its very next attempt is 429, even with the right PIN", thenCorrect.status === 429,
    `status=${thenCorrect.status} ${S(thenCorrect.json)}`);
  check("an enumerating address therefore gets about one attempt a minute",
    thenCorrect.status === 429);

  sub("R10. and one quiet for a minute but with three failures in the window still is");
  const ipE = "203.0.113.202";
  await rawLogin(ipE, { method: "pin", pin: missPin() });
  const ipEHash = (await one(
    `SELECT "ipHash" FROM "LoginAttempt" ORDER BY "createdAt" DESC LIMIT 1`)).ipHash;
  // Age this address's own rows past the one-minute burst window, leaving the system-wide
  // burst intact. It is now "quiet" by the sixty-second measure and still has three PIN
  // failures inside the fifteen-minute one — the case the second clause exists for.
  await db.query(
    `UPDATE "LoginAttempt" SET "createdAt" = now() - interval '5 minutes' WHERE "ipHash"=$1`,
    [ipEHash]);
  await db.query(
    `INSERT INTO "LoginAttempt" ("id","ipHash","identifierHash","createdAt")
     VALUES (gen_random_uuid()::text,$1,$2, now() - interval '5 minutes'),
            (gen_random_uuid()::text,$1,$2, now() - interval '4 minutes')`,
    [ipEHash, marker]);
  const aged = num((await one(
    `SELECT COUNT(*)::int n FROM "LoginAttempt" WHERE "ipHash"=$1 AND "identifierHash"=$2`,
    [ipEHash, marker])).n);
  check("the address now has three aged PIN failures and none in the last minute", aged === 3,
    String(aged));
  await ensureBurst();
  const stillBlocked = await rawLogin(ipE, { method: "pin", pin: ADMIN_PIN });
  check("it is still refused under constraint", stillBlocked.status === 429,
    `status=${stillBlocked.status} ${S(stillBlocked.json)}`);

  sub("R11. a successful PIN login clears its marker; a different failed candidate lingers harmlessly");
  await clearAttempts();
  const ipF = "198.51.100.40";
  // One mistype: this writes the wrong candidate's row AND the PIN_GLOBAL marker.
  await rawLogin(ipF, { method: "pin", pin: missPin() });
  const beforeSuccess = num((await one(`SELECT COUNT(*)::int n FROM "LoginAttempt"`)).n);
  const success = await rawLogin(ipF, { method: "pin", pin: ADMIN_PIN });
  const afterRows = await attemptRows();
  check("the correct PIN is accepted", success.status === 200, `status=${success.status}`);
  check("two rows existed before it — the candidate and the marker", beforeSuccess === 2, String(beforeSuccess));
  // clearPinAttempts deletes the marker and the SUCCESS's own candidate. The mistype used a
  // different candidate, so its row is deliberately left: a success clears its pair and the
  // marker, never the whole address (see clearAttempts in rate-limit.ts), so one valid PIN
  // cannot wipe an attacker's per-candidate probing history.
  check("the marker is cleared, so the address stops feeding the global burst",
    afterRows.every((r) => r.identifierHash !== marker), S(afterRows.map((r) => r.identifierHash.slice(0, 8))));
  check("exactly the one different-candidate row remains", afterRows.length === 1, String(afterRows.length));
  check("and what remains is that candidate, not the marker",
    afterRows.length === 1 && afterRows[0].identifierHash !== marker, S(afterRows.map((r) => r.identifierHash.slice(0, 8))));

  sub("R12. the attempt table stores no PIN and no readable bucket name");
  await clearAttempts();
  await rawLogin("198.51.100.50", { method: "pin", pin: "135791" });
  const stored = await attemptRows();
  const blob = S(stored);
  check("the candidate does not appear in the clear", !blob.includes("135791"), blob.slice(0, 120));
  check("nor does the bucket name", !blob.includes("bucket:pin-login"));
  check("every stored value is a 64-character hex digest",
    stored.every((r) => /^[0-9a-f]{64}$/.test(r.ipHash) && /^[0-9a-f]{64}$/.test(r.identifierHash)),
    S(stored.map((r) => r.identifierHash.length)));
  check("and the address is not stored in the clear", !blob.includes("198.51.100.50"));

  sub("R13. a malformed candidate records nothing");
  await clearAttempts();
  const malformed = await rawLogin("198.51.100.60", { method: "pin", pin: "12345" });
  const afterMalformed = num((await one(`SELECT COUNT(*)::int n FROM "LoginAttempt"`)).n);
  check("it is a 400, not a 401", malformed.status === 400, `status=${malformed.status}`);
  check("and the throttle counted nothing: it is for guesses, not garbage",
    afterMalformed === 0, String(afterMalformed));

  sub("R14. a password failure feeds the shared per-IP count but never the PIN-space marker");
  // recordFailedAttempt writes one row; only the PIN path (recordPinFailure) writes the marker.
  // Password, profile and reset all go through recordFailedAttempt, so none of them can inflate
  // the PIN-space burst.
  await clearAttempts();
  const ipPwd = "198.51.100.70";
  const pwdFail = await rawLogin(ipPwd, { method: "password", username: "no-such-user", password: "wrong-password" });
  const pwdRows = await attemptRows();
  check("a bad password is a 401", pwdFail.status === 401, `status=${pwdFail.status} ${S(pwdFail.json)}`);
  check("it records exactly one row", pwdRows.length === 1, String(pwdRows.length));
  check("and that row is NOT the PIN-space marker", pwdRows.every((r) => r.identifierHash !== marker),
    S(pwdRows.map((r) => r.identifierHash.slice(0, 8))));

  sub("R15. thirty PIN failures from one address throttle even a password attempt from it");
  // The per-IP allowance (30) counts the candidate rows and excludes the markers, so thirty
  // PIN misses fill the same shared budget a password login is judged against.
  await clearAttempts();
  const ipMix = "198.51.100.80";
  for (let i = 0; i < 30; i++) await rawLogin(ipMix, { method: "pin", pin: missPin() });
  const mixRows = await attemptRows();
  const mixCandidates = mixRows.filter((r) => r.identifierHash !== marker).length;
  check("thirty candidate rows accrued for that address, markers excluded", mixCandidates === 30, String(mixCandidates));
  const pwdAfter = await rawLogin(ipMix, { method: "password", username: "no-such-user", password: "wrong-password" });
  check("a password attempt from that address is now throttled at 429, not judged",
    pwdAfter.status === 429, `status=${pwdAfter.status} ${S(pwdAfter.json)}`);

  await clearAttempts();
}

// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  await db.connect();
  await loginAs(ADMIN_PIN);
  C = await buildCatalog(P);

  await sectionD();
  await sectionP();
  await sectionR();

  await loginAs(ADMIN_PIN);
  await invariants("after the H2B hardening suite");

  // ── teardown ──────────────────────────────────────────────────────────────
  await db.query(`DELETE FROM "AuthAuditLog" WHERE metadata->>'targetEmployeeId' IN
                    (SELECT id FROM "Employee" WHERE username LIKE '${P}\\_%')`);
  await db.query(`DELETE FROM "Employee" WHERE username LIKE '${P}\\_%'`);
  await db.query(`DELETE FROM "LoginAttempt"`);
  await teardown(P);

  await finish("H2B HARDENING SUMMARY");
}

main().catch(async (e) => {
  console.error("\nFATAL: " + (e?.stack ?? e));
  console.log(`${results.pass} passed, ${results.fail + 1} failed`);
  try { await db.end(); } catch { /* already closed */ }
  process.exit(1);
});
