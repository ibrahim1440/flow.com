import type { ElementType } from "react";
import {
  LayoutDashboard, Package, ShoppingCart, Factory, ClipboardCheck, Box, Truck, History,
  Tag, Users, Settings, FlaskConical, Users2, ShoppingBag, PackageCheck,
  ClipboardList, UserPlus, KanbanSquare, Percent, CalendarCheck, FileText, Target, BarChart3,
  ScrollText, Briefcase, Landmark, Boxes, Workflow, Zap, MessageSquareText, QrCode,
  Contact, UserRound, CalendarDays, Banknote, Laptop,
  Flame, ListChecks, Coffee, Bell, Megaphone,
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
/** A module (and optionally one of its sub-privileges); with `role`, also that account role. */
export type Ability = { module: string; sub?: string; role?: string };

/**
 * One way to qualify for a node: a single ability, or several that must ALL be held.
 *
 * The conjunction exists for the screens Figma lists once but two audiences reach for
 * different reasons. Commission review is a sales manager's (`view_team`, inside Sales) and
 * Finance's (`approve` / `record_payout`, with no sales module at all). They used to be two
 * placements, one under each group, so the administrator met it twice; one entry under
 * «المالية» now carries both reasons, unchanged, as `[[view_team, sales], approve, payout]`.
 */
export type Requirement = Ability | Ability[];

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
  /** Visible when the caller meets ANY of these. Empty or absent means "always". */
  anyOf?: Requirement[];
  /**
   * ALSO required, all of them, for the node to appear AT THIS POSITION in the tree.
   * Scopes a placement without touching who may reach the page (the route guard ignores it).
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
   * breadcrumb still names the real page; the global history highlights «لوحة التشغيل»
   * (GX D-P02). The first id the viewer's tree contains wins; if it contains none, the node
   * highlights itself, as every node without this field does.
   */
  highlightAs?: string[];
  children?: NavNode[];
  /**
   * How the Direction 2.1 shell PRESENTS this node — never what it is or who may see it.
   *
   * The approved frames (`erp/docs/design/direction-2.1-rc`, CRM.md D5, the GX frames of
   * Figma 1JbZgpMqmPkUVne8ms9Ozz) name and group the sidebar differently from the registry's
   * own labels: «التشغيل» holds orders, production and stock together, «العملاء» stands for
   * customer management, «الصفقات» for the pipeline, «الأداء» for performance & commissions.
   * The legacy shell ignores every field here.
   */
  shell?: ShellHints;
};

export type ShellHints = {
  /** The approved sidebar wording, when the frame names the entry differently. */
  ar?: string;
  en?: string;
  /**
   * The breadcrumb wording, when the frame's top bar names the entry differently from its
   * sidebar item: the sidebar's «الأداء» is «الأداء والعمولات» in the trail (GX A-P06 /
   * D-P01), «النقد والبنوك» is «النقد والميزانية» (GX B-P01).
   */
  crumb?: { ar: string; en: string };
  /**
   * The sidebar wording for a viewer who holds NONE of `unlessAny` — the rep sidebar of the GX
   * frames (TS-N14, A-05 rep 1458:15314): «التحصيل» and «أهدافي وعمولاتي» for somebody who
   * neither decides collections nor manages anyone's commission.
   */
  own?: { ar: string; en: string; unlessAny: Ability[]; crumb?: { ar: string; en: string } };
  /** The reference icon (screens.py ICONS); lucide stays the fallback (register row A-18). */
  icon?: D21IconName;
  /**
   * List under this group instead of under its own module (a module id or a SHELL_GROUPS key).
   * On a module it moves every subunit; on a subunit it moves that entry alone, which is how the
   * one registry module «العمليات» is drawn as «الطلبات · الإنتاج · الجودة» (owner, 19 Oct 2026).
   */
  group?: string;
  /**
   * The module whose «جديد» create actions a top-level entry offers (see `./creates`), when it
   * belongs to none: the operations dashboard keeps offering «طلب».
   */
  creates?: string;
  /**
   * "menu": reached from the user block's gear menu, not from the sidebar (a group placed
   * there is ONE menu entry, opening onto its first permitted page).
   * "none": drawn neither in the sidebar nor in the menu — reached from its section, its
   * highlighted entry and the quick jump (Ctrl K), as the frame draws it (GX D-P02: the
   * global history has no sidebar item; it highlights «لوحة التشغيل»).
   */
  place?: "menu" | "none";
  /**
   * The top-bar trail starts with this group's label (a module id or a SHELL_GROUPS key)
   * instead of this node's registry ancestors: «التشغيل / لوحة التشغيل» (20:236, 101:6411),
   * «التشغيل / السجل العام» (GX D-P02), «الإعدادات / الأتمتة والواتساب / القواعد» (GX E-P01),
   * «الإعدادات / المبيعات» (GX A-P08). The group is a label, not a link.
   */
  trailRoot?: string;
  /**
   * Shown — and resolved — as that registry node instead (see `presentTree`). The approved
   * frames put «الطلبات» under «التشغيل» for every persona (orders-1440, crumb «التشغيل /
   * الطلبات»), while the registry keeps orders under Sales for a seller in the legacy shell.
   */
  as?: string;
};

/**
 * Groups the sidebar draws that are not modules of their own.
 *
 * Owner (19 Oct 2026, phone «المزيد»): the one long «التشغيل» list — thirteen entries from the
 * dashboard to the labels — is split into sections that each hold one area of work: the order
 * flow, production, quality, and stock with its purchasing. Presentation only: every entry
 * keeps its registry node, its permissions and its route; only the heading it is drawn under
 * (`shell.group`) and the trail's first label (`shell.trailRoot`) change.
 */
export const SHELL_GROUPS: Record<string, { ar: string; en: string }> = {
  orders: { ar: "الطلبات", en: "Orders" },
  production: { ar: "الإنتاج", en: "Production" },
  quality: { ar: "الجودة", en: "Quality" },
  inventory: { ar: "المخزون والمشتريات", en: "Inventory & purchasing" },
  team: { ar: "الفريق", en: "Team" },
};

/**
 * The order of the sidebar groups, after the ungrouped «لوحة التشغيل · خدماتي»: the order
 * flow, how it is made, how it is checked, what it is made from, then who buys it, the money
 * and the people. A group not listed follows, in registry order.
 */
export const SHELL_GROUP_ORDER = ["orders", "production", "quality", "inventory", "sales", "finance", "hr", "marketing", "team"];

/**
 * The gear menu, in this order (GX F-P01 settings navigation: «المنشأة · المستخدمون والصلاحيات ·
 * … · المبيعات · … · الأتمتة والواتساب»), after the profile. An entry not listed follows.
 */
export const MENU_ORDER = ["profile", "settings", "employees", "settings.production", "settings.inventory", "settings.products", "sales.settings", "settings.invoicing", "automation"];

const sales = (sub?: string): Ability => ({ module: "sales", ...(sub ? { sub } : {}) });
const commissions = (sub?: string): Ability => ({ module: "commissions", ...(sub ? { sub } : {}) });
const IN_SALES: Ability[] = [sales()];
const hr = (sub?: string): Ability => ({ module: "hr", ...(sub ? { sub } : {}) });
const mkt = (sub?: string): Ability => ({ module: "marketing", ...(sub ? { sub } : {}) });
const FINANCE: Ability = { module: "finance" };
const ACCOUNTING: Ability = { module: "accounting" };
/** Who decides a collection (verify, reject, reverse) — Finance's half of the queue. */
const DECIDES_COLLECTIONS: Ability[] = [
  commissions("collection_verify"),
  commissions("collection_reject"),
  commissions("collection_reverse"),
];

/**
 * ── Three levels ──
 *   1. a module in the sidebar
 *   2. subunits beneath it, disclosed on demand
 *   3. the subunit's pages, as contextual navigation inside the page
 *
 * A subunit with a single destination carries an `href` and no children: there is nothing
 * for a contextual bar to offer, and a tab strip with one tab is noise.
 *
 * ── Figma is the source of truth (owner) ──
 * The sidebar of every approved frame (20:236 and the GX frames) is
 *   التشغيل: لوحة التشغيل · الطلبات · الإنتاج والتحميص · الجودة والتذوق · المخزون · المشتريات · المنتجات
 *   المبيعات: العملاء · الصفقات · عروض الأسعار
 *   المالية:  النقد والبنوك · الفواتير والتحصيل · الأداء
 * and the owner's regrouping (19 Oct 2026) splits «التشغيل» into its areas of work:
 *   (top)                 لوحة التشغيل · خدماتي
 *   الطلبات:              الطلبات · التسليم   («تجهيز الطلبات» retired, production simplification B)
 *   الإنتاج:              أوامر الإنتاج · الإنتاج والتحميص · التعبئة · الملصقات
 *   الجودة:               الجودة والتذوق · التذوق
 *   المخزون والمشتريات:   المخزون · المشتريات · المنتجات
 *   المبيعات · المالية · الموارد البشرية as before; the settings stay in the gear menu.
 * Collections and the whole performance & commissions hub live under «المالية» for EVERY
 * viewer (GX A-05 rep frame 1458:15314 draws a salesperson's «المالية» with «التحصيل» and
 * «أهدافي وعمولاتي»), so nothing of it is listed under «المبيعات» any more and nobody meets
 * one of these screens twice. Analytics is a tab of that hub (GX D-P01 trail «المالية / الأداء
 * والعمولات / التحليلات التنبؤية»); the global history sits under the operations dashboard
 * (GX D-P02 «التشغيل / السجل العام»); automation and the settings screens are reached from
 * the gear, under «الإعدادات» (GX E-P01, F-P01, A-P08).
 */
export const NAV: NavNode[] = [
  // «لوحة التشغيل» / "Operations dashboard" (20:236). Since the owner's regrouping (19 Oct 2026)
  // it heads the sidebar ungrouped, with «خدماتي», above the sections; it still offers the
  // operations «جديد» (an order).
  { id: "dashboard", ar: "لوحة التحكم", en: "Dashboard", icon: LayoutDashboard, href: "/dashboard", shell: { ar: "لوحة التشغيل", en: "Operations dashboard", icon: "pulse", creates: "operations" } },
  {
    // GX D-P02 (1494:3302): no sidebar item of its own; «لوحة التشغيل» is highlighted and the
    // trail reads «لوحة التشغيل / السجل العام». Reached from the quick jump and the dashboard.
    id: "history",
    ar: "السجل", en: "History",
    icon: History,
    href: "/dashboard/history",
    anyOf: [{ module: "history" }],
    highlightAs: ["dashboard"],
    shell: { ar: "السجل العام", en: "Global history", icon: "note", place: "none", trailRoot: "dashboard", creates: "operations" },
  },

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
            // The one customers entry, for everyone who holds the module (20:236: «المبيعات ›
            // العملاء»). Somebody without the Sales CRM — the legacy order-taking role holds
            // `customers` and no `sales` — meets the same «العملاء» item, opening on this page.
            id: "sales.customers.accounts",
            ar: "العملاء", en: "Customers",
            href: "/dashboard/customers",
            anyOf: [{ module: "customers" }],
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
        // GX A-P08 (1229:114164): the gear → «الإعدادات › المبيعات», trail «الإعدادات / المبيعات».
        id: "sales.settings",
        ar: "إعدادات المبيعات",
        en: "Sales settings",
        icon: Settings,
        href: "/dashboard/sales/settings",
        anyOf: [sales("stage_manage")],
        shell: { place: "menu", icon: "settings", trailRoot: "settings", crumb: { ar: "المبيعات", en: "Sales" } },
      },
    ],
  },

  {
    // «المالية» (20:236: «النقد والبنوك · الفواتير والتحصيل · الأداء»). No gate on the group
    // itself any more: it shows whenever one of its pages does, so a salesperson meets their
    // collections and commissions here too (GX A-05 rep), and nobody meets them under Sales.
    // Finance still holds no sales module and still cannot read the pipeline.
    id: "finance",
    ar: "المالية",
    en: "Finance",
    icon: Landmark,
    children: [
      {
        // Cash management, receipt allocation and the monthly cash budget. Its six areas are
        // tabs inside the page. The sidebar reads «النقد والبنوك» and the trail and the page
        // «النقد والميزانية», exactly as GX B-P01 (1247:11423) draws them (NAV-B, gap-closure §8).
        id: "finance.cash",
        ar: "النقد والميزانية", en: "Cash & budget",
        href: "/dashboard/finance",
        anyOf: [FINANCE],
        shell: { ar: "النقد والبنوك", en: "Cash & banks", crumb: { ar: "النقد والميزانية", en: "Cash & budget" }, icon: "wallet" },
      },
      {
        // ONE screen and ONE set of records: a salesperson records a receipt and sees their own
        // history; Finance decides it. Any sales user, exactly as before, or anyone who decides.
        id: "finance.collections",
        ar: "التحصيلات", en: "Collections",
        href: "/dashboard/sales/collections",
        // Sales invoicing A2 (Figma ZT-10): «الفواتير والتحصيل» is the hub of the tax invoices, the credit / debit
        // notes, the collections and the AR aging / statements — tabs of one destination, as drawn. The invoice and
        // AR pages belong to it, with its audience unchanged (access parity); each page's API decides what is shown
        // (sales › invoices_view, scoped for a rep, or accounting › ar).
        alsoMatches: ["/dashboard/sales/invoices", "/dashboard/sales/receivables"],
        anyOf: [sales(), ...DECIDES_COLLECTIONS],
        shell: {
          ar: "الفواتير والتحصيل", en: "Invoices & collections", icon: "invoice",
          own: { ar: "التحصيل", en: "Collections", unlessAny: DECIDES_COLLECTIONS },
        },
      },
      {
        // The performance & commissions hub (GX A-P03…A-P08, D-P01): its pages are the tabs
        // «الأهداف · تقارير المبيعات · التحليلات التنبؤية · عمولاتي · مراجعة العمولات · خطط العمولات».
        id: "finance.performance",
        ar: "الأداء والعمولات",
        en: "Performance and commissions",
        icon: BarChart3,
        shell: {
          ar: "الأداء", en: "Performance", icon: "chart",
          crumb: { ar: "الأداء والعمولات", en: "Performance & commissions" },
          own: {
            ar: "أهدافي وعمولاتي", en: "My targets & commissions",
            // The rep's trail «أدائي / عمولاتي» (GX A-05 rep, gx.py perf_shell): no «المالية».
            crumb: { ar: "أدائي", en: "My performance" },
            unlessAny: [commissions("view_team"), commissions("approve"), commissions("record_payout"), commissions("manage_plans"), { module: "analytics" }],
          },
        },
        children: [
          {
            // «لوحة الأداء» — the first tab of every frame of the family (gx.py perf_tabs, the
            // rep's too: TS-N14). The month's figures from deals, quotations, collections,
            // targets and the commission ledger (GET /api/sales/performance). The same audience
            // as the targets and reports beside it: a rep sees their own, a manager the team.
            id: "finance.performance.dashboard",
            ar: "لوحة الأداء", en: "Performance dashboard",
            href: "/dashboard/sales/performance",
            anyOf: IN_SALES,
            shell: { ar: "لوحة الأداء", en: "Dashboard" },
          },
          {
            id: "finance.performance.targets",
            ar: "الأهداف", en: "Targets",
            href: "/dashboard/sales/targets",
            anyOf: IN_SALES,
          },
          {
            // The TEAM's reports: the sales manager (`lead_assign`, the permission that already
            // shows every rep's work) and the admin — owner decision, batch Sales B. A rep's own
            // figures are on «لوحة الأداء». GET /api/sales/reports enforces the same rule
            // (`seesTeamReports`); the route guard is module-level, so the page refuses a rep too.
            id: "finance.performance.reports",
            ar: "تقارير المبيعات", en: "Sales reports",
            href: "/dashboard/sales/reports",
            anyOf: [sales("lead_assign"), { module: "sales", role: "admin" }],
          },
          {
            id: "finance.performance.analytics",
            ar: "التحليلات", en: "Analytics",
            href: "/dashboard/analytics",
            anyOf: [{ module: "analytics" }],
            shell: { ar: "التحليلات التنبؤية", en: "Predictive analytics", icon: "chart" },
          },
          {
            // Their own earnings. The conditions are exactly the two placements this replaces:
            // a salesperson's (commissions + sales) and Finance's (commissions + any finance
            // ability), so nobody gains or loses the entry.
            id: "finance.performance.mine",
            ar: "عمولاتي", en: "My commissions",
            href: "/dashboard/sales/my-commissions",
            anyOf: [
              [commissions(), sales()],
              commissions("approve"), commissions("record_payout"), ...DECIDES_COLLECTIONS,
              [commissions(), FINANCE], [commissions(), ACCOUNTING],
            ],
          },
          {
            // A sales manager's team view (`view_team`, inside Sales) and Finance's approval and
            // payout — one entry for both, as the two placements it replaces admitted them.
            id: "finance.performance.review",
            ar: "مراجعة العمولات", en: "Commission review",
            href: "/dashboard/commissions/review",
            anyOf: [[commissions("view_team"), sales()], commissions("approve"), commissions("record_payout")],
          },
          {
            id: "finance.performance.plans",
            ar: "خطط العمولات", en: "Commission plans",
            href: "/dashboard/commissions/plans",
            anyOf: [commissions("manage_plans")],
            requiresAll: IN_SALES,
          },
          {
            // Commission plan builder — owner decisions of 24 Oct: the new-client window, the lapse
            // period, the eligibility and the activation date, for `commissions › manage_settings`.
            id: "finance.performance.settings",
            ar: "إعدادات العمولات", en: "Commission settings",
            href: "/dashboard/commissions/settings",
            anyOf: [commissions("manage_settings")],
          },
          {
            // The one-time opening setup of existing customers (and, after activation, the audited
            // «تعديل ترتيب الطلب»), the same permission.
            id: "finance.performance.opening",
            ar: "تهيئة العملاء الحاليين", en: "Existing customers setup",
            href: "/dashboard/commissions/opening",
            anyOf: [commissions("manage_settings")],
          },
        ],
      },
      {
        id: "finance.accounting",
        ar: "المحاسبة", en: "Accounting",
        href: "/dashboard/accounting",
        anyOf: [ACCOUNTING],
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
        shell: { icon: "orders", group: "orders", trailRoot: "orders" },
      },
      // «تجهيز الطلبات» (operations.preparation) was retired by the production simplification
      // (Phase B item 4): preparation is automatic and «الطلبات» is the status board. Its route
      // redirects to Orders.
      {
        id: "operations.productionOrders",
        ar: "أوامر الإنتاج", en: "Production orders",
        href: "/dashboard/production-orders",
        icon: ListChecks,
        anyOf: [{ module: "production" }],
        shell: { icon: "flame", group: "production", trailRoot: "production" },
      },
      {
        id: "operations.production",
        ar: "الإنتاج", en: "Production & roasting",
        href: "/dashboard/production",
        icon: Flame,
        anyOf: [{ module: "production" }],
        shell: { ar: "الإنتاج والتحميص", en: "Production & roasting", icon: "flame", group: "production", trailRoot: "production" },
      },
      {
        // Figma 377:2 RM6–RM8 (ROASTERS.md §2, D2): «جدول التحميص» is a tab of «الإنتاج والتحميص», so it has
        // no sidebar item of its own (the frames light «الإنتاج والتحميص»); reached from the tab, the
        // quick jump and its own URL. The same audience as production: viewing is read-only, every write
        // is checked by the API (production › manage_schedule, never a role default).
        id: "operations.productionSchedule",
        ar: "جدول التحميص", en: "Roasting schedule",
        href: "/dashboard/production/schedule",
        icon: CalendarDays,
        anyOf: [{ module: "production" }],
        highlightAs: ["operations.production"],
        shell: { icon: "flame", group: "production", trailRoot: "production", place: "none" },
      },
      {
        id: "operations.packaging",
        ar: "التعبئة", en: "Packaging",
        href: "/dashboard/packaging",
        icon: Package,
        anyOf: [{ module: "packaging" }],
        shell: { icon: "box", group: "production", trailRoot: "production" },
      },
      {
        id: "operations.dispatch",
        ar: "التسليم", en: "Dispatch",
        href: "/dashboard/dispatch",
        icon: Truck,
        anyOf: [{ module: "dispatch" }],
        shell: { icon: "truck", group: "orders", trailRoot: "orders" },
        highlightAs: ["operations.orders"],
      },
      {
        id: "operations.qc",
        ar: "الجودة", en: "Quality & cupping",
        href: "/dashboard/qc",
        icon: FlaskConical,
        anyOf: [{ module: "qc" }],
        shell: { ar: "الجودة والتذوق", en: "Quality & cupping", icon: "flask", group: "quality", trailRoot: "quality" },
      },
      {
        id: "operations.cupping",
        ar: "التذوق", en: "Cupping",
        href: "/dashboard/cupping",
        icon: Coffee,
        anyOf: [{ module: "cupping" }],
        shell: { icon: "flask", group: "quality", trailRoot: "quality" },
      },
    ],
  },

  {
    id: "stock",
    ar: "المخزون والمنتجات",
    en: "Inventory and products",
    icon: Boxes,
    // «المخزون والمشتريات» (owner, 19 Oct 2026); the labels are drawn under «الإنتاج».
    shell: { group: "inventory" },
    children: [
      {
        id: "stock.inventory",
        ar: "المخزون", en: "Inventory",
        href: "/dashboard/inventory",
        anyOf: [{ module: "inventory" }],
        shell: { icon: "box", trailRoot: "inventory" },
      },
      {
        id: "stock.purchases",
        ar: "المشتريات", en: "Purchases",
        href: "/dashboard/purchases",
        anyOf: [{ module: "inventory" }],
        shell: { icon: "truck", trailRoot: "inventory" },
      },
      {
        // Accounting A3: supplier invoices — entered by purchasing (purchases › invoices), approved and posted by
        // accounts payable (accounting › ap). Figma ACC-50 / 51.
        id: "stock.supplierInvoices",
        ar: "فواتير الموردين", en: "Supplier invoices",
        href: "/dashboard/purchases/invoices",
        anyOf: [{ module: "purchases", sub: "invoices" }, { module: "accounting", sub: "ap" }],
        shell: { icon: "note", trailRoot: "inventory" },
      },
      {
        id: "stock.products",
        ar: "المنتجات", en: "Products",
        href: "/dashboard/products",
        anyOf: [{ module: "inventory" }],
        shell: { icon: "cup", trailRoot: "inventory" },
      },
      {
        id: "stock.labels",
        ar: "الملصقات", en: "Labels",
        href: "/dashboard/labels",
        icon: Tag,
        anyOf: [{ module: "labels" }],
        // Printed on the line, with the packing: drawn under «الإنتاج», not with the stock.
        shell: { group: "production", trailRoot: "production" },
      },
    ],
  },

  {
    // WhatsApp messages sent by rules on ERP events. Its own module, because who may decide
    // what customers are sent is not a sales, orders or settings question alone. Presented as
    // GX E-P01…E-P04 draw it: «الأتمتة والواتساب» under «الإعدادات» (the gear menu, and the
    // settings navigation of the page), trail «الإعدادات / الأتمتة والواتساب / القواعد».
    id: "automation",
    ar: "الأتمتة", en: "Automation",
    icon: Workflow,
    shell: { ar: "الأتمتة والواتساب", en: "Automation & WhatsApp", icon: "bell", place: "menu", trailRoot: "settings" },
    children: [
      {
        id: "automation.rules",
        ar: "قواعد الأتمتة", en: "Automation rules",
        icon: Zap,
        href: "/dashboard/automation",
        alsoMatches: ["/dashboard/automation/rules"],
        anyOf: [{ module: "automation" }],
        shell: { ar: "القواعد", en: "Rules" },
      },
      {
        id: "automation.messages",
        ar: "سجل الرسائل", en: "Message log",
        icon: MessageSquareText,
        href: "/dashboard/automation/messages",
        anyOf: [{ module: "automation" }],
      },
      {
        // «إشعارات الحالات» (feat/whatsapp-status; addition beyond Figma): the same audience as
        // the message log; the page and its API are for the admin role (others read a notice).
        id: "automation.statuses",
        ar: "إشعارات الحالات", en: "Status notifications",
        icon: Zap,
        href: "/dashboard/automation/statuses",
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
    // Smart Marketing «التسويق» (feat/smart-marketing, docs/marketing). One module; each page and
    // API re-checks its own key. Money (attribution), customers' phones (WhatsApp) and the policy
    // screens are gated on their keys here too, so nobody is shown a page they cannot use.
    id: "marketing",
    ar: "التسويق", en: "Marketing",
    icon: Megaphone,
    anyOf: [mkt()],
    shell: { icon: "chart" },
    children: [
      { id: "marketing.overview", ar: "نظرة عامة", en: "Overview", icon: BarChart3, href: "/dashboard/marketing", anyOf: [mkt()] },
      {
        id: "marketing.plan",
        ar: "التخطيط والمحتوى", en: "Planning & content",
        icon: CalendarDays,
        anyOf: [mkt()],
        children: [
          { id: "marketing.campaigns", ar: "الحملات", en: "Campaigns", href: "/dashboard/marketing/campaigns", anyOf: [mkt()] },
          { id: "marketing.calendar", ar: "تقويم النشر", en: "Publishing calendar", href: "/dashboard/marketing/calendar", anyOf: [mkt()] },
          { id: "marketing.library", ar: "مكتبة التصاميم", en: "Asset library", href: "/dashboard/marketing/library", anyOf: [mkt()] },
          { id: "marketing.studio", ar: "استوديو الذكاء الاصطناعي", en: "AI studio", href: "/dashboard/marketing/studio", anyOf: [mkt("ai_use")] },
        ],
      },
      {
        id: "marketing.execute",
        ar: "التنفيذ", en: "Execution",
        icon: Zap,
        anyOf: [mkt()],
        children: [
          { id: "marketing.publishing", ar: "مركز النشر", en: "Publishing hub", href: "/dashboard/marketing/publishing", anyOf: [mkt()] },
          { id: "marketing.approvals", ar: "الموافقات", en: "Approvals", href: "/dashboard/marketing/approvals", anyOf: [mkt()] },
          { id: "marketing.whatsapp", ar: "الواتساب والعملاء", en: "WhatsApp & customers", href: "/dashboard/marketing/whatsapp", anyOf: [mkt("customers_data"), mkt("messaging_manage")] },
        ],
      },
      {
        id: "marketing.measure",
        ar: "القياس", en: "Measurement",
        icon: Target,
        anyOf: [mkt()],
        children: [
          { id: "marketing.analytics", ar: "التحليلات والمؤشرات", en: "Analytics & KPIs", href: "/dashboard/marketing/analytics", anyOf: [mkt()] },
          { id: "marketing.budgets", ar: "الميزانيات", en: "Budgets", href: "/dashboard/marketing/budgets", anyOf: [mkt("budget_manage"), mkt("revenue_view")] },
          { id: "marketing.attribution", ar: "المبيعات والإسناد", en: "Sales & attribution", href: "/dashboard/marketing/attribution", anyOf: [mkt("revenue_view")] },
          { id: "marketing.reports", ar: "التقارير", en: "Reports", href: "/dashboard/marketing/reports", anyOf: [mkt()] },
        ],
      },
      { id: "marketing.integrations", ar: "التكاملات", en: "Integrations", icon: Workflow, href: "/dashboard/marketing/integrations", anyOf: [mkt()] },
      { id: "marketing.settings", ar: "إعدادات التسويق", en: "Marketing settings", icon: Settings, href: "/dashboard/marketing/settings", anyOf: [mkt()] },
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
    // The signed-in person's own profile (language, PIN, two-step verification): every login,
    // from the gear menu. Without an entry of its own the page fell through to /dashboard —
    // the sidebar lit «لوحة التشغيل» and the trail read «التشغيل / لوحة التشغيل / ملفي».
    id: "profile",
    ar: "الملف الشخصي", en: "Profile",
    icon: UserRound,
    href: "/dashboard/profile",
    shell: { place: "menu", crumb: { ar: "ملفي الشخصي", en: "My Profile" } },
  },
  {
    // feat/notifications: «التنبيهات», the full list behind the bell. Every login (the person's own
    // notifications; the API scopes by the session). Reached from the bell and the quick jump, not
    // from the sidebar or the menu — the bell is its entry point in every top bar.
    id: "notifications",
    ar: "التنبيهات", en: "Notifications",
    icon: Bell,
    href: "/dashboard/notifications",
    shell: { place: "none", icon: "bell" },
  },
  {
    id: "employees",
    ar: "الموظفون", en: "Employees",
    icon: Users,
    href: "/dashboard/employees",
    anyOf: [{ module: "employees" }],
    // The system users and their access, not HR's «الموظفون» (parity N-19): the reference
    // reaches it under Settings as «المستخدمون والصلاحيات» (users.py ur_shell; GX F-P01), so in
    // the Direction 2.1 shell it sits in the gear menu under that name.
    shell: { place: "menu", icon: "users", ar: "المستخدمون والصلاحيات", en: "Users & permissions", trailRoot: "settings" },
  },
  {
    // GX F-P01 (1205:2): the gear → «الإعدادات», trail «الإعدادات / المنشأة».
    id: "settings",
    ar: "الإعدادات", en: "Settings",
    icon: Settings,
    href: "/dashboard/settings",
    anyOf: [{ module: "settings" }],
    adminOnly: true,
    shell: { place: "menu", icon: "settings", trailRoot: "settings", crumb: { ar: "المنشأة", en: "Organisation" } },
  },
  // The settings sections of GX F-P01 (gx.py SNAV) that had no page («قريباً» until batch "Settings"):
  // the same audience as «المنشأة» (the admin role, the settings module), reached from the gear and
  // the settings navigation, trail «الإعدادات / …».
  {
    // Figma 377:2 RM1–RM5: «الإعدادات / الإنتاج والتحميص / الحمّاصات» (ROASTERS.md §2, D2).
    id: "settings.production",
    ar: "الإنتاج والتحميص", en: "Production & roasting",
    icon: Flame,
    anyOf: [{ module: "settings" }],
    adminOnly: true,
    shell: { place: "menu", icon: "flame", trailRoot: "settings" },
    children: [
      { id: "settings.production.roasters", ar: "الحمّاصات", en: "Roasters", icon: Flame, href: "/dashboard/settings/production", anyOf: [{ module: "settings" }], adminOnly: true },
    ],
  },
  { id: "settings.inventory", ar: "المخزون", en: "Inventory", icon: Boxes, href: "/dashboard/settings/inventory", anyOf: [{ module: "settings" }], adminOnly: true, shell: { place: "menu", icon: "box", trailRoot: "settings" } },
  { id: "settings.products", ar: "المنتجات", en: "Products", icon: Coffee, href: "/dashboard/settings/products", anyOf: [{ module: "settings" }], adminOnly: true, shell: { place: "menu", icon: "cup", trailRoot: "settings" } },
  { id: "settings.invoicing", ar: "الفوترة والضرائب", en: "Invoicing & tax", icon: FileText, href: "/dashboard/settings/invoicing", anyOf: [{ module: "settings" }], adminOnly: true, shell: { place: "menu", icon: "invoice", trailRoot: "settings" } },
];

// Icons imported for the tree above but not otherwise referenced keep the import list
// honest about what the registry can draw.
void [Package, ShoppingCart, Factory, ClipboardCheck, Box, Truck, History, Tag, Users2,
  ShoppingBag, ClipboardList, Percent, CalendarCheck, Target, ScrollText, FlaskConical];

export type Viewer = { permissions: Permissions; role: string };

function holds(v: Viewer, a: Ability): boolean {
  if (a.role && v.role !== a.role) return false;
  return a.sub
    ? hasSubPrivilege(v.permissions, a.module, a.sub)
    : hasModuleAccess(v.permissions, a.module);
}

/** A requirement is met when its ability — or every ability of a conjunction — is held. */
function meets(v: Viewer, r: Requirement): boolean {
  return Array.isArray(r) ? r.every((a) => holds(v, a)) : holds(v, r);
}

/** The same, at MODULE level only — what the route guard checks (see `routeAllowed`). */
function meetsModule(v: Viewer, r: Requirement): boolean {
  return (Array.isArray(r) ? r : [r]).every((a) => hasModuleAccess(v.permissions, a.module));
}

/** Whether this node itself is permitted, ignoring its children. */
export function nodePermitted(v: Viewer, n: NavNode): boolean {
  if (n.adminOnly && v.role !== "admin") return false;
  if (n.requiresAll && !n.requiresAll.every((a) => holds(v, a))) return false;
  if (n.unlessAny && n.unlessAny.some((a) => holds(v, a))) return false;
  if (!n.anyOf || n.anyOf.length === 0) return true;
  return n.anyOf.some((r) => meets(v, r));
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

// ── Direction 2.1 presentation helpers (labels and the top-bar trail) ──

/** A module id or a SHELL_GROUPS key, as the sidebar names it. */
export function groupText(id: string, lang: string): string | null {
  const mod = NAV.find((n) => n.id === id);
  if (mod) return shellText(mod, lang);
  const g = SHELL_GROUPS[id];
  return g ? (lang === "ar" ? g.ar : g.en) : null;
}

/**
 * The sidebar group an entry is drawn under: its own `shell.group`, else its module's, else the
 * module itself. A top-level destination with no hint is ungrouped (`null`). The sidebar, the
 * phone «المزيد» sheet and the quick jump all group by this, so they cannot disagree.
 */
export function shellGroupOf(n: NavNode, module?: NavNode): string | null {
  if (n.shell?.group) return n.shell.group;
  if (!module || module.id === n.id) return null;
  return module.shell?.group ?? module.id;
}

/**
 * The label the Direction 2.1 sidebar, menu and quick jump draw for a node. With a viewer, a
 * node carrying `shell.own` reads its own-work wording for somebody who holds none of its
 * abilities (the GX rep sidebar). Presentation only: it never decides what is shown.
 */
export function shellText(n: NavNode, lang: string, v?: Viewer): string {
  const own = n.shell?.own;
  if (own && v && !own.unlessAny.some((a) => holds(v, a))) return lang === "ar" ? own.ar : own.en;
  return lang === "ar" ? (n.shell?.ar ?? n.ar) : (n.shell?.en ?? n.en);
}

/**
 * Whether the node `id` reads its own-work wording for this viewer (`shell.own`): the GX rep
 * frames title «الأداء والعمولات» as «أهدافي وعمولاتي» for exactly the viewers whose sidebar
 * names it so. Presentation only.
 */
export function ownWordingApplies(id: string, v: Viewer): boolean {
  const n = walk(NAV).find((x) => x.node.id === id)?.node;
  const own = n?.shell?.own;
  return !!own && !own.unlessAny.some((a) => holds(v, a));
}

/** The label the Direction 2.1 top-bar trail draws for a node (`shell.crumb`, else its sidebar label). */
export function crumbText(n: NavNode, lang: string): string {
  const c = n.shell?.crumb;
  return c ? (lang === "ar" ? c.ar : c.en) : shellText(n, lang);
}

export type TrailPart = { key: string; text: string; node: NavNode | null };

/**
 * The Direction 2.1 trail for a list of registry crumbs (see `breadcrumb`): the deepest node
 * naming `shell.trailRoot` replaces everything above it with that group's label — «الإعدادات /
 * الأتمتة والواتساب / القواعد», «التشغيل / السجل العام» — and a part that repeats the text of the
 * one before it is dropped, so a section and its only page never read «عروض الأسعار / عروض
 * الأسعار». The root is a label (`node: null`), not a link.
 */
export function shellTrail(crumbs: NavNode[], lang: string, v?: Viewer): TrailPart[] {
  let from = 0;
  let root: string | null = null;
  crumbs.forEach((c, i) => { if (c.shell?.trailRoot) { from = i; root = c.shell.trailRoot; } });
  // A node whose own-work wording applies to this viewer and names an own crumb starts the
  // trail there, in that wording: the rep's «أدائي / عمولاتي» rather than «المالية / الأداء
  // والعمولات / عمولاتي». Presentation only — the links are the same nodes.
  const ownAt = v ? crumbs.findIndex((c) => !!c.shell?.own?.crumb && !c.shell.own.unlessAny.some((a) => holds(v, a))) : -1;
  if (ownAt >= from && ownAt !== -1) {
    const c = crumbs[ownAt];
    const oc = c.shell!.own!.crumb!;
    return dedupeTrail([
      { key: c.id, text: lang === "ar" ? oc.ar : oc.en, node: c },
      ...crumbs.slice(ownAt + 1).map((x) => ({ key: x.id, text: crumbText(x, lang), node: x })),
    ]);
  }
  const parts: TrailPart[] = crumbs.slice(from).map((c) => ({ key: c.id, text: crumbText(c, lang), node: c }));
  const label = root ? groupText(root, lang) : null;
  if (root && label) parts.unshift({ key: `grp-${root}`, text: label, node: null });
  return dedupeTrail(parts);
}

/** Drops a trail part whose text repeats the part before it. */
export function dedupeTrail<T extends { text: string }>(parts: T[]): T[] {
  return parts.filter((p, i) => i === 0 || p.text !== parts[i - 1].text);
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
    return n.anyOf.some((r) => meetsModule(v, r));
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
