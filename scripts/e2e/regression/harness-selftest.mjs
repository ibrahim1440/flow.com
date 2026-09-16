// Proof that the harness can actually fail.
//
// Two things are proved here, both of which the certified harness got wrong, and both of
// which are unprovable against a live database because neither failure can be staged:
//
//   1. the oversell detector fires on an invalid reservation state, and stays silent on
//      a valid one;
//   2. the runner refuses a suite that died, said nothing, or asserted nothing.
//
// ── Why this suite exists ────────────────────────────────────────────────────
// A green harness proves nothing on its own. The certified regression run reported ALL
// SUITES GREEN while its inventory-safety detector was incapable of firing: skuUnits()
// returned no `free` key, so `free0` was `undefined`, and both
//
//     check("racers together take at most the N units that were free", gained <= free0)
//     if (gained > free0) issue("BLOCKER", "Concurrent reservations oversell...")
//
// evaluated against `undefined`. The first was permanently false (a standing red nobody
// chased) and the second was permanently false too — so the single worst inventory
// failure this harness exists to catch could not be reported under ANY circumstances.
//
// Fixing the arithmetic is not enough. Something has to demonstrate, on every run, that
// a deliberately invalid state still produces a BLOCKER. That is this file.
//
// ── Why it needs no database ─────────────────────────────────────────────────
// It imports oversell.mjs and suite-verdict.mjs and nothing else. Both are pure, and —
// critically — both are the SAME modules harness.mjs, order-to-delivery.mjs and
// run-all.mjs use, so exercising them here exercises the shipped decision paths rather
// than copies of them. It deliberately does NOT import harness.mjs, which refuses to load
// without an approved throwaway database.
//
// It therefore runs on a clean clone with no server, no database and no credentials,
// which is exactly what makes it a usable baseline check.

import { freeUnits, assessOversell } from "./oversell.mjs";
import { classifySuiteResult } from "./suite-verdict.mjs";
// The very modules the application ships, imported directly. Node strips the types, so
// this needs no build step — which is the whole point: the client-side rules that decide
// whether a roast can be packed twice are provable on a clean clone.
import {
  newRequestKey, createRequestKeyHolder, isConclusiveResponse,
} from "../../../src/lib/request-key.ts";
import { evaluateResetAuthorization } from "../../../src/lib/reset-safety.ts";
import { readRequestKey } from "../../../src/lib/services/packaging-idempotency.ts";
import {
  evaluateDatabaseUrl, requireDatabaseUrl, requireDirectUrl,
} from "../../../src/lib/db-config.ts";
import {
  normalizeAdjustmentReason,
  ADJUSTMENT_REASON_MAX_LENGTH,
  ADJUSTMENT_REASON_MIN_LENGTH,
} from "../../../src/lib/services/inventory-adjustment.ts";
import {
  diffEmployeeChange, diffPermissions, PERMISSION_DIFF_LIMIT,
} from "../../../src/lib/services/employee-audit.ts";
import { PIN_LENGTH, PIN_FORMAT_MESSAGE, validatePin, isValidPin } from "../../../src/lib/pin-policy.ts";
import { evaluatePinLookupSecret, pinLookup, pinVerifierInput } from "../../../src/lib/pin-lookup.ts";
import {
  readDeliveryRequestKey, normalizeDeliveryIntent, deliveryIntentHash, roundKg,
} from "../../../src/lib/services/delivery-idempotency.ts";
import { createHash, createHmac } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

let pass = 0,
  fail = 0;
const failures = [];

const check = (name, ok, detail = "") => {
  if (ok) {
    pass++;
    console.log("  [PASS] " + name);
  } else {
    fail++;
    failures.push(name);
    console.log("  [FAIL] " + name + (detail ? "  << " + detail : ""));
  }
  return ok;
};
const section = (t) => console.log("\n" + "=".repeat(78) + "\n  " + t + "\n" + "=".repeat(78));
const sub = (t) => console.log("\n── " + t + " " + "─".repeat(Math.max(0, 60 - t.length)));

/** Assert that a call raises — the guard is only useful if it actually stops things. */
function throws(name, fn, expectedFragment) {
  let raised = null;
  try {
    fn();
  } catch (e) {
    raised = e;
  }
  if (!raised) return check(name, false, "expected a throw, none happened");
  return check(
    name,
    String(raised.message).includes(expectedFragment),
    `message did not mention "${expectedFragment}": ${raised.message}`
  );
}

section("HARNESS SELF-TEST — can this harness fail? (no database, no server)");

// ─────────────────────────────────────────────────────────────────────────────
sub("A. free-to-promise arithmetic");

check("4 on hand, 0 reserved -> 4 free", freeUnits(4, 0) === 4, String(freeUnits(4, 0)));
check("10 on hand, 6 reserved -> 4 free", freeUnits(10, 6) === 4, String(freeUnits(10, 6)));
check("6 on hand, 6 reserved -> 0 free", freeUnits(6, 6) === 0, String(freeUnits(6, 6)));

// The reason clamping is refused. If reserved has somehow exceeded available, the harness
// must be able to SEE the negative number; Math.max(0, ...) would report a healthy 0.
check(
  "over-reserved lot reports NEGATIVE free, not a clamped 0",
  freeUnits(4, 7) === -3,
  String(freeUnits(4, 7))
);

// ─────────────────────────────────────────────────────────────────────────────
sub("B. VALID synthetic states — the detector must stay silent");

// Six racers, 4 units free, 4 taken. The reservation guards did their job.
const exact = assessOversell({ freeBefore: 4, reservedBefore: 0, reservedAfter: 4 });
check("consuming exactly the free stock is NOT an oversell", exact.oversold === false, JSON.stringify(exact));
check("  and it reports the 4 units gained", exact.gained === 4, JSON.stringify(exact));

const under = assessOversell({ freeBefore: 4, reservedBefore: 2, reservedAfter: 5 });
check("taking less than was free is NOT an oversell", under.oversold === false, JSON.stringify(under));

const none = assessOversell({ freeBefore: 0, reservedBefore: 6, reservedAfter: 6 });
check("taking nothing when nothing is free is NOT an oversell", none.oversold === false, JSON.stringify(none));

// A cancellation racing the reservations nets stock back. Signed `gained` keeps that from
// reading as a violation.
const released = assessOversell({ freeBefore: 2, reservedBefore: 9, reservedAfter: 5 });
check("a net RELEASE is NOT an oversell", released.oversold === false, JSON.stringify(released));
check("  and it reports a negative gain", released.gained === -4, JSON.stringify(released));
// Without this, dropping the `oversold ?` ternary from `overage` goes unnoticed: every
// other overage assertion is on the oversold branch, where the mutant agrees.
check("  and overage is 0 when nothing was oversold", released.overage === 0, JSON.stringify(released));

// ─────────────────────────────────────────────────────────────────────────────
sub("C. INVALID synthetic states — the detector MUST fire");

// THE PROOF. Six racers each reserve 1 unit against a shelf holding 4 free. Two units
// that do not exist have been promised. This is the exact failure section F watches for,
// and before this repair it produced no BLOCKER and no red assertion.
const oversold = assessOversell({ freeBefore: 4, reservedBefore: 0, reservedAfter: 6 });
check("6 units taken from 4 free IS an oversell", oversold.oversold === true, JSON.stringify(oversold));
check("  and the overage is reported as 2 units", oversold.overage === 2, JSON.stringify(oversold));
check("  and the gain is reported as 6 units", oversold.gained === 6, JSON.stringify(oversold));

// One unit over is still over. The boundary must be strict, or a single-unit oversell
// hides forever.
const byOne = assessOversell({ freeBefore: 4, reservedBefore: 0, reservedAfter: 5 });
check("exceeding free stock by a single unit IS an oversell", byOne.oversold === true, JSON.stringify(byOne));
check("  overage 1", byOne.overage === 1, JSON.stringify(byOne));

// Reserving anything at all when nothing is free.
const fromEmpty = assessOversell({ freeBefore: 0, reservedBefore: 3, reservedAfter: 4 });
check("reserving against an empty shelf IS an oversell", fromEmpty.oversold === true, JSON.stringify(fromEmpty));

// An already-inverted lot: free is negative before the race even starts.
const alreadyInverted = assessOversell({ freeBefore: -2, reservedBefore: 8, reservedAfter: 8 });
check(
  "a lot already over-reserved IS an oversell even with no new gain",
  alreadyInverted.oversold === true,
  JSON.stringify(alreadyInverted)
);

// ─────────────────────────────────────────────────────────────────────────────
sub("D. The original defect must be impossible to reintroduce");

// This is the regression guard for the bug itself. Before the repair, `free0` was
// `undefined` and BOTH directions of the comparison silently answered false. If a future
// change reintroduces a missing balance, these must raise rather than quietly pass.
throws(
  "an undefined `free` raises instead of silently comparing false",
  () => assessOversell({ freeBefore: undefined, reservedBefore: 0, reservedAfter: 6 }),
  "freeBefore must be a finite number"
);
throws(
  "an undefined reservedAfter raises",
  () => assessOversell({ freeBefore: 4, reservedBefore: 0, reservedAfter: undefined }),
  "reservedAfter must be a finite number"
);
throws(
  "NaN raises — it compares false in every direction, exactly like undefined",
  () => assessOversell({ freeBefore: NaN, reservedBefore: 0, reservedAfter: 6 }),
  "freeBefore must be a finite number"
);
throws(
  "an undefined balance raises in freeUnits too",
  () => freeUnits(undefined, 0),
  "available must be a finite number"
);

// Demonstrates WHY the guard is needed, using raw JavaScript rather than the helper: both
// directions of the comparison are false, so a naive detector reports neither a violation
// nor a pass. This is what the certified harness was doing.
const poisoned = 6 > undefined || 6 <= undefined;
check(
  "an unguarded comparison against undefined answers false BOTH ways (why the guard exists)",
  poisoned === false,
  String(poisoned)
);

// ─────────────────────────────────────────────────────────────────────────────
sub("E. the runner must not accept an untrustworthy suite");

// A healthy suite: ran, reported, asserted, exited clean.
const healthy = classifySuiteResult({ name: "delivery", code: 0, reported: true, passed: 22, failed: 0 });
check("a suite that ran and asserted is accepted", healthy.length === 0, JSON.stringify(healthy));

// A suite that reported real failures and exited non-zero is red, but it is HONEST — the
// one reason is its exit code, not a trustworthiness problem.
const honestRed = classifySuiteResult({ name: "delivery", code: 1, reported: true, passed: 20, failed: 2 });
check("a suite that reports failures and exits 1 is flagged once", honestRed.length === 1, JSON.stringify(honestRed));
check("  and the reason is its exit code", honestRed[0] === "exited 1", JSON.stringify(honestRed));

// CASE A — non-zero exit.
const crashed = classifySuiteResult({ name: "delivery", code: 2, reported: true, passed: 5, failed: 0 });
check("A. a non-zero exit is rejected", crashed.includes("exited 2"), JSON.stringify(crashed));

// CASE B — THE DEAD SUITE. This is exactly what delivery.mjs did for two commits: it threw
// a ReferenceError at module evaluation, printed no summary, and was scored 0/0 alongside
// nine green suites. Before this repair the runner recorded it as passed:0 failed:0 and
// said nothing at all.
const dead = classifySuiteResult({ name: "delivery", code: 1, reported: false, passed: 0, failed: 0 });
check("B. a suite that printed no summary is rejected", dead.includes('printed no "<n> passed, <m> failed" summary'), JSON.stringify(dead));
// Both reasons, not just one: `dead.length > 0` would be implied by the line above and
// could not fail independently. Asserting exactly two catches a classifier that dropped
// the exit-code reason while keeping the summary one.
check("  and BOTH its exit code and its silence are reported", dead.length === 2, JSON.stringify(dead));

// A suite can also die silently with a SUCCESSFUL exit code — an early `process.exit(0)`,
// or output swallowed. The exit code alone would clear it; the summary check does not.
const silentZeroExit = classifySuiteResult({ name: "delivery", code: 0, reported: false, passed: 0, failed: 0 });
check("  a suite that exits 0 but printed no summary is STILL rejected", silentZeroExit.length > 0, JSON.stringify(silentZeroExit));

// CASE C — reported, exited clean, asserted nothing. Cannot be staged against a real
// database, which is precisely why it is proved here.
const empty = classifySuiteResult({ name: "delivery", code: 0, reported: true, passed: 0, failed: 0 });
check("C. a suite reporting zero assertions is rejected", empty.includes("reported zero assertions"), JSON.stringify(empty));

// ...unless it is DECLARED non-asserting. Declared, never merely observed.
const declared = classifySuiteResult({ name: "some-utility", code: 0, reported: true, passed: 0, failed: 0 }, new Set(["some-utility"]));
check("  a suite explicitly declared non-asserting is accepted", declared.length === 0, JSON.stringify(declared));
const undeclared = classifySuiteResult({ name: "delivery", code: 0, reported: true, passed: 0, failed: 0 }, new Set(["some-utility"]));
check("  the exemption applies only to the declared suite", undeclared.length > 0, JSON.stringify(undeclared));

// CASE D — a suite that printed failures and then claimed success.
const liar = classifySuiteResult({ name: "delivery", code: 0, reported: true, passed: 3, failed: 4 });
check("D. a suite reporting failures but exiting 0 is rejected", liar.includes("reported 4 failure(s) but exited 0"), JSON.stringify(liar));


// ═════════════════════════════════════════════════════════════════════════════
// REQUEST-KEY LIFECYCLE — the client half of packaging idempotency.
//
// The server half is proved in packaging-idempotency.mjs, over HTTP, against a database.
// None of that can prove the part that actually decides whether an operator can double-pack
// a roast: whether the BROWSER sends the same key twice when it should, and a different key
// when it should. That is pure logic about when a key is minted and when it is retired, and
// it is asserted here, against the same module the packaging page imports.
//
// It also cross-checks the two halves against each other — the client's generated key is
// fed through the SERVER's own validator, so a change to either contract that breaks the
// other fails here rather than in production.
section("REQUEST-KEY LIFECYCLE (client, no browser, no database)");

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// 1 — one submit, one key.
const h = createRequestKeyHolder();
check("a holder mints nothing until an attempt is made", h.current() === null, String(h.current()));
const first = h.keyForAttempt();
check("the first attempt mints a v4 UUID", UUID_V4.test(first), first);
check("asking again during the same attempt returns the SAME key", h.keyForAttempt() === first, h.keyForAttempt());

// 2 — an unknown outcome keeps the key, so a retry is the same operation.
// This is the case that matters: the pack may have committed and the answer been lost.
h.recordResponse(503);
check("a 5xx leaves the operation unresolved and keeps the key", h.current() === first, String(h.current()));
check("the retry after a 5xx carries the same key", h.keyForAttempt() === first, h.keyForAttempt());
// A dropped connection never reports a status at all, which is the same thing: nothing is
// retired because nothing was decided.
check("a dropped connection (no status reported) also keeps the key", h.current() === first, String(h.current()));

// 3 — a decided outcome retires the key, so the next action is a new operation.
h.recordResponse(200);
check("a 2xx retires the key", h.current() === null, String(h.current()));
const second = h.keyForAttempt();
check("a genuinely new partial pack gets a DIFFERENT key", second !== first, second + " vs " + first);

// A refusal is decided too: nothing was written, so the operator may correct the quantity
// and submit again. Keeping the key here would answer that correction with a 422 mismatch.
h.recordResponse(409);
check("a 4xx refusal also retires the key", h.current() === null, String(h.current()));
const third = h.keyForAttempt();
check("the corrected submit is a new operation, not a replay", third !== second, third + " vs " + second);

// 4 — the two packing forms must not share an operation identity.
const kg = createRequestKeyHolder();
const sku = createRequestKeyHolder();
check("separate holders never collide", kg.keyForAttempt() !== sku.keyForAttempt(),
  kg.current() + " vs " + sku.current());

// 5 — the generator is not degenerate. A collision would make a real pack silently answer
// with another operation's stored result, so this is a correctness property, not hygiene.
const minted = new Set();
for (let i = 0; i < 2000; i++) minted.add(newRequestKey());
check("2000 generated keys are all distinct", minted.size === 2000, minted.size + "/2000");

// 6 — CROSS-CHECK: the server's own validator accepts what the client generates.
const accepted = readRequestKey(new Request("http://x/", { headers: { "Idempotency-Key": first } }));
check("the server validator accepts a client-generated key",
  accepted.ok === true && accepted.key === first && accepted.clientSupplied === true,
  JSON.stringify(accepted));

// ...and still refuses the things it is there to refuse, proving the check above is not
// vacuous because the validator waves everything through.
const blank = readRequestKey(new Request("http://x/"));
check("a caller that sends no key gets a server-generated one, flagged as such",
  blank.ok === true && blank.clientSupplied === false && blank.key.startsWith("srv-"),
  JSON.stringify(blank));
const dirty = readRequestKey(new Request("http://x/", { headers: { "Idempotency-Key": 'a b"c' } }));
check("the validator still refuses a key outside the charset", dirty.ok === false, JSON.stringify(dirty));
const long = readRequestKey(new Request("http://x/", { headers: { "Idempotency-Key": "x".repeat(300) } }));
check("the validator still refuses an unbounded key", long.ok === false, JSON.stringify(long));


// ═════════════════════════════════════════════════════════════════════════════
// RETRY CLASSIFICATION — which answers retire a packaging key, and which do not.
//
// The dangerous direction is retiring a key when the operation may in fact have run: the
// operator's next click then becomes a second, genuinely separate pack and the roast is
// drawn down twice. So every status is classified, and anything that is not a decision by
// the application itself keeps the key.
section("REQUEST-KEY RETRY CLASSIFICATION");

const KEEPS = [
  [408, "Request Timeout — abandoned in flight; the work may have finished anyway"],
  [425, "Too Early — decided below the application"],
  [429, "Too Many Requests — a 'try again', not a 'this did not happen'"],
  [500, "Internal Server Error"],
  [502, "Bad Gateway — a proxy answered, not the application"],
  [503, "Service Unavailable"],
  [504, "Gateway Timeout — the pack may have committed after the proxy gave up"],
  [301, "a redirect decides nothing about the operation"],
  [599, "an unknown status is treated as ambiguous, not as a decision"],
  [0, "no status at all"],
];
for (const [status, why] of KEEPS) {
  const holder = createRequestKeyHolder();
  const k = holder.keyForAttempt();
  holder.recordResponse(status);
  check(`${status} KEEPS the key — ${why}`,
    isConclusiveResponse(status) === false && holder.current() === k,
    `conclusive=${isConclusiveResponse(status)} held=${holder.current()}`);
}

const RETIRES = [
  [200, "packed"],
  [201, "packed"],
  [204, "packed"],
  [400, "validation refusal — nothing was written"],
  [401, "not authenticated — nothing was written"],
  [403, "not authorized — nothing was written"],
  [404, "no such batch — nothing was written"],
  [409, "status gate or insufficient stock — the transaction rolled back"],
  [422, "idempotency-key mismatch — the request was never executed"],
];
for (const [status, why] of RETIRES) {
  const holder = createRequestKeyHolder();
  holder.keyForAttempt();
  holder.recordResponse(status);
  check(`${status} RETIRES the key — ${why}`,
    isConclusiveResponse(status) === true && holder.current() === null,
    `conclusive=${isConclusiveResponse(status)} held=${holder.current()}`);
}

// The sequence that matters operationally: a proxy timeout, then a retry, then success.
// One operation, one key, start to finish.
const seq = createRequestKeyHolder();
const seqKey = seq.keyForAttempt();
seq.recordResponse(504);
seq.recordResponse(429);
seq.recordResponse(500);
check("a 504 then a 429 then a 500 still leaves ONE key for the retry",
  seq.keyForAttempt() === seqKey, seq.keyForAttempt() + " vs " + seqKey);
seq.recordResponse(201);
check("and only the eventual success retires it", seq.current() === null, String(seq.current()));

// ═════════════════════════════════════════════════════════════════════════════
// RESET SAFETY GUARD — deny by default, and refuse anything ambiguous.
//
// This is the last thing between an administrator's click and the irreversible destruction
// of a customer's operational history, so every permutation is enumerated rather than
// sampled. It is a pure function of the environment, which is exactly why it can be.
section("RESET SAFETY GUARD (pure, exhaustive)");

const TEST_URL = "postgresql://u:p@ep-wandering-leaf-aqjtuin5.eu-central-1.aws.neon.tech/neondb?sslmode=require";
const OK_ENV = {
  ERP_TRAINING_RESET_ENABLED: "true",
  ERP_RESET_ALLOWED_HOST: "ep-wandering-leaf-aqjtuin5.eu-central-1.aws.neon.tech",
  ERP_RESET_ALLOWED_DATABASE: "neondb",
  DATABASE_URL: TEST_URL,
};

const allowed = evaluateResetAuthorization(OK_ENV);
check("a fully and explicitly authorized configuration is allowed",
  allowed.allowed === true, JSON.stringify(allowed));

// Every single-field defect must deny. Written as overrides of a known-good environment so
// that each case differs from a passing one in exactly one way.
const DENY = [
  ["the enable flag is absent", { ERP_TRAINING_RESET_ENABLED: undefined }],
  ["the enable flag is empty", { ERP_TRAINING_RESET_ENABLED: "" }],
  ['the enable flag is "1"', { ERP_TRAINING_RESET_ENABLED: "1" }],
  ['the enable flag is "yes"', { ERP_TRAINING_RESET_ENABLED: "yes" }],
  ['the enable flag is "TRUE" (wrong case)', { ERP_TRAINING_RESET_ENABLED: "TRUE" }],
  ['the enable flag is "false"', { ERP_TRAINING_RESET_ENABLED: "false" }],
  ["the host allowlist is absent", { ERP_RESET_ALLOWED_HOST: undefined }],
  ["the host allowlist is empty", { ERP_RESET_ALLOWED_HOST: "" }],
  ["the host allowlist is only separators", { ERP_RESET_ALLOWED_HOST: " , , " }],
  ["the database allowlist is absent", { ERP_RESET_ALLOWED_DATABASE: undefined }],
  ["the database allowlist is empty", { ERP_RESET_ALLOWED_DATABASE: "" }],
  ["DATABASE_URL is absent", { DATABASE_URL: undefined }],
  ["DATABASE_URL is not a postgres URL", { DATABASE_URL: "mysql://u:p@h/db" }],
  ["DATABASE_URL is unparseable", { DATABASE_URL: "postgresql://" }],
  ["DATABASE_URL names no database", { DATABASE_URL: "postgresql://u:p@host/" }],
  ["the connected host is not allowlisted", {
    ERP_RESET_ALLOWED_HOST: "ep-somewhere-else.eu-central-1.aws.neon.tech" }],
  ["the connected database is not allowlisted", { ERP_RESET_ALLOWED_DATABASE: "other_db" }],
  ["only a PREFIX of the host is allowlisted (no partial matching)", {
    ERP_RESET_ALLOWED_HOST: "ep-wandering-leaf-aqjtuin5" }],
  ["only a SUFFIX of the host is allowlisted", {
    ERP_RESET_ALLOWED_HOST: "eu-central-1.aws.neon.tech" }],
  ["the database name is a prefix of an allowlisted one", {
    ERP_RESET_ALLOWED_DATABASE: "neondb_training" }],
];
for (const [label, override] of DENY) {
  const verdict = evaluateResetAuthorization({ ...OK_ENV, ...override });
  check("DENIED when " + label,
    verdict.allowed === false && typeof verdict.reason === "string" && verdict.reason.length > 0,
    JSON.stringify(verdict));
}

// A completely empty environment is the realistic production case: nobody configured a
// destructive-reset target, so there is not one.
const bare = evaluateResetAuthorization({});
check("DENIED on a completely unconfigured environment (the production case)",
  bare.allowed === false, JSON.stringify(bare));

// The DEMO and PRODUCTION endpoints of this deployment must never be authorized by the
// configuration that authorizes the regression branch. Named explicitly because these are
// the two databases the whole guard exists to protect.
for (const [name, host] of [
  ["demo", "ep-dawn-dust-aqn1u1uf.eu-central-1.aws.neon.tech"],
  ["production", "ep-icy-field-aq4upc3z.eu-central-1.aws.neon.tech"],
]) {
  const verdict = evaluateResetAuthorization({
    ...OK_ENV,
    DATABASE_URL: `postgresql://u:p@${host}/neondb?sslmode=require`,
  });
  check(`DENIED against the ${name} endpoint under the regression allowlist`,
    verdict.allowed === false, JSON.stringify(verdict));
}

// A refusal must never hand back the connection string or the credentials in it.
const leaky = evaluateResetAuthorization({ ...OK_ENV, ERP_RESET_ALLOWED_DATABASE: "nope" });
const reasonText = leaky.allowed === false ? leaky.reason : "";
check("a refusal reason leaks no credential and no connection string",
  !reasonText.includes("p@") && !reasonText.includes(TEST_URL) && !reasonText.includes("sslmode"),
  reasonText);

// ─────────────────────────────────────────────────────────────────────────────
section("DATABASE CONFIGURATION GUARD (pure, exhaustive) — H1-1");
//
// The runtime used to answer a missing or malformed DATABASE_URL by opening a local SQLite
// file. In production that starts an ERP which looks healthy, shows no data, and accepts
// writes into a scratch file — the worst failure mode available, because nothing raises.
// Every permutation is enumerated here, with no server, no database and no risk, which is
// the same reason the reset guard is tested this way.

const PG_URL = "postgresql://user:secret@db.example.com:5432/erp?sslmode=require";

const okUrl = evaluateDatabaseUrl({ DATABASE_URL: PG_URL });
check("a valid PostgreSQL URL is accepted", okUrl.ok === true, JSON.stringify(okUrl));
check("and is decomposed into scheme, host and database",
  okUrl.ok === true && okUrl.scheme === "postgresql" && okUrl.host === "db.example.com" &&
  okUrl.database === "erp", JSON.stringify(okUrl));
check("the postgres:// spelling is accepted too",
  evaluateDatabaseUrl({ DATABASE_URL: "postgres://u:p@h/db" }).ok === true, "");
check("scheme comparison is case-insensitive",
  evaluateDatabaseUrl({ DATABASE_URL: "POSTGRESQL://u:p@h/db" }).ok === true, "");
check("surrounding whitespace does not defeat it",
  evaluateDatabaseUrl({ DATABASE_URL: `  ${PG_URL}  ` }).ok === true, "");

// Each of these used to reach the libSQL branch instead of failing.
const DB_DENY = [
  ["DATABASE_URL absent", {}],
  ["DATABASE_URL empty", { DATABASE_URL: "" }],
  ["DATABASE_URL blank", { DATABASE_URL: "   " }],
  ["a file: URL (the old silent fallback)", { DATABASE_URL: "file:./prisma/dev.db" }],
  ["a bare relative file path", { DATABASE_URL: "file:../dev.db" }],
  ["a libsql: URL", { DATABASE_URL: "libsql://erp-org.turso.io?authToken=x" }],
  ["an http URL", { DATABASE_URL: "http://db.example.com/erp" }],
  ["a mysql URL", { DATABASE_URL: "mysql://u:p@h/db" }],
  ["an unparseable string", { DATABASE_URL: "not a url at all" }],
  ["a scheme with nothing after it", { DATABASE_URL: "postgresql://" }],
  ["no database in the path", { DATABASE_URL: "postgresql://u:p@host/" }],
  ["more than one host", { DATABASE_URL: "postgresql://u:p@host1,host2/db" }],
];
for (const [label, env] of DB_DENY) {
  const verdict = evaluateDatabaseUrl(env);
  check(`REFUSED: ${label}`, verdict.ok === false, JSON.stringify(verdict));
}

// The decision is environment-independent on purpose: a fallback that only bites outside
// production is a fallback that gets tested least where it does most harm.
for (const nodeEnv of ["production", "development", "test", undefined]) {
  const verdict = evaluateDatabaseUrl({ NODE_ENV: nodeEnv, DATABASE_URL: "file:./prisma/dev.db" });
  check(`a file: URL is refused with NODE_ENV=${nodeEnv ?? "(unset)"}`, verdict.ok === false, "");
}

// requireDatabaseUrl is what db.ts calls at module load, so it must THROW rather than
// return a value the caller might ignore.
let threw = false;
try { requireDatabaseUrl({}); } catch { threw = true; }
check("requireDatabaseUrl throws when DATABASE_URL is absent", threw, "");
threw = false;
try { requireDatabaseUrl({ DATABASE_URL: "file:./prisma/dev.db" }); } catch { threw = true; }
check("requireDatabaseUrl throws on a file: URL", threw, "");
check("requireDatabaseUrl returns the URL when it is valid",
  requireDatabaseUrl({ DATABASE_URL: PG_URL }) === PG_URL, "");

// DIRECT_URL: migrations must name the direct endpoint explicitly.
threw = false;
try { requireDirectUrl({ DATABASE_URL: PG_URL }); } catch { threw = true; }
check("requireDirectUrl throws when DIRECT_URL is absent", threw, "");
threw = false;
try { requireDirectUrl({ DIRECT_URL: "file:./dev.db" }); } catch { threw = true; }
check("requireDirectUrl throws on a non-PostgreSQL DIRECT_URL", threw, "");
check("requireDirectUrl accepts a direct PostgreSQL endpoint",
  requireDirectUrl({ DIRECT_URL: PG_URL }) === PG_URL, "");

// A refusal is read by whoever is staring at a failed boot. It must name the problem and
// nothing else — a connection URL carries a password.
for (const [label, env] of [
  ["missing", {}],
  ["file:", { DATABASE_URL: "file:./prisma/dev.db" }],
  ["wrong engine", { DATABASE_URL: "mysql://admin:hunter2@db.example.com/erp" }],
]) {
  const verdict = evaluateDatabaseUrl(env);
  const reason = verdict.ok === false ? verdict.reason : "";
  check(`the ${label} refusal leaks no credential`,
    !reason.includes("hunter2") && !reason.includes("secret") && !reason.includes("@"), reason);
}

// ─────────────────────────────────────────────────────────────────────────────
section("DEPLOYMENT CONFIGURATION (static) — H1-1 / H1-4");
//
// Static assertions rather than documentation. The build script used to run
// `prisma migrate deploy`, so every deployment mutated the production database as a side
// effect of compiling TypeScript, with no approval and no snapshot behind it. Nothing but a
// test stops that coming back.

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const pkg = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8"));
const buildScript = pkg.scripts?.build ?? "";

check("a build script exists", buildScript.length > 0, JSON.stringify(pkg.scripts));
check("the build does NOT run `migrate deploy`", !/migrate\s+deploy/.test(buildScript), buildScript);
check("the build does NOT run `migrate dev`", !/migrate\s+dev/.test(buildScript), buildScript);
check("the build does NOT run `db push`", !/db\s+push/.test(buildScript), buildScript);
check("the build still generates the Prisma client", /prisma\s+generate/.test(buildScript), buildScript);
check("the build still builds the application", /next\s+build/.test(buildScript), buildScript);
check("postinstall does not migrate either",
  !/migrate|db\s+push/.test(pkg.scripts?.postinstall ?? ""), pkg.scripts?.postinstall ?? "");
check("no npm script other than the explicit one deploys migrations",
  Object.entries(pkg.scripts ?? {})
    .filter(([name]) => name !== "db:migrate:deploy")
    .every(([, cmd]) => !/migrate\s+(deploy|dev)/.test(cmd)),
  JSON.stringify(pkg.scripts));
check("an explicit operator migration command exists",
  typeof pkg.scripts?.["db:migrate:deploy"] === "string", "");
check("and it goes through the wrapper that requires DIRECT_URL",
  /scripts\/migrate-deploy\.mjs/.test(pkg.scripts?.["db:migrate:deploy"] ?? ""),
  pkg.scripts?.["db:migrate:deploy"] ?? "");

// F — the Prisma CLI carried the same silent fallback the runtime did.
//
// Comments are stripped before scanning: both files explain what the old fallback WAS,
// and an assertion that cannot tell a quoted line of history from a live one would force
// the next person to delete the explanation in order to keep the test green.
const stripComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const prismaConfig = stripComments(readFileSync(join(REPO, "prisma.config.ts"), "utf8"));
check("prisma.config.ts has no implicit SQLite fallback",
  !/file:\.\/prisma\/dev\.db/.test(prismaConfig), "fallback string still present in code");
check("prisma.config.ts does not default DATABASE_URL to anything",
  !/DATABASE_URL\s*\|\|/.test(prismaConfig), "a || fallback is still present");
check("prisma.config.ts resolves its URL through the fail-closed guard",
  /requireDatabaseUrl\(/.test(prismaConfig), "guard not used");

const dbModule = stripComments(readFileSync(join(REPO, "src", "lib", "db.ts"), "utf8"));
check("db.ts no longer imports the libSQL adapter",
  !/adapter-libsql|PrismaLibSql/.test(dbModule), "libSQL adapter still referenced");
check("db.ts no longer names a dev.db fallback",
  !/dev\.db/.test(dbModule), "dev.db still referenced in code");
check("db.ts does not default DATABASE_URL to anything",
  !/DATABASE_URL\s*(\|\||\?\?)/.test(dbModule), "a fallback is still present");
check("db.ts resolves its URL through the fail-closed guard",
  /requireDatabaseUrl\(/.test(dbModule), "guard not used");

// ─────────────────────────────────────────────────────────────────────────────
section("MANUAL ADJUSTMENT REASON (pure) — H2A");
//
// A manual stock adjustment is the one inventory movement with no document behind it, so
// the reason is the document. Both adjustment routes share this rule precisely so they
// cannot drift apart on what counts as an explanation.

for (const [label, input] of [
  ["undefined", undefined],
  ["null", null],
  ["a number", 42],
  ["empty", ""],
  ["spaces", "     "],
  ["a tab and a newline", "\t\n"],
  ["too short", "typo"],
  ["short after trimming", "   ok   "],
  ["longer than the maximum", "x".repeat(ADJUSTMENT_REASON_MAX_LENGTH + 1)],
]) {
  const verdict = normalizeAdjustmentReason(input);
  check(`REFUSED as a reason: ${label}`, verdict.ok === false, JSON.stringify(verdict));
}

const goodReason = normalizeAdjustmentReason("  Stock count 14 Sep — two bags behind the pallet  ");
check("a real reason is accepted", goodReason.ok === true, JSON.stringify(goodReason));
check("and is stored trimmed",
  goodReason.ok === true && goodReason.reason === "Stock count 14 Sep — two bags behind the pallet",
  goodReason.ok ? goodReason.reason : "");
check("a reason of exactly the maximum length is accepted",
  normalizeAdjustmentReason("x".repeat(ADJUSTMENT_REASON_MAX_LENGTH)).ok === true, "");
check("a reason of exactly the minimum length is accepted",
  normalizeAdjustmentReason("x".repeat(ADJUSTMENT_REASON_MIN_LENGTH)).ok === true, "");

// ─────────────────────────────────────────────────────────────────────────────
section("EMPLOYEE ADMINISTRATION AUDIT (pure) — H2A");
//
// The audit describes what CHANGED, derived from the row before and after, so a request that
// sets the role to what it already was is not a role change six months later. And it records
// the change EXACTLY: a fingerprint proves only that something moved, which is no use to
// somebody asked to explain why an operator could suddenly authorize surplus production.

const P_QC = JSON.stringify({
  dashboard: { access: "edit" },
  qc: { access: "edit", sub: { create_record: true, manage: false } },
});
const P_QC_MANAGE = JSON.stringify({
  dashboard: { access: "edit" },
  qc: { access: "edit", sub: { create_record: true, manage: true } },
});
const P_DISPATCH = JSON.stringify({
  dashboard: { access: "edit" },
  dispatch: { access: "edit", sub: { mark_delivered: true } },
});

// ── the diff itself ────────────────────────────────────────────────────────
const noDiff = diffPermissions(P_QC, P_QC);
check("identical documents differ in nothing", noDiff.changes.length === 0, JSON.stringify(noDiff));
check("and are not reported as truncated", noDiff.truncated === false, "");

const granted = diffPermissions(P_QC, P_QC_MANAGE);
check("granting one sub-privilege reports exactly one change",
  granted.changes.length === 1, JSON.stringify(granted.changes));
check("naming the privilege by path, with both values",
  granted.changes[0]?.path === "qc.manage" && granted.changes[0]?.from === false &&
  granted.changes[0]?.to === true, JSON.stringify(granted.changes[0]));

const revoked = diffPermissions(P_QC_MANAGE, P_QC);
check("revoking it reports the exact inverse",
  revoked.changes.length === 1 && revoked.changes[0]?.path === "qc.manage" &&
  revoked.changes[0]?.from === true && revoked.changes[0]?.to === false,
  JSON.stringify(revoked.changes[0]));

const moved = diffPermissions(P_QC, P_DISPATCH);
const paths = moved.changes.map((c) => c.path).sort();
check("replacing a module reports the access level on both sides",
  paths.includes("qc.access") && paths.includes("dispatch.access"), JSON.stringify(paths));
check("and every sub-privilege that moved with it",
  paths.includes("qc.create_record") && paths.includes("dispatch.mark_delivered"),
  JSON.stringify(paths));
check("a module that is gone reads as a change TO null",
  moved.changes.find((c) => c.path === "qc.access")?.to === null,
  JSON.stringify(moved.changes.find((c) => c.path === "qc.access")));
check("a module that is new reads as a change FROM null",
  moved.changes.find((c) => c.path === "dispatch.access")?.from === null,
  JSON.stringify(moved.changes.find((c) => c.path === "dispatch.access")));

// One sweeping regrant must not write an unbounded document into the audit log.
const wide = {};
for (let i = 0; i < PERMISSION_DIFF_LIMIT + 20; i++) wide[`mod${i}`] = { access: "edit" };
const truncated = diffPermissions(JSON.stringify({}), JSON.stringify(wide));
check("an enormous change is capped", truncated.changes.length === PERMISSION_DIFF_LIMIT,
  `${truncated.changes.length} changes`);
check("and says so rather than trimming in silence", truncated.truncated === true, "");

// Unparseable permissions must degrade, never throw: an audit write may not be the reason an
// administrative action fails.
check("a permission document that is not JSON is survivable",
  Array.isArray(diffPermissions("{not json", P_QC).changes), "");

// ── which events an edit produces ──────────────────────────────────────────
const unchanged = diffEmployeeChange(
  { role: "qc", active: true, permissions: P_QC },
  { role: "qc", active: true, permissions: P_QC },
  {},
);
check("a change that changes nothing records nothing", unchanged.length === 0, JSON.stringify(unchanged));

const promoted = diffEmployeeChange(
  { role: "qc", active: true, permissions: P_QC },
  { role: "admin", active: true, permissions: P_QC },
  {},
);
check("a role change is recorded once",
  promoted.length === 1 && promoted[0].action === "EMPLOYEE_ROLE_CHANGED", JSON.stringify(promoted));
check("with both the old and the new role",
  promoted[0]?.metadata.oldRole === "qc" && promoted[0]?.metadata.newRole === "admin",
  JSON.stringify(promoted[0]?.metadata));

const deactivated = diffEmployeeChange(
  { role: "qc", active: true, permissions: P_QC },
  { role: "qc", active: false, permissions: P_QC },
  {},
);
check("a deactivation is recorded as one, with both values",
  deactivated.length === 1 && deactivated[0].action === "EMPLOYEE_DEACTIVATED" &&
  deactivated[0].metadata.oldActive === true && deactivated[0].metadata.newActive === false,
  JSON.stringify(deactivated));
check("and a reactivation as the other",
  diffEmployeeChange(
    { role: "qc", active: false, permissions: P_QC },
    { role: "qc", active: true, permissions: P_QC },
    {},
  )[0]?.action === "EMPLOYEE_ACTIVATED", "");

const regranted = diffEmployeeChange(
  { role: "qc", active: true, permissions: P_QC },
  { role: "qc", active: true, permissions: P_QC_MANAGE },
  {},
);
check("a permission change carries the exact diff, not a summary",
  regranted.length === 1 && regranted[0].action === "EMPLOYEE_PERMISSIONS_CHANGED" &&
  JSON.stringify(regranted[0].metadata.changes) ===
    JSON.stringify([{ path: "qc.manage", from: false, to: true }]),
  JSON.stringify(regranted[0]?.metadata));

const everythingAtOnce = diffEmployeeChange(
  { role: "qc", active: true, permissions: P_QC },
  { role: "admin", active: false, permissions: P_DISPATCH },
  { pin: true, password: true },
);
check("four separate events when four things change", everythingAtOnce.length === 4,
  JSON.stringify(everythingAtOnce.map((e) => e.action)));
const credential = everythingAtOnce.find((e) => e.action === "EMPLOYEE_CREDENTIAL_CHANGED");
check("the credential event names the classes that changed",
  JSON.stringify(credential?.metadata.credentials) === JSON.stringify(["pin", "password"]),
  JSON.stringify(credential?.metadata));
check("only the pin when only the pin changed",
  JSON.stringify(
    diffEmployeeChange(
      { role: "qc", active: true, permissions: P_QC },
      { role: "qc", active: true, permissions: P_QC },
      { pin: true },
    )[0]?.metadata.credentials,
  ) === JSON.stringify(["pin"]), "");
check("and NEVER what it changed to",
  !/\$2[aby]\$|pinHash|password"\s*:\s*"/.test(JSON.stringify(everythingAtOnce)),
  JSON.stringify(everythingAtOnce).slice(0, 140));
// ─────────────────────────────────────────────────────────────────────────────
section("PIN POLICY (pure) — H2B");
//
// Five paths set or check a PIN: employee create, admin employee edit, self-service change,
// login, and the re-verification guarding the destructive resets. They previously agreed
// only that a PIN was "at least 4 characters", and only two of them said so in the same
// words. One rule now decides, and every permutation of it is provable on a clean clone —
// no server, no database, no credential.

check("the policy length is six", PIN_LENGTH === 6, String(PIN_LENGTH));
check("six digits is a PIN", validatePin("123456").ok === true);
check("and the accepted value is returned unchanged", validatePin("123456").pin === "123456");

for (const bad of ["", "1", "12345", "1234567", "12345678"]) {
  check(`"${bad}" is the wrong length`, validatePin(bad).ok === false);
}
for (const bad of ["12345a", "abcdef", "12-456", "12 456", "+12345", "1.2345"]) {
  check(`"${bad}" is not six digits`, validatePin(bad).ok === false);
}

sub("digits means ASCII digits");
// \d in a Unicode-aware regex also matches Arabic-Indic digits, which would let two visually
// different strings be the same PIN on one path and different PINs on another.
check("Arabic-Indic digits are refused", validatePin("١٢٣٤٥٦").ok === false);
check("fullwidth digits are refused", validatePin("１２３４５６").ok === false);

sub("whitespace is refused, not trimmed");
// Trimming would mean " 012345" and "012345" authenticate the same account while being
// different strings — and the lookup, the verifier and the rate-limit identifier would each
// have to agree on where the trimming happened.
check("a leading space is refused", validatePin(" 123456").ok === false);
check("a trailing space is refused", validatePin("123456 ").ok === false);
check("an interior space is refused", validatePin("123 456").ok === false);
check("a tab is refused", validatePin("\t123456").ok === false);

sub("a PIN is a string, and stays one");
for (const [label, bad] of [
  ["a number", 123456], ["null", null], ["undefined", undefined],
  ["an object", {}], ["an array", ["123456"]], ["a boolean", true],
]) {
  check(`${label} is refused`, validatePin(bad).ok === false);
}
check("012345 is valid", validatePin("012345").ok === true);
check("and survives as six characters", validatePin("012345").pin === "012345");

check("isValidPin and validatePin never disagree",
  ["123456", "012345", "12345", "abcdef", "", " 123456", 123456, null]
    .every((v) => isValidPin(v) === validatePin(v).ok));
check("the refusal message states the rule and quotes no candidate",
  validatePin("12345").message === PIN_FORMAT_MESSAGE && !/12345/.test(PIN_FORMAT_MESSAGE),
  PIN_FORMAT_MESSAGE);

// ─────────────────────────────────────────────────────────────────────────────
section("PIN LOOKUP SECRET (pure) — H2B");
//
// A lookup secret that quietly defaults to something weak is the original defect wearing a
// different hat, so this is evaluated the way auth.ts evaluates JWT_SECRET: fail closed, and
// never name the value in the reason.

const STRONG = "d7Qv2mZ".padEnd(48, "x");

check("unset is refused", evaluatePinLookupSecret({}).ok === false);
check("empty is refused", evaluatePinLookupSecret({ PIN_LOOKUP_SECRET: "" }).ok === false);
check("whitespace-only is refused", evaluatePinLookupSecret({ PIN_LOOKUP_SECRET: "    " }).ok === false);
check("31 characters is refused", evaluatePinLookupSecret({ PIN_LOOKUP_SECRET: "y".repeat(31) }).ok === false);
check("32 characters is accepted", evaluatePinLookupSecret({ PIN_LOOKUP_SECRET: "y".repeat(32) }).ok === true);
for (const weak of ["hiqbah-fallback-secret", "changeme", "secret", "test"]) {
  check(`the placeholder "${weak}" is refused`,
    evaluatePinLookupSecret({ PIN_LOOKUP_SECRET: weak }).ok === false);
}
// The one placeholder long enough to clear the length gate, so this is the case that proves
// the blocklist itself is consulted rather than the length doing all the work.
const LONG_PLACEHOLDER = "replace-this-with-a-strong-random-secret-min-32-chars";
const placeholderDecision = evaluatePinLookupSecret({ PIN_LOOKUP_SECRET: LONG_PLACEHOLDER });
check("a 52-character placeholder is refused on its own merits, not on length",
  placeholderDecision.ok === false && /weak or placeholder/.test(placeholderDecision.reason),
  placeholderDecision.reason);
check("and case does not launder it",
  evaluatePinLookupSecret({ PIN_LOOKUP_SECRET: LONG_PLACEHOLDER.toUpperCase() }).ok === false);
check("a strong value is accepted and returned trimmed",
  evaluatePinLookupSecret({ PIN_LOOKUP_SECRET: `  ${STRONG}  ` }).secret === STRONG);

const secretRefusals = [
  evaluatePinLookupSecret({}),
  evaluatePinLookupSecret({ PIN_LOOKUP_SECRET: "y".repeat(31) }),
  evaluatePinLookupSecret({ PIN_LOOKUP_SECRET: "hiqbah-fallback-secret" }),
].map((r) => r.reason);
check("no refusal ever quotes any part of the value it refused",
  secretRefusals.every((r) => !/yyyy|hiqbah/.test(r)), JSON.stringify(secretRefusals));

// ─────────────────────────────────────────────────────────────────────────────
section("PIN LOOKUP (pure) — H2B");

const K1 = "k".repeat(40);
const K2 = "m".repeat(40);

check("the lookup is deterministic", pinLookup("123456", K1) === pinLookup("123456", K1));
check("different PINs give different values", pinLookup("123456", K1) !== pinLookup("123457", K1));
check("different secrets give different values", pinLookup("123456", K1) !== pinLookup("123456", K2));
check("it is not the unsalted hash it replaces",
  pinLookup("123456", K1) !== createHash("sha256").update("123456").digest("hex"));
check("it is domain-separated, not a bare HMAC of the PIN",
  pinLookup("123456", K1) !== createHmac("sha256", K1).update("123456").digest("base64"));
check("012345 and 12345 are different credentials",
  pinLookup("012345", K1) !== pinLookup("12345", K1));

sub("the harness duplicates this formula — and must not drift from it");
// The regression suites are plain .mjs and seed employees with SQL, so harness.mjs computes
// the selector itself. That duplication is only safe while both sides agree exactly, and
// nothing in a green suite would notice if they stopped: the fixtures would simply become
// unloggable, which reads as a broken fixture rather than as drift.
const lookupSrc = readFileSync(join(REPO, "src", "lib", "pin-lookup.ts"), "utf8");
const harnessSrc = readFileSync(
  join(REPO, "scripts", "e2e", "regression", "harness.mjs"), "utf8");

check("the module builds the selector with HMAC-SHA256",
  /createHmac\(\s*"sha256"/.test(lookupSrc), "");
check("under the lookup domain prefix pin:lookup:v1:", /"pin:lookup:v1:"/.test(lookupSrc), "");
check("and encodes it as base64", /digest\(\s*"base64"\s*\)/.test(lookupSrc), "");
check("the harness names the same lookup domain prefix", /"pin:lookup:v1:"/.test(harnessSrc), "");
check("the same digest, and the same encoding",
  /createHmac\(\s*"sha256"/.test(harnessSrc) && /digest\(\s*"base64"\s*\)/.test(harnessSrc), "");
check("and refuses to run without the server's secret",
  /PIN_LOOKUP_SECRET is not set/.test(harnessSrc), "");
check("the two implementations agree on a worked example",
  createHmac("sha256", K1).update("pin:lookup:v1:" + "012345").digest("base64") === pinLookup("012345", K1));

sub("the verifier input is a distinct keyed derivation — Secure Version B");
// Employee.pin is bcrypt(pinVerifierInput(PIN)), not bcrypt(PIN). The verifier input is
// HMAC-SHA384 under its own domain, so it is a different construction AND a different domain
// from the selector: brute-forcing the stored bcrypt offline recovers only this value, never
// the PIN, and the raw PIN can never verify directly.
check("the module builds the verifier input with HMAC-SHA384",
  /createHmac\(\s*"sha384"/.test(lookupSrc), "");
check("under the verify domain prefix pin:verify:v1:", /"pin:verify:v1:"/.test(lookupSrc), "");
check("the harness duplicates the verifier formula too",
  /createHmac\(\s*"sha384"/.test(harnessSrc) && /"pin:verify:v1:"/.test(harnessSrc), "");
check("the verifier input is not the selector", pinVerifierInput("123456", K1) !== pinLookup("123456", K1));
check("it is not a bare HMAC of the PIN",
  pinVerifierInput("123456", K1) !== createHmac("sha384", K1).update("123456").digest("base64"));
check("it is deterministic and keyed",
  pinVerifierInput("123456", K1) === pinVerifierInput("123456", K1) &&
  pinVerifierInput("123456", K1) !== pinVerifierInput("123456", K2));
check("different PINs give different verifier inputs",
  pinVerifierInput("123456", K1) !== pinVerifierInput("123457", K1));
check("the two implementations agree on a worked verifier example",
  createHmac("sha384", K1).update("pin:verify:v1:" + "012345").digest("base64") ===
    pinVerifierInput("012345", K1));

sub("rotation is a window, not a dual-secret migration");
// A stored HMAC does not say which key produced it, so "how many rows are still on the old
// secret?" is a question the database cannot answer without every plaintext PIN. A second
// secret would therefore create state no query could prove complete.
check("there is no second secret", !/PIN_LOOKUP_SECRET_(OLD|PREVIOUS|NEXT)/.test(lookupSrc), "");
check("and no version bump smuggled into either domain",
  !/pin:lookup:v2:/.test(lookupSrc) && !/pin:verify:v2:/.test(lookupSrc), "");

// ─────────────────────────────────────────────────────────────────────────────
section("DISPATCH IDEMPOTENCY (pure) — H2B");
//
// A dispatch had no request identity at all: a retry after an ambiguous outcome created a
// second Delivery, applied the quantity again and drew the stock again. The ordered-quantity
// ceiling bounded how much damage that could do; it never noticed that the retry WAS the
// first request.

const keyReq = (value) =>
  new Request("http://localhost/api/deliveries", {
    method: "POST",
    headers: value === undefined ? {} : { "Idempotency-Key": value },
  });

check("a missing key is refused", readDeliveryRequestKey(keyReq(undefined)).ok === false);
check("an empty key is refused", readDeliveryRequestKey(keyReq("")).ok === false);
check("a whitespace-only key is refused", readDeliveryRequestKey(keyReq("   ")).ok === false);
check("the refusal names the header it wants",
  /Idempotency-Key/.test(readDeliveryRequestKey(keyReq(undefined)).message), "");
check("a padded key is trimmed, not rejected — a retry may arrive padded",
  readDeliveryRequestKey(keyReq("  abc-123  ")).key === "abc-123");
check("the certified dialect is accepted", readDeliveryRequestKey(keyReq("aZ0._:-")).ok === true);
// Not a newline: the Headers API refuses one outright, so a header value carrying it can
// never reach this reader — the transport rejects that shape before the application sees it.
for (const bad of ["has space", "slash/es", "semi;colon", 'quote"d', "pipe|d", "comma,d", "brace{s}"]) {
  check(`${JSON.stringify(bad)} is refused`, readDeliveryRequestKey(keyReq(bad)).ok === false);
}
check("200 characters is accepted", readDeliveryRequestKey(keyReq("k".repeat(200))).ok === true);
check("201 characters is refused", readDeliveryRequestKey(keyReq("k".repeat(201))).ok === false);

sub("one canonical intent, hashed and executed");
const baseIntent = {
  orderItemId: "item-1", finishedGoodsLotId: "lot-1",
  deliveryType: "partial", quantityUnits: 4, notes: "ship it",
};
const norm = (b) => normalizeDeliveryIntent(b);
const hashOf = (b) => deliveryIntentHash(norm(b).intent);

check("a well-formed body normalizes", norm(baseIntent).ok === true);
check("both quantity axes at once is refused", norm({ ...baseIntent, quantityKg: 1 }).ok === false);
check("neither axis is refused",
  norm({ orderItemId: "i", finishedGoodsLotId: "l", deliveryType: "full" }).ok === false);
check("a missing lot is refused", norm({ ...baseIntent, finishedGoodsLotId: "" }).ok === false);
check("a missing order item is refused", norm({ ...baseIntent, orderItemId: "  " }).ok === false);
check("an unknown deliveryType is refused", norm({ ...baseIntent, deliveryType: "maybe" }).ok === false);
check("deliveryType is case-folded, not rejected", norm({ ...baseIntent, deliveryType: "FULL" }).intent.deliveryType === "full");
check("a fractional unit count is refused", norm({ ...baseIntent, quantityUnits: 2.5 }).ok === false);
check("zero units is refused", norm({ ...baseIntent, quantityUnits: 0 }).ok === false);
check("a negative kilogram figure is refused",
  norm({ ...baseIntent, quantityUnits: undefined, quantityKg: -1 }).ok === false);
check("kilograms are rounded once, to grams",
  norm({ ...baseIntent, quantityUnits: undefined, quantityKg: 1.23456 }).intent.quantityKg === 1.235);
check("and rounding is the value that gets hashed",
  hashOf({ ...baseIntent, quantityUnits: undefined, quantityKg: 1.23456 }) ===
  hashOf({ ...baseIntent, quantityUnits: undefined, quantityKg: 1.235 }));
check("an empty note is the same as no note",
  hashOf({ ...baseIntent, notes: "   " }) === hashOf({ ...baseIntent, notes: undefined }));

sub("property order is not part of a dispatch's meaning");
// Object property order is not part of a body's meaning but it IS part of its serialization,
// so hashing raw JSON would let a reordered retry look like a different dispatch.
const reordered = {
  notes: baseIntent.notes, quantityUnits: baseIntent.quantityUnits,
  deliveryType: baseIntent.deliveryType, finishedGoodsLotId: baseIntent.finishedGoodsLotId,
  orderItemId: baseIntent.orderItemId,
};
check("the same values in any order hash identically", hashOf(reordered) === hashOf(baseIntent));
check("a different quantity hashes differently",
  hashOf({ ...baseIntent, quantityUnits: 5 }) !== hashOf(baseIntent));
check("a different note hashes differently — it is caller-supplied and persisted",
  hashOf({ ...baseIntent, notes: "ship it tomorrow" }) !== hashOf(baseIntent));
check("a different lot hashes differently",
  hashOf({ ...baseIntent, finishedGoodsLotId: "lot-2" }) !== hashOf(baseIntent));
check("the hash is a sha256 digest", /^[0-9a-f]{64}$/.test(hashOf(baseIntent)));
check("kilograms and units are separate positions, not one number",
  hashOf({ ...baseIntent, quantityUnits: 4 }) !==
  hashOf({ ...baseIntent, quantityUnits: undefined, quantityKg: 4 }));
check("roundKg is gram precision", roundKg(1.23456) === 1.235 && roundKg(2) === 2);

// ─────────────────────────────────────────────────────────────────────────────
section("THE PINHASH CUTOVER, STATICALLY — H2B");
//
// Secure Version B writes two live credential columns and reads one, and — critically —
// bcrypts a keyed derivation of the PIN, never the PIN itself. None of that is visible in a
// green suite: a path that silently stopped writing pinLookup would leave accounts that
// cannot log in, a login that started reading pinHash again would quietly restore the
// precomputable lookup this migration exists to retire, and a path that bcrypted the raw PIN
// would reintroduce the offline verifier the whole correction removes. All are assertions
// about source.

const src = (...p) => stripComments(readFileSync(join(REPO, ...p), "utf8"));

const loginRoute = src("src", "app", "api", "auth", "login", "route.ts");
check("login finds its employee by the keyed lookup", /pinLookup:\s*lookup/.test(loginRoute), "");
check("and never reads pinHash", !/pinHash/.test(loginRoute), "pinHash is referenced again");
check("the credential is proved by bcrypt over the derived verifier input",
  /compare\(\s*pinVerifierInput\(\s*candidate/.test(loginRoute), "");
check("and never by bcrypting the raw candidate directly",
  !/compare\(\s*candidate\s*,/.test(loginRoute), "a raw-PIN bcrypt compare is present");
check("and the candidate is shape-checked before anything is hashed",
  /validatePin\(/.test(loginRoute), "");
check("the opportunistic backfill is gone", !/backfill/i.test(loginRoute), "");

for (const [label, ...p] of [
  ["employee create", "src", "app", "api", "employees", "route.ts"],
  ["admin employee edit", "src", "app", "api", "employees", "[id]", "route.ts"],
  ["self-service PIN change", "src", "app", "api", "profile", "route.ts"],
]) {
  const path = src(...p);
  check(`${label} validates the PIN shape`, /validatePin\(/.test(path), "");
  check(`${label} writes the keyed lookup`, /pinLookups*[:=]/.test(path), "");
  check(`${label} bcrypts the derived verifier input, not the raw PIN`,
    /hash\(\s*pinVerifierInput\(/.test(path), "");
  check(`${label} does NOT write the legacy pinHash — inert until #19`,
    !/pinHash/.test(path), "pinHash is written on a Version B credential path");
  check(`${label} checks uniqueness on the lookup, not the legacy column`,
    /pinLookup:\s*(lookup|newLookup|nextLookup)/.test(path), "");
}

for (const [label, ...p] of [
  ["the destructive reset", "src", "app", "api", "admin", "reset", "route.ts"],
  ["the training reset", "src", "app", "api", "admin", "training-reset", "route.ts"],
]) {
  const path = src(...p);
  check(`${label} shape-checks the re-verified PIN before bcrypt`,
    /validatePin\(pin\)[\s\S]{0,800}compare\(\s*pinVerifierInput\(\s*pinShape\.pin/.test(path), "");
  check(`${label} never bcrypts the raw re-verified PIN`,
    !/compare\(\s*pinShape\.pin\s*,/.test(path), "a raw-PIN bcrypt compare is present");
}

sub("the rate-limit accounting the marker depends on");
const rateLimit = src("src", "lib", "rate-limit.ts");
check("the PIN-space bucket exists", /PIN_GLOBAL/.test(rateLimit), "");
check("it is peppered like every other identifier",
  /PIN_GLOBAL\s*=\s*hashRateLimitKey\(/.test(rateLimit), "");
check("and the per-address count EXCLUDES it, so one failure counts once",
  /identifierHash:\s*\{\s*not:\s*PIN_GLOBAL\s*\}/.test(rateLimit),
  "isIpRateLimited would double-count every PIN failure");
check("a failed PIN writes the candidate row and the marker together",
  /recordPinFailure[\s\S]{0,300}identifierHash:\s*PIN_GLOBAL/.test(rateLimit), "");
check("and a success clears both", /clearPinAttempts[\s\S]{0,300}in:\s*\[identifierHash,\s*PIN_GLOBAL\]/.test(rateLimit), "");

sub("migration #18 is additive");
// The column is added nullable with no default and no backfill, so applying it cannot
// rewrite a row or take a table lock long enough to matter — and rolling the application
// back to the previous version leaves a schema that version still runs on.
const MIG18 = "20260915100000_add_delivery_idempotency_and_pin_lookup";
const mig18Raw = readFileSync(join(REPO, "prisma", "migrations", MIG18, "migration.sql"), "utf8");
// The SQL comments explain what the columns replace, and name pinHash while doing it. An
// assertion that cannot tell an explanation from a statement would force the next person to
// delete the explanation in order to keep this green.
const mig18 = mig18Raw.replace(/^\s*--.*$/gm, "");
const statements = mig18.split(";").map((s) => s.trim()).filter(Boolean);
check("it is exactly five statements", statements.length === 5, String(statements.length));
check("two columns on Delivery, two indexes, one column on Employee",
  statements.filter((s) => /^ALTER TABLE/i.test(s)).length === 3 &&
  statements.filter((s) => /^CREATE UNIQUE INDEX/i.test(s)).length === 2,
  JSON.stringify(statements.map((s) => s.slice(0, 28))));
check("every added column is nullable", !/NOT NULL/i.test(mig18), "a NOT NULL column would fail on existing rows");
check("nothing is dropped, truncated or rewritten",
  !/\b(DROP|TRUNCATE|DELETE|UPDATE|RENAME)\b/i.test(mig18), "a destructive statement is present");
check("no default is backfilled into existing rows", !/\bDEFAULT\b/i.test(mig18), "");
check("the legacy column is still there for a rollback to use",
  !/pinHash/i.test(mig18), "the migration touches pinHash");

// ─────────────────────────────────────────────────────────────────────────────
section("THE MIGRATE-DEPLOY WRAPPER, STATICALLY — H2B");
//
// `npm run build` no longer mutates the database as a side effect of compiling. Migrations
// run through scripts/migrate-deploy.mjs, by a person who means to run them, and only against
// the direct endpoint. None of that is visible in a green suite: the wrapper is never invoked
// by a test (running it would apply a migration), so its safety is asserted from source, and
// the URL boundary it depends on is exercised as pure functions.

sub("the URL boundary the wrapper depends on never quotes a credential");
// requireDatabaseUrl / requireDirectUrl already prove they THROW on a missing or malformed
// URL above (fail-closed). What the migration wrapper additionally depends on is that the
// refusal names the problem and never any part of the value — a connection URL carries a
// password.
const SECRET_PW = "hunter2SUPERSECRET";
const withPw = `postgres://neondb_owner:${SECRET_PW}@ep-example.aws.neon.tech/neondb?sslmode=require`;
let dbReason = "", directReason = "";
try { requireDatabaseUrl({ DATABASE_URL: "postgres://:@" }); } catch (e) { dbReason = String(e.message); }
try { requireDirectUrl({ DIRECT_URL: "not a url at all" }); } catch (e) { directReason = String(e.message); }
check("a malformed DATABASE_URL refusal quotes no part of the value",
  dbReason.length > 0 && !dbReason.includes("hunter2") && !dbReason.includes("@"), dbReason);
check("a malformed DIRECT_URL refusal quotes no part of the value",
  directReason.length > 0 && !directReason.includes("not a url"), directReason);
check("a well-formed URL is accepted, and its decision exposes host/db but never the password",
  evaluateDatabaseUrl({ DATABASE_URL: withPw }).ok === true &&
  evaluateDatabaseUrl({ DATABASE_URL: withPw }).host === "ep-example.aws.neon.tech" &&
  !JSON.stringify(evaluateDatabaseUrl({ DATABASE_URL: withPw })).includes(SECRET_PW),
  "the decision object leaked the password");

sub("the spawn is shell-free, local, and propagates the child's fate");
const md = stripComments(readFileSync(join(REPO, "scripts", "migrate-deploy.mjs"), "utf8"));
check("it never spawns a shell", !/shell:\s*true/.test(md), "shell: true is present");
check("and never reaches for cmd.exe or a .cmd shim",
  !/cmd\.exe/i.test(md) && !/\.cmd\b/i.test(md), "a cmd.exe / .cmd reference is present");
check("it runs the Prisma JS CLI resolved from this install, not a bin shim",
  /createRequire/.test(md) && /resolve\(\s*["']prisma\/build\/index\.js["']\s*\)/.test(md), "");
check("under this same Node via process.execPath",
  /spawnSync\(\s*process\.execPath/.test(md), "");
check("DATABASE_URL and DIRECT_URL are both required before the child is spawned",
  /requireDatabaseUrl\([\s\S]*requireDirectUrl\([\s\S]*spawnSync\(/.test(md),
  "validation does not precede the spawn");
check("the child's non-zero exit is propagated, not swallowed",
  /process\.exit\(\s*result\.status\s*\?\?\s*1\s*\)/.test(md), "");
check("a spawn error exits non-zero rather than continuing",
  /result\.error[\s\S]{0,120}process\.exit\(1\)/.test(md), "");
check("only the host is ever logged, never a connection string",
  /new URL\(\s*direct\s*\)\.hostname/.test(md) &&
  !/console\.(log|error)\([^)]*\b(DATABASE_URL|DIRECT_URL)\b/.test(md) &&
  !/console\.log\(\s*(direct|url)\s*\)/.test(md), "a credential may be logged");

// ─────────────────────────────────────────────────────────────────────────────
section("THE SEED IS A VERSION-B CREDENTIAL PATH, STATICALLY — H2B");
//
// prisma/seed.ts creates employees, so it is a credential-writing path and must obey Secure
// Version B exactly as the application routes do. It is never run by a suite (running it would
// require an explicitly enabled disposable target), so its rules are asserted from source.
const seedSrc = stripComments(readFileSync(join(REPO, "prisma", "seed.ts"), "utf8"));

sub("it writes Version B credentials, not the retired scheme");
check("it bcrypts the derived verifier input", /hashSync\(\s*pinVerifierInput\(/.test(seedSrc), "");
check("and never bcrypts a raw or literal PIN",
  !/hashSync\(\s*"[0-9]/.test(seedSrc) && !/hashSync\(\s*pin\s*[,)]/.test(seedSrc), "a raw-PIN bcrypt is present");
check("it writes the keyed lookup", /pinLookup:\s*pinLookup\(/.test(seedSrc), "");
check("it does NOT write the legacy pinHash", !/pinHash/.test(seedSrc), "the seed writes pinHash");
check("no four-digit PIN literal survives",
  !/"1234"|"2345"|"3456"|"4567"|"5678"/.test(seedSrc), "a legacy four-digit PIN literal is present");
check("PINs are validated by the shared six-digit policy", /validatePin\(/.test(seedSrc), "");
check("the lookup secret is required, not defaulted", /requirePinLookupSecret\(/.test(seedSrc), "");

sub("it is fail-closed on its target");
check("it requires a real PostgreSQL URL — no SQLite fallback",
  /requireDatabaseUrl\(/.test(seedSrc) && !/PrismaLibSql/.test(seedSrc) && !/file:\.\/prisma\/dev\.db/.test(seedSrc), "");
check("it refuses to run unless explicitly enabled", /ERP_SEED_ENABLED/.test(seedSrc), "");
check("and it refuses the Production endpoint by name",
  /ep-icy-field-aq4upc3z/.test(seedSrc), "the seed does not block Production");

// ─────────────────────────────────────────────────────────────────────────────
section("THE SERVER ENVIRONMENT GATE — GL-09");
//
// PIN_LOOKUP_SECRET used to be read only inside request handlers, so a deployment missing it
// installed, built, started, and answered /api/health with 200 — and then returned 500 on the
// first PIN login, possibly hours later at a wall-mounted pad.
//
// The rules live in evaluateDatabaseUrl and evaluatePinLookupSecret; src/lib/server-env.ts
// aggregates them; src/instrumentation.ts runs that aggregate at server startup and
// scripts/validate-env.ts runs it before the build compiles anything.
//
// This suite deliberately does NOT import src/lib/server-env.ts. That module imports other
// TypeScript modules, so importing it from a plain-Node .mjs would only work while Node keeps
// stripping types natively — the very coupling this correction removed from the build. The
// aggregate is proved two honest ways instead: the rules are exercised directly, and the
// SHIPPED validator is executed as a child process exactly as `npm run build` executes it.

const GOOD_DB = "postgresql://user:pw@db.example.com/appdb";
const GOOD_SECRET = "Z".repeat(48);

sub("the rules the gate aggregates");
check("a valid database URL passes", evaluateDatabaseUrl({ DATABASE_URL: GOOD_DB }).ok === true, "");
check("a missing database URL fails", evaluateDatabaseUrl({}).ok === false, "");
check("a valid secret passes", evaluatePinLookupSecret({ PIN_LOOKUP_SECRET: GOOD_SECRET }).ok === true, "");
check("a missing secret fails", evaluatePinLookupSecret({}).ok === false, "");
check("a blank secret fails", evaluatePinLookupSecret({ PIN_LOOKUP_SECRET: "   " }).ok === false, "");
check("31 characters is too short", evaluatePinLookupSecret({ PIN_LOOKUP_SECRET: "x".repeat(31) }).ok === false, "");
check("a known placeholder is refused",
  evaluatePinLookupSecret({ PIN_LOOKUP_SECRET: "hiqbah-fallback-secret" }).ok === false, "");

sub("the aggregate names both variables and restates neither rule");
const serverEnvSrc = stripComments(readFileSync(join(REPO, "src", "lib", "server-env.ts"), "utf8"));
check("it delegates to the database evaluator", /evaluateDatabaseUrl\(/.test(serverEnvSrc), "");
check("and to the PIN lookup evaluator", /evaluatePinLookupSecret\(/.test(serverEnvSrc), "");
check("it contains no copy of the length rule", !/32/.test(serverEnvSrc), "a duplicated rule constant is present");
check("and no copy of the placeholder blocklist", !/hiqbah-fallback-secret/.test(serverEnvSrc), "");
check("it exports both an evaluator and an assertion",
  /export function evaluateServerEnv/.test(serverEnvSrc) && /export function assertServerEnv/.test(serverEnvSrc), "");
check("it does not import server-only, so the build validator can load it",
  !/server-only/.test(serverEnvSrc), "");

sub("the SHIPPED validator, run exactly as the build runs it");
// node_modules/tsx/dist/cli.mjs is the binary `tsx` resolves to; invoking it through
// process.execPath keeps this shell-free and independent of PATH.
const TSX_CLI = join(REPO, "node_modules", "tsx", "dist", "cli.mjs");
const VALIDATOR = join(REPO, "scripts", "validate-env.ts");
function runValidator(env) {
  return spawnSync(process.execPath, [TSX_CLI, VALIDATOR], {
    cwd: REPO,
    encoding: "utf8",
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ...env },
  });
}
check("the validator ships as TypeScript, not as a plain-Node .mjs",
  /\.ts$/.test(VALIDATOR) && readFileSync(VALIDATOR, "utf8").length > 0, "");
const okRun = runValidator({ DATABASE_URL: GOOD_DB, PIN_LOOKUP_SECRET: GOOD_SECRET });
check("a valid environment exits 0", okRun.status === 0, "status=" + okRun.status + " " + (okRun.stderr ?? ""));

const REFUSED_VALUE = "hunter2-but-far-too-short";
const badRun = runValidator({ DATABASE_URL: GOOD_DB, PIN_LOOKUP_SECRET: REFUSED_VALUE });
const badOut = (badRun.stdout ?? "") + (badRun.stderr ?? "");
check("a weak secret exits non-zero", badRun.status === 1, "status=" + badRun.status);
check("the refusal names the variable", /PIN_LOOKUP_SECRET/.test(badOut), "");
check("and never prints the value it refused", !badOut.includes(REFUSED_VALUE), "the secret leaked into output");

const missingRun = runValidator({});
const missingOut = (missingRun.stdout ?? "") + (missingRun.stderr ?? "");
check("a wholly unconfigured environment exits non-zero", missingRun.status === 1, "status=" + missingRun.status);
check("and reports BOTH variables, not just the first",
  /DATABASE_URL/.test(missingOut) && /PIN_LOOKUP_SECRET/.test(missingOut), missingOut.slice(0, 120));

sub("install, build and migration stay separated");
check("npm run build validates the environment before compiling anything",
  /validate-env\.ts[\s\S]*prisma generate[\s\S]*next build/.test(pkg.scripts.build), pkg.scripts.build);
check("the validator runs through the locally installed tsx, not npx",
  /^tsx /.test(pkg.scripts.build) && !/npx/.test(pkg.scripts.build), pkg.scripts.build);
check("tsx is a declared direct devDependency, so that binary exists",
  Boolean((pkg.devDependencies ?? {}).tsx), "");
check("npm run build still runs NO migration",
  !/migrate|db push/.test(pkg.scripts.build), pkg.scripts.build);
check("installing dependencies needs no application secret: there is no postinstall",
  pkg.scripts.postinstall === undefined, String(pkg.scripts.postinstall));
check("Prisma generation is available as an explicit supported step",
  pkg.scripts["db:generate"] === "prisma generate", String(pkg.scripts["db:generate"]));
check("the workflows that need a generated client generate it themselves",
  /prisma generate/.test(pkg.scripts.dev) && /prisma generate/.test(pkg.scripts.seed), "");
check("migration remains an explicit operator action",
  /migrate-deploy\.mjs/.test(pkg.scripts["db:migrate:deploy"]), "");

sub("no native-TypeScript coupling is left in the build path");
const tsconfigRaw = readFileSync(join(REPO, "tsconfig.json"), "utf8");
check("tsconfig no longer relaxes .ts imports for the validator",
  !/allowImportingTsExtensions/.test(tsconfigRaw), "the compiler relaxation is still present");
check("the aggregate imports its dependencies without a .ts extension",
  !/from\s+["'][^"']*\.ts["']/.test(serverEnvSrc), "");
const validatorSrc = stripComments(readFileSync(VALIDATOR, "utf8"));
check("the validator imports the shared aggregate", /evaluateServerEnv\(/.test(validatorSrc), "");
check("and exits non-zero so the build stops", /process\.exit\(1\)/.test(validatorSrc), "");

sub("the gate still runs at server startup");
const instrSrc = stripComments(readFileSync(join(REPO, "src", "instrumentation.ts"), "utf8"));
check("instrumentation exports register()", /export async function register\s*\(/.test(instrSrc), "");
check("it asserts the server environment", /assertServerEnv\s*\(/.test(instrSrc), "");
check("scoped to the Node runtime, so an Edge instance never loads it",
  /NEXT_RUNTIME/.test(instrSrc), "");

sub("the secrets are server-only and never cross the client boundary");
function walkSrc(dir, acc = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "generated" || entry.name === "node_modules") continue;
      walkSrc(full, acc);
    } else if (/\.(ts|tsx)$/.test(entry.name)) acc.push(full);
  }
  return acc;
}
const srcFiles = walkSrc(join(REPO, "src"));
const srcTexts = new Map(srcFiles.map((f) => [f, readFileSync(f, "utf8")]));
const allSrcText = [...srcTexts.values()].join("\n");
check("no NEXT_PUBLIC variant of any secret exists anywhere in src",
  !/NEXT_PUBLIC_[A-Z0-9_]*(PIN_LOOKUP|JWT_SECRET|DATABASE_URL|DIRECT_URL)/.test(allSrcText), "");
const clientFiles = srcFiles.filter((f) => /^\s*['"]use client['"]/m.test(srcTexts.get(f)));
check("there is at least one client component, so the next check means something",
  clientFiles.length > 0, String(clientFiles.length));
const leaking = clientFiles.filter((f) =>
  /from\s+["'][^"']*(server-env|pin-lookup|db-config)["']/.test(srcTexts.get(f)));
check("no use-client module imports the server env or the PIN/database config",
  leaking.length === 0, leaking.map((f) => f.replace(REPO, "")).join(", "));

// ─────────────────────────────────────────────────────────────────────────────
section("HARNESS SELF-TEST");
console.log(`${pass} passed, ${fail} failed`);
if (failures.length) console.log("FAILURES:\n  - " + failures.join("\n  - "));
process.exit(fail === 0 ? 0 : 1);
