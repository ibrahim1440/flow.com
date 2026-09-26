import type { ElementType } from "react";
import {
  LayoutDashboard, Package, ShoppingCart, Factory, ClipboardCheck, Box, Truck, History,
  TrendingUp, Tag, Users, Settings, FlaskConical, Users2, ShoppingBag, Wallet, PackageCheck,
  ClipboardList, UserPlus, KanbanSquare, Percent, CalendarCheck, FileText, Target, BarChart3,
  ScrollText, Briefcase, Landmark, Boxes,
} from "lucide-react";
import { hasModuleAccess, hasSubPrivilege, type Permissions } from "@/lib/auth-shared";

/**
 * THE NAVIGATION REGISTRY — one description of the menu, read by everything that draws it.
 *
 * ── Why this exists ──
 * The sidebar was a flat list of twenty-four leaves with no parent relationships, so there
 * was nothing for a second level to be derived FROM. That is the whole reason the
 * contextual navigation in the reference design was missing: it was never removed or
 * broken, there was simply no structure in the codebase that could express it. Every
 * consumer — sidebar, contextual bar, breadcrumbs, active-page resolution and the route
 * guard — now reads this one tree, so they cannot disagree about what exists, what it is
 * called, where it sits or who may see it.
 *
 * ── What this is NOT ──
 * Not an authorisation boundary. Every API re-checks the caller, and the dashboard route
 * guard below is a courtesy that stops somebody being shown a working-looking screen for
 * work they cannot do. Hiding an entry hides a door; it does not lock one.
 * See https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html —
 * authorisation is enforced server-side, per request, every time.
 */

/** A single permission requirement. `sub` omitted means "any access to the module". */
export type Ability = { module: string; sub?: string };

export type NavNode = {
  /** Stable across renames and re-orderings. Used by tests and by active resolution. */
  id: string;
  ar: string;
  en: string;
  icon?: ElementType;
  /** Where it goes. A group has none; its landing is its first permitted descendant. */
  href?: string;
  /**
   * Extra path prefixes that belong to this destination — detail pages with no nav entry
   * of their own. Without these a deal page highlights nothing and shows no breadcrumb.
   */
  alsoMatches?: string[];
  /** Visible when the caller holds ANY of these. Empty or absent means "always". */
  anyOf?: Ability[];
  /**
   * ALSO required, all of them, for the node to appear AT THIS POSITION in the tree.
   *
   * The commission screens are the reason. They belong to Sales for a sales manager and to
   * Finance for a finance user, and Finance deliberately holds no sales module. Without
   * this, Finance would see a Sales group containing nothing but commission links — the
   * same destinations their own Finance group already offers. This scopes a placement
   * without touching who may reach the page.
   */
  requiresAll?: Ability[];
  /**
   * Hides this PLACEMENT from anyone holding any of these — the mirror of `requiresAll`.
   *
   * Orders is the reason. It is a sales order to a salesperson and the thing being prepared
   * to operations, and both need it. Listing it only under Sales showed a dispatch operator
   * a "Sales" group containing one link; listing it in both showed a salesperson the same
   * destination twice. So each placement excludes the other's audience and the result is
   * deterministic: whoever holds the sales module meets it under Sales, everybody else
   * meets it under Operations, and nobody meets it twice.
   */
  unlessAny?: Ability[];
  /** Admin-only double guard, kept from the previous sidebar for the settings screen. */
  adminOnly?: boolean;
  children?: NavNode[];
};

const sales = (sub?: string): Ability => ({ module: "sales", ...(sub ? { sub } : {}) });
const commissions = (sub?: string): Ability => ({ module: "commissions", ...(sub ? { sub } : {}) });
const IN_SALES: Ability[] = [sales()];

/**
 * ── Three levels ──
 *   1. a module in the sidebar
 *   2. subunits beneath it, disclosed on demand
 *   3. the subunit's pages, as contextual navigation inside the page
 *
 * A subunit with a single destination carries an `href` and no children: there is nothing
 * for a contextual bar to offer, and a tab strip with one tab is noise.
 */
export const NAV: NavNode[] = [
  { id: "dashboard", ar: "لوحة التحكم", en: "Dashboard", icon: LayoutDashboard, href: "/dashboard" },

  {
    id: "sales",
    ar: "المبيعات",
    en: "Sales",
    icon: Briefcase,
    children: [
      {
        id: "sales.customers",
        ar: "إدارة العملاء",
        en: "Customer management",
        icon: UserPlus,
        children: [
          {
            id: "sales.customers.leads",
            ar: "العملاء المحتملون", en: "Leads",
            href: "/dashboard/sales/leads",
            anyOf: IN_SALES,
          },
          {
            id: "sales.customers.accounts",
            ar: "العملاء", en: "Customers",
            href: "/dashboard/customers",
            anyOf: [{ module: "customers" }],
            // The CRM framing. The plain top-level entry near the bottom of this file is
            // the same screen for somebody who has no Sales CRM; the two never coexist.
            requiresAll: IN_SALES,
          },
        ],
      },
      {
        id: "sales.pipeline",
        ar: "الفرص والمتابعات",
        en: "Opportunities and follow-ups",
        icon: KanbanSquare,
        children: [
          {
            id: "sales.pipeline.board",
            ar: "مسار الصفقات", en: "Pipeline",
            href: "/dashboard/sales/pipeline",
            // A deal has no nav entry of its own and belongs to the board it came from.
            alsoMatches: ["/dashboard/sales/deals"],
            anyOf: IN_SALES,
          },
          {
            id: "sales.pipeline.activities",
            ar: "الأنشطة والمتابعات", en: "Activities and follow-ups",
            href: "/dashboard/sales/activities",
            anyOf: IN_SALES,
          },
        ],
      },
      {
        id: "sales.quotes",
        ar: "عروض الأسعار والطلبات",
        en: "Quotations and orders",
        icon: FileText,
        children: [
          {
            id: "sales.quotes.list",
            ar: "عروض الأسعار", en: "Quotations",
            href: "/dashboard/sales/quotes",
            anyOf: IN_SALES,
          },
          {
            // The same order operations prepares. One record, two contexts — the sales list
            // and the preparation workstation — and deliberately not a second system.
            id: "sales.quotes.orders",
            ar: "طلبات البيع", en: "Sales orders",
            href: "/dashboard/orders",
            anyOf: [{ module: "orders" }],
            requiresAll: IN_SALES,
          },
        ],
      },
      {
        id: "sales.collections",
        ar: "التحصيلات",
        en: "Collections",
        icon: Wallet,
        href: "/dashboard/sales/collections",
        // Any sales user, exactly as before: the screen itself shows a rep their own
        // history and says plainly when they may not record one.
        anyOf: IN_SALES,
      },
      {
        id: "sales.performance",
        ar: "الأداء والعمولات",
        en: "Performance and commissions",
        icon: BarChart3,
        children: [
          {
            id: "sales.performance.targets",
            ar: "الأهداف", en: "Targets",
            href: "/dashboard/sales/targets",
            anyOf: IN_SALES,
          },
          {
            id: "sales.performance.reports",
            ar: "تقارير المبيعات", en: "Sales reports",
            href: "/dashboard/sales/reports",
            anyOf: IN_SALES,
          },
          {
            id: "sales.performance.mine",
            ar: "عمولاتي", en: "My commissions",
            href: "/dashboard/sales/my-commissions",
            anyOf: [commissions()],
            requiresAll: IN_SALES,
          },
          {
            id: "sales.performance.review",
            ar: "مراجعة العمولات", en: "Commission review",
            href: "/dashboard/commissions/review",
            anyOf: [commissions("view_team")],
            requiresAll: IN_SALES,
          },
          {
            id: "sales.performance.plans",
            ar: "خطط العمولات", en: "Commission plans",
            href: "/dashboard/commissions/plans",
            anyOf: [commissions("manage_plans")],
            requiresAll: IN_SALES,
          },
        ],
      },
      {
        id: "sales.settings",
        ar: "إعدادات المبيعات",
        en: "Sales settings",
        icon: Settings,
        href: "/dashboard/sales/settings",
        anyOf: [sales("stage_manage")],
      },
    ],
  },

  {
    // Finance holds no sales module on purpose — they must not read the pipeline — so this
    // is how they reach the work that is theirs. Same routes, same records, same services.
    id: "finance",
    ar: "المالية",
    en: "Finance",
    icon: Landmark,
    // The group itself, not just its contents. A sales manager holds `view_team` and none
    // of these, so they meet the commission screens under Sales and never see a Finance
    // heading; Finance meets them here and never sees a Sales one.
    anyOf: [
      commissions("approve"),
      commissions("record_payout"),
      commissions("collection_verify"),
      commissions("collection_reject"),
      commissions("collection_reverse"),
    ],
    children: [
      {
        id: "finance.collections",
        ar: "التحصيلات", en: "Collections",
        href: "/dashboard/sales/collections",
        anyOf: [
          commissions("collection_verify"),
          commissions("collection_reject"),
          commissions("collection_reverse"),
        ],
      },
      {
        id: "finance.commissions",
        ar: "مراجعة العمولات", en: "Commission review",
        href: "/dashboard/commissions/review",
        // The finance half of commission work — approving a period and paying it out. A
        // sales manager holds `view_team` and neither of these, so they see this under
        // Sales and never see a Finance group at all.
        anyOf: [commissions("approve"), commissions("record_payout")],
      },
      {
        // Their own earnings. Reachable before the restructuring through the flat sidebar,
        // so it stays reachable — the group gate above is what keeps it from leaking to
        // people who are not Finance.
        id: "finance.mine",
        ar: "عمولاتي", en: "My commissions",
        href: "/dashboard/sales/my-commissions",
        anyOf: [commissions()],
      },
      {
        id: "finance.accounting",
        ar: "المحاسبة", en: "Accounting",
        href: "/dashboard/accounting",
        anyOf: [{ module: "accounting" }],
      },
    ],
  },

  {
    id: "operations",
    ar: "العمليات",
    en: "Operations",
    icon: PackageCheck,
    children: [
      {
        // Fulfilment, not Sales. The route and its permissions are untouched; only where
        // it is listed has changed.
        // The same route and the same permission as the Sales placement above — one
        // destination, framed for whoever is looking at it. `unlessAny` keeps the two from
        // ever both appearing.
        id: "operations.orders",
        ar: "الطلبات", en: "Orders",
        href: "/dashboard/orders",
        anyOf: [{ module: "orders" }],
        unlessAny: [sales()],
      },
      {
        id: "operations.preparation",
        ar: "تجهيز الطلبات", en: "Order preparation",
        href: "/dashboard/workstation/preparation",
        anyOf: [{ module: "orders" }],
      },
      {
        id: "operations.production",
        ar: "الإنتاج", en: "Production",
        href: "/dashboard/production",
        anyOf: [{ module: "production" }],
      },
      {
        id: "operations.productionOrders",
        ar: "أوامر الإنتاج", en: "Production orders",
        href: "/dashboard/production-orders",
        anyOf: [{ module: "production" }],
      },
      {
        id: "operations.packaging",
        ar: "التعبئة", en: "Packaging",
        href: "/dashboard/packaging",
        anyOf: [{ module: "packaging" }],
      },
      {
        id: "operations.dispatch",
        ar: "التسليم", en: "Dispatch",
        href: "/dashboard/dispatch",
        anyOf: [{ module: "dispatch" }],
      },
      {
        id: "operations.qc",
        ar: "الجودة", en: "Quality control",
        href: "/dashboard/qc",
        anyOf: [{ module: "qc" }],
      },
      {
        id: "operations.cupping",
        ar: "التذوق", en: "Cupping",
        href: "/dashboard/cupping",
        anyOf: [{ module: "cupping" }],
      },
    ],
  },

  {
    id: "stock",
    ar: "المخزون والمنتجات",
    en: "Inventory and products",
    icon: Boxes,
    children: [
      {
        id: "stock.inventory",
        ar: "المخزون", en: "Inventory",
        href: "/dashboard/inventory",
        anyOf: [{ module: "inventory" }],
      },
      {
        id: "stock.purchases",
        ar: "المشتريات", en: "Purchases",
        href: "/dashboard/purchases",
        anyOf: [{ module: "inventory" }],
      },
      {
        id: "stock.products",
        ar: "المنتجات", en: "Products",
        href: "/dashboard/products",
        anyOf: [{ module: "inventory" }],
      },
      {
        id: "stock.labels",
        ar: "الملصقات", en: "Labels",
        href: "/dashboard/labels",
        anyOf: [{ module: "labels" }],
      },
    ],
  },

  {
    id: "insights",
    ar: "التقارير والسجل",
    en: "Reports and history",
    icon: TrendingUp,
    children: [
      {
        id: "insights.analytics",
        ar: "التحليلات", en: "Analytics",
        href: "/dashboard/analytics",
        anyOf: [{ module: "analytics" }],
      },
      {
        id: "insights.history",
        ar: "السجل", en: "History",
        href: "/dashboard/history",
        anyOf: [{ module: "history" }],
      },
    ],
  },

  {
    // Where the customer list lives for somebody without the Sales CRM — the legacy
    // order-taking role holds `customers` and no `sales`. It was a top-level entry before
    // the restructuring and stays one for them, rather than becoming a Sales group of one.
    id: "customers",
    ar: "العملاء", en: "Customers",
    icon: Users2,
    href: "/dashboard/customers",
    anyOf: [{ module: "customers" }],
    unlessAny: [sales()],
  },
  {
    id: "employees",
    ar: "الموظفون", en: "Employees",
    icon: Users,
    href: "/dashboard/employees",
    anyOf: [{ module: "employees" }],
  },
  {
    id: "settings",
    ar: "الإعدادات", en: "Settings",
    icon: Settings,
    href: "/dashboard/settings",
    anyOf: [{ module: "settings" }],
    adminOnly: true,
  },
];

// Icons imported for the tree above but not otherwise referenced keep the import list
// honest about what the registry can draw.
void [Package, ShoppingCart, Factory, ClipboardCheck, Box, Truck, History, Tag, Users2,
  ShoppingBag, ClipboardList, Percent, CalendarCheck, Target, ScrollText, FlaskConical];

export type Viewer = { permissions: Permissions; role: string };

function holds(v: Viewer, a: Ability): boolean {
  return a.sub
    ? hasSubPrivilege(v.permissions, a.module, a.sub)
    : hasModuleAccess(v.permissions, a.module);
}

/** Whether this node itself is permitted, ignoring its children. */
export function nodePermitted(v: Viewer, n: NavNode): boolean {
  if (n.adminOnly && v.role !== "admin") return false;
  if (n.requiresAll && !n.requiresAll.every((a) => holds(v, a))) return false;
  if (n.unlessAny && n.unlessAny.some((a) => holds(v, a))) return false;
  if (!n.anyOf || n.anyOf.length === 0) return true;
  return n.anyOf.some((a) => holds(v, a));
}

/**
 * The tree this viewer may see, pruned.
 *
 * A branch survives only if it still leads somewhere: a group whose every destination is
 * refused is removed entirely rather than left as a heading that opens onto nothing.
 */
export function visibleNav(v: Viewer, tree: NavNode[] = NAV): NavNode[] {
  const out: NavNode[] = [];
  for (const n of tree) {
    if (!nodePermitted(v, n)) continue;
    if (!n.children) { out.push(n); continue; }
    const children = visibleNav(v, n.children);
    if (children.length === 0) continue;
    out.push({ ...n, children });
  }
  return out;
}

/** Every node in the tree, depth-first, with its ancestors. */
function walk(tree: NavNode[], trail: NavNode[] = []): { node: NavNode; trail: NavNode[] }[] {
  const out: { node: NavNode; trail: NavNode[] }[] = [];
  for (const n of tree) {
    out.push({ node: n, trail });
    if (n.children) out.push(...walk(n.children, [...trail, n]));
  }
  return out;
}

const matchesPath = (n: NavNode, pathname: string): boolean => {
  const candidates = [n.href, ...(n.alsoMatches ?? [])].filter(Boolean) as string[];
  return candidates.some((h) => pathname === h || pathname.startsWith(h + "/"));
};

export type ActiveTrail = { group?: NavNode; subunit?: NavNode; leaf?: NavNode };

/**
 * Which entry the current URL belongs to.
 *
 * Longest match wins, so `/dashboard/sales/quotes/new` resolves to the quotations list and
 * not to `/dashboard`, and a detail route resolves through `alsoMatches` to the list it
 * came from rather than highlighting nothing.
 */
export function resolveActive(pathname: string, tree: NavNode[] = NAV): ActiveTrail {
  const hits = walk(tree)
    .filter(({ node }) => node.href && matchesPath(node, pathname))
    .sort((a, b) => {
      const len = (x: NavNode) =>
        Math.max(...[x.href, ...(x.alsoMatches ?? [])].filter(Boolean).map((h) => (h as string).length));
      return len(b.node) - len(a.node);
    });
  const hit = hits[0];
  if (!hit) return {};
  const [group, subunit] = hit.trail;
  // A destination hung directly off a group is its own subunit — Collections, Settings.
  return { group, subunit: subunit ?? (group ? hit.node : undefined), leaf: hit.node };
}

/**
 * Where a group or subunit should open.
 *
 * Its first PERMITTED destination, never a fixed default: sending somebody to a page they
 * cannot open is how a menu becomes a trap.
 */
export function firstDestination(v: Viewer, n: NavNode): string | null {
  if (!nodePermitted(v, n)) return null;
  if (n.href) return n.href;
  for (const c of n.children ?? []) {
    const found = firstDestination(v, c);
    if (found) return found;
  }
  return null;
}

/**
 * Every node that claims this path. A route can be claimed twice on purpose: the
 * collections queue is Sales work for the person recording one and Finance work for the
 * person deciding it, and it is deliberately ONE screen reading ONE set of records.
 */
export function nodesForPath(pathname: string, tree: NavNode[] = NAV): NavNode[] {
  const all = walk(tree).map((h) => h.node).filter((n) => n.href && matchesPath(n, pathname));
  if (all.length === 0) return [];
  const len = (x: NavNode) =>
    Math.max(...[x.href, ...(x.alsoMatches ?? [])].filter(Boolean).map((h) => (h as string).length));
  const longest = Math.max(...all.map(len));
  return all.filter((n) => len(n) === longest);
}

/**
 * May this viewer open this path?
 *
 * ── Why this is module-level, and deliberately looser than the menu ──
 * This is not the authorisation boundary; the API is, on every request. Its job is to stop
 * somebody being shown a working-looking screen for work they cannot do. The previous
 * guard checked only the MODULE of a route and left sub-privileges to the page and its
 * API — so a sales user without `stage_manage` could still open the settings screen and
 * meet its own refusals. Tightening that here would change who can open several existing
 * pages, which is not what a navigation restructuring is for. Same rule, read from the
 * registry instead of from a flat array.
 *
 * A route claimed by more than one node passes if ANY of them admits the viewer: Finance
 * reaches the collections queue through the Finance placement even though the Sales
 * placement refuses them.
 */
export function routeAllowed(v: Viewer, pathname: string): boolean {
  const claims = nodesForPath(pathname);
  if (claims.length === 0) return true;
  return claims.some((n) => {
    if (n.adminOnly && v.role !== "admin") return false;
    if (!n.anyOf || n.anyOf.length === 0) return true;
    return n.anyOf.some((a) => hasModuleAccess(v.permissions, a.module));
  });
}

/**
 * The breadcrumb for a path: module › subunit › page, skipping repeats.
 *
 * A subunit that IS the destination — Collections — would otherwise read
 * "Sales › Collections › Collections".
 */
export function breadcrumb(pathname: string, tree: NavNode[] = NAV): NavNode[] {
  const { group, subunit, leaf } = resolveActive(pathname, tree);
  const trail = [group, subunit, leaf].filter(Boolean) as NavNode[];
  return trail.filter((n, i) => i === 0 || n.id !== trail[i - 1].id);
}
