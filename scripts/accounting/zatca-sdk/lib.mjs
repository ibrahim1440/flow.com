// Pure building blocks of the ZATCA SDK validation harness (no I/O except where a function says so).
// The harness separates EVIDENCE (what ran, what it printed) from the GATE (pass only if every
// required check is PASS). Statuses: PASS, FAIL, BLOCKED (could not run or could not interpret
// reliably), NOT_RUN (an earlier step stopped the run).
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync, existsSync, lstatSync } from "node:fs";
import { join, isAbsolute, normalize } from "node:path";

export const STATUS = Object.freeze({ PASS: "PASS", FAIL: "FAIL", BLOCKED: "BLOCKED", NOT_RUN: "NOT_RUN" });
export const MATRIX_KEYS = Object.freeze(["standard-invoice", "standard-credit-note", "standard-debit-note", "simplified-invoice", "simplified-credit-note", "simplified-debit-note"]);
export const MATRIX_FILES = Object.freeze(["document.xml", "qr.txt", "qr.bin", "meta.json"]);
export const COMMANDS = Object.freeze({ validate: "fatoora -validate -invoice", hash: "fatoora -generateHash -invoice" });

export const sha256File = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");

/**
 * The matrix must be exactly the six documents, each with its four files, every file listed in
 * SHA256SUMS with a matching digest, nothing extra, and MANIFEST.json naming the same six.
 * Returns { ok, problems[], documents: { key: { files: {name: sha256}, meta } } }.
 */
export function verifyMatrix(dir) {
  const problems = [];
  const documents = {};
  if (!existsSync(join(dir, "SHA256SUMS"))) return { ok: false, problems: ["SHA256SUMS missing"], documents };
  const sums = new Map();
  for (const line of readFileSync(join(dir, "SHA256SUMS"), "utf8").split("\n").filter(Boolean)) {
    const m = /^([0-9a-f]{64}) {2}(\S+)$/.exec(line);
    if (!m) { problems.push(`SHA256SUMS line not understood: ${JSON.stringify(line.slice(0, 80))}`); continue; }
    if (sums.has(m[2])) problems.push(`SHA256SUMS lists ${m[2]} twice`);
    sums.set(m[2], m[1]);
  }
  const dirs = readdirSync(dir).filter((n) => statSync(join(dir, n)).isDirectory()).sort();
  for (const extra of dirs.filter((d) => !MATRIX_KEYS.includes(d))) problems.push(`unexpected document directory: ${extra}`);
  for (const key of MATRIX_KEYS) {
    if (!dirs.includes(key)) { problems.push(`required document missing: ${key}`); continue; }
    const files = {};
    for (const f of MATRIX_FILES) {
      const rel = `${key}/${f}`, p = join(dir, key, f);
      if (!existsSync(p)) { problems.push(`${rel} missing`); continue; }
      if (lstatSync(p).isSymbolicLink()) { problems.push(`${rel} is a symbolic link`); continue; }
      const got = sha256File(p);
      if (!sums.has(rel)) problems.push(`${rel} not listed in SHA256SUMS`);
      else if (sums.get(rel) !== got) problems.push(`${rel} checksum mismatch (listed ${sums.get(rel).slice(0, 12)}…, actual ${got.slice(0, 12)}…)`);
      files[f] = got;
    }
    const extraFiles = readdirSync(join(dir, key)).filter((f) => !MATRIX_FILES.includes(f));
    for (const f of extraFiles) problems.push(`unexpected file ${key}/${f}`);
    let meta = null;
    try { meta = JSON.parse(readFileSync(join(dir, key, "meta.json"), "utf8")); } catch { if (files["meta.json"]) problems.push(`${key}/meta.json is not JSON`); }
    if (meta && meta.key !== key) problems.push(`${key}/meta.json names ${meta.key}`);
    if (meta && !/^[A-Za-z0-9+/]{43}=$/.test(meta.invoiceHash ?? "")) problems.push(`${key}/meta.json invoiceHash is not a base64 SHA-256`);
    documents[key] = { files, meta };
  }
  for (const listed of sums.keys()) {
    const [k, f] = listed.split("/");
    if (!MATRIX_KEYS.includes(k) || !MATRIX_FILES.includes(f)) problems.push(`SHA256SUMS lists an unexpected file: ${listed}`);
  }
  try {
    const man = JSON.parse(readFileSync(join(dir, "MANIFEST.json"), "utf8"));
    const keys = (man.documents ?? []).map((d) => d.key).sort();
    if (JSON.stringify(keys) !== JSON.stringify([...MATRIX_KEYS].sort())) problems.push(`MANIFEST.json documents differ from the required six: ${keys.join(",")}`);
  } catch { problems.push("MANIFEST.json missing or not JSON"); }
  return { ok: problems.length === 0, problems, documents };
}

/**
 * Archive entries (from `zipinfo -l`-style lines: permissions first, name last) must be relative,
 * stay inside the extraction root, and not be links or devices.
 */
export function checkArchiveEntries(entries) {
  const problems = [];
  for (const { name, mode } of entries) {
    if (!name || name.includes("\0")) { problems.push(`empty or NUL name`); continue; }
    if (isAbsolute(name) || /^[A-Za-z]:/.test(name) || name.startsWith("\\")) problems.push(`absolute path: ${name}`);
    if (name.split(/[\\/]/).includes("..")) problems.push(`path traversal: ${name}`);
    if (name.includes("\\")) problems.push(`backslash in path: ${name}`);
    const n = normalize(name);
    if (n.startsWith("..") || isAbsolute(n)) problems.push(`escapes the root: ${name}`);
    if (mode && /^[lbcps]/.test(mode)) problems.push(`not a regular file or directory (${mode[0]}): ${name}`);
  }
  return problems;
}

/** Parse `zipinfo -l <zip>` output into entries. Lines that are not entries are ignored. */
export function parseZipinfo(text) {
  const out = [];
  for (const line of text.split("\n")) {
    // perms, version, OS, size, text/binary flag, compressed size, method, date, time, name
    const m = /^([-dlbcpsrwxtTSs?]{10})\s+\S+\s+\S+\s+\d+\s+\S+\s+\d+\s+\S+\s+\S+\s+\S+\s(.+)$/.exec(line);
    if (m) out.push({ mode: m[1], name: m[2] });
  }
  return out;
}

/** The Java range stated in a readme ("between 11 and 15", ">=11 and <15"), or null if not stated. */
export function javaRequirement(readme) {
  const t = readme.replace(/[\\*]/g, "");
  let m = /(?:versions?|java|jdk|jre)\s*>=\s*(\d+)\s*(?:and|,|&)\s*<\s*(\d+)/i.exec(t);
  if (m) return { min: Number(m[1]), maxExclusive: Number(m[2]), source: m[0] };
  m = /between\s+(\d+)\s+and\s+(\d+)/i.exec(t);
  if (m) return { min: Number(m[1]), maxExclusive: Number(m[2]), source: m[0] };
  return null;
}

/** Is the exact command syntax documented in the readme (markdown emphasis and runs of spaces ignored)? */
export function documented(readme, syntax) {
  return readme.replace(/[\\*]/g, "").replace(/[ \t\u00a0]+/g, " ").includes(syntax);
}

/**
 * Interpret SDK output with a CONFIRMED output profile. Without a confirmed profile nothing can be
 * interpreted reliably → BLOCKED. With one, exactly one global-result line and (for the hash
 * command) exactly one hash line must match; anything else → BLOCKED (uninterpretable).
 */
export function interpretValidate(stdout, exitCode, profile) {
  if (!profile?.confirmed) return { status: STATUS.BLOCKED, reason: "SDK output profile not confirmed against the official SDK" };
  const lines = stdout.split(/\r?\n/);
  const global = lines.map((l) => new RegExp(profile.validate.globalResult).exec(l)).filter(Boolean);
  if (global.length !== 1) return { status: STATUS.BLOCKED, reason: `expected exactly one global result line, found ${global.length}` };
  const value = global[0].groups?.result ?? global[0][1];
  const checks = lines.map((l) => new RegExp(profile.validate.checkResult).exec(l)).filter(Boolean).map((m) => ({ check: m.groups?.check ?? m[1], result: m.groups?.result ?? m[2] }));
  const warnings = profile.validate.warning ? lines.filter((l) => new RegExp(profile.validate.warning).test(l)) : [];
  const errors = profile.validate.error ? lines.filter((l) => new RegExp(profile.validate.error).test(l)) : [];
  if (exitCode !== 0) return { status: STATUS.FAIL, reason: `exit code ${exitCode}`, global: value, checks, warnings, errors };
  if (profile.validate.passValues.includes(value)) return { status: STATUS.PASS, global: value, checks, warnings, errors };
  if (profile.validate.failValues.includes(value)) return { status: STATUS.FAIL, reason: `global result ${value}`, global: value, checks, warnings, errors };
  return { status: STATUS.BLOCKED, reason: `global result value not recognised: ${value}`, global: value, checks, warnings, errors };
}

export function interpretHash(stdout, exitCode, appHash, profile) {
  if (!profile?.confirmed) return { status: STATUS.BLOCKED, reason: "SDK output profile not confirmed against the official SDK" };
  const found = stdout.split(/\r?\n/).map((l) => new RegExp(profile.hash.line).exec(l)).filter(Boolean).map((m) => m.groups?.hash ?? m[1]);
  if (exitCode !== 0) return { status: STATUS.FAIL, reason: `exit code ${exitCode}`, sdkHash: found[0] ?? null };
  if (found.length !== 1) return { status: STATUS.BLOCKED, reason: `expected exactly one hash line, found ${found.length}` };
  const sdkHash = found[0];
  if (!/^[A-Za-z0-9+/]{43}=$/.test(sdkHash) || Buffer.from(sdkHash, "base64").length !== 32) return { status: STATUS.BLOCKED, reason: "hash line is not a base64 SHA-256", sdkHash };
  return sdkHash === appHash ? { status: STATUS.PASS, sdkHash } : { status: STATUS.FAIL, reason: "SDK hash differs from the application hash", sdkHash, appHash };
}

/** Gate: PASS only if every required check is PASS. Exit 0 pass; 1 any FAIL; 3 otherwise (BLOCKED / NOT_RUN). */
export function gate(results) {
  const all = results.flatMap((r) => Object.values(r.checks));
  const count = (s) => all.filter((c) => c.status === s).length;
  const fail = count(STATUS.FAIL), blocked = count(STATUS.BLOCKED), notRun = count(STATUS.NOT_RUN), pass = count(STATUS.PASS);
  const decision = all.length > 0 && pass === all.length ? STATUS.PASS : fail > 0 ? STATUS.FAIL : blocked > 0 ? STATUS.BLOCKED : STATUS.NOT_RUN;
  return { decision, exitCode: decision === STATUS.PASS ? 0 : decision === STATUS.FAIL ? 1 : 3, counts: { pass, fail, blocked, notRun, total: all.length } };
}

/**
 * Plain text of an RTF document, enough to search it for documented commands and the Java range:
 * destination groups (font and colour tables, pictures, \*\ groups) dropped, \par and \line as new
 * lines, \'hh as a Windows-1252 byte, \uN as a Unicode code point (its fallback character skipped),
 * other control words removed.
 */
export function rtfToText(rtf) {
  let out = "", i = 0, depth = 0, skipDepth = null, ucSkip = 0;
  const DEST = new Set(["fonttbl", "colortbl", "stylesheet", "info", "pict", "header", "footer", "listtable", "listoverridetable", "rsidtbl", "generator", "themedata", "colorschememapping", "datastore", "latentstyles", "xmlnstbl", "mmathPr"]);
  const cp1252 = new TextDecoder("windows-1252");
  while (i < rtf.length) {
    const c = rtf[i];
    if (c === "{") { depth++; i++; if (rtf.startsWith("\\*", i) && skipDepth === null) skipDepth = depth; continue; }
    if (c === "}") { if (skipDepth === depth) skipDepth = null; depth--; i++; continue; }
    if (c === "\\") {
      const n = rtf[i + 1];
      if (n === "'" ) { const b = parseInt(rtf.slice(i + 2, i + 4), 16); i += 4; if (skipDepth === null) { if (ucSkip > 0) ucSkip--; else out += cp1252.decode(Uint8Array.of(b)); } continue; }
      if (n === "\\" || n === "{" || n === "}") { if (skipDepth === null) out += n; i += 2; continue; }
      if (n === "~") { if (skipDepth === null) out += " "; i += 2; continue; }
      if (n === "\n" || n === "\r") { if (skipDepth === null) out += "\n"; i += 2; continue; }
      const m = /^\\([a-zA-Z]+)(-?\d+)? ?/.exec(rtf.slice(i, i + 40));
      if (!m) { i += 2; continue; }
      i += m[0].length;
      const word = m[1];
      if (skipDepth === null && DEST.has(word)) { skipDepth = depth; continue; }
      if (skipDepth !== null) continue;
      if (word === "par" || word === "line" || word === "row") out += "\n";
      else if (word === "tab" || word === "cell") out += "\t";
      else if (word === "u") { out += String.fromCodePoint((Number(m[2]) + 65536) % 65536); ucSkip = 1; }
      continue;
    }
    if (c === "\n" || c === "\r") { i++; continue; }
    if (skipDepth === null) { if (ucSkip > 0) ucSkip--; else out += c; }
    i++;
  }
  return out.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n");
}

/** Readme candidates in preference order: text formats the harness can read reliably come first. */
export const README_FORMATS = Object.freeze([".md", ".txt", ".rtf", ".pdf"]);
export function readmeText(path) {
  const lower = path.toLowerCase();
  if (lower.endsWith(".rtf")) return { text: rtfToText(readFileSync(path, "latin1")), readable: true, how: "rtf (control words removed)" };
  if (lower.endsWith(".md") || lower.endsWith(".txt")) return { text: readFileSync(path, "utf8"), readable: true, how: "text" };
  return { text: "", readable: false, how: "no text extractor for this format" };
}

/** Component and version from a jar file name such as cli-3.0.8-jar-with-dependencies.jar. */
export function jarComponent(fileName) {
  const m = /^(.+?)-(\d+(?:\.\d+)+(?:[-.][A-Za-z0-9]+)*?)(?:-jar-with-dependencies)?\.jar$/.exec(fileName);
  return m ? { component: m[1], version: m[2] } : { component: fileName.replace(/\.jar$/, ""), version: null };
}
