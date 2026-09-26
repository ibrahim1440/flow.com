// NAVIGATION — the registry, against the real roles and the real routes on disk.
//
// No database and no browser: this is a suite about a data structure. Every consumer of the
// menu — sidebar, contextual bar, breadcrumbs, active resolution and the dashboard route
// guard — reads one tree, so the properties worth defending are properties of that tree:
//
//   every route that exists is reachable by somebody;
//   nobody is offered a destination they cannot open;
//   nobody LOSES a destination they can open today;
//   a group never appears with nothing behind it;
//   a detail page resolves to the list it came from.
//
// The last one is why the second level was missing to begin with. The sidebar was a flat
// list of twenty-four leaves with no parent relationships, so there was nothing for a
// contextual bar or a breadcrumb to be derived FROM.
//
// Written in TypeScript and run through tsx so it exercises the SOURCE registry and the
// SOURCE role definitions the browser suites use, rather than a transcription of either.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  NAV, visibleNav, resolveActive, firstDestination, routeAllowed, breadcrumb,
  type NavNode, type Viewer,
} from "@/lib/nav/registry";
import { ROLES, type RoleName } from "../../../tests/e2e/support/roles";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

const results = { pass: 0, fail: 0, failures: [] as string[] };
function check(name: string, ok: boolean, detail = "") {
  if (ok) { results.pass++; console.log(`  [PASS] ${name}`); }
  else { results.fail++; results.failures.push(name); console.log(`  [FAIL] ${name}  << ${detail}`); }
}
const section = (t: string) => console.log(`\n${"=".repeat(78)}\n  ${t}\n${"=".repeat(78)}`);
const sub = (t: string) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 58 - t.length))}`);
const S = (v: unknown) => { try { return JSON.stringify(v) ?? String(v); } catch { return String(v); } };

const viewer = (r: RoleName): Viewer => ({ permissions: ROLES[r].permissions, role: ROLES[r].role });

/** Every destination in a tree, flattened, with the trail that leads to it. */
function destinations(tree: NavNode[] = NAV, trail: NavNode[] = []): { node: NavNode; trail: NavNode[] }[] {
  const out: { node: NavNode; trail: NavNode[] }[] = [];
  for (const n of tree) {
    if (n.href) out.push({ node: n, trail });
    if (n.children) out.push(...destinations(n.children, [...trail, n]));
  }
  return out;
}

/** Every page route the application actually has on disk. */
function routesOnDisk(): string[] {
  const out: string[] = [];
  const walk = (dir: string, url: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) walk(path.join(dir, e.name), `${url}/${e.name}`);
      else if (e.name === "page.tsx") out.push(url || "/dashboard");
    }
  };
  walk(path.join(ROOT, "src/app/dashboard"), "/dashboard");
  return out.sort();
}

// ═══════════════════════════════════════════════════════════════════════════
section("A — THE TREE ITSELF");

sub("A1. identifiers and labels");
{
  const all: string[] = [];
  const collect = (t: NavNode[]) => t.forEach((n) => { all.push(n.id); if (n.children) collect(n.children); });
  collect(NAV);
  const dupes = all.filter((id, i) => all.indexOf(id) !== i);
  check("every node id is unique", dupes.length === 0, S(dupes));

  let labelled = true;
  const w = (ns: NavNode[]) => ns.forEach((n) => { if (!n.ar || !n.en) labelled = false; if (n.children) w(n.children); });
  w(NAV);
  check("every node has an Arabic and an English label", labelled);
}

sub("A2. every node is either a destination or a group, never neither");
{
  const bad: string[] = [];
  const w = (ns: NavNode[]) => ns.forEach((n) => {
    if (!n.href && (!n.children || n.children.length === 0)) bad.push(n.id);
    if (n.children) w(n.children);
  });
  w(NAV);
  check("no node is a dead end", bad.length === 0, S(bad));
}

sub("A3. the menu is at most three levels deep");
{
  let deepest = 0;
  const w = (ns: NavNode[], d: number) => ns.forEach((n) => { deepest = Math.max(deepest, d); if (n.children) w(n.children, d + 1); });
  w(NAV, 1);
  check("module → subunit → page, and no deeper", deepest <= 3, `depth ${deepest}`);
}

// ═══════════════════════════════════════════════════════════════════════════
section("B — EVERY ROUTE THAT EXISTS IS REACHABLE");

const ON_DISK = routesOnDisk();
// Reached from somewhere else by design: a detail page opened from its list, the quotation
// editor and its print view, and the personal profile, which is not a module.
const NOT_IN_MENU = [
  "/dashboard/profile",
  "/dashboard/sales/quotes/new",
  "/dashboard/sales/quotes/[id]",
  "/dashboard/sales/quotes/[id]/print",
  "/dashboard/sales/leads/[id]",
  "/dashboard/sales/deals/[id]",
  "/dashboard/cupping/[id]",
  "/dashboard/production-orders/[id]",
];

sub("B1. no page on disk is orphaned");
{
  const hrefs = new Set(destinations().map((d) => d.node.href));
  const orphans = ON_DISK.filter((r) => !hrefs.has(r) && !NOT_IN_MENU.includes(r));
  check("every listable route has a navigation entry", orphans.length === 0, S(orphans));
  console.log(`         ${ON_DISK.length} routes on disk · ${hrefs.size} destinations in the menu`);
}

sub("B2. every menu destination is a page that exists");
{
  const missing = destinations().map((d) => d.node.href!).filter((h) => !ON_DISK.includes(h));
  check("the menu points at nothing that is not built", missing.length === 0, S(missing));
}

sub("B3. detail routes resolve to the list they came from");
{
  const cases: [string, string][] = [
    ["/dashboard/sales/deals/abc", "sales.pipeline.board"],
    ["/dashboard/sales/leads/abc", "sales.customers.leads"],
    ["/dashboard/sales/quotes/abc", "sales.quotes.list"],
    ["/dashboard/sales/quotes/new", "sales.quotes.list"],
    ["/dashboard/sales/quotes/abc/print", "sales.quotes.list"],
    ["/dashboard/production-orders/abc", "operations.productionOrders"],
    ["/dashboard/cupping/abc", "operations.cupping"],
  ];
  for (const [url, expected] of cases) {
    const { leaf } = resolveActive(url);
    check(`${url} → ${expected}`, leaf?.id === expected, S(leaf?.id));
  }
}

sub("B4. the dashboard root does not swallow everything beneath it");
{
  check("a nested route beats the shorter /dashboard",
    resolveActive("/dashboard/sales/leads").leaf?.id === "sales.customers.leads");
  check("and /dashboard itself still resolves", resolveActive("/dashboard").leaf?.id === "dashboard");
}

// ═══════════════════════════════════════════════════════════════════════════
section("C — WHAT EACH ROLE SEES");

const ROLE_NAMES: RoleName[] =
  ["crmRep", "crmManager", "crmFinance", "sales", "dispatch", "production", "qc", "packaging", "admin"];

sub("C1. nobody is shown a group that leads nowhere");
for (const r of ROLE_NAMES) {
  const empty: string[] = [];
  const w = (ns: NavNode[]) => ns.forEach((n) => {
    if (n.children && n.children.length === 0) empty.push(n.id);
    if (n.children) w(n.children);
  });
  w(visibleNav(viewer(r)));
  check(`${r}: no empty group or subunit`, empty.length === 0, S(empty));
}

sub("C2. nobody is offered a destination they cannot open");
for (const r of ROLE_NAMES) {
  const v = viewer(r);
  const refused = destinations(visibleNav(v))
    .filter((d) => !routeAllowed(v, d.node.href!))
    .map((d) => d.node.id);
  check(`${r}: every offered link opens`, refused.length === 0, S(refused));
}

sub("C3. entering a group lands on a page that role may open");
for (const r of ROLE_NAMES) {
  const v = viewer(r);
  const bad: string[] = [];
  const w = (ns: NavNode[]) => ns.forEach((n) => {
    const dest = firstDestination(v, n);
    if (!dest) bad.push(`${n.id}: nowhere`);
    else if (!routeAllowed(v, dest)) bad.push(`${n.id} → ${dest}`);
    if (n.children) w(n.children);
  });
  w(visibleNav(v));
  check(`${r}: every group opens onto a permitted page`, bad.length === 0, S(bad));
}

sub("C4. the Sales CRM group belongs to the Sales CRM");
{
  const fin = visibleNav(viewer("crmFinance")).map((n) => n.id);
  check("Finance sees no Sales group", !fin.includes("sales"), S(fin));
  check("and does see a Finance group", fin.includes("finance"), S(fin));

  const mgr = visibleNav(viewer("crmManager")).map((n) => n.id);
  check("a sales manager sees Sales", mgr.includes("sales"), S(mgr));
  check("and NOT a Finance group, holding no finance ability", !mgr.includes("finance"), S(mgr));

  const rep = visibleNav(viewer("crmRep")).map((n) => n.id);
  check("a rep sees Sales", rep.includes("sales"), S(rep));
  check("and no Finance group", !rep.includes("finance"), S(rep));
}

sub("C5. commission review reaches both audiences, and neither sees it twice");
for (const r of ["crmRep", "crmManager", "crmFinance"] as RoleName[]) {
  const review = destinations(visibleNav(viewer(r)))
    .filter((d) => d.node.href === "/dashboard/commissions/review");
  check(`${r}: commission review appears at most once`, review.length <= 1, S(review.map((d) => d.node.id)));
}
{
  const fin = destinations(visibleNav(viewer("crmFinance"))).map((d) => d.node.href);
  check("Finance can reach commission review", fin.includes("/dashboard/commissions/review"), S(fin));
  check("and the collections queue", fin.includes("/dashboard/sales/collections"), S(fin));
  const mgr = destinations(visibleNav(viewer("crmManager"))).map((d) => d.node.href);
  check("a manager can still reach commission review", mgr.includes("/dashboard/commissions/review"));
  check("and collections, to see the team's", mgr.includes("/dashboard/sales/collections"));
}

sub("C6. no destination is listed twice for one person");
for (const r of ROLE_NAMES) {
  const hrefs = destinations(visibleNav(viewer(r))).map((d) => d.node.href!);
  const dupes = hrefs.filter((h, i) => hrefs.indexOf(h) !== i);
  if (r === "admin") {
    // The administrator holds every ability at once and is the only viewer who meets both
    // the Sales and the Finance framing of the three shared screens. Every real role sees
    // exactly one of the two, which is what the assertions above pin down.
    const SHARED = [
      "/dashboard/sales/collections",
      "/dashboard/commissions/review",
      "/dashboard/sales/my-commissions",
    ];
    check("admin: the only duplicates are the deliberate Sales/Finance pairs",
      dupes.every((h) => SHARED.includes(h)), S(dupes));
  } else {
    check(`${r}: no duplicated destination`, dupes.length === 0, S(dupes));
  }
}

sub("C7. order preparation left Sales without leaving the people who need it");
for (const r of ["dispatch", "production", "admin"] as RoleName[]) {
  const prep = destinations(visibleNav(viewer(r)))
    .find((d) => d.node.href === "/dashboard/workstation/preparation");
  check(`${r}: preparation is reachable`, Boolean(prep), "missing");
  if (prep) {
    check(`${r}: and sits under Operations, not Sales`, prep.trail[0]?.id === "operations",
      S(prep.trail.map((t) => t.id)));
  }
}

// ═══════════════════════════════════════════════════════════════════════════
section("D — NOTHING REACHABLE TODAY BECOMES UNREACHABLE");
//
// The previous flat sidebar, transcribed with the gate each entry carried. If a role could
// open a destination before the restructuring, it must still be able to afterwards.
const BEFORE: [string, string | null, string | null, string?][] = [
  ["/dashboard", null, null],
  ["/dashboard/inventory", "inventory", null],
  ["/dashboard/purchases", "inventory", null],
  ["/dashboard/products", "inventory", null],
  ["/dashboard/sales/leads", "sales", null],
  ["/dashboard/sales/pipeline", "sales", null],
  ["/dashboard/sales/activities", "sales", null],
  ["/dashboard/sales/quotes", "sales", null],
  // The one entry the old sidebar already admitted two ways: sales, or a collection
  // decision ability. Transcribed faithfully so "nothing new appeared" means what it says.
  ["/dashboard/sales/collections", "sales", null, "FINANCE_TOO"],
  ["/dashboard/sales/targets", "sales", null],
  ["/dashboard/sales/reports", "sales", null],
  ["/dashboard/sales/settings", "sales", "stage_manage"],
  ["/dashboard/sales/my-commissions", "commissions", null],
  ["/dashboard/commissions/review", "commissions", "view_team"],
  ["/dashboard/commissions/plans", "commissions", "manage_plans"],
  ["/dashboard/orders", "orders", null],
  ["/dashboard/workstation/preparation", "orders", null],
  ["/dashboard/production", "production", null],
  ["/dashboard/production-orders", "production", null],
  ["/dashboard/qc", "qc", null],
  ["/dashboard/packaging", "packaging", null],
  ["/dashboard/dispatch", "dispatch", null],
  ["/dashboard/history", "history", null],
  ["/dashboard/analytics", "analytics", null],
  ["/dashboard/labels", "labels", null],
  ["/dashboard/employees", "employees", null],
  ["/dashboard/cupping", "cupping", null],
  ["/dashboard/customers", "customers", null],
  ["/dashboard/accounting", "accounting", null],
  ["/dashboard/settings", "settings", null],
];

function couldSeeBefore(v: Viewer, [, module, subKey, extra]: [string, string | null, string | null, string?]): boolean {
  if (extra === "FINANCE_TOO") {
    const cs = v.permissions.commissions;
    const decides = !!cs && cs.access !== "none" &&
      (cs.sub?.collection_verify === true || cs.sub?.collection_reject === true || cs.sub?.collection_reverse === true);
    if (decides) return true;
  }
  if (!module) return true;
  const perm = v.permissions[module];
  if (!perm || perm.access === "none") return false;
  if (module === "settings" && v.role !== "admin") return false;
  if (subKey) return perm.sub?.[subKey] === true;
  return true;
}

sub("D1. nothing is lost");
for (const r of ROLE_NAMES) {
  const v = viewer(r);
  const now = new Set(destinations(visibleNav(v)).map((d) => d.node.href));
  const lost = BEFORE.filter((row) => couldSeeBefore(v, row) && !now.has(row[0])).map((row) => row[0]);
  check(`${r}: nothing they could reach before is gone`, lost.length === 0, S(lost));
}

sub("D2. and nothing new is handed to anybody");
for (const r of ROLE_NAMES) {
  const v = viewer(r);
  const before = new Set(BEFORE.filter((row) => couldSeeBefore(v, row)).map((row) => row[0]));
  const gained = [...new Set(destinations(visibleNav(v)).map((d) => d.node.href!))].filter((h) => !before.has(h));
  check(`${r}: no destination appeared that they could not already open`, gained.length === 0, S(gained));
}

// ═══════════════════════════════════════════════════════════════════════════
section("E — THE GUARD AND THE BREADCRUMB");

sub("E1. the route guard agrees with the menu");
{
  const fin = viewer("crmFinance");
  check("Finance is refused the pipeline", routeAllowed(fin, "/dashboard/sales/pipeline") === false);
  check("and the leads list", routeAllowed(fin, "/dashboard/sales/leads") === false);
  check("but allowed the collections queue", routeAllowed(fin, "/dashboard/sales/collections") === true,
    "verifying collections is the finance job");
  const rep = viewer("crmRep");
  check("and refused settings, which keeps its admin-only double guard",
    routeAllowed(rep, "/dashboard/settings") === false);
  check("an unlisted route stays open to anybody signed in", routeAllowed(rep, "/dashboard/profile") === true);
  // Deliberately unchanged from the previous guard: the layout gates on the MODULE and
  // leaves sub-privileges to the page and its API, which refuse the actual work. A
  // navigation restructuring is not the place to change who can open a screen.
  check("a rep may still open the commission plans screen, as before",
    routeAllowed(rep, "/dashboard/commissions/plans") === true,
    "the page and its API enforce manage_plans");
}

sub("E2. a detail route is guarded like its list");
{
  check("Finance cannot open a deal page", routeAllowed(viewer("crmFinance"), "/dashboard/sales/deals/abc") === false,
    "detail pages inherit their list's requirement");
  check("a rep can", routeAllowed(viewer("crmRep"), "/dashboard/sales/deals/abc") === true);
}

sub("E3. breadcrumbs read as module, subunit, page");
{
  const crumbs = (p: string) => breadcrumb(p).map((n) => n.id);
  check("a leaf under a subunit gives three",
    S(crumbs("/dashboard/sales/leads")) === S(["sales", "sales.customers", "sales.customers.leads"]),
    S(crumbs("/dashboard/sales/leads")));
  check("a detail page gives the same three as its list",
    S(crumbs("/dashboard/sales/deals/abc")) === S(["sales", "sales.pipeline", "sales.pipeline.board"]),
    S(crumbs("/dashboard/sales/deals/abc")));
  check("a subunit that IS the page does not repeat itself",
    S(crumbs("/dashboard/sales/collections")) === S(["sales", "sales.collections"]),
    S(crumbs("/dashboard/sales/collections")));
  check("a top-level destination gives one", S(crumbs("/dashboard")) === S(["dashboard"]), S(crumbs("/dashboard")));
}

sub("E4. contextual navigation appears only where there is a choice to make");
{
  const withTabs: string[] = [];
  const w = (ns: NavNode[]) => ns.forEach((n) => {
    if (n.children && n.children.filter((c) => c.href).length > 1) withTabs.push(n.id);
    if (n.children) w(n.children);
  });
  w(visibleNav(viewer("crmRep")));
  check("the multi-page subunits offer a contextual bar",
    withTabs.includes("sales.customers") && withTabs.includes("sales.pipeline") && withTabs.includes("sales.quotes"),
    S(withTabs));
  check("and a single-destination subunit does not",
    !withTabs.includes("sales.collections") && !withTabs.includes("sales.settings"), S(withTabs));
}

sub("E5. a subunit hides the pages the viewer cannot open");
{
  const perf = visibleNav(viewer("crmRep"))
    .find((n) => n.id === "sales")?.children?.find((c) => c.id === "sales.performance");
  check("a rep does not see the commission plans screen",
    perf?.children?.every((c) => c.id !== "sales.performance.plans") ?? false,
    S(perf?.children?.map((c) => c.id)));
  check("and does see their own targets", perf?.children?.some((c) => c.id === "sales.performance.targets") ?? false,
    S(perf?.children?.map((c) => c.id)));
}

// ═══════════════════════════════════════════════════════════════════════════
console.log(`\n${"=".repeat(78)}`);
console.log(`  ${results.pass} passed, ${results.fail} failed`);
if (results.fail) {
  console.log("\n  Failures:");
  for (const f of results.failures) console.log(`    - ${f}`);
}
console.log("=".repeat(78));
process.exit(results.fail ? 1 : 0);
