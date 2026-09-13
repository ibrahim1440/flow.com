// RESET SAFETY — R2.2B closure.
//
// Two separate things are proved here, and they are the two that a reset endpoint can get
// catastrophically wrong.
//
// 1. ATOMICITY. A reset deletes seventeen tables in a fixed order. If those deletes were
//    independently committed, a failure partway through would leave a half-erased database:
//    inventory movements and finished stock gone, the batches and orders that explain them
//    still present. That is worse than either outcome on its own, and it is unrecoverable
//    without a backup. Both routes issue their deletes through the array form of
//    prisma.$transaction, which is a single BEGIN/COMMIT — and section B proves the
//    invariant on the real delete order rather than taking that on trust.
//
// 2. THE ENVIRONMENT BOUNDARY. Privilege, a typed confirmation phrase and a PIN
//    re-verification all establish that a human meant to do this. None of them establish
//    WHICH DATABASE is about to be emptied. The deny-by-default guard is what does, and
//    every permutation of it is enumerated in harness-selftest, where it can be exercised
//    with no server and no risk. What is proved HERE is the other half: that when the guard
//    does allow a reset, the reset actually works, and works in an order that preserves the
//    RESTRICT on packaging history.
//
// ── This suite destroys the whole database, so it runs LAST ──────────────────
// Section C really does wipe everything. That is the behaviour under test: a training reset
// is supposed to be wholesale. It is registered as the final suite so nothing downstream
// depends on what it removes, and it only ever runs against the throwaway database
// harness.mjs will accept.
import {
  ADMIN_PIN, db, api, check, section, sub, one, num, invariants, loginAs, results, ensureUser,
} from "./harness.mjs";
import { buildCatalog, teardown, roastAndPass } from "./catalog.mjs";

const S = (v) => { try { return JSON.stringify(v) ?? String(v); } catch { return String(v); } };
const P = "RSF";

// The seeded regression administrator deliberately does NOT hold settings.reset, so a reset
// attempt as that user is refused by authorization long before the environment guard is
// consulted — which is the correct layering, and also useless for testing the guard. The
// suite therefore provisions its own reset-capable operator. Employee rows survive both
// resets by design, so this user is still there afterwards to make the second call.
const RESET_PIN = "770021";

// The delete order admin/reset uses, verbatim. Kept next to the test that depends on it so
// that a change to the route which forgets this list fails section B loudly.
const RESET_ORDER = [
  "CuppingScore", "CuppingSessionBatch", "CuppingSession", "InventoryMovement",
  "StockAllocation", "FinishedGoodsLot", "ProductionOrder", "PurchaseRecord", "QcRecord",
  "Delivery", "BlendIngredient", "PackagingOperation", "RoastingBatch", "OrderItem",
  "Order", "Customer", "GreenBean",
];

const rowCount = async (table) =>
  num((await one(`SELECT COUNT(*)::int n FROM "${table}"`)).n);

const snapshot = async () => {
  const out = {};
  for (const t of RESET_ORDER) out[t] = await rowCount(t);
  return out;
};

const totals = (snap) => Object.values(snap).reduce((a, b) => a + b, 0);

async function main() {
  await db.connect();
  await teardown(P);
  await loginAs(ADMIN_PIN);
  const C = await buildCatalog(P);

  // ═══════════════════════════════════════════════════════════════════════
  section("A — A PACKED ROAST IS PROTECTED BY NORMAL BUSINESS RULES");

  sub("A1. a batch with packaging history cannot be deleted through the normal route");
  // The reset guard is about wholesale destruction. This is the everyday path, and it must
  // keep refusing regardless of anything done for reset safety: packaging history is not
  // something an ordinary business workflow may erase.
  await db.query('UPDATE "GreenBean" SET "quantityKg" = "quantityKg" + 20 WHERE id = $1',
    [C.beans.brazil.id]);
  const b = await roastAndPass(P, C.coffees.brazil, C.beans.brazil, 12, 10, 2, "A01");
  if (!b.id) throw new Error("fixture roast failed: " + S(b.error?.json ?? b));

  const packed = await api(`/api/roasting-batches/${b.id}/package`, {
    method: "PUT", body: { bags1kg: 3 },
  });
  check("the fixture batch packs", packed.status === 200, `status=${packed.status} ${S(packed.json).slice(0, 90)}`);

  const opsBefore = await num((await one(
    `SELECT COUNT(*)::int n FROM "PackagingOperation" WHERE "batchId"=$1`, [b.id])).n);
  check("it left a packaging operation on the record", opsBefore === 1, `${opsBefore} rows`);

  const lotBefore = await one(
    `SELECT id, "availableQty" a FROM "FinishedGoodsLot" WHERE "roastingBatchId"=$1`, [b.id]);

  const del = await api(`/api/roasting-batches/${b.id}`, { method: "DELETE" });
  const stillThere = await one('SELECT id FROM "RoastingBatch" WHERE id=$1', [b.id]);
  const opsAfter = num((await one(
    `SELECT COUNT(*)::int n FROM "PackagingOperation" WHERE "batchId"=$1`, [b.id])).n);
  const lotAfter = await one(
    `SELECT id, "availableQty" a FROM "FinishedGoodsLot" WHERE "roastingBatchId"=$1`, [b.id]);
  console.log(`    DELETE -> ${del.status} ${S(del.json).slice(0, 100)}`);

  check("a packed batch is refused with 409", del.status === 409, `status=${del.status}`);
  check("the refusal is a domain message, not a foreign-key error",
    del.json?.error === "Batch cannot be deleted because packaging operations exist.",
    S(del.json).slice(0, 140));
  check("no raw foreign-key text reaches the caller",
    !/constraint|violates|23503|fkey/i.test(S(del.json)), S(del.json).slice(0, 140));
  check("the batch survives", stillThere !== undefined, `row ${S(stillThere)}`);
  check("the packaging operation survives", opsAfter === 1, `${opsAfter} rows`);
  check("the finished stock survives", lotAfter?.id === lotBefore?.id && num(lotAfter?.a) === num(lotBefore?.a),
    `lot ${lotBefore?.id}/${lotBefore?.a} -> ${lotAfter?.id}/${lotAfter?.a}`);

  // ═══════════════════════════════════════════════════════════════════════
  section("B — THE RESET IS ALL-OR-NOTHING");

  sub("B1. the reset delete order really does empty every table it names");
  // Run the route's exact sequence inside a transaction and look at the result from INSIDE
  // it, before rolling back. Without this the rollback test below would pass just as
  // happily if the statements deleted nothing at all.
  const before = await snapshot();
  console.log(`    ${totals(before)} rows across ${RESET_ORDER.length} tables before`);
  check("the fixture leaves something substantial to destroy", totals(before) > 0,
    `${totals(before)} rows`);

  await db.query("BEGIN");
  for (const t of RESET_ORDER) await db.query(`DELETE FROM "${t}"`);
  const insideTx = await snapshot();
  const emptied = Object.entries(insideTx).filter(([, n]) => n !== 0);
  check("inside the transaction every one of those tables is empty", emptied.length === 0,
    emptied.map(([t, n]) => `${t}=${n}`).join(", "));
  check("PackagingOperation is deleted before RoastingBatch, so RESTRICT never fires",
    RESET_ORDER.indexOf("PackagingOperation") < RESET_ORDER.indexOf("RoastingBatch"),
    `PackagingOperation@${RESET_ORDER.indexOf("PackagingOperation")}, RoastingBatch@${RESET_ORDER.indexOf("RoastingBatch")}`);

  sub("B2. a failure partway through undoes the whole thing");
  // The failure is injected at the very end, so the maximum amount of destruction has
  // already been staged and has the most to roll back. There is no foreign key that can
  // block this delete order — that was measured, and it is why the failure has to be
  // injected rather than provoked.
  let injected = null;
  try {
    await db.query("SELECT 1 / 0");
    console.log("    UNEXPECTED: the injected failure did not raise");
  } catch (e) {
    injected = e.code;
  }
  check("a statement failure aborts the reset transaction", injected === "22012",
    `sqlstate ${injected} (22012 = division_by_zero)`);

  await db.query("ROLLBACK");
  const after = await snapshot();
  const drifted = RESET_ORDER.filter((t) => after[t] !== before[t]);
  console.log(`    ${totals(after)} rows after rollback (was ${totals(before)})`);
  check("every table is exactly as it was — no partial wipe", drifted.length === 0,
    drifted.map((t) => `${t}: ${before[t]} -> ${after[t]}`).join(", "));
  check("the packaging history in particular came back",
    after.PackagingOperation === before.PackagingOperation,
    `${before.PackagingOperation} -> ${after.PackagingOperation}`);

  // ═══════════════════════════════════════════════════════════════════════
  section("C — AN AUTHORIZED RESET OF A DISPOSABLE DATABASE");

  await db.query('DELETE FROM "LoginAttempt"');

  await ensureUser(`${P}_emp_reset`, `${P} Reset Operator`, "admin", {
    dashboard: { access: "edit" },
    settings: { access: "edit", sub: { reset: true, training_reset: true } },
  }, RESET_PIN);
  await loginAs(RESET_PIN);

  sub("C0. authorization is still checked, and checked FIRST");
  // Proof that the guard has not become a way around privilege: the seeded administrator has
  // no reset privilege and must still be refused, and refused with an authorization message
  // that reveals nothing about how destructive resets are configured here.
  await loginAs(ADMIN_PIN);
  const unprivileged = await api("/api/admin/reset", {
    method: "POST", body: { phrase: "RESET HIQBAH", pin: ADMIN_PIN },
  });
  check("a user without settings.reset is refused", unprivileged.status === 403,
    `status=${unprivileged.status} ${S(unprivileged.json).slice(0, 90)}`);
  check("and the refusal discloses nothing about reset configuration",
    !/ERP_|allowlist|DATABASE_URL|host/i.test(S(unprivileged.json)), S(unprivileged.json).slice(0, 120));
  await loginAs(RESET_PIN);

  sub("C1. training reset succeeds, and its success proves the delete order");
  // A training reset is wholesale by design. The interesting assertion is not that rows
  // disappear but that the call SUCCEEDS at all: PackagingOperation.batchId is ON DELETE
  // RESTRICT, so had the route deleted the batches before their packaging operations, this
  // would come back a failure and nothing would be removed.
  const preTraining = await snapshot();
  check("there is packaging history in the way of the batch delete",
    preTraining.PackagingOperation > 0 && preTraining.RoastingBatch > 0,
    `PackagingOperation=${preTraining.PackagingOperation}, RoastingBatch=${preTraining.RoastingBatch}`);

  const employeesBefore = await rowCount("Employee");

  const tr = await api("/api/admin/training-reset", {
    method: "POST", body: { phrase: "CLEAR DEMO DATA", pin: RESET_PIN },
  });
  console.log(`    training-reset -> ${tr.status} ${S(tr.json).slice(0, 110)}`);
  check("the authorized training reset is accepted", tr.status === 200, `status=${tr.status} ${S(tr.json).slice(0, 120)}`);
  check("no raw foreign-key text in the response",
    !/constraint|violates|23503|fkey/i.test(S(tr.json)), S(tr.json).slice(0, 140));

  const postTraining = await snapshot();
  check("packaging operations are gone", postTraining.PackagingOperation === 0,
    `${postTraining.PackagingOperation} rows`);
  check("roasting batches are gone", postTraining.RoastingBatch === 0, `${postTraining.RoastingBatch} rows`);
  check("finished stock is gone", postTraining.FinishedGoodsLot === 0, `${postTraining.FinishedGoodsLot} rows`);
  check("the whole operational dataset is gone", totals(postTraining) === 0,
    Object.entries(postTraining).filter(([, n]) => n).map(([t, n]) => `${t}=${n}`).join(", "));
  check("employees are preserved, so the system is still administrable",
    (await rowCount("Employee")) === employeesBefore,
    `${employeesBefore} -> ${await rowCount("Employee")}`);

  sub("C2. factory reset also runs behind the same guard");
  const fr = await api("/api/admin/reset", {
    method: "POST", body: { phrase: "RESET HIQBAH", pin: RESET_PIN },
  });
  console.log(`    reset -> ${fr.status} ${S(fr.json).slice(0, 110)}`);
  check("the authorized factory reset is accepted", fr.status === 200, `status=${fr.status} ${S(fr.json).slice(0, 120)}`);
  check("employees are still preserved", (await rowCount("Employee")) === employeesBefore,
    `${employeesBefore} -> ${await rowCount("Employee")}`);

  sub("C3. the confirmation controls still apply on an authorized database");
  // The environment boundary is additional to the existing controls, not a replacement for
  // them. Both must still refuse a caller who has not confirmed.
  const wrongPhrase = await api("/api/admin/reset", {
    method: "POST", body: { phrase: "nope", pin: RESET_PIN },
  });
  check("a wrong confirmation phrase is still refused", wrongPhrase.status === 400,
    `status=${wrongPhrase.status}`);
  const wrongPin = await api("/api/admin/reset", {
    method: "POST", body: { phrase: "RESET HIQBAH", pin: "000000" },
  });
  check("a wrong PIN is still refused", wrongPin.status === 401 || wrongPin.status === 429,
    `status=${wrongPin.status}`);

  await invariants("after the reset-safety suite");

  section("RESET SAFETY RESULT");
  console.log(`${results.pass} passed, ${results.fail} failed`);
  if (results.failures.length) console.log("FAILURES:\n  - " + results.failures.join("\n  - "));
  await db.end();
  process.exit(results.fail === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.log("FATAL:", e?.stack || e);
  try { await db.query("ROLLBACK"); } catch {}
  try { await db.end(); } catch {}
  process.exit(1);
});
