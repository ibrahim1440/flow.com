/**
 * «واجهة المحاسب» — THE ACCOUNTANT WORKSPACE SIDEBAR (Qoyod-parity program, phase 1).
 *
 * Qoyod's sidebar tree, in Qoyod's order and with Qoyod's names (`./glossary`), drawn by the Direction 2.1 shell
 * INSTEAD of the system menu for a viewer who holds the accounting module (owner decision), until they switch to
 * «القائمة الكاملة». Everyone else keeps today's menus: nothing here is read unless the viewer holds accounting.
 *
 * ── Access: this tree can only NARROW what the system menu offers ──
 * It is not a second registry and it grants nothing. Each item points at an EXISTING route, and it is shown as a link
 * only when the full registry (`./registry`) would offer that route to the same viewer — some node of the viewer's
 * pruned tree claims the path and the route guard opens it — and, where an item names `anyOf`, when the viewer also
 * holds one of those (a tab of a page, e.g. the purchase claims, is offered only to the tab's own audience). So for
 * every viewer: accountant-workspace links ⊆ system-menu destinations. `scripts/nav/accountant-parity.ts` proves it
 * for every role and 20,000 random permission documents.
 *
 * ── «قريباً» ──
 * An item whose page does not exist yet is drawn, disabled, with a «قريباً» badge. Its href is RESERVED for the
 * builder creating that page; the item becomes a link by itself once the registry has an entry at exactly that href
 * (or the route is listed in `./accountant-live`). `tests/ui/unit/accountant-nav.test.ts` fails when a reserved route
 * has a page on disk but is not live, or is live without a page.
 */
import { hasModuleAccess, hasSubPrivilege, canEdit } from "@/lib/auth-shared";
import { NAV, nodesForPath, presentTree, routeAllowed, visibleNav, type Ability, type NavNode, type Viewer } from "./registry";
import { qoyodTerm, type TermKey } from "./glossary";
import { LIVE_RESERVED } from "./accountant-live";
import { SIMPLE_BILL_HREF, SIMPLE_BILL_LIST_HREF } from "./accountant-contract";
import { canWriteQuotes } from "@/lib/services/sales/quote-access";
import type { D21IconName } from "@/components/shell/icons";

/** `anyOf`: the duty the page's own create button checks; `editOf`: or edit access to that module (the API's `requireEdit`). */
export type AcctCreate = { href: string; anyOf?: Ability[]; editOf?: string;
  /** Or a page helper's own rule (the same function its API's door calls — BATCH22 WP-E `canWriteQuotes`). */
  can?: (p: Viewer["permissions"]) => boolean };

export type AcctItem = {
  id: string;
  term: TermKey;
  /** The existing route (with its tab, when the item is a tab of a page). Absent: no route at all yet. */
  href?: string;
  /** A route reserved for a page another builder is creating: «قريباً» until it is listed in `./accountant-live`. */
  reserved?: boolean;
  /** Also required (any one), beyond the registry's offer of the route — narrows only. */
  anyOf?: Ability[];
  /** The «+» quick-new: the page's own create entry, for the same audience its own button has. */
  create?: AcctCreate;
  /** Extra path prefixes this item lights for (detail pages of its list). */
  alsoMatches?: string[];
};

export type AcctGroup = { id: string; term: TermKey; icon: D21IconName; href?: string; children?: AcctItem[]; anyOf?: Ability[] };

const A = (module: string, sub?: string): Ability => ({ module, ...(sub ? { sub } : {}) });

/** The Qoyod tree, in order (BRIEF.md). ✗ المهام والمشاريع · قيود لايند · الخدمات الاحترافية are left out (owner). */
export const ACCOUNTANT_NAV: AcctGroup[] = [
  { id: "acct.home", term: "dashboard", icon: "pulse", href: "/dashboard/accounting/home" },
  {
    id: "acct.sales", term: "sales", icon: "deal",
    children: [
      { id: "acct.sales.customers", term: "customers", href: "/dashboard/customers", create: { href: "/dashboard/customers?new=customer", editOf: "customers" } },
      // Read-only for the accountant by default (Sales owns quotes; QOYOD-REF §5.1; owner answer 3). «+ عرض سعر» only with
      // `canWriteQuotes` (sales › quote_write, or accounting › quotes_issue — BATCH22 WP-E): on an existing open deal.
      { id: "acct.sales.quotes", term: "quotes", href: "/dashboard/accounting/quotes", alsoMatches: ["/dashboard/sales/quotes"], create: { href: "/dashboard/accounting/quotes/new", can: canWriteQuotes } },
      { id: "acct.sales.invoices", term: "salesInvoices", href: "/dashboard/sales/invoices", anyOf: [A("sales", "invoices_view"), A("accounting", "ar")], create: { href: "/dashboard/sales/invoices/new", anyOf: [A("sales", "invoices_create")] } },
      // «طلبات الفواتير» (BATCH 22 WP-C): the queue of requested drafts, for the issuers (a badge counts them).
      { id: "acct.sales.requests", term: "invoiceRequests", href: "/dashboard/sales/invoices?view=requests", anyOf: [A("sales", "invoices_issue")] },
      { id: "acct.sales.notes", term: "creditNotes", href: "/dashboard/sales/invoices?tab=notes", anyOf: [A("sales", "invoices_view"), A("accounting", "ar")] },
      // «سندات العملاء» (BATCH22 WP-D): the receipts the accountant confirms («سند قبض»), and «+» records a receipt for an
      // invoice with no deal (accounting › receipts_confirm or ar).
      { id: "acct.sales.receipts", term: "collections", href: "/dashboard/accounting/receipts", alsoMatches: ["/dashboard/sales/collections"], create: { href: "/dashboard/accounting/receipts?new=1", anyOf: [A("accounting", "receipts_confirm"), A("accounting", "ar")] } },
      { id: "acct.sales.ar", term: "arCenter", href: "/dashboard/sales/receivables", anyOf: [A("sales", "invoices_view"), A("accounting", "ar")] },
    ],
  },
  {
    id: "acct.purchases", term: "purchases", icon: "truck",
    children: [
      { id: "acct.purchases.suppliers", term: "suppliers", href: "/dashboard/purchases?tab=suppliers", alsoMatches: ["/dashboard/purchases/suppliers"], anyOf: [A("accounting"), A("purchases", "invoices"), A("inventory")] },
      { id: "acct.purchases.orders", term: "purchaseOrders" }, // deferred (owner decision): «قريباً», no route
      { id: "acct.purchases.invoices", term: "purchaseInvoices", href: "/dashboard/purchases?tab=invoices", alsoMatches: ["/dashboard/purchases/invoices", "/dashboard/purchases"], anyOf: [A("accounting"), A("purchases", "invoices")], create: { href: "/dashboard/purchases/invoices/new", anyOf: [A("purchases", "invoices"), A("accounting", "ap")] } },
      { id: "acct.purchases.debitNotes", term: "supplierClaims", href: "/dashboard/purchases?tab=claims", anyOf: [A("accounting"), A("purchases", "invoices")] },
      // «فواتير بسيطة» (BATCH22 WP-H): the purchase invoices filtered kind=SIMPLE; its «+» opens the simple-invoice form
      // (`?mode=expense`, ./accountant-contract), which the item also lights.
      { id: "acct.purchases.simple", term: "simpleBills", href: SIMPLE_BILL_LIST_HREF, alsoMatches: [SIMPLE_BILL_HREF], anyOf: [A("purchases", "invoices"), A("accounting", "ap")], create: { href: SIMPLE_BILL_HREF, anyOf: [A("purchases", "invoices"), A("accounting", "ap")] } },
      { id: "acct.purchases.vouchers", term: "supplierPayments", href: "/dashboard/accounting/ap?view=payments" },
    ],
  },
  {
    id: "acct.products", term: "productsCosts", icon: "box",
    children: [
      // The accountant's «المنتجات والتكاليف» is the valuation (quantities, average cost, value; QOYOD-REF §5.3), read-only: no «+».
      { id: "acct.products.products", term: "productsCosts", href: "/dashboard/accounting/inventory", alsoMatches: ["/dashboard/inventory/valuation"] },
      { id: "acct.products.locations", term: "locations", href: "/dashboard/inventory/locations" },
      // Read-only for the accountant (Sales creates them, Production runs them): no «+». The accountant's view is the
      // completed roasting batches with their stock movements, cost and journal entry (qb-pages, QOYOD-REF §3.4 / §3.5).
      { id: "acct.products.mo", term: "productionOrders", href: "/dashboard/accounting/manufacturing", alsoMatches: ["/dashboard/production-orders"] },
    ],
  },
  {
    id: "acct.assets", term: "fixedAssets", icon: "cols",
    children: [
      { id: "acct.assets.list", term: "fixedAssets", href: "/dashboard/accounting/fixed-assets", reserved: true, alsoMatches: ["/dashboard/accounting/fixed-assets/new"], create: { href: "/dashboard/accounting/fixed-assets/new", anyOf: [A("accounting", "fixed_assets")] } },
      { id: "acct.assets.depreciation", term: "depreciation", href: "/dashboard/accounting/fixed-assets/depreciation", reserved: true },
      { id: "acct.assets.disposals", term: "disposals", href: "/dashboard/accounting/fixed-assets/disposals", reserved: true },
      { id: "acct.assets.additions", term: "additions", href: "/dashboard/accounting/fixed-assets/additions", reserved: true },
    ],
  },
  { id: "acct.payroll", term: "payroll", icon: "wallet", href: "/dashboard/hr/payroll" },
  {
    id: "acct.accounting", term: "accounting", icon: "invoice",
    children: [
      { id: "acct.accounting.deferrals", term: "deferrals", href: "/dashboard/accounting/deferrals", reserved: true },
      { id: "acct.accounting.easy", term: "easyJournals", href: "/dashboard/accounting/journal-templates", reserved: true },
      { id: "acct.accounting.journals", term: "journals", href: "/dashboard/accounting/journals", create: { href: "/dashboard/accounting/journals/new", anyOf: [A("accounting", "journal_create")] } },
      { id: "acct.accounting.chart", term: "chart", href: "/dashboard/accounting/chart" },
      { id: "acct.accounting.budgets", term: "budgets", href: "/dashboard/accounting/budgets", reserved: true },
      { id: "acct.accounting.docs", term: "commercialDocs" },
      // «جودة المحاسبة» — reserved; today it opens the close checklist and reconciliation (the page redirects there).
      { id: "acct.accounting.quality", term: "quality", href: "/dashboard/accounting/quality" },
      { id: "acct.accounting.recurring", term: "recurring", href: "/dashboard/accounting/recurring", reserved: true, create: { href: "/dashboard/accounting/recurring/new", anyOf: [A("accounting", "recurring")] } },
    ],
  },
  {
    id: "acct.reports", term: "reports", icon: "chart",
    children: [
      { id: "acct.reports.all", term: "allReports", href: "/dashboard/accounting/reports" },
      { id: "acct.reports.log", term: "reportLog" },
    ],
  },
  {
    id: "acct.settings", term: "settings", icon: "settings",
    children: [
      { id: "acct.settings.general", term: "generalSettings", href: "/dashboard/settings" },
      { id: "acct.settings.years", term: "fiscalPeriods", href: "/dashboard/accounting/periods" },
      { id: "acct.settings.dimensions", term: "dimensions" },
      { id: "acct.settings.invoice", term: "invoiceDetails", href: "/dashboard/settings/invoicing" },
      { id: "acct.settings.einvoice", term: "einvoicing", href: "/dashboard/accounting/zatca" },
      { id: "acct.settings.currencies", term: "currencies" },
      { id: "acct.settings.taxes", term: "taxes", href: "/dashboard/accounting/tax" },
      { id: "acct.settings.payroll", term: "payrollSettings", href: "/dashboard/hr/settings" },
      { id: "acct.settings.users", term: "users", href: "/dashboard/employees" },
      { id: "acct.settings.terms", term: "paymentTerms" },
      { id: "acct.settings.fields", term: "customFields" },
      { id: "acct.settings.attachments", term: "attachments" },
      { id: "acct.settings.attributes", term: "productAttributes", href: "/dashboard/settings/products" },
    ],
  },
];

/** Every reserved route of the tree (for the unit test and the report). */
export const RESERVED_ROUTES: string[] = ACCOUNTANT_NAV.flatMap((g) => g.children ?? []).filter((i) => i.reserved && i.href).map((i) => i.href!);

// ── who gets the workspace ───────────────────────────────────────────────────────────────────────────────────────

/** The accountant workspace exists for this viewer: they hold the accounting module (owner decision). */
export function accountantEligible(v: Viewer): boolean {
  return hasModuleAccess(v.permissions, "accounting");
}

/**
 * What the workspace starts as when the viewer has never chosen: the accountant sidebar for an accounting holder,
 * EXCEPT the admin role, whose system-wide menu stays the default (they can switch with «واجهة المحاسب»).
 */
export function accountantDefault(v: Viewer): boolean {
  return accountantEligible(v) && v.role !== "admin";
}

export const WORKSPACE_KEY_PREFIX = "hiqbah.nav.workspace.";
/** The per-user storage key of the choice («full» | «accountant»). */
export const workspaceKey = (userId: string) => `${WORKSPACE_KEY_PREFIX}${userId}`;

/** The mode in force: the saved choice when there is one and the viewer is eligible, else the default. Never for a non-holder. */
export function accountantModeFor(v: Viewer, saved: string | null): boolean {
  if (!accountantEligible(v)) return false;
  if (saved === "full") return false;
  if (saved === "accountant") return true;
  return accountantDefault(v);
}

// ── the viewer's tree ────────────────────────────────────────────────────────────────────────────────────────────

const pathOf = (href: string) => href.split("?")[0];
const holds = (v: Viewer, a: Ability) => (a.sub ? hasModuleAccess(v.permissions, a.module) && hasSubPrivilege(v.permissions, a.module, a.sub) : hasModuleAccess(v.permissions, a.module));

/** Would the system menu offer this route to the viewer? (some node of the pruned, presented tree claims it, and the guard opens it) */
export function offeredByRegistry(v: Viewer, href: string, pruned: NavNode[] = presentTree(visibleNav(v))): boolean {
  const p = pathOf(href);
  return nodesForPath(p, pruned).length > 0 && routeAllowed(v, p);
}

export type ShownItem = {
  id: string; label: string; href: string | null;
  state: "link" | "soon";
  create: string | null;
  matches: string[];
};
export type ShownGroup = { id: string; label: string; icon: D21IconName; href: string | null; items: ShownItem[] };

/** Registry destinations by their exact href (a reserved page lands with its own registry entry). */
const REGISTERED = new Set<string>();
(function collect(ns: NavNode[]) { for (const n of ns) { if (n.href) REGISTERED.add(n.href); if (n.children) collect(n.children); } })(NAV);

/**
 * Is the item's route live? An existing page; or a reserved one whose page has landed — it has a registry entry of
 * its own at exactly that href (e.g. `finance.accountingBudgets`, feat/budgets-deferrals), or it is listed in
 * `./accountant-live` (a page that ships without a registry entry).
 */
export const isLive = (i: AcctItem) => !!i.href && (!i.reserved || REGISTERED.has(pathOf(i.href)) || LIVE_RESERVED.includes(pathOf(i.href)));

function itemFor(v: Viewer, i: AcctItem, lang: string, pruned: NavNode[]): ShownItem | null {
  const label = qoyodTerm(i.term, lang);
  if (!isLive(i)) return { id: i.id, label, href: null, state: "soon", create: null, matches: [] };
  if (!offeredByRegistry(v, i.href!, pruned)) return null;
  if (i.anyOf && i.anyOf.length > 0 && !i.anyOf.some((a) => holds(v, a))) return null;
  const c = i.create;
  const canCreate = !!c && offeredByRegistry(v, c.href, pruned)
    && ((c.anyOf ?? []).some((a) => holds(v, a)) || (!!c.editOf && canEdit(v.permissions, c.editOf)) || (!!c.can && c.can(v.permissions)));
  return { id: i.id, label, href: i.href!, state: "link", create: canCreate ? c!.href : null, matches: [i.href!, ...(i.alsoMatches ?? [])] };
}

/**
 * The accountant sidebar for this viewer: groups in Qoyod order; within each, the links the viewer may follow and
 * the «قريباً» items. A group whose every live item is refused AND that has no «قريباً» item is dropped; a group
 * holding only «قريباً» items stays (it is what the accountant expects to find there).
 */
export function accountantTree(v: Viewer, lang: string): ShownGroup[] {
  const pruned = presentTree(visibleNav(v));
  const out: ShownGroup[] = [];
  for (const g of ACCOUNTANT_NAV) {
    const label = qoyodTerm(g.term, lang);
    if (!g.children) {
      if (!g.href || !offeredByRegistry(v, g.href, pruned)) continue;
      out.push({ id: g.id, label, icon: g.icon, href: g.href, items: [] });
      continue;
    }
    const all = g.children.map((i) => ({ src: i, shown: itemFor(v, i, lang, pruned) })).filter((x): x is { src: AcctItem; shown: ShownItem } => !!x.shown);
    const live = all.filter((x) => x.shown.state === "link");
    // A section whose real pages are all refused to this viewer is dropped, «قريباً» items and all; a section that
    // has no page yet (the fixed assets) is drawn with its «قريباً» items — it is what the accountant expects there.
    if (all.length === 0 || (g.children.some(isLive) && live.length === 0)) continue;
    out.push({ id: g.id, label, icon: g.icon, href: null, items: all.map((x) => x.shown) });
  }
  return out;
}

/** Every link of the viewer's accountant tree (the parity script and the tests). */
export function accountantLinks(v: Viewer, lang = "ar"): string[] {
  return accountantTree(v, lang).flatMap((g) => [...(g.href ? [g.href] : []), ...g.items.flatMap((i) => [...(i.href ? [i.href] : []), ...(i.create ? [i.create] : [])])]);
}

/** «الإنشاء السريع»: every «+» of the viewer's tree, in tree order. */
export function quickCreates(v: Viewer, lang: string): { id: string; label: string; href: string }[] {
  return accountantTree(v, lang).flatMap((g) => g.items.filter((i) => i.create).map((i) => ({ id: i.id, label: i.label, href: i.create! })));
}

/**
 * The item the current address belongs to (the highlight and the top-bar trail). A candidate is an item's href or
 * one of its `alsoMatches` whose path the address is (or is under). A candidate that names a query (`?tab=claims`,
 * `?mode=expense`) the address does not carry is set aside; among the rest the longest path wins, then the one whose
 * query matches. Only when every candidate was set aside does the longest path win regardless of the query.
 */
export function activeAccountantItem(tree: ShownGroup[], pathname: string, search: string): { group: ShownGroup; item: ShownItem | null } | null {
  const q = new URLSearchParams(search);
  type Hit = { group: ShownGroup; item: ShownItem | null; len: number; score: number; fits: boolean };
  const hits: Hit[] = [];
  const consider = (group: ShownGroup, item: ShownItem | null, href: string) => {
    const [p, qs] = href.split("?");
    if (!(pathname === p || pathname.startsWith(p + "/"))) return;
    const want = [...new URLSearchParams(qs ?? "")];
    const fits = want.every(([k, v]) => q.get(k) === v);
    hits.push({ group, item, len: p.length, score: want.length, fits });
  };
  for (const g of tree) {
    if (g.href) consider(g, null, g.href);
    for (const i of g.items) for (const m of i.matches) consider(g, i, m);
  }
  const pool = hits.some((h) => h.fits) ? hits.filter((h) => h.fits) : hits;
  const best = pool.sort((a, b) => b.len - a.len || b.score - a.score)[0];
  return best ? { group: best.group, item: best.item } : null;
}

