// HARNESS TESTS for scripts/accounting/zatca-sdk/harness.mjs. They use a STUB "SDK" built here (a
// shell script that prints fixed lines) and a synthetic matrix. They test the harness's evidence
// collection and gate decision only. They are NOT official ZATCA SDK validation and say nothing
// about whether our e-invoices conform.
//   node --test tests/accounting/harness/zatca-sdk-harness.test.mjs
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, cpSync, chmodSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync, execFileSync } from "node:child_process";
import * as L from "../../../scripts/accounting/zatca-sdk/lib.mjs";

const HARNESS = new URL("../../../scripts/accounting/zatca-sdk/harness.mjs", import.meta.url).pathname;
const base = mkdtempSync(join(tmpdir(), "zatca-harness-test-"));
const sha = (b) => createHash("sha256").update(b).digest("hex");
const TEST_PROFILE = { confirmed: true, confirmedBy: "HARNESS TEST PROFILE (stub output only)", confirmedAgainst: "stub",
  validate: { globalResult: "^STUB GLOBAL RESULT = (?<result>[A-Z ]+)$", checkResult: "^STUB \\[(?<check>\\w+)\\] = (?<result>\\w+)$", warning: "^STUB WARNING", error: "^STUB ERROR", passValues: ["PASSED"], failValues: ["NOT PASSED"] },
  hash: { line: "^STUB HASH = (?<hash>\\S+)$" } };
const profilePath = join(base, "profile.json");
const unconfirmedPath = join(base, "profile-unconfirmed.json");

function makeMatrix(dir) {
  const sums = [], docs = [];
  for (const key of L.MATRIX_KEYS) {
    mkdirSync(join(dir, key), { recursive: true });
    const xml = Buffer.from(`<Invoice><cbc:ID>${key}</cbc:ID><note>نص عربي</note></Invoice>`);
    const invoiceHash = createHash("sha256").update(xml).digest("base64");
    const files = { "document.xml": xml, "qr.txt": "AQ==\n", "qr.bin": Buffer.from([1]), "meta.json": JSON.stringify({ key, invoiceHash }) + "\n" };
    for (const [f, c] of Object.entries(files)) { writeFileSync(join(dir, key, f), c); sums.push(`${sha(readFileSync(join(dir, key, f)))}  ${key}/${f}`); }
    docs.push({ key });
  }
  writeFileSync(join(dir, "SHA256SUMS"), sums.join("\n") + "\n");
  writeFileSync(join(dir, "MANIFEST.json"), JSON.stringify({ fixture: "harness-test", documents: docs }));
}

/** A stub SDK archive. behaviour(key) decides what the stub prints for each document. */
function makeStubArchive(name, { readmeCommands = ["validate", "generateHash"], behaviour = "pass", extra } = {}) {
  const d = join(base, `${name}-src`, "stub-sdk");
  mkdirSync(join(d, "Apps"), { recursive: true }); mkdirSync(join(d, "Configuration"), { recursive: true });
  writeFileSync(join(d, "readme.md"), ["STUB SDK FOR HARNESS TESTS — not the ZATCA SDK", "The prerequisite is using the Java SDK (JAR) versions >=11 and <15.",
    ...readmeCommands.map((c) => `***fatoora -${c} -invoice <filename>***`)].join("\n"));
  writeFileSync(join(d, "install.sh"), 'echo "export FATOORA_HOME=${PWD}/Apps" >> ~/.bash-profile\necho "export SDK_CONFIG=${PWD}/Configuration/config.json" >> ~/.bash-profile\n');
  writeFileSync(join(d, "Apps", "stub.jar"), "not a jar");
  writeFileSync(join(d, "Apps", "fatoora"), `#!/bin/sh
# STUB: prints fixed lines so the harness can be tested. Behaviour: ${behaviour}
CMD=$1; FILE=$3; KEY=$(basename $(dirname "$FILE"))
HASH=$(sed -n 's/.*"invoiceHash":"\\([^"]*\\)".*/\\1/p' "$(dirname "$FILE")/meta.json")
B="${behaviour}"
if [ "$CMD" = "-validate" ]; then
  case "$B:$KEY" in
    sdkfail:simplified-debit-note) echo "STUB GLOBAL RESULT = NOT PASSED"; echo "STUB ERROR something"; exit 1;;
    garbage:*) echo "unexpected text"; exit 0;;
    *) echo "STUB [XSD] = PASSED"; echo "STUB WARNING minor"; echo "STUB GLOBAL RESULT = PASSED"; exit 0;;
  esac
fi
if [ "$CMD" = "-generateHash" ]; then
  case "$B:$KEY" in
    mismatch:standard-credit-note) echo "STUB HASH = AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="; exit 0;;
    garbage:*) echo "no hash here"; exit 0;;
    *) echo "STUB HASH = $HASH"; exit 0;;
  esac
fi
exit 2
`);
  chmodSync(join(d, "Apps", "fatoora"), 0o755);
  if (extra) extra(d);
  const zip = join(base, `${name}.zip`);
  execFileSync("zip", ["-qry", zip, "stub-sdk"], { cwd: join(base, `${name}-src`) });
  return { archive: zip, sha256: sha(readFileSync(zip)) };
}

/** Runs the harness. keep=true reuses the same requested output location (no cleanup). */
function run(t, { archive, sha256, matrix, profile = profilePath, runner = "direct", extra = [], keep = false }) {
  const out = join(base, `out-${t}`);
  if (!keep) rmSync(out, { recursive: true, force: true });
  const a = ["--matrix", matrix, "--out", out, "--profile", profile, "--runner", runner, "--harness-test", "--source-url", "https://zatca.gov.sa/stub-test"];
  if (archive) a.push("--archive", archive);
  if (sha256) a.push("--sha256", sha256);
  const r = spawnSync("node", [HARNESS, ...a, ...extra], { encoding: "utf8" });
  const runId = readFileSync(join(out, "LATEST"), "utf8").trim();
  const summary = JSON.parse(readFileSync(join(out, runId, "summary.json"), "utf8"));
  const check = (key, cmd) => summary.documents.find((d) => d.key === key).checks[cmd];
  return { exit: r.status, out, runId, summary, check, status: (key, cmd) => check(key, cmd).status };
}
/** A replacement runner (direct runner, harness tests only). */
function runnerScript(name, body) {
  const p = join(base, `runner-${name}.sh`);
  writeFileSync(p, `#!/bin/sh\n# HARNESS TEST RUNNER: ${name}\n${body}\n`);
  return p;
}

let M, pass;
before(() => {
  writeFileSync(profilePath, JSON.stringify(TEST_PROFILE));
  writeFileSync(unconfirmedPath, JSON.stringify({ ...TEST_PROFILE, confirmed: false }));
  M = join(base, "matrix"); makeMatrix(M);
  pass = makeStubArchive("pass");
});

test("harness: all six documents pass → exit 0, still marked harness test (never official)", () => {
  const r = run("pass", { ...pass, matrix: M });
  assert.equal(r.exit, 0, JSON.stringify(r.summary.preconditions));
  assert.equal(r.summary.gate.decision, "PASS");
  assert.equal(r.summary.gate.counts.total, 12);
  assert.equal(r.summary.official, false);
  const v = r.summary.documents[0].checks.validate;
  assert.deepEqual([v.global, v.warnings.length, v.raw.exitCode, v.raw.argv[1]], ["PASSED", 1, 0, "-validate"]);
});

test("harness: an SDK command failure on one document → exit 1, the other five are still collected", () => {
  const r = run("sdkfail", { ...makeStubArchive("sdkfail", { behaviour: "sdkfail" }), matrix: M });
  assert.equal(r.exit, 1);
  assert.equal(r.status("simplified-debit-note", "validate"), "FAIL");
  assert.equal(r.summary.documents.filter((d) => d.checks.validate.status === "PASS").length, 5);
});

test("harness: SDK hash differs from the application hash → FAIL, exit 1", () => {
  const r = run("mismatch", { ...makeStubArchive("mismatch", { behaviour: "mismatch" }), matrix: M });
  assert.equal(r.exit, 1);
  assert.equal(r.status("standard-credit-note", "generateHash"), "FAIL");
  assert.match(r.summary.documents.find((d) => d.key === "standard-credit-note").checks.generateHash.reason, /differs/);
});

test("harness: a missing document → FAIL for it, exit 1; evidence still lists all six", () => {
  const m2 = join(base, "matrix-missing"); cpSync(M, m2, { recursive: true }); rmSync(join(m2, "standard-debit-note"), { recursive: true });
  const r = run("missing", { ...pass, matrix: m2 });
  assert.equal(r.exit, 1);
  assert.equal(r.summary.documents.length, 6);
  assert.equal(r.status("standard-debit-note", "validate"), "FAIL");
});

test("harness: a corrupted input (checksum mismatch) → FAIL for that document, exit 1", () => {
  const m3 = join(base, "matrix-corrupt"); cpSync(M, m3, { recursive: true });
  writeFileSync(join(m3, "simplified-invoice", "document.xml"), "<Invoice>tampered</Invoice>");
  const r = run("corrupt", { ...pass, matrix: m3 });
  assert.equal(r.exit, 1);
  assert.equal(r.status("simplified-invoice", "validate"), "FAIL");
  assert.match(r.summary.documents.find((d) => d.key === "simplified-invoice").checks.validate.reason, /checksum mismatch/);
});

test("harness: output it cannot interpret → BLOCKED, exit 3 (exit code 0 is never taken as a pass)", () => {
  const r = run("garbage", { ...makeStubArchive("garbage", { behaviour: "garbage" }), matrix: M });
  assert.equal(r.exit, 3);
  assert.equal(r.status("standard-invoice", "validate"), "BLOCKED");
  assert.equal(r.status("standard-invoice", "generateHash"), "BLOCKED");
});

test("harness: an unconfirmed output profile → BLOCKED everywhere, exit 3", () => {
  const r = run("unconfirmed", { ...pass, matrix: M, profile: unconfirmedPath });
  assert.equal(r.exit, 3);
  assert.equal(r.summary.gate.counts.blocked, 12);
});

test("harness: wrong archive hash → FAIL precondition, nothing runs, exit 1", () => {
  const r = run("badsha", { archive: pass.archive, sha256: "0".repeat(64), matrix: M });
  assert.equal(r.exit, 1);
  assert.equal(r.summary.gate.counts.notRun, 12);
});

test("harness: no archive → NOT_RUN, exit 3", () => {
  const r = run("noarchive", { matrix: M });
  assert.equal(r.exit, 3);
  assert.equal(r.summary.gate.decision, "NOT_RUN");
});

test("harness: an undocumented command → BLOCKED for that command", () => {
  const r = run("undoc", { ...makeStubArchive("undoc", { readmeCommands: ["validate"] }), matrix: M });
  assert.equal(r.exit, 3);
  assert.equal(r.status("standard-invoice", "validate"), "PASS");
  assert.equal(r.status("standard-invoice", "generateHash"), "BLOCKED");
});

test("harness: unsafe archive entries (traversal, symbolic link) are refused before extraction", () => {
  const evil = join(base, "evil.zip");
  spawnSync("python3", ["-c", `import zipfile,stat
z=zipfile.ZipFile(${JSON.stringify(evil)},'w')
z.writestr('stub-sdk/install.sh','echo')
z.writestr('../escape.txt','x')
i=zipfile.ZipInfo('stub-sdk/link'); i.external_attr=(stat.S_IFLNK|0o777)<<16; z.writestr(i,'/etc/passwd')
z.close()`]);
  const r = run("evil", { archive: evil, sha256: sha(readFileSync(evil)), matrix: M });
  assert.equal(r.exit, 1);
  const p = r.summary.preconditions.find((x) => x.name.startsWith("archive entries safe"));
  assert.equal(p.status, "FAIL");
  assert.match(p.detail, /path traversal: \.\.\/escape\.txt/);
  assert.match(p.detail, /not a regular file or directory \(l\): stub-sdk\/link/);
});

test("lib: java requirement parsing and archive entry checks", () => {
  assert.deepEqual([L.javaRequirement("versions >=11 and <15").min, L.javaRequirement("must be between 11 and 15").maxExclusive], [11, 15]);
  assert.equal(L.javaRequirement("no statement"), null);
  assert.deepEqual(L.checkArchiveEntries([{ name: "a/b.txt", mode: "-rw-r--r--" }]), []);
  assert.equal(L.checkArchiveEntries([{ name: "/etc/x", mode: "-rw-r--r--" }]).length > 0, true);
  assert.equal(L.checkArchiveEntries([{ name: "a\\..\\b", mode: "-rw-r--r--" }]).length > 0, true);
});

test("harness: the container runner runs the stub with no network and read-only inputs (skipped without Docker)", (t) => {
  if (spawnSync("docker", ["image", "inspect", "zatca-sdk-runner:11"]).status !== 0) { t.skip("Docker or the runner image is not available"); return; }
  const out = join(base, "out-container");
  rmSync(out, { recursive: true, force: true });
  const r = spawnSync("node", [HARNESS, "--matrix", M, "--out", out, "--profile", profilePath, "--runner", "container", "--harness-test", "--archive", pass.archive, "--sha256", pass.sha256, "--source-url", "https://zatca.gov.sa/stub-test"], { encoding: "utf8" });
  const s = JSON.parse(readFileSync(join(out, readFileSync(join(out, "LATEST"), "utf8").trim(), "summary.json"), "utf8"));
  assert.equal(r.status, 0, JSON.stringify(s.preconditions) + JSON.stringify(s.documents[0]));
  assert.equal(s.runner, "container");
  assert.equal(s.official, false, "a stub run is never official");
});

// ── Stale evidence: a run can only ever be judged on output written by that run ──────────────

test("harness: REGRESSION — a successful run, then a failing runner on the same output location, cannot PASS", () => {
  const first = run("reuse", { ...pass, matrix: M });
  assert.equal(first.exit, 0);
  assert.equal(first.summary.gate.decision, "PASS");
  // Same requested --out, nothing cleaned up; the runner now fails without writing anything.
  const failing = runnerScript("exits-1", 'echo "simulated runner failure" >&2; exit 1');
  const second = run("reuse", { ...pass, matrix: M, keep: true, extra: ["--runner-script", failing] });
  assert.notEqual(second.runId, first.runId, "every run gets its own run directory");
  assert.equal(second.exit, 1);
  assert.equal(second.summary.gate.decision, "FAIL");
  assert.equal(second.summary.gate.counts.pass, 0, "nothing from the first run may be counted");
  assert.equal(second.summary.gate.counts.fail, 12);
  assert.match(second.check("standard-invoice", "validate").reason, /runner exit 1/);
  assert.equal(second.check("standard-invoice", "validate").raw.runId, second.runId);
  // The first run's evidence is untouched and still says what it said.
  const kept = JSON.parse(readFileSync(join(first.out, first.runId, "summary.json"), "utf8"));
  assert.equal(kept.gate.decision, "PASS");
  assert.equal(kept.runId, first.runId);
});

test("harness: a runner that replays an earlier run's output files is refused (foreign run ID)", () => {
  const first = run("replay", { ...pass, matrix: M });
  assert.equal(first.exit, 0);
  // Copies the earlier run's evidence for this command into its fresh directory and claims success.
  const replay = runnerScript("replay", `CMD=$1 KEY=$2
for d in "$OUT_DIR"/../../../../*/cmd/$KEY/$CMD; do [ "$d" -ef "$OUT_DIR" ] && continue; cp "$d"/* "$OUT_DIR"/; break; done
exit 0`);
  const second = run("replay", { ...pass, matrix: M, keep: true, extra: ["--runner-script", replay] });
  assert.equal(second.exit, 1);
  assert.equal(second.summary.gate.counts.pass, 0);
  assert.match(second.check("simplified-invoice", "generateHash").reason, new RegExp(`output belongs to another run \\(${first.runId}\\)`));
});

test("harness: output bound to this run but to a different input is refused", () => {
  const forge = runnerScript("wrong-input", `echo "$RUN_ID" > "$OUT_DIR/run-id"; echo ${"0".repeat(64)} > "$OUT_DIR/input.sha256"
printf 'fatoora\\n' > "$OUT_DIR/argv"; date > "$OUT_DIR/started"; date > "$OUT_DIR/finished"
echo "STUB GLOBAL RESULT = PASSED" > "$OUT_DIR/stdout"; echo 0 > "$OUT_DIR/exit"; exit 0`);
  const r = run("wrong-input", { ...pass, matrix: M, extra: ["--runner-script", forge] });
  assert.equal(r.exit, 1);
  assert.equal(r.summary.gate.counts.pass, 0);
  assert.match(r.check("standard-invoice", "validate").reason, /runner read a different input/);
});

test("harness: a runner that exits 0 but writes no fresh output → FAIL", () => {
  const silent = runnerScript("silent", "exit 0");
  const r = run("silent", { ...pass, matrix: M, extra: ["--runner-script", silent] });
  assert.equal(r.exit, 1);
  assert.match(r.check("standard-invoice", "validate").reason, /no fresh output: run-id missing/);
});

test("harness: a runner timeout → FAIL", () => {
  const hang = runnerScript("hang", "exec sleep 30");
  const t0 = Date.now();
  const r = run("timeout", { ...pass, matrix: M, extra: ["--runner-script", hang, "--timeout-seconds", "1"] });
  assert.equal(r.exit, 1);
  assert.ok(Date.now() - t0 < 25000, "the harness did not wait for the hung runner");
  assert.match(r.check("standard-invoice", "validate").reason, /runner timed out after 1 s/);
});

test("harness: SDK installation failure stops the runner and is recorded as FAIL", () => {
  const broken = makeStubArchive("installfail", { extra: (d) => writeFileSync(join(d, "install.sh"), 'echo "simulated install failure" >&2; exit 3\n') });
  const r = run("installfail", { ...broken, matrix: M });
  assert.equal(r.exit, 1);
  assert.equal(r.summary.gate.counts.fail, 12);
  const c = r.check("standard-invoice", "validate");
  assert.match(c.reason, /runner exit 72: SDK installation failed \(install.sh exit 3/);
  assert.equal(c.raw.exitCode, null, "the SDK command never ran");
  assert.ok(!c.raw.filesWritten.includes("stdout"));
});

test("harness: --runner-script is refused outside direct harness tests", () => {
  const r = spawnSync("node", [HARNESS, "--matrix", M, "--out", join(base, "out-refuse"), "--runner", "container", "--runner-script", "/bin/true", "--source-url", "x"], { encoding: "utf8" });
  assert.equal(r.status, 64);
});

test("harness: a container that cannot launch → FAIL, nothing runs (skipped without Docker)", (t) => {
  if (spawnSync("docker", ["info"]).status !== 0) { t.skip("Docker is not available"); return; }
  const r = run("nolaunch", { ...pass, matrix: M, runner: "container", extra: ["--image", "zatca-sdk-runner:does-not-exist"] });
  assert.equal(r.exit, 1);
  assert.equal(r.summary.preconditions.find((p) => p.name === "runner container launches")?.status, "FAIL");
  assert.equal(r.summary.gate.counts.notRun, 12);
});
