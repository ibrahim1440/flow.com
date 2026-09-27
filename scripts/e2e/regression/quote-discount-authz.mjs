// QUOTATION DISCOUNTS — can the authorisation be forged?
//
// Deliberately narrow. `quotes-domain` already proves the pricing arithmetic, the threshold
// and the lifecycle by calling the domain functions; repeating those here would be forty
// assertions that drift out of step with the originals. This suite asserts only what that
// one cannot: a STRUCTURAL property of the route, namely that the discount authorisation is
// derived from the session and there exists no request-body key that could supply it.
//
// Why read the source rather than post a crafted request: an HTTP test proves the server
// refused the body it happened to send. Reading the route proves there is no body key that
// would work at all — a stronger statement, and one that needs no database.
//
// What this does NOT prove: that the deployed route reaches this service under a real
// session with a real user's privileges. That is integration evidence and is reported
// separately as unproven.
import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../../..");

const quotesPath = path.join(ROOT, ".test-build/lib/services/sales/quotes.js");
const quotes = await import(`file://${quotesPath}`).catch((e) => {
  console.log("FATAL: build the domain first — npm run build:test-domain");
  console.log(String(e?.message ?? e));
  process.exit(1);
});
const { assertTransition, isRevisable } = quotes;

const results = { pass: 0, fail: 0, failures: [] };
function check(name, ok, detail = "") {
  if (ok) { results.pass++; console.log(`  [PASS] ${name}`); }
  else { results.fail++; results.failures.push(name); console.log(`  [FAIL] ${name}  << ${detail}`); }
}
const section = (t) => console.log(`\n${"=".repeat(78)}\n  ${t}\n${"=".repeat(78)}`);
const sub = (t) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 62 - t.length))}`);
const threw = (fn) => { try { fn(); return null; } catch (e) { return e; } };

// Comments are stripped so prose about the body can neither satisfy nor defeat a check.
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const route = strip(readFileSync(path.join(ROOT, "src/app/api/sales/quotes/[id]/transition/route.ts"), "utf8"));
const svc = strip(readFileSync(path.join(ROOT, "src/lib/services/sales/quotes.ts"), "utf8"));
const reviseRoute = strip(readFileSync(path.join(ROOT, "src/app/api/sales/quotes/[id]/revise/route.ts"), "utf8"));

section("A — THE DISCOUNT AUTHORISATION COMES FROM THE SESSION");

sub("A1. the flag is derived from the caller's own permissions");
check("route computes canApproveDiscount from user.permissions",
  /canApproveDiscount\s*=\s*hasSubPrivilege\(\s*user\.permissions\s*,\s*"sales"\s*,\s*"quote_approve_discount"\s*\)/.test(route),
  "not found in route source");

sub("A2. no request-body key can influence it");
{
  const bodyKeys = [...new Set([...route.matchAll(/\bb\.([A-Za-z_$][\w$]*)/g)].map((m) => m[1]))].sort();
  check(`the body is read for exactly [note, to] — found [${bodyKeys.join(", ")}]`,
    bodyKeys.length === 2 && bodyKeys.includes("to") && bodyKeys.includes("note"), bodyKeys.join(","));
  check("no body key names approval, discount, permission or role",
    !bodyKeys.some((k) => /approv|discount|permission|privile|role|can/i.test(k)), bodyKeys.join(","));
  check("canApproveDiscount is never assigned from the body",
    !/canApproveDiscount\s*[:=][^;]*\bb\./.test(route), "the body reaches the flag");
  check("the raw request object is not passed into the service either",
    !/issueQuote\([^)]*\b(request|body|b)\b/.test(route), "request forwarded into the domain");
}

sub("A3. the endpoint is privilege-gated and ownership-scoped before it does anything");
{
  check("requireSub('sales','quote_write') gates the route",
    /requireSub\(\s*"sales"\s*,\s*"quote_write"\s*\)/.test(route), "");
  check("visibility is scoped inside the WHERE clause, not checked after fetching",
    /findFirst\(\{[\s\S]{0,300}?seesAllSales\(user\.permissions\)\s*\?\s*\{\}\s*:\s*\{\s*opportunity:\s*\{\s*ownerId:\s*user\.id/.test(route),
    "scope not found in the query");
  check("the revise route is gated too",
    /requireSub\(\s*"sales"\s*,\s*"quote_write"\s*\)/.test(reviseRoute), "");
}

sub("A4. the service refuses rather than issuing unapproved");
{
  const issue = svc.slice(svc.indexOf("export async function issueQuote"));
  check("issueQuote takes canApproveDiscount as an explicit argument",
    /issueQuote\s*\([\s\S]{0,400}?canApproveDiscount\s*:\s*boolean/.test(svc), "signature not found");
  check("the gate is re-checked at ISSUE time, not trusted from when lines were saved",
    /discountNeedsApproval\(\s*priced\s*\)/.test(issue), "no re-check at issue");
  check("a needed-but-absent approval throws instead of silently issuing",
    /if\s*\(\s*discountNeedsApproval\(\s*priced\s*\)\s*\)\s*\{[\s\S]{0,200}?if\s*\(\s*!\s*input\.canApproveDiscount\s*\)/.test(issue),
    "the refusal branch was not found");
  check("the price it gates on is recomputed from the stored lines, not taken from input",
    /const\s+priced\s*=\s*priceQuote\(\s*\n?\s*quote\.lines\.map/.test(issue), "priced from something other than stored lines");
}

section("B — A REFUSAL NEVER ADVISES AN ACTION THE RULES FORBID");

sub("B1. the ACCEPTED refusal does not send the reader to a locked door");
{
  // Guards a fix: the message used to say "Raise a new revision instead" for ACCEPTED, and
  // isRevisable("ACCEPTED") is false, so that advice could not be followed.
  check("ACCEPTED is not revisable (existing rule, restated here as the premise)",
    isRevisable("ACCEPTED") === false, "");
  const e = threw(() => assertTransition("ACCEPTED", "ISSUED"));
  check("the ACCEPTED refusal does not tell the reader to revise",
    !/revision/i.test(String(e?.message ?? "")), String(e?.message ?? ""));
  check("it names something they can actually do instead",
    /new quotation/i.test(String(e?.message ?? "")), String(e?.message ?? ""));
}

sub("B2. the SUPERSEDED refusal points at the replacement");
{
  const e = threw(() => assertTransition("SUPERSEDED", "ISSUED"));
  check("SUPERSEDED is not revisable", isRevisable("SUPERSEDED") === false, "");
  check("the refusal does not suggest raising a revision of a superseded quote",
    !/raise a new revision/i.test(String(e?.message ?? "")), String(e?.message ?? ""));
}

section("QUOTE DISCOUNT AUTHORISATION RESULT");
console.log(`${results.pass} passed, ${results.fail} failed`);
if (results.fail > 0) {
  console.log("\nFailures:");
  for (const f of results.failures) console.log("  - " + f);
  process.exit(1);
}
