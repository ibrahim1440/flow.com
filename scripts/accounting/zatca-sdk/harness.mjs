#!/usr/bin/env node
// ZATCA SDK validation harness. Collects evidence for all six application-generated documents, then
// decides the gate separately: exit 0 only if every required check is PASS; 1 if anything FAILED;
// 3 if anything is BLOCKED or NOT_RUN (and nothing failed). See docs/accounting/ZATCA_SDK_VALIDATION.md.
//
//   node scripts/accounting/zatca-sdk/harness.mjs --matrix <dir> --out <dir> --archive <sdk.zip> \
//     --sha256 <hex> --source-url <where it was downloaded from> [--profile <output-profile.json>]
//     [--image zatca-sdk-runner:11] [--runner container|direct] [--harness-test] [--timeout-seconds 600]
//     [--downloaded-at <time>] [--provenance-note <text>]
//     [--repackaged-from <MANIFEST.json of the extracted files>]
//
// --repackaged-from: the archive is a LOCAL transport zip made from extracted files (e.g. received
// unzipped), not the original download. --sha256 then checks only that transport zip; the original
// archive's checksum is recorded as NOT VERIFIED, the source manifest's own SHA-256 is recorded, and
// the run can never be marked official, whatever its results.
//
// Fresh evidence only: every invocation creates a NEW run directory <out>/<runId>/ (creation fails if
// it already exists) and a new, empty directory per command inside it. Each command's runner writes
// the run ID and the SHA-256 of the input it actually read; a result counts only if both match this
// run and the verified matrix. A container launch failure, a nonzero runner exit, a timeout, or
// missing or foreign output is a FAIL — evidence from an earlier run is never read. <out>/LATEST is
// removed when a run starts and written only when it finishes.
//
// Isolation: --runner container (default, the only mode that can produce an official result) runs
// every SDK command in a fresh container with no network, a read-only root, the SDK and matrix
// mounted read-only, a tmpfs work directory and one writable output directory, as an unprivileged
// user with all capabilities dropped. --runner direct exists ONLY for harness tests with a stub SDK
// and is always recorded as "harness test — not official validation".
// Provenance: --sha256 verifies the archive's integrity against that value; --source-url is recorded
// as the operator's claim — it does not authenticate where the archive came from.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync, readdirSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join, resolve, dirname, relative, basename } from "node:path";
import { fileURLToPath } from "node:url";
import * as L from "./lib.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).reduce((a, x, i, all) => (x.startsWith("--") ? [...a, [x.slice(2), all[i + 1]?.startsWith("--") || all[i + 1] === undefined ? true : all[i + 1]]] : a), []));
const need = (k) => { if (!args[k] || args[k] === true) { console.error(`missing --${k}`); process.exit(64); } return args[k]; };
const MATRIX = resolve(need("matrix")), OUT = resolve(need("out"));
const runner = args.runner ?? "container";
const harnessTest = !!args["harness-test"] || runner !== "container";
const image = args.image ?? "zatca-sdk-runner:11";
const profile = JSON.parse(readFileSync(args.profile ? resolve(args.profile) : join(HERE, "output-profile.json"), "utf8"));
const now = () => new Date().toISOString();
const TIMEOUT_MS = Number(args["timeout-seconds"] ?? 600) * 1000;
// Test-only: replace run-one.sh (direct runner + --harness-test only; never official).
const runnerScript = args["runner-script"] && args["runner-script"] !== true ? resolve(args["runner-script"]) : null;
if (runnerScript && (runner !== "direct" || !args["harness-test"])) { console.error("--runner-script is only allowed with --runner direct --harness-test"); process.exit(64); }
mkdirSync(OUT, { recursive: true });
rmSync(join(OUT, "LATEST"), { force: true });
const runId = `${new Date().toISOString().replace(/[-:.]/g, "")}-${randomBytes(6).toString("hex")}`;
const RUN = join(OUT, runId);
mkdirSync(RUN); // not recursive: fails if it already exists, so nothing from an earlier run can be in it

const ev = { harness: "scripts/accounting/zatca-sdk/harness.mjs", runId, runDir: RUN, startedAt: now(), official: false, harnessTest, runner, image: runner === "container" ? image : null,
  inputs: { matrix: MATRIX, archive: args.archive ?? null, archiveFileName: args.archive && args.archive !== true ? basename(args.archive) : null, sha256Expected: args.sha256 ?? null },
  // Provenance as stated by the operator. None of it is verified by the harness: the SHA-256 shows the
  // file is the one the operator hashed, not where it came from or that it is the current release.
  provenanceClaimed: { sourceUrl: args["source-url"] ?? null, downloadedAt: args["downloaded-at"] ?? null, note: args["provenance-note"] ?? null,
    authenticated: false, latestRelease: "not assumed" }, preconditions: [], sdk: {}, documents: [] };
const repackagedFrom = args["repackaged-from"] && args["repackaged-from"] !== true ? resolve(args["repackaged-from"]) : null;
if (repackagedFrom) {
  ev.archiveKind = "locally repackaged transport zip, built from user-provided extracted files; NOT the original downloaded archive";
  ev.originalArchiveChecksum = "NOT VERIFIED";
  ev.sourceManifest = existsSync(repackagedFrom) ? { path: repackagedFrom, sha256: L.sha256File(repackagedFrom), files: JSON.parse(readFileSync(repackagedFrom, "utf8")).files?.length ?? null } : { path: repackagedFrom, missing: true };
} else ev.archiveKind = "archive as supplied";
const pre = (name, status, detail) => { ev.preconditions.push({ name, status, detail }); return status === L.STATUS.PASS; };
try { ev.applicationCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: HERE }).toString().trim(); } catch { ev.applicationCommit = null; }

// ── Preconditions (each recorded; a failure stops SDK execution but not evidence collection) ──
let canRun = true, blockedReason = null;
const m = L.verifyMatrix(MATRIX);
ev.matrix = { problems: m.problems, manifest: existsSync(join(MATRIX, "MANIFEST.json")) ? JSON.parse(readFileSync(join(MATRIX, "MANIFEST.json"), "utf8")) : null };
pre("matrix: exactly the six documents, checksums verified", m.ok ? L.STATUS.PASS : L.STATUS.FAIL, m.problems.join("; ") || "ok");

const archive = args.archive && args.archive !== true ? resolve(args.archive) : null;
if (!archive || !existsSync(archive)) { pre("SDK archive present", L.STATUS.NOT_RUN, "no SDK archive supplied"); canRun = false; }
else {
  const actual = L.sha256File(archive);
  ev.sdk.archiveSha256 = actual;
  if (!/^[0-9a-f]{64}$/.test(String(args.sha256 ?? ""))) { pre("archive SHA-256 matches the supplied value", L.STATUS.FAIL, "no valid --sha256 supplied"); canRun = false; }
  else if (actual !== args.sha256) { pre("archive SHA-256 matches the supplied value", L.STATUS.FAIL, `actual ${actual}`); canRun = false; }
  else pre("archive SHA-256 matches the supplied value", L.STATUS.PASS, actual);
}

const SDK = join(RUN, "sdk-extracted");
if (canRun) {
  const info = spawnSync("zipinfo", ["-l", archive], { encoding: "utf8" });
  const entries = L.parseZipinfo(info.stdout ?? "");
  const problems = info.status === 0 && entries.length ? L.checkArchiveEntries(entries) : [`zipinfo could not list the archive (exit ${info.status})`];
  ev.sdk.entries = entries.length;
  if (!pre("archive entries safe (no absolute paths, traversal or links)", problems.length ? L.STATUS.FAIL : L.STATUS.PASS, problems.slice(0, 20).join("; ") || `${entries.length} entries`)) canRun = false;
}
if (canRun) {
  mkdirSync(SDK);
  const unz = spawnSync("unzip", ["-q", "-n", archive, "-d", SDK], { encoding: "utf8" });
  const links = execFileSync("find", [SDK, "-type", "l"]).toString().trim();
  if (!pre("archive extracted, no links after extraction", unz.status === 0 && !links ? L.STATUS.PASS : L.STATUS.FAIL, unz.status !== 0 ? `unzip exit ${unz.status}` : links ? `links: ${links.slice(0, 200)}` : "ok")) canRun = false;
}
let readme = "";
if (canRun) {
  const install = execFileSync("find", [SDK, "-name", "install.sh"]).toString().trim().split("\n").filter(Boolean);
  if (install.length !== 1) { pre("exactly one install.sh", L.STATUS.FAIL, `${install.length} found`); canRun = false; }
  else {
    const root = dirname(install[0]);
    writeFileSync(join(SDK, ".sdk-root"), relative(SDK, root) || ".");
    // Readmes anywhere in the archive (e.g. Readme/readme.rtf and Readme/readme.pdf); every one is
    // recorded with its hash, and the first readable format in README_FORMATS order is used.
    const rank = (f) => L.README_FORMATS.findIndex((x) => f.toLowerCase().endsWith(x));
    const readmes = execFileSync("find", [SDK, "-type", "f", "-iname", "readme*"]).toString().trim().split("\n").filter(Boolean)
      .filter((f) => rank(f) >= 0).sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
    ev.sdk.readmes = readmes.map((f) => ({ path: relative(SDK, f), sha256: L.sha256File(f), readable: L.readmeText(f).readable }));
    const used = readmes.find((f) => L.readmeText(f).readable);
    if (used) { const r = L.readmeText(used); readme = r.text; ev.sdk.readme = { path: relative(SDK, used), how: r.how }; writeFileSync(join(RUN, "readme-text.txt"), readme); }
    const jars = execFileSync("find", [SDK, "-name", "*.jar"]).toString().trim().split("\n").filter(Boolean).sort();
    ev.sdk.root = relative(SDK, root) || ".";
    // Versions come from the jars themselves (file name, and the Maven pom.properties inside), recorded
    // separately from the archive's file name, which says nothing reliable about the version.
    ev.sdk.jars = jars.map((j) => {
      const pom = spawnSync("unzip", ["-p", j, "META-INF/maven/*/*/pom.properties"], { encoding: "utf8" });
      const prop = (k) => (new RegExp(`^${k}=(.*)$`, "m").exec(pom.stdout ?? "") ?? [])[1]?.trim() ?? null;
      return { path: relative(SDK, j), sha256: L.sha256File(j), ...L.jarComponent(basename(j)), pom: pom.status === 0 && pom.stdout ? { groupId: prop("groupId"), artifactId: prop("artifactId"), version: prop("version") } : null };
    });
    ev.sdk.javaRequirement = L.javaRequirement(readme);
    if (!readme) { pre("readable readme found", L.STATUS.BLOCKED, readmes.length ? `only unreadable formats: ${readmes.map((f) => relative(SDK, f)).join(", ")}` : "no readme in the archive"); blockedReason = "no readme"; }
    else pre("readable readme found", L.STATUS.PASS, `${ev.sdk.readme.path} (${ev.sdk.readme.how})`);
  }
}
const documentedCmd = { validate: L.documented(readme, L.COMMANDS.validate), generateHash: L.documented(readme, L.COMMANDS.hash) };
if (canRun) pre("commands documented in the archive's readme", documentedCmd.validate && documentedCmd.generateHash ? L.STATUS.PASS : L.STATUS.BLOCKED, JSON.stringify(documentedCmd));
if (canRun) pre("SDK output profile confirmed against the official SDK", profile.confirmed ? L.STATUS.PASS : L.STATUS.BLOCKED, profile.confirmed ? `${profile.confirmedBy} / ${profile.confirmedAgainst}` : "not confirmed — results cannot be interpreted reliably");

// ── Runner ──────────────────────────────────────────────────────────────────────────────────
// Each command gets a NEW empty directory (mkdir fails if it exists) that is the only thing the
// runner can write. The result is read only from there, and only if the runner completed.
const RUN_ONE = runnerScript ?? join(HERE, "run-one.sh");
function runOne(cmd, key) {
  const dir = join(RUN, "cmd", key, cmd);
  mkdirSync(join(RUN, "cmd", key), { recursive: true });
  mkdirSync(dir);
  const opts = { encoding: "utf8", timeout: TIMEOUT_MS, killSignal: "SIGKILL" };
  let r, name = null;
  if (runner === "container") {
    chmodSync(dir, 0o777); // the container runs as uid 10001; only this directory is writable to it
    name = `zatca-${runId}-${key}-${cmd}`.toLowerCase();
    r = spawnSync("docker", ["run", "--rm", "--name", name, "--network", "none", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--pids-limit", "512", "--memory", "2g",
      "--tmpfs", "/work:rw,exec,size=1g", "--tmpfs", "/tmp:rw,size=256m", "-e", "SDK_DIR=/sdk", "-e", "IN_DIR=/in", "-e", "OUT_DIR=/out", "-e", "WORK_DIR=/work", "-e", `RUN_ID=${runId}`,
      "-v", `${SDK}:/sdk:ro`, "-v", `${MATRIX}:/in:ro`, "-v", `${dir}:/out:rw`, "-v", `${RUN_ONE}:/runner/run-one.sh:ro`, image, "sh", "/runner/run-one.sh", cmd, key], opts);
  } else {
    r = spawnSync("sh", [RUN_ONE, cmd, key], { ...opts, env: { ...process.env, SDK_DIR: SDK, IN_DIR: MATRIX, OUT_DIR: dir, WORK_DIR: join(RUN, "work"), RUN_ID: runId } });
  }
  const timedOut = r.error?.code === "ETIMEDOUT";
  if (name && (r.error || r.signal)) spawnSync("docker", ["rm", "-f", name], { encoding: "utf8" });
  return { dir, runnerExit: r.status, signal: r.signal ?? null, timedOut, launchError: r.error && !timedOut ? String(r.error.code ?? r.error.message) : null, runnerStderr: (r.stderr ?? "").slice(-2000) };
}
/** Why a runner result cannot be used, or null if it is a complete, fresh result of this run. */
function runnerProblem(r, read, expectedInputSha) {
  if (r.timedOut) return `runner timed out after ${TIMEOUT_MS / 1000} s`;
  if (r.launchError) return `runner could not be launched (${r.launchError})`;
  if (r.signal) return `runner killed by ${r.signal}`;
  if (r.runnerExit !== 0) return `runner exit ${r.runnerExit}${read("runner-error") ? `: ${read("runner-error").trim()}` : ""}${runner === "container" && r.runnerExit === 125 ? " (container launch failure)" : ""}`;
  const got = read("run-id")?.trim();
  if (got !== runId) return got ? `output belongs to another run (${got})` : "no fresh output: run-id missing";
  const seen = read("input.sha256")?.trim();
  if (seen !== expectedInputSha) return seen ? `runner read a different input (sha256 ${seen.slice(0, 12)}…, verified ${String(expectedInputSha).slice(0, 12)}…)` : "no fresh output: input.sha256 missing";
  for (const f of ["exit", "argv", "started", "finished", "stdout"]) if (read(f) === null) return `no fresh output: ${f} missing`;
  return null;
}
if (canRun && runner === "container") {
  const v = spawnSync("docker", ["run", "--rm", "--network", "none", image, "java", "-version"], { encoding: "utf8", timeout: 120000 });
  if (v.status !== 0 && !/version "/.test(v.stderr ?? "")) { pre("runner container launches", L.STATUS.FAIL, `docker run exit ${v.status}${v.error ? ` (${v.error.code})` : ""}: ${(v.stderr ?? "").trim().split("\n").pop()}`); canRun = false; }
  else {
    const major = Number((/version "(\d+)/.exec(v.stderr ?? "") ?? [])[1]);
    ev.sdk.java = (v.stderr ?? "").split("\n")[0];
    const req = ev.sdk.javaRequirement;
    const ok = req ? major >= req.min && major < req.maxExclusive : false;
    if (!pre("container Java satisfies the readme's requirement", ok ? L.STATUS.PASS : L.STATUS.BLOCKED, `${ev.sdk.java}; readme: ${req?.source ?? "not stated"}`)) blockedReason = "java";
  }
}

// ── Evidence for every document (always six entries) ─────────────────────────────────────────
const preBlocked = ev.preconditions.some((p) => p.status === L.STATUS.BLOCKED);
for (const key of L.MATRIX_KEYS) {
  const doc = m.documents[key];
  const entry = { key, inputs: doc?.files ?? null, appHash: doc?.meta?.invoiceHash ?? null, checks: {} };
  const inputProblems = m.problems.filter((p) => p.startsWith(key) || p.includes(`${key}/`) || p.includes(`: ${key}`));
  for (const cmd of ["validate", "generateHash"]) {
    if (!doc || inputProblems.length) { entry.checks[cmd] = { status: L.STATUS.FAIL, reason: inputProblems.join("; ") || "document missing" }; continue; }
    if (!canRun) { const p = ev.preconditions.find((x) => x.status !== L.STATUS.PASS); entry.checks[cmd] = { status: L.STATUS.NOT_RUN, reason: p ? `precondition not met: ${p.name} (${p.detail})` : "precondition not met" }; continue; }
    if (!documentedCmd[cmd]) { entry.checks[cmd] = { status: L.STATUS.BLOCKED, reason: `'${cmd}' not documented in the archive's readme` }; continue; }
    if (blockedReason === "java" || blockedReason === "no readme") { entry.checks[cmd] = { status: L.STATUS.BLOCKED, reason: blockedReason }; continue; }
    const r = runOne(cmd, key);
    const read = (f) => (existsSync(join(r.dir, f)) ? readFileSync(join(r.dir, f), "utf8") : null);
    const rel = relative(RUN, r.dir);
    const exitTxt = read("exit");
    const exit = exitTxt === null || !/^\d+$/.test(exitTxt.trim()) ? null : Number(exitTxt.trim());
    const raw = { runId, inputSha256: doc.files["document.xml"], observedInputSha256: read("input.sha256")?.trim() ?? null, argv: read("argv")?.trim().split("\n") ?? null, exitCode: exit,
      startedAt: read("started")?.trim() ?? null, finishedAt: read("finished")?.trim() ?? null, stdout: `${rel}/stdout`, stderr: `${rel}/stderr`,
      runnerExit: r.runnerExit, runnerSignal: r.signal, timedOut: r.timedOut, launchError: r.launchError, filesWritten: readdirSync(r.dir).sort() };
    const problem = runnerProblem(r, read, doc.files["document.xml"]) ?? (exit === null ? "no fresh output: exit code missing or not a number" : null);
    if (problem) { entry.checks[cmd] = { status: L.STATUS.FAIL, reason: `${problem} ${r.runnerStderr ? `— ${r.runnerStderr.trim().split("\n").pop()}` : ""}`.trim(), raw }; continue; }
    const out = read("stdout") ?? "";
    const verdict = cmd === "validate" ? L.interpretValidate(out, exit, profile) : L.interpretHash(out, exit, entry.appHash, profile);
    entry.checks[cmd] = { ...verdict, raw };
  }
  ev.documents.push(entry);
}

if (archive && existsSync(archive) && ev.sdk.archiveSha256) {
  const after = L.sha256File(archive);
  if (!pre("original archive unchanged after the run", after === ev.sdk.archiveSha256 ? L.STATUS.PASS : L.STATUS.FAIL, after)) ev.archiveChanged = true;
}
const g = L.gate(ev.documents);
const decision = ev.preconditions.some((p) => p.status === L.STATUS.FAIL) && g.decision !== L.STATUS.FAIL ? { ...g, decision: L.STATUS.FAIL, exitCode: 1 } : preBlocked && g.decision === L.STATUS.PASS ? { ...g, decision: L.STATUS.BLOCKED, exitCode: 3 } : g;
ev.official = !harnessTest && !repackagedFrom && decision.decision === L.STATUS.PASS && profile.confirmed === true;
ev.officialReason = ev.official ? "all checks PASS with the archive as supplied and a confirmed output profile" : harnessTest ? "harness test" : repackagedFrom ? "original archive checksum NOT VERIFIED (locally repackaged from extracted files)" : decision.decision !== L.STATUS.PASS ? `gate ${decision.decision}` : "output profile not confirmed";
ev.gate = decision; ev.finishedAt = now();
writeFileSync(join(RUN, "summary.json"), JSON.stringify(ev, null, 2) + "\n");
const md = [`# ZATCA SDK harness run — ${decision.decision}`, "", harnessTest ? "**HARNESS TEST (stub or direct runner) — NOT official SDK validation.**" : `Runner: container \`${image}\` (no network, read-only root, read-only inputs).`, "",
  `Run \`${runId}\`. Application commit: \`${ev.applicationCommit}\`; started ${ev.startedAt}; finished ${ev.finishedAt}.`, "",
  "## SDK and provenance", "", `- Archive kind: ${ev.archiveKind}${repackagedFrom ? `; original archive checksum: **NOT VERIFIED**; source manifest \`${ev.sourceManifest.path}\` SHA-256 \`${ev.sourceManifest.sha256 ?? "missing"}\`` : ""}`,
  `- Official result: **${ev.official ? "yes" : "no"}** (${ev.officialReason})`, `- Archive file name: \`${ev.inputs.archiveFileName ?? "none"}\` (says nothing reliable about the version); SHA-256 \`${ev.sdk.archiveSha256 ?? "n/a"}\``,
  ...(ev.sdk.jars ?? []).map((j) => `- Jar \`${j.path}\`: ${j.component} ${j.version ?? "?"}${j.pom ? ` (pom: ${j.pom.groupId}:${j.pom.artifactId}:${j.pom.version})` : ""}; SHA-256 \`${j.sha256}\``),
  `- Readme used: ${ev.sdk.readme ? `\`${ev.sdk.readme.path}\` (${ev.sdk.readme.how})` : "none"}; Java requirement: ${ev.sdk.javaRequirement?.source ?? "not found"}; container: ${ev.sdk.java ?? "n/a"}`,
  `- Provenance **as stated by the operator, not verified**: source ${ev.provenanceClaimed.sourceUrl ?? "not stated"}; downloaded ${ev.provenanceClaimed.downloadedAt ?? "not stated"}${ev.provenanceClaimed.note ? `; ${ev.provenanceClaimed.note}` : ""}. Not assumed to be the latest release.`, "",
  "## Preconditions", "", "| Check | Status | Detail |", "|---|---|---|",
  ...ev.preconditions.map((p) => `| ${p.name} | ${p.status} | ${String(p.detail).replace(/\|/g, "/").slice(0, 300)} |`), "", "## Documents", "", "| Document | validate | generateHash vs application hash |", "|---|---|---|",
  ...ev.documents.map((d) => `| ${d.key} | ${d.checks.validate.status}${d.checks.validate.reason ? ` — ${d.checks.validate.reason}` : ""} | ${d.checks.generateHash.status}${d.checks.generateHash.reason ? ` — ${d.checks.generateHash.reason}` : ""} |`),
  "", `Gate: **${decision.decision}** (${decision.counts.pass}/${decision.counts.total} PASS, ${decision.counts.fail} FAIL, ${decision.counts.blocked} BLOCKED, ${decision.counts.notRun} NOT_RUN). Exit ${decision.exitCode}.`, ""].join("\n");
writeFileSync(join(RUN, "SUMMARY.md"), md);
rmSync(join(RUN, "work"), { recursive: true, force: true });
writeFileSync(join(OUT, "LATEST"), runId + "\n");
console.log(`gate ${decision.decision} (exit ${decision.exitCode}) run ${runId} — ${join(RUN, "SUMMARY.md")}`);
process.exit(decision.exitCode);
