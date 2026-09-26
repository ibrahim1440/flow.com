import type { ElementType } from "react";
import {
  LayoutDashboard, Factory, ClipboardCheck, Box, Truck, History, TrendingUp, Tag, Users,
  Settings, FlaskConical, Users2, ShoppingBag, ClipboardList, Briefcase, Landmark, Boxes,
  PackageCheck, Package, ShoppingCart,
} from "lucide-react";
import { hasModuleAccess, hasSubPrivilege, type Permissions } from "@/lib/auth-shared";

/**
 * THE NAVIGATION REGISTRY — one description of the menu, read by everything that draws it.
 *
 * ── Why this exists ──
 * The sidebar was a flat list of nineteen leaves with no parent relationships, so there
 * was nothing for a second level to be derived FROM. That is the whole reason the
 * contextual navigation in the reference design was missing: it was never removed or
 * broken, there was simply no structure in the codebase that could express it. Every
 * consumer — sidebar, contextual bar, breadcrumbs, active-page resolution and the route
 * guard — now reads this one tree, so they cannot disagree about what exists, what it is
 * called, where it sits or who may see it.
 *
 * ── Provenance ──
 * The shape of this tree, and the resolution and pruning functions below it, come from
 * the navigation work on `feature/sales-crm-commissions`. That branch carries 63 commits
 * of Sales CRM and commissions business logic — 157 files, three Prisma migrations and
 * 874 lines of schema — none of which belongs in a UI alignment. Only the navigation
 * architecture was taken. Its Sales and Finance subtrees named twelve routes that do not
 * exist here, so those were dropped rather than carried across as dead links; the
 * Operations, Inventory, Reports, Employees and Settings branches are reproduced as they
 * were written there, because every route they name exists on this branch.
 *
 * ── What this is NOT ──
 * Not an authorisation boundary. Every API re-checks the caller, and the dashboard route
 * guard below is a courtesy that stops somebody being shown a working-looking screen for
 * work they cannot do. Hiding an entry hides a door; it does not lock one.
 * See https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html —
 * authorisation is enforced server-side, per request, every time.
 *
 * ── Module keys ──
 * Every `module` named here already exists in employee permission records. A key nobody
 * has been granted hides the entry from everyone, administrators included, because
 * `hasModuleAccess` reads the stored permissions object and finds nothing — so a new
 * module key is a lockout, not a feature flag.
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
   * Extra path prefixes that belong to this destination — detail pages that do not sit
   * under the destination's own path. Routes nested beneath `href` already resolve to it
   * and need no entry here.
   */
  alsoMatches?: string[];
  /** Visible when the caller holds ANY of these. Empty or absent means "always". */
  anyOf?: Ability[];
  /** ALSO required, all of them, for the node to appear AT THIS POSITION in the tree. */
  requiresAll?: Ability[];
  /** Admin-only double guard, kept from the previous sidebar for the settings screen. */
  adminOnly?: boolean;
  children?: NavNode[];
};

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
        // Order MANAGEMENT — who ordered, what, how much, what state is it in. The
        // fulfilment side of the same order lives under Operations, deliberately: they
        // are related jobs done by different people answering different questions.
        id: "sales.orders",
        ar: "الطلبات", en: "Orders",
        icon: ShoppingCart,
        href: "/dashboard/orders",
        anyOf: [{ module: "orders" }],
      },
      {
        id: "sales.customers",
        ar: "العملاء", en: "Customers",
        icon: Users2,
        href: "/dashboard/customers",
        anyOf: [{ module: "customers" }],
      },
    ],
  },

  {
    id: "finance",
    ar: "المالية",
    en: "Finance",
    icon: Landmark,
    children: [
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
        id: "operations.preparation",
        ar: "تجهيز الطلبات", en: "Order Preparation",
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
        ar: "أوامر الإنتاج", en: "Production Orders",
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
        ar: "الجودة", en: "Quality Control",
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
    en: "Inventory and Products",
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
    en: "Reports and History",
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
    id: "employees",
    ar: "الموظفون", en: "Employees",
    icon: Users,
    href: "/dashboard/employees",
    anyOf: [{ module: "employees" }],
  },
  {
    id: "settings",
    ar: "الإعدادات", en: "System Settings",
    icon: Settings,
    href: "/dashboard/settings",
    anyOf: [{ module: "settings" }],
    adminOnly: true,
  },
];

// Icons imported for the tree above but not otherwise referenced keep the import list
// honest about what the registry can draw.
void [Factory, ClipboardCheck, Box, Truck, History, Tag, ShoppingBag, ClipboardList,
  FlaskConical, Package];

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

const matchLength = (x: NavNode): number =>
  Math.max(...[x.href, ...(x.alsoMatches ?? [])].filter(Boolean).map((h) => (h as string).length));

export type ActiveTrail = { group?: NavNode; subunit?: NavNode; leaf?: NavNode };

/**
 * Which entry the current URL belongs to.
 *
 * Longest match wins, so `/dashboard/production-orders` resolves to production orders and
 * not to `/dashboard`, and a detail route resolves to the list it came from rather than
 * highlighting nothing. Longest-match is also what stops `/dashboard/production` lighting
 * up while the operator is on `/dashboard/production-orders`.
 */
export function resolveActive(pathname: string, tree: NavNode[] = NAV): ActiveTrail {
  const hits = walk(tree)
    .filter(({ node }) => node.href && matchesPath(node, pathname))
    .sort((a, b) => matchLength(b.node) - matchLength(a.node));
  const hit = hits[0];
  if (!hit) return {};
  const [group, subunit] = hit.trail;
  // A destination hung directly off a group is its own subunit.
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

/** Every node that claims this path, keeping only the longest (most specific) matches. */
export function nodesForPath(pathname: string, tree: NavNode[] = NAV): NavNode[] {
  const all = walk(tree).map((h) => h.node).filter((n) => n.href && matchesPath(n, pathname));
  if (all.length === 0) return [];
  const longest = Math.max(...all.map(matchLength));
  return all.filter((n) => matchLength(n) === longest);
}

/**
 * May this viewer open this path?
 *
 * ── Why this is module-level, and deliberately looser than the menu ──
 * This is not the authorisation boundary; the API is, on every request. Its job is to stop
 * somebody being shown a working-looking screen for work they cannot do — typing the
 * address, following an old bookmark or using browser history all reached the page before
 * this existed, which then rendered its full chrome and an empty list because the APIs
 * behind it were refusing every call. The data was never exposed and no write was ever
 * accepted, but the operator was shown a working-looking screen for work they cannot do.
 *
 * It checks the MODULE of a route and leaves sub-privileges to the page and its API, which
 * is exactly what the previous flat guard did. Tightening that here would change who can
 * open several existing pages, and a navigation restructuring is not the place to do it.
 *
 * A route claimed by more than one node passes if ANY of them admits the viewer.
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
 * The trail to show above the page: Module › Subunit › Page.
 *
 * Consecutive duplicates are collapsed, so a destination hung directly off its group does
 * not render as "Finance › Accounting › Accounting".
 */
export function breadcrumb(pathname: string, tree: NavNode[] = NAV): NavNode[] {
  const { group, subunit, leaf } = resolveActive(pathname, tree);
  const trail = [group, subunit, leaf].filter(Boolean) as NavNode[];
  return trail.filter((n, i) => i === 0 || n.id !== trail[i - 1].id);
}
