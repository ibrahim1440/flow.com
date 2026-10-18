import type { ElementType } from "react";
import {
  LayoutDashboard, Package, ShoppingCart, Factory, ClipboardCheck, Box, Truck, History,
  TrendingUp, Tag, Users, Settings, FlaskConical, Users2, ShoppingBag, Wallet, PackageCheck,
  ClipboardList, UserPlus, KanbanSquare, Percent, CalendarCheck, FileText, Target, BarChart3,
  ScrollText, Briefcase, Landmark, Boxes, Workflow, Zap, MessageSquareText, QrCode,
  Contact, UserRound, CalendarDays, Banknote, Laptop,
  Flame, ListChecks, Coffee,
} from "lucide-react";
import { hasModuleAccess, hasSubPrivilege, type Permissions } from "@/lib/auth-shared";
import type { D21IconName } from "@/components/shell/icons";

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
  /**
   * The sidebar entry to HIGHLIGHT on this destination's pages, when it is not this node
   * (G-11, owner-approved interim): Preparation and Dispatch highlight «الطلبات» while the
   * breadcrumb still names the real page. The first id the viewer's tree contains wins; if it
   * contains none, the node highlights itself, as every node without this field does.
   */
  highlightAs?: string[];
  children?: NavNode[];
  /**
   * How the Direction 2.1 shell PRESENTS this node — never what it is or who may see it.
   *
   * The approved frames (`erp/docs/design/direction-2.1-rc`, CRM.md D5) name and group the
   * sidebar differently from the registry's own labels: «التشغيل» holds orders, production
   * and stock together, «العملاء» stands for customer management, «الصفقات» for the pipeline.
   * The legacy shell ignores every field here, so nothing outside a Direction 2.1 route moves.
   */
  shell?: ShellHints;
};

export type ShellHints = {
  /** The approved sidebar wording, when the frame names the entry differently. */
  ar?: string;
  en?: string;
  /** The reference icon (screens.py ICONS); lucide stays the fallback (register row A-18). */
  icon?: D21IconName;
  /** List under this group instead of under its own module (a module id or a SHELL_GROUPS key). */
  group?: string;
  /** Reached from the user block's gear menu, not from the sidebar. */
  place?: "menu";
  /** The top-bar trail starts with the group it is listed under («التشغيل / لوحة التشغيل», 101:6411). */
  trailGroup?: boolean;
  /**
   * Shown — and resolved — as that registry node instead (see `presentTree`). The approved
   * frames put «الطلبات» under «التشغيل» for every persona (orders-1440, crumb «التشغيل /
   * الطلبات»), while the registry keeps orders under Sales for a seller in the legacy shell.
   */
  as?: string;
};

/** Groups the approved sidebar draws that are not modules of their own. */
export const SHELL_GROUPS: Record<string, { ar: string; en: string }> = {
  team: { ar: "الفريق", en: "Team" },
};

/** The approved order of the sidebar groups; a group not listed follows, in registry order. */
export const SHELL_GROUP_ORDER = ["operations", "sales", "finance", "team", "hr", "insights", "automation"];

const sales = (sub?: string): Ability => ({ module: "sales", ...(sub ? { sub } : {}) });
const commissions = (sub?: string): Ability => ({ module: "commissions", ...(sub ? { sub } : {}) });
const IN_SALES: Ability[] = [sales()];
const hr = (sub?: string): Ability => ({ module: "hr", ...(sub ? { sub } : {}) });

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
  // Figma is the source of truth (owner): the approved sidebar lists the dashboard as «لوحة التشغيل»
  // / "Operations dashboard" first in «التشغيل», and the top bar reads «التشغيل / لوحة التشغيل»
  // (20:236: sidebar I20:585;249:368, top bar 101:6411; EN shells e.g. I1560:158819).
  { id: "dashboard", ar: "لوحة التحكم", en: "Dashboard", icon: LayoutDashboard, href: "/dashboard", shell: { ar: "لوحة التشغيل", en: "Operations dashboard", icon: "pulse", group: "operations", trailGroup: true } },

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
        shell: { ar: "العملاء", en: "Customers", icon: "users" },
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
        shell: { ar: "الصفقات", en: "Deals", icon: "deal" },
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
        shell: { ar: "عروض الأسعار", en: "Quotations", icon: "quote" },
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
            // Direction 2.1: «الطلبات» in «التشغيل», as for everyone else (parity N-02).
            shell: { as: "operations.orders" },
          },
        ],
      },
      {
        id: "sales.collections",
        ar: "التحصيلات",
        en: "Collections",
        icon: Wallet,
        shell: { icon: "wallet" },
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
        shell: { icon: "chart" },
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
        shell: { place: "menu", icon: "settings" },
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
      // Cash & budget and Accounting holders reach their screens through this group too;
      // without these an accounting-only or finance-only user would lose the whole group.
      { module: "finance" },
      { module: "accounting" },
    ],
    children: [
      {
        // Cash management, receipt allocation and the monthly cash budget. Its six areas are
        // tabs inside the page.
        id: "finance.cash",
        ar: "النقد والميزانية", en: "Cash & budget",
        href: "/dashboard/finance",
        anyOf: [{ module: "finance" }],
        shell: { icon: "wallet" },
      },
      {
        id: "finance.collections",
        ar: "التحصيلات", en: "Collections",
        href: "/dashboard/sales/collections",
        shell: { ar: "الفواتير والتحصيل", en: "Invoices & collections", icon: "invoice" },
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
        shell: { icon: "chart" },
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
        shell: { icon: "chart" },
      },
      {
        id: "finance.accounting",
        ar: "المحاسبة", en: "Accounting",
        href: "/dashboard/accounting",
        anyOf: [{ module: "accounting" }],
        shell: { icon: "invoice" },
      },
    ],
  },

  {
    id: "operations",
    ar: "العمليات",
    en: "Operations",
    icon: PackageCheck,
    shell: { ar: "التشغيل", en: "Operations" },
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
        icon: ClipboardList,
        anyOf: [{ module: "orders" }],
        unlessAny: [sales()],
        shell: { icon: "orders" },
      },
      {
        id: "operations.preparation",
        ar: "تجهيز الطلبات", en: "Order preparation",
        href: "/dashboard/workstation/preparation",
        icon: PackageCheck,
        anyOf: [{ module: "orders" }],
        shell: { icon: "orders" },
        // G-11: Operations' «الطلبات» is highlighted here. A seller meets orders under Sales
        // instead, has no such entry, and keeps the page's own highlight.
        highlightAs: ["operations.orders"],
      },
      {
        id: "operations.production",
        ar: "الإنتاج", en: "Production & roasting",
        href: "/dashboard/production",
        icon: Flame,
        anyOf: [{ module: "production" }],
        shell: { ar: "الإنتاج والتحميص", en: "Production & roasting", icon: "flame" },
      },
      {
        id: "operations.productionOrders",
        ar: "أوامر الإنتاج", en: "Production orders",
        href: "/dashboard/production-orders",
        icon: ListChecks,
        anyOf: [{ module: "production" }],
        shell: { icon: "flame" },
      },
      {
        id: "operations.packaging",
        ar: "التعبئة", en: "Packaging",
        href: "/dashboard/packaging",
        icon: Package,
        anyOf: [{ module: "packaging" }],
        shell: { icon: "box" },
      },
      {
        id: "operations.dispatch",
        ar: "التسليم", en: "Dispatch",
        href: "/dashboard/dispatch",
        icon: Truck,
        anyOf: [{ module: "dispatch" }],
        shell: { icon: "truck" },
        highlightAs: ["operations.orders"],
      },
      {
        id: "operations.qc",
        ar: "الجودة", en: "Quality & cupping",
        href: "/dashboard/qc",
        icon: FlaskConical,
        anyOf: [{ module: "qc" }],
        shell: { ar: "الجودة والتذوق", en: "Quality & cupping", icon: "flask" },
      },
      {
        id: "operations.cupping",
        ar: "التذوق", en: "Cupping",
        href: "/dashboard/cupping",
        icon: Coffee,
        anyOf: [{ module: "cupping" }],
        shell: { icon: "flask" },
      },
    ],
  },

  {
    id: "stock",
    ar: "المخزون والمنتجات",
    en: "Inventory and products",
    icon: Boxes,
    // The approved sidebar lists stock under «التشغيل», after the production entries.
    shell: { group: "operations" },
    children: [
      {
        id: "stock.inventory",
        ar: "المخزون", en: "Inventory",
        href: "/dashboard/inventory",
        anyOf: [{ module: "inventory" }],
        shell: { icon: "box" },
      },
      {
        id: "stock.purchases",
        ar: "المشتريات", en: "Purchases",
        href: "/dashboard/purchases",
        anyOf: [{ module: "inventory" }],
        shell: { icon: "truck" },
      },
      {
        id: "stock.products",
        ar: "المنتجات", en: "Products",
        href: "/dashboard/products",
        anyOf: [{ module: "inventory" }],
        shell: { icon: "cup" },
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
        shell: { icon: "chart" },
      },
      {
        id: "insights.history",
        ar: "السجل", en: "History",
        href: "/dashboard/history",
        anyOf: [{ module: "history" }],
        shell: { icon: "note" },
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
    // The approved sidebar's «العملاء» entry, in «المبيعات», for somebody without the CRM.
    shell: { group: "sales", icon: "users" },
  },
  {
    // WhatsApp messages sent by rules on ERP events. Its own module, because who may decide
    // what customers are sent is not a sales, orders or settings question alone.
    id: "automation",
    ar: "الأتمتة", en: "Automation",
    icon: Workflow,
    children: [
      {
        id: "automation.rules",
        ar: "قواعد الأتمتة", en: "Automation rules",
        icon: Zap,
        href: "/dashboard/automation",
        alsoMatches: ["/dashboard/automation/rules"],
        anyOf: [{ module: "automation" }],
      },
      {
        id: "automation.messages",
        ar: "سجل الرسائل", en: "Message log",
        icon: MessageSquareText,
        href: "/dashboard/automation/messages",
        anyOf: [{ module: "automation" }],
      },
      {
        id: "automation.whatsapp",
        ar: "ربط الواتساب", en: "WhatsApp connection",
        icon: QrCode,
        href: "/dashboard/automation/whatsapp",
        anyOf: [{ module: "automation" }],
      },
    ],
  },
  {
    // Native HR. Its subunits carry icons for the Direction 2.1 rail; every page and API
    // re-checks its own duty server-side.
    id: "hr",
    ar: "الموارد البشرية", en: "Human resources",
    icon: Contact,
    anyOf: [hr()],
    children: [
      {
        id: "hr.people",
        ar: "الموظفون", en: "People",
        icon: Users,
        // No alsoMatches: /dashboard/hr already prefixes the profile pages, and a longer
        // alias would out-rank the payroll and leave pages in active resolution.
        href: "/dashboard/hr",
        anyOf: [hr("directory")],
      },
      {
        id: "hr.time",
        ar: "الوقت والإجازات", en: "Time & leave",
        icon: CalendarDays,
        anyOf: [hr("leave_manage"), hr("leave_approve"), hr("attendance_manage"), hr("attendance_approve")],
        children: [
          { id: "hr.leave", ar: "الإجازات", en: "Leave", href: "/dashboard/hr/leave", anyOf: [hr("leave_manage"), hr("leave_approve")] },
          { id: "hr.attendance", ar: "الحضور", en: "Attendance", href: "/dashboard/hr/attendance", anyOf: [hr("attendance_manage"), hr("attendance_approve")] },
        ],
      },
      {
        id: "hr.pay",
        ar: "الرواتب والسلف", en: "Payroll & advances",
        icon: Banknote,
        anyOf: [hr("payroll_prepare"), hr("payroll_approve"), hr("payroll_pay"), hr("advances_manage"), hr("advances_approve"), hr("advances_disburse")],
        children: [
          { id: "hr.payroll", ar: "مسيرات الرواتب", en: "Payroll", href: "/dashboard/hr/payroll", anyOf: [hr("payroll_prepare"), hr("payroll_approve"), hr("payroll_pay")] },
          { id: "hr.advances", ar: "السلف", en: "Advances", href: "/dashboard/hr/advances", anyOf: [hr("advances_manage"), hr("advances_approve"), hr("advances_disburse")] },
        ],
      },
      { id: "hr.recruitment", ar: "التوظيف", en: "Recruitment", icon: UserPlus, href: "/dashboard/hr/recruitment", anyOf: [hr("recruit")] },
      { id: "hr.assets", ar: "العهد", en: "Assets", icon: Laptop, href: "/dashboard/hr/assets", anyOf: [hr("assets_manage")] },
      { id: "hr.settings", ar: "إعدادات الموارد البشرية", en: "HR settings", icon: Settings, href: "/dashboard/hr/settings", anyOf: [hr("policy_manage"), { module: "employees", sub: "edit" }] }, // account editors: «الأشخاص الخارجيون» (Option A)
    ],
  },
  {
    // Self-service: every login. The page shows a "not linked" state when the login has no
    // HR record; the API resolves the subject from the session, never from the request.
    id: "me",
    ar: "خدماتي", en: "My HR",
    icon: UserRound,
    href: "/dashboard/me",
  },
  {
    id: "employees",
    ar: "الموظفون", en: "Employees",
    icon: Users,
    href: "/dashboard/employees",
    anyOf: [{ module: "employees" }],
    // The system users and their access, not HR's «الموظفون» (parity N-19): the reference
    // reaches it under Settings as «المستخدمون والصلاحيات» (users.py ur_shell), so in the
    // Direction 2.1 shell it sits in the gear menu under that name.
    shell: { place: "menu", icon: "users", ar: "المستخدمون والصلاحيات", en: "Users & permissions" },
  },
  {
    id: "settings",
    ar: "الإعدادات", en: "Settings",
    icon: Settings,
    href: "/dashboard/settings",
    anyOf: [{ module: "settings" }],
    adminOnly: true,
    shell: { place: "menu", icon: "settings" },
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
 * The trail the sidebar HIGHLIGHTS for a path. The same as `resolveActive` unless the matched
 * node names `highlightAs`: then the first of those ids present in `tree` (the viewer's
 * pruned tree) is highlighted instead, with its own group and subunit. The breadcrumb keeps
 * using `resolveActive` — it always names the real page.
 */
/**
 * The Direction 2.1 presentation of a (pruned) tree. An entry whose hint names `as` is taken
 * out and the named node is shown in its own group instead, created from the registry if the
 * viewer's tree has no such group. The shown copy drops `unlessAny`: that guard only keeps the
 * two placements from ever both appearing, and the entry it replaces already passed the same
 * module check. A section left with no pages is dropped. The legacy shell never calls this.
 */
export function presentTree(tree: NavNode[]): NavNode[] {
  const targets = walk(tree).map((h) => h.node.shell?.as).filter((id): id is string => !!id);
  if (targets.length === 0) return tree;
  const strip = (nodes: NavNode[]): NavNode[] =>
    nodes
      .filter((n) => !n.shell?.as)
      .map((n) => (n.children ? { ...n, children: strip(n.children) } : n))
      .filter((n) => !n.children || n.children.length > 0);
  const out = strip(tree);
  const rank = (id: string) => NAV.findIndex((n) => n.id === id);
  for (const id of targets) {
    if (walk(out).some((h) => h.node.id === id)) continue;
    const group = NAV.find((g) => g.children?.some((c) => c.id === id));
    const node = group?.children?.find((c) => c.id === id);
    if (!group || !node) continue;
    const shown: NavNode = { ...node, unlessAny: undefined };
    const at = out.findIndex((g) => g.id === group.id);
    if (at === -1) {
      const before = out.findIndex((g) => rank(g.id) > rank(group.id));
      out.splice(before === -1 ? out.length : before, 0, { ...group, children: [shown] });
    } else {
      const order = group.children!.map((c) => c.id);
      const children = [...(out[at].children ?? []), shown].sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
      out[at] = { ...out[at], children };
    }
  }
  return out;
}

export function resolveHighlight(active: ActiveTrail, tree: NavNode[]): ActiveTrail {
  const ids = active.leaf?.highlightAs;
  if (!ids || ids.length === 0) return active;
  const all = walk(tree);
  for (const id of ids) {
    const hit = all.find((h) => h.node.id === id);
    if (!hit) continue;
    const [group, subunit] = hit.trail;
    return { group, subunit: subunit ?? (group ? hit.node : undefined), leaf: hit.node };
  }
  return active;
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
