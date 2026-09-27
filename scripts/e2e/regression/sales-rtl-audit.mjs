// SALES RTL AND RESPONSIVE AUDIT — static, no database, no browser.
//
// Arabic is the default language of this system, so a single `ml-2` is not a cosmetic slip:
// it lands the gap on the wrong side for the people who use the screens most, and it does so
// silently, because an English-speaking reviewer sees it look correct.
//
// This asserts the properties that can be checked without rendering:
//   - no physical-direction utility survives in the Sales tree (they must be logical)
//   - phone numbers and other Latin runs are explicitly marked LTR inside Arabic text
//   - every screen declares responsive behaviour rather than assuming desktop width
//
// It deliberately does NOT claim the screens LOOK right at 1024 or 390. Only a browser can
// say that, and that evidence is reported separately as outstanding.
import path from "node:path";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../../..");
const ROOTS = [
  path.join(ROOT, "src/app/dashboard/sales"),
  path.join(ROOT, "src/app/dashboard/commissions"),
];

function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    const p = path.join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".tsx")) out.push(p);
  }
  return out;
}
const files = ROOTS.flatMap((r) => walk(r));
const rel = (p) => path.relative(ROOT, p).replace(/\\/g, "/");

const results = { pass: 0, fail: 0, failures: [] };
function check(name, ok, detail = "") {
  if (ok) { results.pass++; console.log(`  [PASS] ${name}`); }
  else { results.fail++; results.failures.push(name); console.log(`  [FAIL] ${name}  << ${detail}`); }
}
const section = (t) => console.log(`\n${"=".repeat(78)}\n  ${t}\n${"=".repeat(78)}`);
const sub = (t) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 62 - t.length))}`);

section("A — DIRECTION IS LOGICAL, NEVER PHYSICAL");

sub("A1. no physical spacing or alignment utility in the Sales tree");
{
  // `rtl:` prefixed utilities are exempt: they are an explicit, deliberate RTL override.
  const physical = /\b(?<!rtl:)(ml-\d|mr-\d|pl-\d|pr-\d|text-left|text-right|border-l-|border-r-)\b/;
  const offenders = [];
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    src.split(/\r?\n/).forEach((line, i) => {
      if (!/class(Name)?=/.test(line)) return;
      const cleaned = line.replace(/rtl:[a-z0-9:-]+/g, "");
      if (physical.test(cleaned)) offenders.push(`${rel(f)}:${i + 1}`);
    });
  }
  check(`no physical-direction class in ${files.length} Sales screens`,
    offenders.length === 0, offenders.slice(0, 8).join("  "));
}

sub("A2. logical properties are actually used, so A1 is not vacuous");
{
  let logical = 0;
  for (const f of files) {
    const m = readFileSync(f, "utf8").match(/\b(ms-\d|me-\d|ps-\d|pe-\d|text-start|text-end)\b/g);
    logical += m ? m.length : 0;
  }
  // If this were zero, A1 would pass simply because nobody had written any spacing at all.
  check(`logical direction utilities are in use (${logical} occurrences)`, logical > 50, String(logical));
}

section("B — LATIN RUNS INSIDE ARABIC TEXT");

sub("B1. phone numbers are marked LTR wherever they are rendered");
{
  // A Saudi number rendered in an RTL run without dir="ltr" displays with its parts reversed.
  const offenders = [];
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    if (!/\bphone\b/.test(src)) continue;
    const rendersPhone = /\{[^}]*\.phone[^}]*\}/.test(src);
    if (!rendersPhone) continue;
    // Accepts a literal dir="ltr", a computed dir={...'ltr'...}, or the EN text style, which
    // carries the direction itself. The computed form is what the lead detail uses.
    if (!/dir=["']ltr["']|dir=\{[^}]*["']ltr["'][^}]*\}|Text\/EN|enBody/.test(src)) offenders.push(rel(f));
  }
  check("every screen that renders a phone marks it LTR",
    offenders.length === 0, offenders.join("  "));
}

section("C — RESPONSIVE INTENT IS DECLARED");

/**
 * Known exemptions, each with the reason it is not a defect. Listed rather than silently
 * skipped so that a stale entry fails too: if one of these gains responsive markup, the
 * assertion below notices the exemption is no longer needed and says so.
 */
const RESPONSIVE_EXEMPT = {
  "src/app/dashboard/sales/quotes/new/page.tsx":
    "a redirect stub — creates the draft and navigates; it renders only a spinner",
  "src/app/dashboard/sales/leads/ImportDialog.tsx":
    "a dialog body inside Modal, which owns the responsive frame",
  // The pipeline board was listed here as a KNOWN GAP and has been removed: the designed
  // stage accordion (pattern P5) is now implemented, the board is `hidden lg:block`, and the
  // staleness assertion below is what forced this entry to be deleted rather than linger.
};
const TABLE_WRAP_EXEMPT = {
  "src/app/dashboard/sales/quotes/[id]/print/page.tsx":
    "an A4 print document — a horizontal scroll container would be meaningless on paper",
};

sub("C1. screens declare breakpoints rather than assuming a desktop width");
{
  const bare = [];
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    if (!/export default function/.test(src)) continue;
    if (!/\b(sm:|md:|lg:|xl:|flex-wrap|grid-cols-1)\b/.test(src)) bare.push(rel(f));
  }
  const unexpected = bare.filter((f) => !(f in RESPONSIVE_EXEMPT));
  check("every Sales page declares responsive behaviour, or is a listed exemption",
    unexpected.length === 0, unexpected.join("  "));
  const stale = Object.keys(RESPONSIVE_EXEMPT).filter((f) => !bare.includes(f));
  check("no responsive exemption has gone stale", stale.length === 0,
    "these now declare breakpoints and should be removed from the list: " + stale.join("  "));
}

sub("C2. wide tabular screens provide a horizontal-scroll container");
{
  const offenders = [];
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    if (!/<table/.test(src)) continue;
    if (!/TableWrap|overflow-x-auto/.test(src)) offenders.push(rel(f));
  }
  const unexpected = offenders.filter((f) => !(f in TABLE_WRAP_EXEMPT));
  check("every screen with a table wraps it for narrow widths, or is a listed exemption",
    unexpected.length === 0, unexpected.join("  "));
}

sub("C3. the known responsive gap is recorded, not forgotten");
{
  const gaps = Object.entries(RESPONSIVE_EXEMPT).filter(([, why]) => why.startsWith("KNOWN GAP"));
  console.log(`  [INFO] ${gaps.length} screen(s) carry a known responsive gap:`);
  for (const [f, why] of gaps) console.log(`         ${f}\n           ${why}`);
  check("known gaps are annotated with why, not merely skipped",
    gaps.every(([, why]) => why.length > 40), "");
}

section("SALES RTL & RESPONSIVE AUDIT RESULT");
console.log(`${results.pass} passed, ${results.fail} failed`);
console.log("\nNOTE: static evidence only. Whether these screens READ correctly at 1024 and");
console.log("390, with long names and dense rows, needs a browser and is not claimed here.");
if (results.fail > 0) {
  console.log("\nFailures:");
  for (const f of results.failures) console.log("  - " + f);
  process.exit(1);
}
