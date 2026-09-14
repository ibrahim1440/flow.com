// PLATFORM HARDENING — H1.
//
// Three fail-closed platform properties, none of which the domain suites can observe
// because none of them is about inventory or orders.
//
// ── A signed token is not an authorization decision ─────────────────────────
// Permissions were re-read from the database on every request, but `active` was never
// selected and `role` came from the token. So deactivating an employee did nothing they
// could notice for up to eight hours — the single control an operations manager reaches
// for when somebody leaves or a device goes missing — and demoting an admin left
// `role: "admin"` in a signed token that no later change could contradict, which is the
// field gating employee deletion and the production surplus override.
//
// ── A page that can be framed is a page that can be clicked for you ─────────
// The session cookie is SameSite=Lax, so a dashboard loaded inside a frame on another
// origin is fully authenticated. With no anti-framing header, an attacker who gets an
// operator onto their page can overlay the real one and harvest clicks on approve, cancel
// or delete. The application shipped with no security headers at all.
//
// ── Nobody was watching ────────────────────────────────────────────────────
// There was no health endpoint, so the way anyone learned the database was unreachable was
// a member of staff telephoning to say the screen was broken.
//
// The database-configuration half of H1 is NOT here: it is in harness-selftest.mjs, where
// every permutation runs with no server and no database, which is the only honest place to
// test what happens when the database URL is wrong.
import {
  ADMIN_PIN, db, api, check, section, sub, one, num, invariants, loginAs, results,
  ensureUser, BASE, getCookie,
} from "./harness.mjs";

const S = (v) => { try { return JSON.stringify(v) ?? String(v); } catch { return String(v); } };
const P = "PHD";

const OPS_PIN = "770051";
const ADM_PIN = "770052";
const OPS_ID = `${P}_emp_ops`;
const ADM_ID = `${P}_emp_adm`;

const opsPerms = {
  dashboard: { access: "edit" },
  orders: { access: "view", sub: { create: false, edit: false } },
  production: { access: "edit", sub: { start_batch: true } },
};
const adminPerms = {
  dashboard: { access: "edit" },
  orders: { access: "edit", sub: { create: true, edit: true } },
  employees: { access: "edit", sub: { create: true, edit: true } },
};

/** A request with full control of headers and cookies — the harness helper returns neither. */
async function raw(path, { cookie, method = "GET" } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { ...(cookie ? { cookie } : {}) },
    redirect: "manual",
  });
  const text = await res.text();
  const headers = {};
  res.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });
  return { status: res.status, headers, text };
}

const setActive = (id, active) =>
  db.query('UPDATE "Employee" SET active=$2 WHERE id=$1', [id, active]);
const setRole = (id, role) =>
  db.query('UPDATE "Employee" SET role=$2 WHERE id=$1', [id, role]);
const setPerms = (id, perms) =>
  db.query('UPDATE "Employee" SET permissions=$2 WHERE id=$1', [id, JSON.stringify(perms)]);

async function main() {
  await db.connect();
  await db.query(`DELETE FROM "Employee" WHERE id LIKE '${P}\\_%'`);

  await ensureUser(OPS_ID, `${P} Operator`, "roasting", opsPerms, OPS_PIN);
  await ensureUser(ADM_ID, `${P} Admin`, "admin", adminPerms, ADM_PIN);

  // ═══════════════════════════════════════════════════════════════════════
  section("A — DEACTIVATION TAKES EFFECT ON THE NEXT REQUEST");

  sub("A1. an active account works, and the token is captured");
  await loginAs(OPS_PIN);
  const opsCookie = getCookie();
  check("logging in yields a session cookie", opsCookie.startsWith("token="), opsCookie.slice(0, 12));

  const meBefore = await raw("/api/auth/me", { cookie: opsCookie });
  check("the account can identify itself", meBefore.status === 200, `status=${meBefore.status}`);
  const ordersBefore = await raw("/api/orders", { cookie: opsCookie });
  check("and can read the module it has access to", ordersBefore.status === 200,
    `status=${ordersBefore.status}`);

  sub("A2. deactivated in the database, with the SAME token still in hand");
  await setActive(OPS_ID, false);
  const meAfter = await raw("/api/auth/me", { cookie: opsCookie });
  const ordersAfter = await raw("/api/orders", { cookie: opsCookie });
  console.log(`    same cookie after deactivation: me=${meAfter.status} orders=${ordersAfter.status}`);
  check("the token is unchanged, so this is live state and not a re-login",
    getCookie() === opsCookie, "cookie changed");
  check("identity is refused", meAfter.status === 401, `status=${meAfter.status}`);
  check("and so is the data route", ordersAfter.status === 401, `status=${ordersAfter.status}`);
  check("the refusal says nothing about why the account is gone",
    !/inactive|disabled|deactivat/i.test(meAfter.text), meAfter.text.slice(0, 90));

  sub("A3. reactivating restores access without a new login");
  await setActive(OPS_ID, true);
  const meBack = await raw("/api/auth/me", { cookie: opsCookie });
  check("the same token works again", meBack.status === 200, `status=${meBack.status}`);

  sub("A4. a deleted account is refused the same way");
  const ghostCookie = opsCookie;
  await db.query('DELETE FROM "Employee" WHERE id=$1', [OPS_ID]);
  const meGhost = await raw("/api/auth/me", { cookie: ghostCookie });
  check("a token for a row that no longer exists is not authenticated",
    meGhost.status === 401, `status=${meGhost.status}`);
  await ensureUser(OPS_ID, `${P} Operator`, "roasting", opsPerms, OPS_PIN);

  // ═══════════════════════════════════════════════════════════════════════
  section("B — ROLE COMES FROM THE DATABASE, NOT THE TOKEN");

  sub("B1. an admin sees the full employee record");
  await loginAs(ADM_PIN);
  const admCookie = getCookie();
  const listAdmin = await api("/api/employees");
  const adminRow = Array.isArray(listAdmin.json)
    ? listAdmin.json.find((e) => e.id === ADM_ID)
    : undefined;
  check("the employee list is readable", listAdmin.status === 200, `status=${listAdmin.status}`);
  check("and an admin gets the privileged projection",
    !!adminRow && "permissions" in adminRow, S(adminRow).slice(0, 120));

  sub("B2. demoted in the database, with the SAME admin token still in hand");
  await setRole(ADM_ID, "roasting");
  const listDemoted = await raw("/api/employees", { cookie: admCookie });
  let demotedRow;
  try {
    demotedRow = JSON.parse(listDemoted.text).find((e) => e.id === ADM_ID);
  } catch { demotedRow = undefined; }
  console.log(`    after demotion: status=${listDemoted.status}, keys=${S(Object.keys(demotedRow ?? {}))}`);
  check("the token is unchanged", getCookie() === admCookie, "cookie changed");
  check("the privileged projection is withdrawn immediately",
    !!demotedRow && !("permissions" in demotedRow), S(demotedRow).slice(0, 120));

  sub("B3. and the admin-only destructive route refuses the same token");
  const del = await raw(`/api/employees/${OPS_ID}`, { cookie: admCookie, method: "DELETE" });
  const opsStillThere = await one('SELECT id FROM "Employee" WHERE id=$1', [OPS_ID]);
  console.log(`    DELETE /api/employees/${OPS_ID} -> ${del.status}`);
  check("employee deletion is refused for the demoted token", del.status === 403,
    `status=${del.status} ${del.text.slice(0, 90)}`);
  check("and the employee still exists", opsStillThere !== undefined, "employee was deleted");

  sub("B4. promoting again restores it, still without a new login");
  await setRole(ADM_ID, "admin");
  const listRestored = await raw("/api/employees", { cookie: admCookie });
  let restoredRow;
  try {
    restoredRow = JSON.parse(listRestored.text).find((e) => e.id === ADM_ID);
  } catch { restoredRow = undefined; }
  check("the privileged projection is back", !!restoredRow && "permissions" in restoredRow,
    S(restoredRow).slice(0, 120));

  // ═══════════════════════════════════════════════════════════════════════
  section("C — PERMISSIONS ARE LIVE TOO");

  sub("C1. a sub-privilege the account does not hold is refused");
  await loginAs(OPS_PIN);
  const opsCookie2 = getCookie();
  const createDenied = await api("/api/orders", { method: "POST", body: {} });
  check("creating an order is forbidden", createDenied.status === 403,
    `status=${createDenied.status} ${S(createDenied.json).slice(0, 90)}`);

  sub("C2. granted in the database, the very next request is past the gate");
  await setPerms(OPS_ID, {
    ...opsPerms,
    orders: { access: "edit", sub: { create: true, edit: false } },
  });
  const createGranted = await raw("/api/orders", { cookie: opsCookie2, method: "POST" });
  console.log(`    after grant: POST /api/orders -> ${createGranted.status}`);
  check("the same token is no longer forbidden", createGranted.status !== 403,
    `status=${createGranted.status}`);
  check("it fails on the request body instead, which is the next gate",
    createGranted.status === 400 || createGranted.status === 500,
    `status=${createGranted.status} ${createGranted.text.slice(0, 90)}`);
  check("and no order was created by a probe with no body",
    num((await one(`SELECT COUNT(*)::int n FROM "Order" WHERE notes LIKE '${P}%'`)).n) === 0,
    "an order appeared");
  await setPerms(OPS_ID, opsPerms);

  // ═══════════════════════════════════════════════════════════════════════
  section("D — SECURITY HEADERS");

  sub("D1. a public page carries the full set");
  const login = await raw("/login");
  const h = login.headers;
  console.log(`    /login -> ${login.status}; xfo=${h["x-frame-options"]}, csp=${(h["content-security-policy"] ?? "").slice(0, 40)}`);
  check("the page is served", login.status === 200, `status=${login.status}`);
  check("X-Frame-Options: DENY", h["x-frame-options"] === "DENY", S(h["x-frame-options"]));
  check("CSP is enforced and forbids framing",
    (h["content-security-policy"] ?? "").includes("frame-ancestors 'none'"),
    S(h["content-security-policy"]));
  check("the enforced CSP also pins base-uri and form-action",
    (h["content-security-policy"] ?? "").includes("base-uri 'self'") &&
    (h["content-security-policy"] ?? "").includes("form-action 'self'"),
    S(h["content-security-policy"]));
  check("X-Content-Type-Options: nosniff", h["x-content-type-options"] === "nosniff",
    S(h["x-content-type-options"]));
  check("Referrer-Policy is set", (h["referrer-policy"] ?? "").length > 0, S(h["referrer-policy"]));
  check("Strict-Transport-Security is set with a long max-age",
    /max-age=\d{7,}/.test(h["strict-transport-security"] ?? ""), S(h["strict-transport-security"]));
  check("Permissions-Policy denies the hardware this application never asks for",
    /camera=\(\)/.test(h["permissions-policy"] ?? "") &&
    /geolocation=\(\)/.test(h["permissions-policy"] ?? ""), S(h["permissions-policy"]));
  check("a Report-Only policy is present for the directives not yet enforced",
    (h["content-security-policy-report-only"] ?? "").includes("script-src"),
    S(h["content-security-policy-report-only"]).slice(0, 80));

  sub("D2. an authenticated dashboard response carries them too");
  await loginAs(ADMIN_PIN);
  const dash = await raw("/dashboard", { cookie: getCookie() });
  const dh = dash.headers;
  console.log(`    /dashboard -> ${dash.status}; xfo=${dh["x-frame-options"]}`);
  check("the authenticated page is not framable",
    dh["x-frame-options"] === "DENY" &&
    (dh["content-security-policy"] ?? "").includes("frame-ancestors 'none'"),
    `${S(dh["x-frame-options"])} / ${S(dh["content-security-policy"])}`);
  check("and still carries nosniff and Referrer-Policy",
    dh["x-content-type-options"] === "nosniff" && (dh["referrer-policy"] ?? "").length > 0,
    `${S(dh["x-content-type-options"])} / ${S(dh["referrer-policy"])}`);

  sub("D3. API responses are never publicly cacheable");
  const apiRes = await raw("/api/orders", { cookie: getCookie() });
  const cc = apiRes.headers["cache-control"] ?? "";
  console.log(`    /api/orders cache-control: ${S(cc)}`);
  check("operational data is marked no-store", /no-store/.test(cc), S(cc));
  check("and is never marked public", !/public/.test(cc), S(cc));
  check("the API response is not framable either",
    apiRes.headers["x-frame-options"] === "DENY", S(apiRes.headers["x-frame-options"]));

  // ═══════════════════════════════════════════════════════════════════════
  section("E — HEALTH ENDPOINT");

  sub("E1. it answers an unauthenticated caller");
  const health = await raw("/api/health");
  console.log(`    /api/health -> ${health.status} ${health.text.slice(0, 60)}`);
  check("200 with no session at all", health.status === 200, `status=${health.status}`);
  let body;
  try { body = JSON.parse(health.text); } catch { body = null; }
  check("the body is exactly { status: \"ok\" }",
    !!body && body.status === "ok" && Object.keys(body).length === 1, health.text.slice(0, 90));

  sub("E2. and tells an anonymous caller nothing else");
  const leaked = [
    ["the database name", /neondb/i],
    ["the endpoint id", /ep-[a-z]+-[a-z]+-[a-z0-9]+/i],
    ["a connection string", /postgres(ql)?:\/\//i],
    ["a credential", /password|secret|authToken/i],
    ["a stack trace", /\bat\s+\w+.*:\d+:\d+/],
    ["migration or schema detail", /prisma|migration|SELECT/i],
    ["a host name", /\.aws\.neon\.tech|\.amazonaws\.com/i],
  ];
  for (const [label, re] of leaked) {
    check(`the response does not disclose ${label}`, !re.test(health.text), health.text.slice(0, 90));
  }
  check("and it is not cached anywhere",
    /no-store/.test(health.headers["cache-control"] ?? ""), S(health.headers["cache-control"]));

  sub("E3. it is read-only and bounded");
  const before = num((await one(`SELECT COUNT(*)::int n FROM "InventoryMovement"`)).n);
  const t0 = Date.now();
  const again = await raw("/api/health");
  const elapsed = Date.now() - t0;
  const after = num((await one(`SELECT COUNT(*)::int n FROM "InventoryMovement"`)).n);
  console.log(`    second probe: ${again.status} in ${elapsed}ms`);
  check("a probe writes nothing", after === before, `${before} -> ${after}`);
  check("and returns well inside its own timeout", elapsed < 3000, `${elapsed}ms`);
  // The 503 branch is deliberately NOT exercised here. Producing it means making the
  // database genuinely unreachable mid-run, which would destabilise every suite sharing
  // this connection for the sake of one assertion — the failure path is covered by reading
  // it, not by staging an outage.

  await invariants("after the platform hardening suite");

  // ── teardown ──────────────────────────────────────────────────────────────
  await loginAs(ADMIN_PIN);
  await db.query(`DELETE FROM "Employee" WHERE id LIKE '${P}\\_%'`);

  section("PLATFORM HARDENING RESULT");
  console.log(`${results.pass} passed, ${results.fail} failed`);
  if (results.failures.length) console.log("FAILURES:\n  - " + results.failures.join("\n  - "));
  await db.end();
  process.exit(results.fail === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.log("FATAL:", e?.stack || e);
  try { await db.query(`DELETE FROM "Employee" WHERE id LIKE '${P}\\_%'`); } catch {}
  try { await db.end(); } catch {}
  process.exit(1);
});
