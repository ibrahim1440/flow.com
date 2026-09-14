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
import { readFileSync } from "node:fs";
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
section("HARNESS SELF-TEST");
console.log(`${pass} passed, ${fail} failed`);
if (failures.length) console.log("FAILURES:\n  - " + failures.join("\n  - "));
process.exit(fail === 0 ? 0 : 1);
