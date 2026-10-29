"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { useWsBadge } from "@/lib/workspace/badge-client";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Circle, LogOut, UserRound } from "lucide-react";
import {
  NAV, SHELL_GROUP_ORDER, MENU_ORDER, visibleNav, presentTree, resolveActive, resolveHighlight, firstDestination, breadcrumb,
  shellText, crumbText, groupText, shellGroupOf, shellTrail, dedupeTrail,
  type NavNode, type Viewer,
} from "@/lib/nav/registry";
import { ROLE_LABELS, ROLE_LABELS_AR } from "@/lib/auth-shared";
import { NotificationsBell } from "@/components/notifications/NotificationsBell";
import { LanguageToggle } from "./LanguageToggle";
import "./alerts-bell.css";
import { BrandMark } from "@/components/brand/BrandMark";
import { Ico, type D21IconName } from "./icons";
import { createActions } from "./creates";
import { CrumbsContext, PhoneContext, SectionPagesContext, TitleContext, type Crumb, type PhoneHeader, type SectionPages } from "./page-context";
import "./direction-2.1.css";
import { accountantEligible, accountantModeFor, accountantTree, activeAccountantItem, quickCreates, workspaceKey } from "@/lib/nav/accountant";
import { AccountantMore, AccountantNav, WorkspaceSwitch } from "./AccountantNav";
import { ACCOUNTANT_HOME, FULL_HOME, WorkspaceModeContext } from "./workspace-mode";

/**
 * The Direction 2.1 application shell — one shell for every migrated route.
 *
 * Approved design (owner decision, 7 Oct 2026; reference build `direction-2.1-rc`,
 * `screens/shell-1440.html`, `shell-1024.html`, `shell-390.html`; Figma 1JbZgpMqmPkUVne8ms9Ozz,
 * Sidebar 13:322): warm canvas sidebar (244 px) with brand bar, «بحث أو انتقال», the folding
 * groups and the user block at the foot; one white sheet carrying the work, with a 52 px top
 * bar holding the trail and «جديد · C»; a 64 px icon rail from 768 to 1279; below 768 a phone
 * header (mark · title · search), the sheet, and the bottom tab bar.
 *
 * WHAT it shows comes from the one navigation registry: the same permission pruning
 * (`visibleNav`), the same active-route resolution, the same first permitted destination as
 * the legacy shell. How the registry is PRESENTED follows the approved frames through the
 * registry's `shell` hints (labels, grouping, reference icons). Test ids are kept (`nav-*`,
 * `navgroup-*`, `contextual-nav`, `ctx-*`, `breadcrumbs`) so the shell suite drives it.
 *
 * Which routes use it is decided in `./routes.ts`; this component knows nothing about HR or
 * the CRM. A page names itself through `./page-context` (its last crumb, its phone header)
 * and draws its section's pages where the reference puts a Segmented control.
 */

export type ShellUser = { id: string; name: string; role: string };

/** A node as this shell names it — for this viewer when given (`shellText`, the GX rep wording). */
const text = (n: NavNode, lang: string, viewer?: Viewer) => shellText(n, lang, viewer);
/** The full registry as this shell presents it (see `presentTree`); WHERE a path is resolves here. */
const SHELL_NAV = presentTree(NAV);
const pagesOf = (n: NavNode | undefined): NavNode[] => (n?.children ?? []).filter((c) => c.href);
/** Two initials; the Arabic article is skipped, so «نورة الدوسري» reads «ند», not «نا». */
const initials = (name: string) => {
  const parts = name.trim().split(/\s+/).filter(Boolean).map((w) => (w.length > 2 && w.startsWith("ال") ? w.slice(2) : w));
  return ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "")).trim() || "؟";
};

/** The node's icon: the reference set when the frame draws one, lucide otherwise (A-18). */
function NodeIcon({ node, fallback }: { node?: NavNode; fallback?: NavNode }) {
  const ref = node?.shell?.icon ?? fallback?.shell?.icon;
  if (ref) return <Ico name={ref} />;
  const L = node?.icon ?? fallback?.icon ?? Circle;
  return <L aria-hidden />;
}

/**
 * The groups are an accordion (owner, 19 Oct 2026): a heading opens its entries and closes the
 * others. The group holding the current page opens on every navigation; otherwise the last group
 * this person opened on this device is remembered. Presentation only — the entries, their
 * permissions and their routes are exactly what `sidebarGroups` returns.
 */
const OPEN_GROUP_KEY = "hiqbah.nav.openGroup";
const readOpenGroup = (): string | null => { try { return window.localStorage.getItem(OPEN_GROUP_KEY) || null; } catch { return null; } };
const writeOpenGroup = (id: string | null) => { try { window.localStorage.setItem(OPEN_GROUP_KEY, id ?? ""); } catch { /* storage unavailable: the choice lasts this page only */ } };

/**
 * «واجهة المحاسب» / «القائمة الكاملة» — the person's choice, remembered on this device under their own user id (so a
 * shared computer keeps each person's choice). No choice yet: the default of `accountantDefault`. Presentation only.
 */
const readWorkspace = (userId: string): string | null => { try { return window.localStorage.getItem(workspaceKey(userId)); } catch { return null; } };
const writeWorkspace = (userId: string, v: "full" | "accountant") => { try { window.localStorage.setItem(workspaceKey(userId), v); } catch { /* storage unavailable: the choice lasts this page only */ } };

/** The address's query, for the accountant tree's tab items (`?tab=…`). In its own Suspense boundary, as Next requires. */
function SearchSync({ onChange }: { onChange: (s: string) => void }) {
  const params = useSearchParams();
  const s = params.toString();
  useEffect(() => { onChange(s); }, [s, onChange]);
  return null;
}

/** A group heading's icon: the reference set for the shell's own groups, else the module's icon. */
const GROUP_ICONS: Record<string, D21IconName> = {
  orders: "orders", production: "flame", quality: "flask", inventory: "box",
  sales: "deal", finance: "wallet", hr: "users", team: "users", settings: "settings",
};
function GroupIcon({ id }: { id: string }) {
  const ref = GROUP_ICONS[id];
  return ref ? <Ico name={ref} /> : <NodeIcon node={NAV.find((n) => n.id === id)} />;
}

type Item = { node: NavNode; href: string; current: "page" | "true" | undefined };
type Group = { id: string; label: string | null; items: Item[] };
type Dest = { id: string; href: string; text: string; context: string | null; group: string | null; groupLabel: string | null; node: NavNode; ctx: NavNode | null };

/** Where a group sits: the ungrouped entries first, then SHELL_GROUP_ORDER, the gear's screens last. */
const SETTINGS_GROUP = "settings";
const groupRank = (id: string | null) => {
  if (id === null) return -1;
  if (id === SETTINGS_GROUP) return SHELL_GROUP_ORDER.length + 1;
  const i = SHELL_GROUP_ORDER.indexOf(id);
  return i === -1 ? SHELL_GROUP_ORDER.length : i;
};

/**
 * The sidebar: ungrouped entries («لوحة التشغيل · خدماتي»), then flat groups. A module is a
 * group; a hint may move its subunits under another group (stock → «المخزون والمشتريات»), a
 * single subunit into one (the operations module is drawn as «الطلبات · الإنتاج · الجودة»,
 * owner 19 Oct 2026; see `shellGroupOf`), take an entry — or a whole module, as one entry —
 * out to the gear menu, or keep it out of both (`place: "none"`, the global history: reached
 * from the quick jump, lighting «لوحة التشغيل»).
 */
function sidebarGroups(tree: NavNode[], lang: string, active: ReturnType<typeof resolveActive>, viewer: Viewer): { top: Item[]; groups: Group[]; menu: Item[] } {
  const top: Item[] = [];
  const menu: Item[] = [];
  const groups = new Map<string, Group>();
  const into = (gid: string, item: Item) => {
    let g = groups.get(gid);
    if (!g) { g = { id: gid, label: groupText(gid, lang), items: [] }; groups.set(gid, g); }
    g.items.push(item);
  };
  for (const n of tree) {
    if (n.shell?.place === "none") continue;
    if (!n.children) {
      const item: Item = { node: n, href: n.href!, current: active.leaf?.id === n.id ? "page" : undefined };
      const gid = shellGroupOf(n);
      if (n.shell?.place === "menu") menu.push(item);
      else if (gid) into(gid, item);
      else top.push(item);
      continue;
    }
    if (n.shell?.place === "menu") {
      const href = firstDestination(viewer, n);
      if (href) menu.push({ node: n, href, current: active.group?.id === n.id ? "true" : undefined });
      continue;
    }
    for (const sub of n.children) {
      if (sub.shell?.place === "none") continue;
      const href = firstDestination(viewer, sub);
      if (!href) continue;
      const item: Item = { node: sub, href, current: active.subunit?.id === sub.id ? (sub.href ? "page" : "true") : undefined };
      if (sub.shell?.place === "menu") menu.push(item);
      else into(shellGroupOf(sub, n) ?? n.id, item);
    }
  }
  const ordered = [...groups.values()].filter((g) => g.items.length > 0).sort((a, b) => groupRank(a.id) - groupRank(b.id));
  const menuRank = (id: string) => { const i = MENU_ORDER.indexOf(id); return i === -1 ? MENU_ORDER.length : i; };
  menu.sort((a, b) => menuRank(a.node.id) - menuRank(b.node.id));
  return { top, groups: ordered, menu };
}

/**
 * Ctrl K: every destination, grouped and ordered as the sidebar draws them, with the gear's
 * screens last under «الإعدادات». `context` names the section a page sits in when it is not
 * the group itself («العملاء» for the leads, «الأتمتة والواتساب» for its rules).
 */
function destinations(tree: NavNode[], lang: string, viewer: Viewer): Dest[] {
  const out: Dest[] = [];
  const seen = new Set<string>();
  const add = (n: NavNode, group: string | null, parent: NavNode | null, mod: NavNode | null) => {
    if (!n.href || seen.has(n.href)) return;
    seen.add(n.href);
    out.push({
      id: n.id, href: n.href, text: text(n, lang, viewer),
      context: parent ? text(parent, lang, viewer) : null,
      group, groupLabel: group ? groupText(group, lang) : null, node: n, ctx: parent ?? mod,
    });
  };
  const walk = (nodes: NavNode[], group: string | null, parent: NavNode | null, mod: NavNode | null) => {
    for (const n of nodes) {
      add(n, group, parent, mod);
      if (n.children) walk(n.children, group, n, mod);
    }
  };
  for (const n of tree) {
    const inMenu = n.shell?.place === "menu";
    if (!n.children) { add(n, inMenu ? SETTINGS_GROUP : shellGroupOf(n), null, null); continue; }
    for (const sub of n.children) {
      const group = inMenu || sub.shell?.place === "menu" ? SETTINGS_GROUP : shellGroupOf(sub, n) ?? n.id;
      // A gear-menu module keeps its own name as the context («الأتمتة والواتساب»).
      add(sub, group, inMenu ? n : null, n);
      if (sub.children) walk(sub.children, group, sub, n);
    }
  }
  return out
    .map((d, i) => ({ d, i }))
    .sort((a, b) => groupRank(a.d.group) - groupRank(b.d.group) || a.i - b.i)
    .map(({ d }) => d);
}

export function AppShell({
  user, viewer, lang, allowed, onLogout, deniedTitle, deniedBody, homeLabel, children,
}: {
  user: ShellUser;
  viewer: Viewer;
  lang: string;
  allowed: boolean;
  onLogout: () => void;
  deniedTitle: string;
  deniedBody: string;
  homeLabel: string;
  children: ReactNode;
}) {
  const ar = lang === "ar";
  const pathname = usePathname();
  // The viewer's tree as the approved frames present it (`presentTree`: «الطلبات» in «التشغيل»
  // for every persona, N-02); resolution uses the same presentation of the full registry.
  const tree = useMemo(() => presentTree(visibleNav(viewer)), [viewer]);
  // «واجهة المحاسب» (Qoyod-parity program): drawn for an accounting holder unless they chose the full menu.
  // Everybody else: `acctMode` is false and nothing below differs from the system shell.
  const eligible = accountantEligible(viewer);
  const [savedMode, setSavedMode] = useState<string | null>(() => (typeof window === "undefined" ? null : readWorkspace(user.id)));
  const acctMode = accountantModeFor(viewer, savedMode);
  const wsHome = acctMode ? ACCOUNTANT_HOME : FULL_HOME;
  const [search, setSearch] = useState("");
  const acctTree = useMemo(() => (acctMode ? accountantTree(viewer, lang) : []), [acctMode, viewer, lang]);
  const acctActive = useMemo(() => (acctMode ? activeAccountantItem(acctTree, pathname, search) : null), [acctMode, acctTree, pathname, search]);
  // WHERE you are is resolved against the full registry; WHAT you may follow is the pruned
  // tree. Resolving against the pruned tree mislabels a refused page: without the leave duty,
  // /dashboard/hr/leave would fall through to /dashboard/hr and read «الموظفون».
  // One exception: a route placed twice on purpose (orders: Sales work for a seller,
  // Operations work for everyone else) is labelled by the placement THIS viewer may follow,
  // so a dispatch login on /dashboard/orders is not told it is in Sales. The pruned tree is
  // trusted only when it lands on the same destination the full registry does.
  const locus = useMemo(() => {
    const full = resolveActive(pathname, SHELL_NAV);
    const own = resolveActive(pathname, tree);
    return own.leaf && full.leaf && own.leaf.href === full.leaf.href ? tree : SHELL_NAV;
  }, [pathname, tree]);
  // The signed-in user's own account («ملفي الشخصي») belongs to no module: Figma TD-11 (556:4350)
  // lights no sidebar entry and names it «الحساب / …» in the trail (the page names the last crumb).
  const ownAccount = pathname === "/dashboard/profile" || pathname.startsWith("/dashboard/profile/");
  const active = useMemo(() => (ownAccount ? {} : resolveActive(pathname, locus)), [pathname, locus, ownAccount]);
  // What the sidebar (and so the rail) and «المزيد» highlight: the same trail as `active` unless
  // the page's node names `highlightAs` (G-11). The breadcrumb and the page tabs keep `active`.
  const lit = useMemo(() => resolveHighlight(active, tree), [active, tree]);
  const crumbs = useMemo(() => (ownAccount ? [] : breadcrumb(pathname, locus)), [pathname, locus, ownAccount]);
  const visibleSub = useMemo(() => (active.subunit ? tree.flatMap((n) => n.children ?? []).find((c) => c.id === active.subunit!.id) : undefined), [active.subunit, tree]);
  const pages = pagesOf(visibleSub);
  const leafIsPage = !!active.leaf && pages.some((p) => p.id === active.leaf!.id);
  const showSeg = pages.length >= 2 && allowed;

  // What the page says about itself.
  const [title, setTitle] = useState<string | null>(null);
  const [phoneHeader, setPhoneHeader] = useState<PhoneHeader | null>(null);
  const setTitleStable = useCallback((t: string | null) => setTitle(t), []);
  const [extraCrumbs, setExtraCrumbs] = useState<Crumb[] | null>(null);
  const setCrumbsStable = useCallback((c: Crumb[] | null) => setExtraCrumbs(c), []);
  const setPhoneStable = useCallback((h: PhoneHeader | null) => setPhoneHeader(h), []);

  // The trail (reference `.top .crumb`): module / section / page — a list page keeps its own
  // crumb even with the section's pages in the Segmented control («المبيعات / العملاء / العملاء
  // المحتملون», N-17); a record page ends with the record's own name instead of the page
  // («المبيعات / الصفقات / محمصة النخبة — …»).
  // A node naming `shell.trailRoot` starts the trail with that group's label (a label, not a
  // link): «التشغيل / لوحة التشغيل» (20:236 top bar 101:6411), «التشغيل / السجل العام» (GX D-P02),
  // «الإعدادات / الأتمتة والواتساب / القواعد» (GX E-P01). A part repeating the one before it is
  // dropped — «المبيعات / عروض الأسعار», never «… / عروض الأسعار / عروض الأسعار».
  const trail = useMemo(() => {
    // The accountant workspace names the page as Qoyod does: «المبيعات / فواتير المبيعات», «الصفحة الرئيسية / لوحة المتابعة».
    if (acctMode && acctActive) {
      // «القسم / الصفحة» (Qoyod); only the dashboard starts with «الصفحة الرئيسية» (QOYOD-REF §0.2).
      const parts: { key: string; text: string; href: string | null }[] = acctActive.item ? [] : [{ key: "acct-home", text: ar ? "الصفحة الرئيسية" : "Home", href: ACCOUNTANT_HOME }];
      if (acctActive.item) {
        parts.push({ key: acctActive.group.id, text: acctActive.group.label, href: null });
        parts.push({ key: acctActive.item.id, text: acctActive.item.label, href: title ? acctActive.item.href : null });
      } else {
        parts.push({ key: acctActive.group.id, text: acctActive.group.label, href: title ? acctActive.group.href : null });
      }
      if (title) (extraCrumbs ?? []).forEach((c, i) => parts.push({ key: `extra-${i}`, text: c.text, href: c.href ?? null }));
      if (title) parts.push({ key: "title", text: title, href: null });
      return dedupeTrail(parts);
    }
    const base = showSeg && leafIsPage && title ? crumbs.slice(0, -1) : crumbs;
    const shown = shellTrail(base, lang, viewer);
    const parts: { key: string; text: string; href: string | null }[] = shown.map((p, i) => ({
      key: p.key, text: p.text, href: !p.node || (i === shown.length - 1 && !title) ? null : firstDestination(viewer, p.node),
    }));
    if (ownAccount && title) parts.push({ key: "account", text: lang === "ar" ? "الحساب" : "Account", href: null });
    // A record inside a section without a registry node of its own names that section too.
    if (title) (extraCrumbs ?? []).forEach((c, i) => parts.push({ key: `extra-${i}`, text: c.text, href: c.href ?? null }));
    if (title) parts.push({ key: "title", text: title, href: null });
    return dedupeTrail(parts);
  }, [crumbs, showSeg, leafIsPage, title, lang, viewer, ownAccount, extraCrumbs, acctMode, acctActive, ar]);

  const workspaceMode = useMemo(() => ({ accountant: acctMode, home: wsHome }), [acctMode, wsHome]);
  const sectionPages: SectionPages = useMemo(() => showSeg ? {
    label: ar ? "صفحات القسم" : "Section pages",
    pages: pages.map((p) => ({ id: p.id, href: p.href!, text: text(p, lang, viewer), current: active.leaf?.id === p.id })),
  } : null, [showSeg, pages, ar, lang, active.leaf, viewer]);

  const [palette, setPalette] = useState(false);
  const [more, setMore] = useState(false);
  const [menu, setMenu] = useState(false);
  // Which «جديد» menu is open: the top bar's (desktop and rail) or the phone «+»'s. One at a time.
  const [create, setCreate] = useState<"top" | "fab" | null>(null);
  const moreRef = useRef<HTMLButtonElement | null>(null);
  // The control an overlay was opened from. Focus goes back to it only after the overlay is
  // gone AND the page behind is no longer inert — focusing inside an inert subtree is refused
  // by the browser, which is why this is an effect and not part of the close handler.
  const returnTo = useRef<HTMLElement | null>(null);
  const openPalette = () => { returnTo.current = document.activeElement as HTMLElement | null; setPalette(true); };
  const openMore = () => { returnTo.current = moreRef.current; setMore(true); };
  useEffect(() => {
    if (palette || more || !returnTo.current) return;
    returnTo.current.focus();
    returnTo.current = null;
  }, [palette, more]);

  // «جديد» offers the create actions of the module you are in (owner decision A-3): several →
  // a menu, exactly one → the control opens it directly, none → no control.
  const router = useRouter();
  // «لوحة المتابعة» is the accountant workspace's landing page: the dashboard address opens it.
  useEffect(() => { if (acctMode && pathname === FULL_HOME) router.replace(ACCOUNTANT_HOME); }, [acctMode, pathname, router]);
  // A top-level entry naming `shell.creates` (the operations dashboard and the global history)
  // offers that module's create actions, as the frame's top bar «جديد · C» shows (20:236).
  const moduleId = active.group?.id ?? active.leaf?.shell?.creates;
  // In the accountant workspace «جديد» is «الإنشاء السريع»: every «+» of the accountant tree (the rail and the phone
  // have no sidebar menu for it). The same entries, the same permissions — see `quickCreates`.
  const acctQuick = useMemo(() => {
    if (!acctMode) return [];
    const en = quickCreates(viewer, "en");
    return quickCreates(viewer, "ar").map((c, i) => ({ id: c.id, labelAr: c.label, labelEn: en[i]?.label ?? c.label, href: c.href, permitted: () => true }));
  }, [acctMode, viewer]);
  const creates = useMemo(() => (!allowed ? [] : acctMode ? acctQuick : createActions(viewer, moduleId)), [viewer, moduleId, allowed, acctMode, acctQuick]);
  const single = creates.length === 1 ? creates[0] : null;
  const singleHref = single?.href ?? null;

  // Ctrl/⌘ K opens the quick jump from anywhere, as the approved sidebar advertises; a bare
  // «C» opens «جديد» (reference top bar), never while typing or while a dialog is open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        if (!document.querySelector(".d21-pal")) { returnTo.current = document.activeElement as HTMLElement | null; setPalette(true); }
        return;
      }
      if (e.key === "Escape") { setMenu(false); setCreate(null); return; }
      const t = e.target as HTMLElement | null;
      const typing = !!t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
      if (!typing && !e.ctrlKey && !e.metaKey && !e.altKey && e.key.toLowerCase() === "c" && !document.querySelector("[role=dialog]")) {
        if (singleHref) router.push(singleHref);
        else if (creates.length > 0) { const at = window.matchMedia("(max-width: 767.98px)").matches ? "fab" : "top"; setCreate((v) => (v ? null : at)); }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [creates.length, singleHref, router]);
  // The two small menus close on a click anywhere else.
  useEffect(() => {
    if (!menu && !create) return;
    const close = (e: MouseEvent) => {
      const el = e.target as HTMLElement;
      if (!el.closest("[data-d21-menu]")) setMenu(false);
      if (!el.closest("[data-d21-new]")) setCreate(null);
    };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [menu, create]);
  // The phone's «المزيد» sheet does not outlive the phone width: widening the window to a
  // permanent sidebar must not leave the whole application inert behind an invisible sheet.
  useEffect(() => {
    const phone = window.matchMedia("(max-width: 767.98px)");
    const onChange = () => { if (!phone.matches) setMore(false); };
    phone.addEventListener("change", onChange);
    return () => phone.removeEventListener("change", onChange);
  }, []);
  // A page change closes the overlays.
  const [seenPath, setSeenPath] = useState(pathname);
  if (seenPath !== pathname) { setSeenPath(pathname); setMore(false); setPalette(false); setMenu(false); setCreate(null); }

  const { top, groups, menu: menuItems } = useMemo(() => sidebarGroups(tree, lang, lit, viewer), [tree, lang, lit, viewer]);
  const roleLabel = (ar ? ROLE_LABELS_AR[user.role] : ROLE_LABELS[user.role]) || user.role;
  // «مساحة عملي»: overdue + due today + waiting for my decision, refreshed on navigation and every 2 min.
  const wsBadge = useWorkspaceBadge(tree.some((n) => n.id === "workspace"), pathname);

  const navItem = (it: Item, parent?: NavNode) => {
    const label = text(it.node, lang, viewer);
    return (
      <li key={it.node.id}>
        <Link href={it.href} className="d21-nav" aria-current={it.current} data-testid={`nav-${it.node.id}`} title={label}>
          <NodeIcon node={it.node} fallback={parent} />
          <span>{label}</span>
          {it.node.id === "workspace" && wsBadge > 0 ? (
            <span className="d21-badge" data-testid="nav-workspace-badge" aria-label={ar ? `${wsBadge} بحاجة إلى تصرفك` : `${wsBadge} need your action`}>{wsBadge > 99 ? "99+" : wsBadge}</span>
          ) : null}
        </Link>
      </li>
    );
  };

  // The phone tab bar's section tab: the sidebar group holding the lit entry, opening on its first page.
  // Outside the sidebar groups (a gear-menu screen) it is the registry module, as before.
  const litGroup = groups.find((g) => g.items.some((it) => it.current));
  // The accordion (sidebar, rail and «المزيد» share it): the current page's group opens on every
  // navigation; a page outside the groups keeps whatever was open.
  // A gear-menu screen opens «الحساب والإعدادات» in «المزيد» (the sidebar has no such group).
  const acctLit = acctActive && acctActive.item ? acctActive.group.id : null;
  const litGroupId = acctMode ? acctLit : litGroup?.id ?? (menuItems.some((it) => it.current) ? SETTINGS_GROUP : null);
  const [openGroup, setOpenGroup] = useState<string | null>(litGroupId);
  const [openFor, setOpenFor] = useState(pathname);
  if (openFor !== pathname) { setOpenFor(pathname); if (litGroupId) setOpenGroup(litGroupId); }
  // With no current group (the dashboard, the profile), the group last opened on this device.
  // Read after mount: the server cannot see this device's storage.
  const restoredOpen = useRef(false);
  useEffect(() => {
    if (restoredOpen.current) return;
    restoredOpen.current = true;
    if (litGroupId) return;
    const saved = readOpenGroup();
    if (saved) setOpenGroup(saved); // eslint-disable-line react-hooks/set-state-in-effect -- the saved choice exists only in the browser
  }, [litGroupId]);
  const toggleGroup = (id: string) => {
    const next = openGroup === id ? null : id;
    setOpenGroup(next);
    writeOpenGroup(next);
  };
  const switchWorkspace = (toAccountant: boolean) => {
    const v = toAccountant ? "accountant" : "full";
    writeWorkspace(user.id, v);
    setSavedMode(v);
    setOpenGroup(null);
    router.push(toAccountant ? ACCOUNTANT_HOME : FULL_HOME);
  };
  const moduleHref = !litGroup && active.group ? firstDestination(viewer, active.group) : null;
  const meNode = tree.find((n) => n.id === "me");
  const wsNode = tree.find((n) => n.id === "workspace");
  const dests = useMemo(() => destinations(tree, lang, viewer), [tree, lang, viewer]);
  // The phone header keeps naming the section on a list page with a Segmented control (reference
  // crm-390: «الصفقات» over the pipeline); otherwise it names the last crumb.
  const sectionCrumbs = showSeg && leafIsPage && !title && active.leaf?.href && pathname === active.leaf.href ? crumbs.slice(0, -1) : null;
  const lastCrumb = sectionCrumbs?.length ? crumbText(sectionCrumbs[sectionCrumbs.length - 1], lang) : trail.length ? trail[trail.length - 1].text : "";
  const phoneTitle = phoneHeader?.title ?? title ?? lastCrumb;

  const createMenu = (dir: "down" | "up") => (
    <div className={`d21-menu ${dir}`} role="menu">
      {creates.map((c) => (
        <Link key={c.id} role="menuitem" href={c.href} data-testid={`d21-new-${c.id}`} onClick={() => setCreate(null)}>{ar ? c.labelAr : c.labelEn}</Link>
      ))}
    </div>
  );

  return (
    <TitleContext value={setTitleStable}>
    <CrumbsContext value={setCrumbsStable}>
    <PhoneContext value={setPhoneStable}>
    <SectionPagesContext value={sectionPages}>
    <WorkspaceModeContext value={workspaceMode}>
    <div className="d21" lang={lang} dir={ar ? "rtl" : "ltr"} data-shell="d21">
      {/* IBM Plex, self-hosted (public/fonts): the same faces, files and unicode-range subsets
          Google Fonts served, so nothing is fetched from a third party. */}
      <link rel="stylesheet" precedence="default" href="/fonts/ibm-plex.css" />
      <a className="d21-skip" href="#d21-content">{ar ? "تجاوز إلى المحتوى" : "Skip to content"}</a>
      <div className="d21-app" inert={palette || more}>
        <aside className="d21-side" aria-label={ar ? "القائمة الجانبية" : "Sidebar"}>
          <div className="d21-brandbar">
            <span className="d21-mark"><BrandMark /></span>
            {/* The EN frames write the name in Latin letters (N-18); the Arabic shell keeps «حِقبة». */}
            <div className="t"><b>{ar ? "حِقبة" : "Hiqbah"}</b><span>{ar ? "مقهى ومحمصة" : "Café & roastery"}</span></div>
          </div>
          <button type="button" className="d21-find" onClick={openPalette} aria-label={ar ? "بحث أو انتقال (Ctrl K)" : "Search or jump (Ctrl K)"} aria-haspopup="dialog">
            <Ico name="search" small />
            <span className="lbl">{ar ? "بحث أو انتقال" : "Search or jump"}</span>
            <span className="d21-kbd" aria-hidden>Ctrl K</span>
          </button>
          <Suspense fallback={null}><SearchSync onChange={setSearch} /></Suspense>
          {acctMode ? (
            <AccountantNav lang={lang} tree={acctTree} creates={acctQuick.map((c) => ({ id: c.id, label: ar ? c.labelAr : c.labelEn, href: c.href }))}
              activeGroup={acctActive?.group.id ?? null} activeItem={acctActive?.item?.id ?? null} openGroup={openGroup} onToggleGroup={toggleGroup} />
          ) : (
            <nav aria-label={ar ? "التنقل الرئيسي" : "Main"}>
              <ul className="d21-navlist">{top.map((it) => navItem(it))}</ul>
              {groups.map((g) => {
                const gid = `d21-grp-${g.id}`;
                const pid = `d21-grp-panel-${g.id}`;
                const mod = NAV.find((n) => n.id === g.id);
                const isOpen = openGroup === g.id;
                return (
                  <div key={g.id} className="d21-grpbox" role="group" aria-labelledby={gid}>
                    {/* The heading opens and closes its entries (a native button: Enter and Space). */}
                    <button type="button" className="d21-grp" id={gid} data-testid={`navgroup-${g.id}`}
                      aria-expanded={isOpen} aria-controls={pid} data-current={g.id === litGroupId ? "true" : undefined}
                      title={g.label ?? undefined} onClick={() => toggleGroup(g.id)}>
                      <GroupIcon id={g.id} /><span>{g.label ?? g.id}</span><Ico name="chevd" small className="chev" />
                    </button>
                    <div className="d21-acc" id={pid} data-open={isOpen ? "true" : undefined}>
                      <div className="d21-acc-in"><ul className="d21-navlist">{g.items.map((it) => navItem(it, mod))}</ul></div>
                    </div>
                  </div>
                );
              })}
            </nav>
          )}
          {eligible ? <WorkspaceSwitch lang={lang} accountant={acctMode} onChange={switchWorkspace} /> : null}
          {/* The user block (reference `.me`): avatar, name and role, the gear. One control: it
              opens the account menu — profile, settings, sign out — on the rail too, where only
              the avatar is drawn. */}
          <div className="d21-me" data-d21-menu>
            <button type="button" className="d21-me-btn" aria-haspopup="menu" aria-expanded={menu}
              aria-label={ar ? `${user.name} — الإعدادات والحساب` : `${user.name} — Settings and account`}
              title={user.name} onClick={() => setMenu((v) => !v)}>
              <span className="d21-av" aria-hidden>{initials(user.name)}</span>
              <span className="who"><b>{user.name}</b><small>{roleLabel}</small></span>
              <span className="gear" aria-hidden><Ico name="settings" small /></span>
            </button>
            {menu ? (
              <div className="d21-menu" role="menu">
                {/* The profile, then the settings screens (registry MENU_ORDER, GX F-P01). */}
                {menuItems.map((it) => (
                  <Link key={it.node.id} role="menuitem" href={it.href} data-testid={`nav-${it.node.id}`} onClick={() => setMenu(false)}>{text(it.node, lang, viewer)}</Link>
                ))}
                {/* The quick language switch, also here (owner, 25 Oct 2026): the account menu is where
                    SaaS dashboards keep it; the top bar's «EN / عربي» is the one-tap path. */}
                <LanguageToggle variant="menu" onDone={() => setMenu(false)} />
                <button role="menuitem" type="button" className="danger" onClick={onLogout}>{ar ? "تسجيل الخروج" : "Sign out"}</button>
              </div>
            ) : null}
          </div>
        </aside>

        {/* The phone header (reference `.ph-top`): the mark, the page title, the search — or a
            record page's back arrow and the page's own action. */}
        <header className="d21-mtop">
          <span className="d21-mark sm"><BrandMark /></span>
          {phoneHeader?.back ? (
            <Link href={phoneHeader.back} className="d21-ib back" aria-label={ar ? "رجوع" : "Back"}><Ico name="back" /></Link>
          ) : null}
          <div className="t">
            <h2>{phoneTitle}</h2>
            {phoneHeader?.sub ? <div className="sub">{phoneHeader.sub}</div> : null}
          </div>
          <span className="sp" />
          {/* The quick language switch: one tap from every screen, beside the bell (owner, 25 Oct 2026). */}
          <LanguageToggle testId="lang-toggle-phone" />
          {!phoneHeader?.back ? <NotificationsBell lang={ar ? "ar" : "en"} phone /> : null}
          {phoneHeader?.action ? (
            <Link href={phoneHeader.action.href} className="d21-ib" aria-label={phoneHeader.action.label} data-testid="ph-action"><Ico name={phoneHeader.action.icon} /></Link>
          ) : !phoneHeader?.back ? (
            <button type="button" className="d21-ib" onClick={openPalette} aria-haspopup="dialog" aria-label={ar ? "بحث أو انتقال" : "Search or jump"}><Ico name="search" /></button>
          ) : null}
        </header>

        <div className="d21-main">
          <div className="d21-sheet">
            <div className="d21-top">
              {trail.length > 0 ? (
                <nav className="d21-crumb" aria-label={ar ? "مسار التنقل" : "Breadcrumb"} data-testid="breadcrumbs">
                  <ol>
                    {trail.map((c, i) => {
                      const last = i === trail.length - 1;
                      return <li key={c.key}>{c.href && c.href !== pathname ? <Link href={c.href}>{c.text}</Link> : <span aria-current={last ? "page" : undefined}>{c.text}</span>}</li>;
                    })}
                  </ol>
                </nav>
              ) : null}
              <span className="sp" />
              {/* feat/notifications: «التنبيهات», the bell of every signed-in account (the storage
                  alerts of feat/credit-hold are its «system» notifications). */}
              {/* The quick language switch (owner, 25 Oct 2026): «EN» / «عربي», one tap, in place. */}
              <LanguageToggle />
              <NotificationsBell lang={ar ? "ar" : "en"} />
              {single ? (
                <div className="d21-new" data-d21-new>
                  <Link href={single.href} className="d21-btn g sm" data-testid="d21-new" title={ar ? single.labelAr : single.labelEn}
                    aria-label={ar ? `جديد: ${single.labelAr}` : `New: ${single.labelEn}`}>
                    <Ico name="plus" small />{ar ? "جديد" : "New"}
                  </Link>
                  <span className="d21-kbd" aria-hidden>C</span>
                </div>
              ) : creates.length > 1 ? (
                <div className="d21-new" data-d21-new>
                  <button type="button" className="d21-btn g sm" aria-haspopup="menu" aria-expanded={create === "top"} data-testid="d21-new" onClick={() => setCreate((v) => (v === "top" ? null : "top"))}>
                    <Ico name="plus" small />{ar ? "جديد" : "New"}
                  </button>
                  <span className="d21-kbd" aria-hidden>C</span>
                  {create === "top" ? createMenu("down") : null}
                </div>
              ) : null}
            </div>
            <main id="d21-content" className="d21-body" tabIndex={-1}>
              {allowed ? children : (
                <div className="d21-denied" role="alert">
                  <h1>{deniedTitle}</h1>
                  <p>{deniedBody}</p>
                  <Link href={wsHome} className="d21-btn p">{homeLabel}</Link>
                </div>
              )}
            </main>
          </div>
        </div>

        {/* The bottom tab bar (reference MobileTabBar): الرئيسية · the inbox (none exists in
            the ERP, so the current module) · «+» only when there is something to create · خدماتي
            · المزيد. A page with its own sticky action bar takes its place. */}
        {!phoneHeader?.ownBar ? (
          <nav className="d21-tabbar" aria-label={ar ? "التنقل السريع" : "Quick navigation"}>
            <Link href={wsHome} aria-current={pathname === wsHome ? "page" : undefined}><Ico name="home" />{ar ? "الرئيسية" : "Home"}</Link>
            {acctMode ? (acctActive && acctActive.item && acctActive.item.href ? <Link href={acctActive.item.href} aria-current="true" data-testid="tab-group"><Ico name={acctActive.group.icon} />{acctActive.group.label}</Link> : null)
              : litGroup && litGroup.label ? <Link href={litGroup.items[0].href} aria-current="true" data-testid="tab-group"><NodeIcon node={litGroup.items[0].node} fallback={NAV.find((n) => n.id === litGroup.id)} />{litGroup.label}</Link>
              : active.group && moduleHref ? <Link href={moduleHref} aria-current="true" data-testid="tab-group"><NodeIcon node={active.group} />{text(active.group, lang)}</Link>
              // «مساحة عملي» takes the slot when no section holds it (the workspace itself, the dashboard,
              // «خدماتي»): the reference's «الوارد» position, never displacing the current section.
              : wsNode ? <Link href={wsNode.href!} aria-current={active.leaf?.id === "workspace" ? "page" : undefined} data-testid="tab-workspace" className="d21-tab-ws"><Ico name="inbox" />{text(wsNode, lang)}{wsBadge > 0 ? <span className="d21-badge" aria-label={ar ? `${wsBadge} بحاجة إلى تصرفك` : `${wsBadge} need your action`}>{wsBadge > 99 ? "99+" : wsBadge}</span> : null}</Link> : null}
            {single ? (
              <div className="d21-fab-slot" data-d21-new>
                <Link href={single.href} className="d21-fab" aria-label={ar ? `جديد: ${single.labelAr}` : `New: ${single.labelEn}`} data-testid="d21-fab"><Ico name="plus" /></Link>
              </div>
            ) : creates.length > 1 ? (
              <div className="d21-fab-slot" data-d21-new>
                <button type="button" className="d21-fab" aria-haspopup="menu" aria-expanded={create === "fab"} aria-label={ar ? "جديد" : "New"} data-testid="d21-fab" onClick={() => setCreate((v) => (v === "fab" ? null : "fab"))}><Ico name="plus" /></button>
                {create === "fab" ? createMenu("up") : null}
              </div>
            ) : null}
            {meNode ? <Link href={meNode.href!} aria-current={active.leaf?.id === "me" ? "page" : undefined}><UserRound aria-hidden />{text(meNode, lang)}</Link> : null}
            <button ref={moreRef} type="button" onClick={openMore} aria-haspopup="dialog" aria-expanded={more}><Ico name="more" />{ar ? "المزيد" : "More"}</button>
          </nav>
        ) : null}
      </div>

      {palette ? <QuickJump lang={lang} dests={dests} onClose={() => setPalette(false)} /> : null}
      {more ? (
        <MoreSheet lang={lang} onClose={() => setMore(false)}>
          <div className="d21-more-me">
            <span className="d21-av">{initials(user.name)}</span>
            <div>{user.name}<small>{roleLabel}</small></div>
          </div>
          {/* Every section under its heading, exactly as the sidebar groups them (owner, 19 Oct 2026),
              each one opening and closing like the sidebar's; the ungrouped entries stay listed. */}
          {acctMode ? <AccountantMore lang={lang} tree={acctTree} activeItem={acctActive?.item?.id ?? null} activeGroup={acctActive?.group.id ?? null} openGroup={openGroup} onToggleGroup={toggleGroup} /> : null}
          {!acctMode && top.length > 0 ? (
            <div role="group" data-testid="moregroup-top">
              {top.map((it) => (
                <Link key={it.node.id} href={it.href} className="d21-more-row" aria-current={it.current ? "page" : undefined} data-testid={`more-${it.node.id}`}>
                  <NodeIcon node={it.node} /><span>{text(it.node, lang, viewer)}</span><Ico name="chev" small className="chev" />
                </Link>
              ))}
            </div>
          ) : null}
          {[...(acctMode ? [] : groups), ...(menuItems.length > 0 ? [{ id: SETTINGS_GROUP, label: ar ? "الحساب والإعدادات" : "Account & settings", items: menuItems } as Group] : [])].map((g) => {
            const parent = g.id === SETTINGS_GROUP ? undefined : NAV.find((n) => n.id === g.id);
            const hid = `d21-more-grp-${g.id}`;
            const pid = `d21-more-panel-${g.id}`;
            const isOpen = openGroup === g.id;
            const settings = g.id === SETTINGS_GROUP;
            return (
              <div key={g.id} role="group" aria-labelledby={hid} data-testid={`moregroup-${g.id}`}>
                <button type="button" className="d21-more-grp" id={hid} aria-expanded={isOpen} aria-controls={pid}
                  data-current={g.id === litGroupId ? "true" : undefined} onClick={() => toggleGroup(g.id)}>
                  <GroupIcon id={g.id} /><span>{g.label ?? g.id}</span><Ico name="chevd" small className="chev" />
                </button>
                <div className="d21-acc" id={pid} data-open={isOpen ? "true" : undefined}>
                  <div className="d21-acc-in">
                    {g.items.map((it) => (
                      <Link key={it.node.id} href={it.href} className="d21-more-row" aria-current={!settings && it.current ? "page" : undefined} data-testid={settings ? undefined : `more-${it.node.id}`}>
                        <NodeIcon node={it.node} fallback={parent} /><span>{text(it.node, lang, viewer)}</span><Ico name="chev" small className="chev" />
                      </Link>
                    ))}
                  </div>
                </div>
              </div>
            );
          })}
          {eligible ? <WorkspaceSwitch lang={lang} accountant={acctMode} onChange={switchWorkspace} variant="row" /> : null}
          <LanguageToggle variant="row" onDone={() => setMore(false)} />
          <button type="button" className="d21-more-row danger" onClick={onLogout}><LogOut aria-hidden /><span>{ar ? "تسجيل الخروج" : "Sign out"}</span></button>
        </MoreSheet>
      ) : null}
    </div>
    </WorkspaceModeContext>
    </SectionPagesContext>
    </PhoneContext>
    </CrumbsContext>
    </TitleContext>
  );
}

/** Focus trap shared by both overlays: Tab cycles inside, Escape closes. */
function useTrap(onClose: () => void) {
  const ref = useRef<HTMLDivElement | null>(null);
  const close = useRef(onClose);
  useEffect(() => { close.current = onClose; });
  useEffect(() => {
    const el = ref.current;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); close.current(); return; }
      if (e.key !== "Tab" || !el) return;
      const f = Array.from(el.querySelectorAll<HTMLElement>('a[href],button:not([disabled]),input,[tabindex]:not([tabindex="-1"])'));
      if (f.length === 0) return;
      const first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
  return ref;
}

/** Ctrl K: every destination the viewer may open (reference `palette-1440`). Navigation only — records are not searched. */
function QuickJump({ lang, dests, onClose }: { lang: string; dests: Dest[]; onClose: () => void }) {
  const ar = lang === "ar";
  const router = useRouter();
  const ref = useTrap(onClose);
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const query = q.trim();
  const hit = (s: string | null) => !!s && (s.includes(query) || s.toLowerCase().includes(query.toLowerCase()));
  const list = query ? dests.filter((d) => hit(d.text) || hit(d.context) || hit(d.groupLabel)) : dests;
  // The list keeps the sidebar's groups: a heading wherever the group changes.
  const blocks: { key: string; label: string | null; items: { d: Dest; i: number }[] }[] = [];
  list.forEach((d, i) => {
    const last = blocks[blocks.length - 1];
    if (last && last.key === (d.group ?? "top")) last.items.push({ d, i });
    else blocks.push({ key: d.group ?? "top", label: d.groupLabel, items: [{ d, i }] });
  });
  const cur = Math.min(sel, Math.max(0, list.length - 1));
  const go = (d: Dest | undefined) => { if (d) { router.push(d.href); onClose(); } };
  return (
    <>
      <div className="d21-scrim" onClick={onClose} />
      <div ref={ref} className="d21-pal" role="dialog" aria-modal="true" aria-label={ar ? "بحث أو انتقال" : "Search or jump"}>
        <div className="d21-pal-in">
          <Ico name="search" />
          <input
            autoFocus
            role="combobox"
            aria-expanded="true"
            aria-controls="d21-pal-list"
            aria-activedescendant={list[cur] ? `d21-pal-${list[cur].id}` : undefined}
            aria-label={ar ? "اكتب اسم الصفحة" : "Type a page name"}
            placeholder={ar ? "اكتب اسم الصفحة…" : "Type a page name…"}
            value={q}
            onChange={(e) => { setQ(e.target.value); setSel(0); }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") { e.preventDefault(); setSel(Math.min(cur + 1, list.length - 1)); }
              else if (e.key === "ArrowUp") { e.preventDefault(); setSel(Math.max(cur - 1, 0)); }
              else if (e.key === "Enter") { e.preventDefault(); go(list[cur]); }
            }}
          />
          <span className="d21-kbd" aria-hidden>Esc</span>
        </div>
        {list.length === 0 ? <p className="empty" role="status">{ar ? "لا توجد صفحة بهذا الاسم ضمن صلاحياتك." : "No page with that name in your access."}</p> : (
          <div id="d21-pal-list" role="listbox" aria-label={ar ? "الصفحات" : "Pages"} className="d21-pal-list">
            {blocks.map((b) => (
              <ul key={b.key} role="group" aria-label={b.label ?? (ar ? "عام" : "General")} data-testid={`palgroup-${b.key}`}>
                {b.label ? <li role="presentation" className="d21-pal-grp" aria-hidden>{b.label}</li> : null}
                {b.items.map(({ d, i }) => (
                  <li key={d.id} role="option" id={`d21-pal-${d.id}`} aria-selected={i === cur}>
                    <a href={d.href} tabIndex={-1} data-active={i === cur} onMouseEnter={() => setSel(i)} onClick={(e) => { e.preventDefault(); go(d); }}>
                      <NodeIcon node={d.node} fallback={d.ctx ?? undefined} /><span><b>{d.text}</b>{d.context ? <small>{d.context}</small> : null}</span>
                    </a>
                  </li>
                ))}
              </ul>
            ))}
          </div>
        )}
        <div className="d21-pal-foot" aria-hidden><span>↑↓ {ar ? "للتنقل" : "to move"}</span><span>Enter {ar ? "للفتح" : "to open"}</span><span>Esc {ar ? "للإغلاق" : "to close"}</span></div>
      </div>
    </>
  );
}

/** The phone's «المزيد» sheet (reference `shell-390` More): the person, then every section. */
function MoreSheet({ lang, onClose, children }: { lang: string; onClose: () => void; children: ReactNode }) {
  const ar = lang === "ar";
  const ref = useTrap(onClose);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => { closeRef.current?.focus(); }, []);
  return (
    <div ref={ref} className="d21-more" role="dialog" aria-modal="true" aria-labelledby="d21-more-h" dir={ar ? "rtl" : "ltr"}>
      <div className="d21-more-head">
        <h2 id="d21-more-h">{ar ? "المزيد" : "More"}</h2>
        <button ref={closeRef} type="button" className="d21-ib" onClick={onClose} aria-label={ar ? "إغلاق" : "Close"}><Ico name="close" /></button>
      </div>
      <nav className="d21-more-body" aria-label={ar ? "كل الأقسام" : "All sections"}>{children}</nav>
    </div>
  );
}

/** The «مساحة عملي» sidebar count (shared, at most one request a minute). Fails quietly: no number, never an error. */
function useWorkspaceBadge(enabled: boolean, pathname: string): number {
  return useWsBadge(enabled, pathname)?.count ?? 0;
}
