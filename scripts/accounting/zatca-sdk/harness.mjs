#!/usr/bin/env node
// ZATCA SDK validation harness. Collects evidence for all six application-generated documents, then
// decides the gate separately: exit 0 only if every required check is PASS; 1 if anything FAILED;
// 3 if anything is BLOCKED or NOT_RUN (and nothing failed). See docs/accounting/ZATCA_SDK_VALIDATION.md.
//
//   node scripts/accounting/zatca-sdk/harness.mjs --matrix <dir> --out <dir> --archive <sdk.zip> \
//     --sha256 <hex> --source-url <where it was downloaded from> [--profile <output-profile.json>]
//     [--image zatca-sdk-runner:11] [--runner container|direct] [--harness-test]
//
// Isolation: --runner container (default, the only mode that can produce an official result) runs
// every SDK command in a fresh container with no network, a read-only root, the SDK and matrix
// mounted read-only, a tmpfs work directory and one writable output directory, as an unprivileged
// user with all capabilities dropped. --runner direct exists ONLY for harness tests with a stub SDK
// and is always recorded as "harness test — not official validation".
// Provenance: --sha256 verifies the archive's integrity against that value; --source-url is recorded
// as the operator's claim — it does not authenticate where the archive came from.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync } from "node:fs";
import { join, resolve, dirname, relative } from "node:path";
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
mkdirSync(OUT, { recursive: true });

const ev = { harness: "scripts/accounting/zatca-sdk/harness.mjs", startedAt: now(), official: false, harnessTest, runner, image: runner === "container" ? image : null,
  inputs: { matrix: MATRIX, archive: args.archive ?? null, sha256Expected: args.sha256 ?? null, sourceUrlClaimed: args["source-url"] ?? null }, preconditions: [], sdk: {}, documents: [] };
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

const SDK = join(OUT, "sdk-extracted");
if (canRun) {
  const info = spawnSync("zipinfo", ["-l", archive], { encoding: "utf8" });
  const entries = L.parseZipinfo(info.stdout ?? "");
  const problems = info.status === 0 && entries.length ? L.checkArchiveEntries(entries) : [`zipinfo could not list the archive (exit ${info.status})`];
  ev.sdk.entries = entries.length;
  if (!pre("archive entries safe (no absolute paths, traversal or links)", problems.length ? L.STATUS.FAIL : L.STATUS.PASS, problems.slice(0, 20).join("; ") || `${entries.length} entries`)) canRun = false;
}
if (canRun) {
  rmSync(SDK, { recursive: true, force: true }); mkdirSync(SDK, { recursive: true });
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
    const readmes = execFileSync("find", [root, "-iname", "readme*.md"]).toString().trim().split("\n").filter(Boolean);
    readme = readmes.length ? readFileSync(readmes[0], "utf8") : "";
    const jars = execFileSync("find", [root, "-name", "*.jar"]).toString().trim().split("\n").filter(Boolean);
    ev.sdk.root = relative(SDK, root) || "."; ev.sdk.readme = readmes[0] ? relative(SDK, readmes[0]) : null;
    ev.sdk.jars = jars.map((j) => ({ path: relative(SDK, j), sha256: L.sha256File(j) }));
    ev.sdk.javaRequirement = L.javaRequirement(readme);
    if (!readme) { pre("readme found", L.STATUS.BLOCKED, "no readme in the archive"); blockedReason = "no readme"; }
  }
}
const documentedCmd = { validate: L.documented(readme, L.COMMANDS.validate), generateHash: L.documented(readme, L.COMMANDS.hash) };
if (canRun) pre("commands documented in the archive's readme", documentedCmd.validate && documentedCmd.generateHash ? L.STATUS.PASS : L.STATUS.BLOCKED, JSON.stringify(documentedCmd));
if (canRun) pre("SDK output profile confirmed against the official SDK", profile.confirmed ? L.STATUS.PASS : L.STATUS.BLOCKED, profile.confirmed ? `${profile.confirmedBy} / ${profile.confirmedAgainst}` : "not confirmed — results cannot be interpreted reliably");

// ── Runner ──────────────────────────────────────────────────────────────────────────────────
const RUN_ONE = join(HERE, "run-one.sh");
function runOne(cmd, key) {
  if (runner === "container") {
    const r = spawnSync("docker", ["run", "--rm", "--network", "none", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--pids-limit", "512", "--memory", "2g",
      "--tmpfs", "/work:rw,exec,size=1g", "--tmpfs", "/tmp:rw,size=256m", "-e", "SDK_DIR=/sdk", "-e", "IN_DIR=/in", "-e", "OUT_DIR=/out", "-e", "WORK_DIR=/work",
      "-v", `${SDK}:/sdk:ro`, "-v", `${MATRIX}:/in:ro`, "-v", `${join(OUT, "runs")}:/out:rw`, "-v", `${RUN_ONE}:/runner/run-one.sh:ro`, image, "sh", "/runner/run-one.sh", cmd, key], { encoding: "utf8", timeout: 600000 });
    return { runnerExit: r.status, runnerStderr: (r.stderr ?? "").slice(0, 2000) };
  }
  const r = spawnSync("sh", [RUN_ONE, cmd, key], { encoding: "utf8", env: { ...process.env, SDK_DIR: SDK, IN_DIR: MATRIX, OUT_DIR: join(OUT, "runs"), WORK_DIR: join(OUT, "work") }, timeout: 600000 });
  return { runnerExit: r.status, runnerStderr: (r.stderr ?? "").slice(0, 2000) };
}
if (canRun && runner === "container") {
  const v = spawnSync("docker", ["run", "--rm", "--network", "none", image, "java", "-version"], { encoding: "utf8" });
  const major = Number((/version "(\d+)/.exec(v.stderr ?? "") ?? [])[1]);
  ev.sdk.java = (v.stderr ?? "").split("\n")[0];
  const req = ev.sdk.javaRequirement;
  const ok = req ? major >= req.min && major < req.maxExclusive : false;
  if (!pre("container Java satisfies the readme's requirement", ok ? L.STATUS.PASS : L.STATUS.BLOCKED, `${ev.sdk.java}; readme: ${req?.source ?? "not stated"}`)) blockedReason = "java";
}

// ── Evidence for every document (always six entries) ─────────────────────────────────────────
mkdirSync(join(OUT, "runs"), { recursive: true });
// The container runs as an unprivileged uid (10001); only this directory is writable to it.
if (runner === "container") chmodSync(join(OUT, "runs"), 0o777);
const preFailed = ev.preconditions.some((p) => p.status === L.STATUS.FAIL);
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
    const d = join(OUT, "runs", key);
    const read = (f) => (existsSync(join(d, `${cmd}.${f}`)) ? readFileSync(join(d, `${cmd}.${f}`), "utf8") : null);
    const exitTxt = read("exit");
    const exit = exitTxt === null ? null : Number(exitTxt.trim());
    const raw = { argv: read("argv")?.trim().split("\n") ?? null, exitCode: exit, startedAt: read("started")?.trim() ?? null, finishedAt: read("finished")?.trim() ?? null,
      stdout: `runs/${key}/${cmd}.stdout`, stderr: `runs/${key}/${cmd}.stderr`, runnerExit: r.runnerExit };
    if (exit === null || Number.isNaN(exit)) { entry.checks[cmd] = { status: L.STATUS.FAIL, reason: `the command did not complete (runner exit ${r.runnerExit}) ${r.runnerStderr}`.trim(), raw }; continue; }
    const out = read("stdout") ?? "";
    const verdict = cmd === "validate" ? L.interpretValidate(out, exit, profile) : L.interpretHash(out, exit, entry.appHash, profile);
    entry.checks[cmd] = { ...verdict, raw };
  }
  ev.documents.push(entry);
}

const g = L.gate(ev.documents);
const decision = preFailed && g.decision !== L.STATUS.FAIL ? { ...g, decision: L.STATUS.FAIL, exitCode: 1 } : preBlocked && g.decision === L.STATUS.PASS ? { ...g, decision: L.STATUS.BLOCKED, exitCode: 3 } : g;
ev.official = !harnessTest && decision.decision === L.STATUS.PASS && profile.confirmed === true;
ev.gate = decision; ev.finishedAt = now();
writeFileSync(join(OUT, "summary.json"), JSON.stringify(ev, null, 2) + "\n");
const md = [`# ZATCA SDK harness run — ${decision.decision}`, "", harnessTest ? "**HARNESS TEST (stub or direct runner) — NOT official SDK validation.**" : `Runner: container \`${image}\` (no network, read-only root, read-only inputs).`, "",
  `Application commit: \`${ev.applicationCommit}\`; started ${ev.startedAt}; finished ${ev.finishedAt}.`, "", "## Preconditions", "", "| Check | Status | Detail |", "|---|---|---|",
  ...ev.preconditions.map((p) => `| ${p.name} | ${p.status} | ${String(p.detail).replace(/\|/g, "/").slice(0, 300)} |`), "", "## Documents", "", "| Document | validate | generateHash vs application hash |", "|---|---|---|",
  ...ev.documents.map((d) => `| ${d.key} | ${d.checks.validate.status}${d.checks.validate.reason ? ` — ${d.checks.validate.reason}` : ""} | ${d.checks.generateHash.status}${d.checks.generateHash.reason ? ` — ${d.checks.generateHash.reason}` : ""} |`),
  "", `Gate: **${decision.decision}** (${decision.counts.pass}/${decision.counts.total} PASS, ${decision.counts.fail} FAIL, ${decision.counts.blocked} BLOCKED, ${decision.counts.notRun} NOT_RUN). Exit ${decision.exitCode}.`, ""].join("\n");
writeFileSync(join(OUT, "SUMMARY.md"), md);
console.log(`gate ${decision.decision} (exit ${decision.exitCode}) — ${join(OUT, "SUMMARY.md")}`);
process.exit(decision.exitCode);
