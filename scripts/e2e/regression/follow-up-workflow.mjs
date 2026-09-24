// FOLLOW-UP SCHEDULING — the five ways two writes can go wrong.
//
// Scheduling a follow-up writes a TASK activity and then the lead's `nextFollowUpAt`. There
// is no service that does both atomically, so the interesting behaviour is entirely in what
// happens when one half fails. That behaviour was extracted out of the React component into
// `runScheduleFollowUp` precisely so it could be exercised here with no browser and no
// database: the deps are two functions, and this file supplies failing ones.
//
// The two properties worth protecting, and the reason each exists:
//
//   - A half-written schedule must never read as success. Someone told "scheduled" walks away
//     believing the list will remind them, and it will not.
//   - A retry after a half-write must not create a second activity. Two identical TASK rows
//     for one promise are indistinguishable from a genuine reschedule, so the history stops
//     being evidence of anything.
//
// What this does NOT prove: that either write actually persists. These deps are stand-ins.
// Persistence is integration evidence and is listed as outstanding.
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../../..");
const mod = await import(`file://${path.join(ROOT, ".test-build/lib/services/sales/follow-up.js")}`)
  .catch((e) => {
    console.log("FATAL: build the domain first — npm run build:test-domain");
    console.log(String(e?.message ?? e));
    process.exit(1);
  });
const { runScheduleFollowUp, scheduleMessage, EMPTY_SCHEDULE_STATE } = mod;

const results = { pass: 0, fail: 0, failures: [] };
function check(name, ok, detail = "") {
  if (ok) { results.pass++; console.log(`  [PASS] ${name}`); }
  else { results.fail++; results.failures.push(name); console.log(`  [FAIL] ${name}  << ${detail}`); }
}
const section = (t) => console.log(`\n${"=".repeat(78)}\n  ${t}\n${"=".repeat(78)}`);
const sub = (t) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 62 - t.length))}`);

const WHEN = "2026-10-01T07:00:00.000Z";
const OTHER = "2026-10-08T07:00:00.000Z";

/** Deps that record every call, so "did it write twice" is answerable. */
function spy({ activityOk = true, dateOk = true } = {}) {
  const calls = { activity: [], date: [] };
  return {
    calls,
    deps: {
      createActivity: async (input) => {
        calls.activity.push(input);
        return activityOk ? { ok: true } : { ok: false, error: "activity refused" };
      },
      setFollowUpDate: async (iso) => {
        calls.date.push(iso);
        return dateOk ? { ok: true } : { ok: false, error: "patch refused" };
      },
    },
  };
}

section("A — THE HAPPY PATH");

sub("A1. both writes land, in the right order");
{
  const s = spy();
  const order = [];
  const deps = {
    createActivity: async (i) => { order.push("activity"); return s.deps.createActivity(i); },
    setFollowUpDate: async (i) => { order.push("date"); return s.deps.setFollowUpDate(i); },
  };
  const r = await runScheduleFollowUp(deps, EMPTY_SCHEDULE_STATE, { subject: "call back", dueAtIso: WHEN, inFlight: false });
  check("outcome is scheduled", r.outcome === "scheduled", r.outcome);
  check("the activity is written BEFORE the date", order.join(">") === "activity>date", order.join(">"));
  check("both writes are reported as performed", r.performed.activity && r.performed.date, JSON.stringify(r.performed));
  check("the date carried is the one asked for", s.calls.date[0] === WHEN, s.calls.date[0]);
  check("state is cleared — a later schedule is a new promise", r.state.activityCreatedFor === null, JSON.stringify(r.state));
  check("the message reads as success", scheduleMessage(r.outcome, false).kind === "success", "");
}

section("B — ACTIVITY CREATION FAILS");

sub("B1. nothing is written and the date is never touched");
{
  const s = spy({ activityOk: false });
  const r = await runScheduleFollowUp(s.deps, EMPTY_SCHEDULE_STATE, { subject: "x", dueAtIso: WHEN, inFlight: false });
  check("outcome is activity-failed", r.outcome === "activity-failed", r.outcome);
  check("the date write is never attempted", s.calls.date.length === 0, String(s.calls.date.length));
  check("nothing is recorded as performed", !r.performed.activity && !r.performed.date, JSON.stringify(r.performed));
  check("no partial state is remembered", r.state.activityCreatedFor === null, JSON.stringify(r.state));
  check("the server's reason is surfaced", r.error === "activity refused", String(r.error));
  const m = scheduleMessage(r.outcome, false, r.error);
  check("the message is an error, not a success", m.kind === "error", m.kind);
}

sub("B2. retrying a total failure DOES write the activity — there is none yet");
{
  const s = spy();
  const r = await runScheduleFollowUp(s.deps, { activityCreatedFor: null }, { subject: "x", dueAtIso: WHEN, inFlight: false });
  check("the activity is created on the retry", s.calls.activity.length === 1, String(s.calls.activity.length));
  check("and the retry succeeds", r.outcome === "scheduled", r.outcome);
}

section("C — THE ACTIVITY LANDS BUT THE DATE DOES NOT");

sub("C1. the half-write is reported honestly");
{
  const s = spy({ dateOk: false });
  const r = await runScheduleFollowUp(s.deps, EMPTY_SCHEDULE_STATE, { subject: "x", dueAtIso: WHEN, inFlight: false });
  check("outcome is date-failed", r.outcome === "date-failed", r.outcome);
  check("the activity was performed", r.performed.activity === true, JSON.stringify(r.performed));
  check("the date was not", r.performed.date === false, JSON.stringify(r.performed));
  const m = scheduleMessage(r.outcome, false, r.error);
  check("the message is NOT a success", m.kind !== "success", m.kind);
  check("it says the task was recorded", /task was recorded/i.test(m.text), m.text);
  check("it says the list may not show it", /may not appear/i.test(m.text), m.text);
  check("it promises the retry will not duplicate", /will not be created/i.test(m.text), m.text);
  check("the partial is remembered against the exact instant", r.state.activityCreatedFor === WHEN, JSON.stringify(r.state));
}

section("D — RETRY AFTER A PARTIAL SUCCESS");

sub("D1. the retry writes ONLY the date");
{
  const s = spy();
  const partial = { activityCreatedFor: WHEN };
  const r = await runScheduleFollowUp(s.deps, partial, { subject: "x", dueAtIso: WHEN, inFlight: false });
  check("no second activity is created", s.calls.activity.length === 0, String(s.calls.activity.length));
  check("the date is written", s.calls.date.length === 1, String(s.calls.date.length));
  check("outcome is scheduled", r.outcome === "scheduled", r.outcome);
  check("the result does not claim it wrote the activity this time",
    r.performed.activity === false, JSON.stringify(r.performed));
  check("state is cleared once whole", r.state.activityCreatedFor === null, JSON.stringify(r.state));
}

sub("D2. a retry that also fails stays resumable, still without duplicating");
{
  const s = spy({ dateOk: false });
  const r = await runScheduleFollowUp(s.deps, { activityCreatedFor: WHEN }, { subject: "x", dueAtIso: WHEN, inFlight: false });
  check("still no second activity", s.calls.activity.length === 0, String(s.calls.activity.length));
  check("still remembered for another attempt", r.state.activityCreatedFor === WHEN, JSON.stringify(r.state));
}

sub("D3. changing the date after a partial IS a new promise, and writes a new activity");
{
  const s = spy();
  const r = await runScheduleFollowUp(s.deps, { activityCreatedFor: WHEN }, { subject: "x", dueAtIso: OTHER, inFlight: false });
  check("a different instant creates its own activity", s.calls.activity.length === 1, String(s.calls.activity.length));
  check("and it carries the NEW date", s.calls.activity[0].dueAtIso === OTHER, s.calls.activity[0].dueAtIso);
  check("outcome is scheduled", r.outcome === "scheduled", r.outcome);
}

section("E — DOUBLE SUBMISSION");

sub("E1. a submit while one is in flight writes nothing at all");
{
  const s = spy();
  const r = await runScheduleFollowUp(s.deps, EMPTY_SCHEDULE_STATE, { subject: "x", dueAtIso: WHEN, inFlight: true });
  check("outcome is already-running", r.outcome === "already-running", r.outcome);
  check("no activity written", s.calls.activity.length === 0, String(s.calls.activity.length));
  check("no date written", s.calls.date.length === 0, String(s.calls.date.length));
  check("it shows no message at all — the first submit owns the feedback",
    scheduleMessage(r.outcome, false).kind === "none", "");
  check("the in-flight refusal does not disturb remembered state",
    r.state.activityCreatedFor === null, JSON.stringify(r.state));
}

sub("E2. two rapid submits produce exactly one activity");
{
  const s = spy();
  // The realistic shape: the second tap arrives while the first is still awaiting.
  const first = runScheduleFollowUp(s.deps, EMPTY_SCHEDULE_STATE, { subject: "x", dueAtIso: WHEN, inFlight: false });
  const second = await runScheduleFollowUp(s.deps, EMPTY_SCHEDULE_STATE, { subject: "x", dueAtIso: WHEN, inFlight: true });
  await first;
  check("exactly one activity", s.calls.activity.length === 1, String(s.calls.activity.length));
  check("exactly one date write", s.calls.date.length === 1, String(s.calls.date.length));
  check("the ignored submit says so", second.outcome === "already-running", second.outcome);
}

section("F — NO OUTCOME LIES");

sub("F1. only a complete schedule may read as success");
{
  for (const o of ["activity-failed", "date-failed", "already-running"]) {
    check(`${o} does not produce a success message`, scheduleMessage(o, false).kind !== "success", o);
  }
  check("scheduled does", scheduleMessage("scheduled", false).kind === "success", "");
}

sub("F2. both languages carry the same guarantees");
{
  const arMsg = scheduleMessage("date-failed", true);
  check("the Arabic half-write message is not a success", arMsg.kind !== "success", arMsg.kind);
  check("and it also promises no duplicate", /لن تُنشأ مهمة ثانية/.test(arMsg.text), arMsg.text);
}

section("FOLLOW-UP WORKFLOW RESULT");
console.log(`${results.pass} passed, ${results.fail} failed`);
console.log("\nNOTE: the two writes are stand-ins here. That they PERSIST — and that the");
console.log("activity is really a TASK against the right lead — is integration evidence.");
if (results.fail > 0) {
  console.log("\nFailures:");
  for (const f of results.failures) console.log("  - " + f);
  process.exit(1);
}
