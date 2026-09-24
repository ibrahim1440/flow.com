// Smoke tests against the DEPLOYED Preview URL.
//
// Every request below crosses the internet to the Vercel deployment, which resolves its own
// branch-scoped environment and connects with the restricted runtime role. Nothing here
// touches a local server or a local database.
//
// Vercel SSO protects the URL, so each request carries a temporary automation-bypass header.
// The secret is read from a 0600 file, never printed, and revoked when the run finishes.
//
// Commission figures are asserted as DELTAS against a baseline read at the start. The
// database already holds fixture rows from the browser suite; an absolute assertion would
// either fail for the wrong reason or pass because of them.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const S = process.env.SCRATCH;
const BASE = process.env.SMOKE_URL;
if (!S || !BASE) { console.error("REFUSE: SCRATCH and SMOKE_URL are required"); process.exit(3); }

// Optional. A bypass secret is only needed when the deployment sits behind Vercel SSO AND
// there is no browser session to carry. Absent — which is the correct resting state, since it
// should be revoked as soon as a run finishes — the requests simply go without the header.
let BYPASS = "";
try { BYPASS = readFileSync(`${S}/.bypass-secret`, "utf8").trim(); } catch { /* none configured */ }
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const CATALOG = JSON.parse(readFileSync(`${ROOT}/tests/e2e/support/catalog.json`, "utf8"));
const SKU = CATALOG.skus.ken1kg.id;
const STAGE = CATALOG.crm.stages[0].id;

const REP = "UAT_emp_crmRep", MGR = "UAT_emp_crmManager", FIN = "UAT_emp_crmFinance";
// The browser suite's fixture PINs are the default, because that suite is what seeds these
// accounts. They stop working the moment `reviewer-accounts.ts` issues fresh ones for a human
// reviewer — so the values are overridable, and the smoke test does not force you to choose
// between running it and having rotated credentials.
const PIN = {
  rep: process.env.SMOKE_PIN_REP ?? "720011",
  manager: process.env.SMOKE_PIN_MANAGER ?? "720022",
  finance: process.env.SMOKE_PIN_FINANCE ?? "720033",
};

// Everything printed goes through this. Three rules, each earned:
//
//   1. Never print a response HEADER. Vercel returns the protection-bypass secret inside a
//      Set-Cookie JWT, so dumping headers leaks it — and base64 defeats a literal-string
//      filter, which is why the filter below is shaped by PATTERN.
//   2. Never print the cookie jar, and never print a response body from an auth endpoint
//      beyond its status code.
//   3. Redact anything JWT-shaped or bypass-secret-shaped even so, because rules 1 and 2
//      depend on remembering and this one does not.
const redact = (s) =>
  String(s)
    .replace(BYPASS ? new RegExp(BYPASS, "g") : /(?!)/g, "<bypass-secret>")
    .replace(/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "<jwt>")
    .replace(/(_vercel_jwt|auth-token|session)=[^;\s"']+/gi, "$1=<redacted>")
    .replace(/("(?:secret|token|password|pin|bypass)"\s*:\s*")[^"]*"/gi, '$1<redacted>"');

const results = { pass: 0, fail: 0, failures: [] };
const check = (name, ok, detail = "") => {
  if (ok) { results.pass++; console.log(`  [PASS] ${name}`); }
  else { results.fail++; results.failures.push(name); console.log(`  [FAIL] ${name}  << ${redact(detail)}`); }
};
const section = (t) => console.log(`\n${"=".repeat(78)}\n  ${t}\n${"=".repeat(78)}`);
const sub = (t) => console.log(`\n-- ${t}`);
const S_ = (v) => { try { return JSON.stringify(v) ?? String(v); } catch { return String(v); } };
const money = (a, b) => (Number(a) - Number(b)).toFixed(2);

let cookies = {};
async function api(path, opts = {}) {
  const jar = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join("; ");
  const res = await fetch(BASE + path, {
    method: opts.method ?? "GET",
    headers: {
      "Content-Type": "application/json",
      ...(BYPASS ? { "x-vercel-protection-bypass": BYPASS } : {}),
      ...(jar ? { Cookie: jar } : {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    redirect: "manual",
  });
  for (const sc of res.headers.getSetCookie?.() ?? []) {
    const [pair] = sc.split(";");
    const i = pair.indexOf("=");
    if (i > 0) cookies[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
  }
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { json = null; }
  return { status: res.status, json, text };
}
const logout = () => { cookies = {}; };
async function loginAs(role) {
  logout();
  const r = await api("/api/auth/login", { method: "POST", body: { method: "pin", pin: PIN[role] } });
  // Status only. An auth response body is never printed, and neither is the jar it filled.
  if (r.status !== 200) throw new Error(`login as ${role} failed with status ${r.status}`);
  return r;
}

const riyadhMonth = () => {
  const r = new Date(Date.now() + 3 * 3600_000);
  return `${r.getUTCFullYear()}-${String(r.getUTCMonth() + 1).padStart(2, "0")}`;
};
const dayOfMonthISO = (d) => {
  const r = new Date(Date.now() + 3 * 3600_000);
  return new Date(Date.UTC(r.getUTCFullYear(), r.getUTCMonth(), d, 9, 0, 0)).toISOString();
};
async function repRow() {
  const r = await api(`/api/commissions/review?month=${riyadhMonth()}`);
  if (r.status !== 200) throw new Error(`review unreadable: ${r.status} ${r.text.slice(0, 160)}`);
  return (r.json.employees ?? []).find((e) => e.employeeId === REP)
      ?? { accrued: "0.00", adjustments: "0.00", paid: "0.00", accrualRowsTotal: "0.00", reconciliationDifference: "0.00" };
}

const st = {};
const NAME = `SMK${Date.now().toString(36).toUpperCase()}`;
const PHONE = "05" + String(Date.now()).slice(-8);
const PHONE_SPACED = "+966 5" + PHONE.slice(2, 4) + " " + PHONE.slice(4, 7) + " " + PHONE.slice(7);

async function main() {
  console.log(`hosted smoke: ${BASE}`);
  console.log(`marker: ${NAME}`);

  section("1 - THE DEPLOYMENT IS REACHABLE, AND PROTECTED");
  {
    const bare = await fetch(BASE + "/login", { redirect: "manual" });
    const loc = bare.headers.get("location") ?? "";
    const protectedBySso = bare.status === 302 && loc.includes("sso-api");
    check("the URL is protected by Vercel SSO", protectedBySso, `status ${bare.status}`);

    const ok = await api("/login");
    if (!BYPASS && protectedBySso) {
      console.log("\n  No bypass secret configured and the URL is SSO-protected, so nothing");
      console.log("  below can reach the application. Create a Protection Bypass for");
      console.log("  Automation, put it in $SCRATCH/.bypass-secret, and revoke it afterwards.");
      console.log("  scripts/sales-preview/README.md has the handling rules.");
      process.exit(2);
    }
    check("the application itself answers", ok.status === 200, `status ${ok.status}`);
    check("and it is the sign-in screen", /PIN|login/i.test(ok.text), `status ${ok.status}`);
  }

  section("2 - LOGIN AND SESSION");
  sub("2.1 the rep signs in with a PIN");
  {
    const r = await loginAs("rep");
    check("login succeeds", r.status === 200, `status ${r.status}`);
    // Succeeding proves two things about the resolved environment at once: the branch-scoped
    // DATABASE_URL points at the database holding this fixture, and the branch-scoped
    // PIN_LOOKUP_SECRET is the key its stored selector was derived under. A wrong value for
    // either selects no row at all, so this cannot pass by accident.
    check("which proves the branch-scoped DATABASE_URL and PIN_LOOKUP_SECRET both resolved", r.status === 200);

    const me = await api("/api/auth/me");
    check("the session identifies the rep", me.status === 200 && me.text.includes(REP), `status ${me.status}`);
  }
  sub("2.2 a wrong PIN is refused");
  {
    logout();
    const bad = await api("/api/auth/login", { method: "POST", body: { method: "pin", pin: "000000" } });
    check("refused with 401", bad.status === 401, `status ${bad.status}`);
    const me = await api("/api/auth/me");
    check("and no session was issued", me.status === 401, String(me.status));
  }

  section("3 - LEAD, DUPLICATE, CONVERSION, DEAL");
  await loginAs("rep");
  sub("3.1 the rep creates a lead");
  {
    const r = await api("/api/sales/leads", {
      method: "POST",
      body: { companyName: `${NAME} Aroma Roasters`, contactName: "Smoke Tester", phone: PHONE, city: "Jeddah", source: "REFERRAL", ownerId: MGR },
    });
    check("created", r.status === 201, r.text.slice(0, 200));
    st.leadId = r.json?.lead?.id;
    check("owned by the caller, not by the ownerId the body tried to set",
      r.json?.lead?.ownerId === REP, S_(r.json?.lead).slice(0, 200));
  }
  sub("3.2 the same number in another format is reported, not merged");
  {
    const dup = await api("/api/sales/leads", {
      method: "POST", body: { companyName: `${NAME} Branch Two`, contactName: "Smoke", phone: PHONE_SPACED },
    });
    check("refused with 409", dup.status === 409, dup.text.slice(0, 200));
    check("and the existing lead is named", dup.json?.duplicates?.[0]?.leadId === st.leadId, S_(dup.json?.duplicates));
  }
  sub("3.3 conversion, then a replay");
  {
    const r1 = await api(`/api/sales/leads/${st.leadId}/convert`, {
      method: "POST", body: { stageId: STAGE, title: `${NAME} annual supply` },
    });
    check("converted", [200, 201].includes(r1.status), r1.text.slice(0, 200));
    st.dealId = r1.json?.conversion?.opportunityId ?? r1.json?.opportunityId;
    check("a deal id came back", !!st.dealId, r1.text.slice(0, 200));

    const r2 = await api(`/api/sales/leads/${st.leadId}/convert`, { method: "POST", body: {} });
    check("the second press replays rather than converting again",
      (r2.json?.replayed ?? r2.json?.conversion?.replayed) === true, r2.text.slice(0, 200));
  }
  sub("3.4 the deal page's data loads");
  {
    const d = await api(`/api/sales/opportunities/${st.dealId}`);
    check("deal detail returns", d.status === 200, d.text.slice(0, 160));
    check("carrying the customer conversion created", !!d.json?.deal?.customer?.id, S_(d.json?.deal?.customer));
    check("and the stages the board draws", (d.json?.stages ?? []).length > 0, String((d.json?.stages ?? []).length));
    check("the rep's screen offers quoting", d.json?.can?.quote === true, S_(d.json?.can));
    check("but not closing", d.json?.can?.close === false, S_(d.json?.can));
  }
  sub("3.5 it persists to a fresh request");
  {
    const list = await api("/api/sales/leads?q=" + encodeURIComponent(NAME));
    check("the lead is found again by search", list.status === 200 && list.text.includes(st.leadId), String(list.status));
  }

  section("4 - PERMISSIONS");
  sub("4.1 a rep cannot close a deal");
  {
    const r = await api(`/api/sales/opportunities/${st.dealId}/transition`, {
      method: "POST", body: { toOutcome: "LOST", lostReason: "smoke" } });
    check("refused with 403", r.status === 403, r.text.slice(0, 160));
  }
  sub("4.2 a rep cannot manufacture a collection to be paid on");
  {
    const r = await api("/api/commissions/sandbox-collections", {
      method: "POST", body: { externalRef: `${NAME}-NOPE`, amountGross: "1000" } });
    check("refused with 403", r.status === 403, r.text.slice(0, 160));
  }
  sub("4.3 a rep cannot open the team commission review");
  {
    const r = await api(`/api/commissions/review?month=${riyadhMonth()}`);
    check("refused with 403", r.status === 403, r.text.slice(0, 140));
  }

  section("5 - QUOTATION, DISCOUNT AUTHORISATION, ORDER");
  sub("5.1 the rep raises a quotation and the server prices it");
  {
    const r = await api("/api/sales/quotes", {
      method: "POST",
      body: {
        opportunityId: st.dealId,
        validUntil: new Date(Date.now() + 30 * 86400_000).toISOString().slice(0, 10),
        grandTotal: "1.00",
        lines: [{ productSkuId: SKU, quantity: "10", unit: "UNIT", unitPrice: "110", taxRatePercent: "15" }],
      },
    });
    check("created", r.status === 201, r.text.slice(0, 250));
    st.quoteId = r.json?.quote?.id;
    // 10 x 110 = 1,100; VAT 15% = 165; total 1,265. The client asked for 1.00 and was ignored.
    check("priced by the server at 1265.00, not by the client's 1.00",
      r.json?.totals?.grandTotal === "1265.00", S_(r.json?.totals));
  }
  sub("5.2 a discount past the threshold cannot be issued by the rep");
  {
    const put = await api(`/api/sales/quotes/${st.quoteId}`, {
      method: "PUT",
      body: { lines: [{ productSkuId: SKU, quantity: "10", unit: "UNIT", unitPrice: "110", discountPercent: "25", taxRatePercent: "15" }] },
    });
    check("the discounted revision saves", put.status === 200, put.text.slice(0, 200));
    const r = await api(`/api/sales/quotes/${st.quoteId}/transition`, { method: "POST", body: { to: "ISSUED" } });
    check("but issuing it is refused with 403", r.status === 403, r.text.slice(0, 200));
  }
  sub("5.3 the manager issues it, and accepts it");
  {
    await loginAs("manager");
    const issued = await api(`/api/sales/quotes/${st.quoteId}/transition`, { method: "POST", body: { to: "ISSUED" } });
    check("issued", issued.status === 200, issued.text.slice(0, 200));
    const accepted = await api(`/api/sales/quotes/${st.quoteId}/transition`, { method: "POST", body: { to: "ACCEPTED" } });
    check("and accepted", accepted.status === 200, accepted.text.slice(0, 200));
  }
  sub("5.4 quote to order, and a second press makes nothing");
  {
    await loginAs("rep");
    const first = await api(`/api/sales/quotes/${st.quoteId}/create-order`, { method: "POST", body: {} });
    check("order created", first.status === 201, first.text.slice(0, 250));
    st.orderNumber = first.json?.orderNumber ?? first.json?.order?.orderNumber;
    check("with an order number", !!st.orderNumber, first.text.slice(0, 200));

    const again = await api(`/api/sales/quotes/${st.quoteId}/create-order`, { method: "POST", body: {} });
    const againNo = again.json?.orderNumber ?? again.json?.order?.orderNumber;
    check("the replay returns the same order", againNo === st.orderNumber, `${againNo} vs ${st.orderNumber}`);
    check("and says it replayed", again.json?.replayed === true, again.text.slice(0, 160));
  }
  sub("5.5 the order is real to the rest of the ERP");
  {
    const orders = await api("/api/orders");
    check("the orders list is readable", orders.status === 200, String(orders.status));
    check(`and order ${st.orderNumber} is on it`, orders.text.includes(st.orderNumber), "not found in the list");
  }

  section("6 - WON");
  {
    await loginAs("manager");
    const r = await api(`/api/sales/opportunities/${st.dealId}/transition`, { method: "POST", body: { toOutcome: "WON" } });
    check("the deal is won now a quotation is accepted", r.status === 200, r.text.slice(0, 200));
    const flip = await api(`/api/sales/opportunities/${st.dealId}/transition`, {
      method: "POST", body: { toOutcome: "LOST", lostReason: "changed my mind" } });
    check("and cannot be flipped to lost without reopening", flip.status === 409, flip.text.slice(0, 200));
  }

  section("7 - COMMISSION: COLLECTION, APPROVAL, ADJUSTMENT, REFUND");
  await loginAs("finance");
  const base0 = await repRow();
  console.log(`  baseline for the rep this period: accrued=${base0.accrued} adj=${base0.adjustments} ` +
    `rows=${base0.accrualRowsTotal} difference=${base0.reconciliationDifference} (left by the browser fixtures)`);

  sub("7.1 the manager records a collection in the sandbox source");
  {
    await loginAs("manager");
    const r = await api("/api/commissions/sandbox-collections", {
      method: "POST",
      body: { externalRef: `${NAME}-PAY-1`, opportunityId: st.dealId, amountGross: "5750", amountTax: "750", collectedAt: dayOfMonthISO(5) },
    });
    check("recorded", r.status === 201, r.text.slice(0, 250));
    // Accepting at all proves SALES_SANDBOX_COLLECTIONS is "true" in the deployed runtime AND
    // that its DATABASE_URL names none of the three protected production endpoints. The route
    // refuses on either count before it writes anything.
    check("which proves the deployed runtime is flagged sandbox and is not on a protected endpoint", r.status === 201);
    check("and the event is stamped SANDBOX", /SANDBOX/.test(r.text), r.text.slice(0, 200));
  }
  sub("7.2 the same payment delivered twice changes nothing");
  {
    const r = await api("/api/commissions/sandbox-collections", {
      method: "POST",
      body: { externalRef: `${NAME}-PAY-1`, opportunityId: st.dealId, amountGross: "5750", amountTax: "750", collectedAt: dayOfMonthISO(5) },
    });
    check("reported as a replay", r.json?.replayed === true, r.text.slice(0, 200));
  }
  sub("7.3 the rep sees their own figure move by 50.00");
  {
    await loginAs("rep");
    const me = await api(`/api/commissions/me?month=${riyadhMonth()}`);
    check("readable", me.status === 200, me.text.slice(0, 160));
    // 5,750 less 750 VAT = 5,000 qualifying; the rep is on 1%.
    check("accrued rose by exactly 50.00", money(me.json?.statement?.accrued, base0.accrued) === "50.00",
      `${base0.accrued} -> ${me.json?.statement?.accrued}`);
    check("and the screen says plainly that it is sandbox data", me.json?.sandbox === true, S_(me.json?.notice).slice(0, 140));
  }
  sub("7.4 finance reviews and approves, but not their own");
  {
    await loginAs("finance");
    const row = await repRow();
    check("the rep appears on the team review with the same figure",
      money(row.accrued, base0.accrued) === "50.00", `${base0.accrued} -> ${row.accrued}`);
    // NOT an absolute reconciliation check. The browser-suite fixtures already left this
    // period unreconciled — an accrual that was approved and then refunded, which by design
    // leaves the approved row standing while the ledger drops. What must hold is that this
    // collection moved BOTH sides by the same 50.00, so the pre-existing difference is
    // carried forward unchanged rather than widened.
    check("the new accrual landed in the accrual rows as well as the ledger",
      money(row.accrualRowsTotal, base0.accrualRowsTotal) === "50.00", S_(row));
    check("so the period's reconciliation difference is unchanged by this run",
      Number(row.reconciliationDifference) === Number(base0.reconciliationDifference),
      `${base0.reconciliationDifference} -> ${row.reconciliationDifference}`);

    const own = await api("/api/commissions/review/actions", {
      method: "POST", body: { action: "approve", employeeId: FIN, month: riyadhMonth() } });
    check("nobody approves their own commission", own.status === 403, own.text.slice(0, 200));

    const ok = await api("/api/commissions/review/actions", {
      method: "POST", body: { action: "approve", employeeId: REP, month: riyadhMonth() } });
    check("the rep's period is approved", ok.status === 200, ok.text.slice(0, 200));
    check("and at least the new accrual was among them", (ok.json?.approved ?? 0) >= 1, S_(ok.json));
  }
  sub("7.5 an adjustment needs a reason, is appended, and survives a fresh request");
  {
    const noReason = await api("/api/commissions/review/actions", {
      method: "POST", body: { action: "adjust", employeeId: REP, month: riyadhMonth(), amount: "10" } });
    check("an adjustment with no reason is refused", noReason.status === 400, noReason.text.slice(0, 200));

    const zero = await api("/api/commissions/review/actions", {
      method: "POST", body: { action: "adjust", employeeId: REP, month: riyadhMonth(), amount: "0", reason: "nothing" } });
    check("a zero adjustment records nothing", zero.status === 400, zero.text.slice(0, 200));

    const adj = await api("/api/commissions/review/actions", {
      method: "POST", body: { action: "adjust", employeeId: REP, month: riyadhMonth(), amount: "10", reason: `${NAME} agreed goodwill` } });
    check("a reasoned adjustment is recorded", adj.status === 201, adj.text.slice(0, 200));
    check("reported separately from accrued, not folded into it",
      money(adj.json?.statement?.accrued, base0.accrued) === "50.00" &&
      money(adj.json?.statement?.adjustments, base0.adjustments) === "10.00", S_(adj.json?.statement));

    // Persistence across a new request, which on a serverless deployment may well be a
    // different instance with a different connection.
    const row = await repRow();
    check("and a fresh request still shows it", money(row.adjustments, base0.adjustments) === "10.00",
      `${base0.adjustments} -> ${row.adjustments}`);
  }
  sub("7.6 a refund reverses the ledger and leaves the approved rows alone");
  {
    await loginAs("manager");
    const rev = await api("/api/commissions/sandbox-collections", { method: "PATCH", body: { externalRef: `${NAME}-PAY-1` } });
    check("the reversal is accepted", rev.status === 200, rev.text.slice(0, 220));

    await loginAs("finance");
    const row = await repRow();
    check("accrued returns to the baseline", money(row.accrued, base0.accrued) === "0.00",
      `${base0.accrued} -> ${row.accrued}`);
    check("the approved accrual row is untouched, so the rows now exceed the ledger",
      money(row.accrualRowsTotal, base0.accrualRowsTotal) === "50.00", S_(row));
    check("and the screen reports the discrepancy rather than hiding it", row.reconciled === false, S_(row));
    check("the adjustment is still there at 10.00", money(row.adjustments, base0.adjustments) === "10.00", S_(row));
  }

  section("8 - LOST, AND PERSISTENCE");
  {
    await loginAs("manager");
    const reopened = await api(`/api/sales/opportunities/${st.dealId}/transition`, { method: "POST", body: { toOutcome: "OPEN" } });
    check("a won deal can be reopened by someone who may", reopened.status === 200, reopened.text.slice(0, 200));

    const noReason = await api(`/api/sales/opportunities/${st.dealId}/transition`, { method: "POST", body: { toOutcome: "LOST" } });
    check("marking it lost without a reason is refused", noReason.status === 400, noReason.text.slice(0, 200));

    const lost = await api(`/api/sales/opportunities/${st.dealId}/transition`, {
      method: "POST", body: { toOutcome: "LOST", lostReason: `${NAME} lost on price` } });
    check("with a reason it succeeds", lost.status === 200, lost.text.slice(0, 200));

    logout();
    await loginAs("manager");
    const after = await api(`/api/sales/opportunities/${st.dealId}`);
    check("and after a new sign-in the deal still reads LOST", after.json?.deal?.outcome === "LOST", S_(after.json?.deal?.outcome));
    check("with the reason that was given", after.json?.deal?.lostReason === `${NAME} lost on price`, S_(after.json?.deal?.lostReason));
  }

  console.log(`\n${"=".repeat(78)}\n  HOSTED SMOKE RESULT\n${"=".repeat(78)}`);
  console.log(`${results.pass} passed, ${results.fail} failed`);
  if (results.failures.length) console.log("FAILURES:\n  - " + results.failures.join("\n  - "));
  process.exit(results.fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error("FATAL: " + String(e.stack ?? e)); process.exit(1); });
