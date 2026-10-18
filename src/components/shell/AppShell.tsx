"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Circle, LogOut, UserRound } from "lucide-react";
import {
  NAV, SHELL_GROUPS, SHELL_GROUP_ORDER, visibleNav, presentTree, resolveActive, resolveHighlight, firstDestination, breadcrumb,
  type NavNode, type Viewer,
} from "@/lib/nav/registry";
import { ROLE_LABELS, ROLE_LABELS_AR } from "@/lib/auth-shared";
import { Ico } from "./icons";
import { createActions } from "./creates";
import { PhoneContext, SectionPagesContext, TitleContext, type PhoneHeader, type SectionPages } from "./page-context";
import "./direction-2.1.css";

/**
 * The Direction 2.1 application shell — one shell for every migrated route.
 *
 * Approved design (owner decision, 7 Oct 2026; reference build `direction-2.1-rc`,
 * `screens/shell-1440.html`, `shell-1024.html`, `shell-390.html`; Figma 1JbZgpMqmPkUVne8ms9Ozz,
 * Sidebar 13:322): warm canvas sidebar (244 px) with brand bar, «بحث أو انتقال», the flat
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

const text = (n: NavNode, lang: string) => (lang === "ar" ? (n.shell?.ar ?? n.ar) : (n.shell?.en ?? n.en));
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

type Item = { node: NavNode; href: string; current: "page" | "true" | undefined };
type Group = { id: string; label: string | null; items: Item[] };
type Dest = { id: string; href: string; text: string; context: string | null; node: NavNode; ctx: NavNode | null };

/**
 * The sidebar as the approved frame draws it: ungrouped entries, then flat groups. A module
 * is a group; a hint may move its subunits under another group («التشغيل» holds stock) or a
 * top-level entry into one («الموظفون» in «الفريق»), or take an entry out to the gear menu.
 */
function sidebarGroups(tree: NavNode[], lang: string, active: ReturnType<typeof resolveActive>, viewer: Viewer): { top: Item[]; groups: Group[]; menu: Item[] } {
  const top: Item[] = [];
  const menu: Item[] = [];
  const groups = new Map<string, Group>();
  const labelOf = (gid: string): string | null => {
    const mod = NAV.find((n) => n.id === gid);
    if (mod) return text(mod, lang);
    const g = SHELL_GROUPS[gid];
    return g ? (lang === "ar" ? g.ar : g.en) : null;
  };
  const into = (gid: string, item: Item) => {
    let g = groups.get(gid);
    if (!g) { g = { id: gid, label: labelOf(gid), items: [] }; groups.set(gid, g); }
    g.items.push(item);
  };
  for (const n of tree) {
    if (!n.children) {
      const item: Item = { node: n, href: n.href!, current: active.leaf?.id === n.id ? "page" : undefined };
      if (n.shell?.place === "menu") menu.push(item);
      else if (n.shell?.group) into(n.shell.group, item);
      else top.push(item);
      continue;
    }
    const gid = n.shell?.group ?? n.id;
    for (const sub of n.children) {
      const href = firstDestination(viewer, sub);
      if (!href) continue;
      const item: Item = { node: sub, href, current: active.subunit?.id === sub.id ? (sub.href ? "page" : "true") : undefined };
      if (sub.shell?.place === "menu") menu.push(item);
      else into(gid, item);
    }
  }
  const rank = (id: string) => { const i = SHELL_GROUP_ORDER.indexOf(id); return i === -1 ? SHELL_GROUP_ORDER.length : i; };
  const ordered = [...groups.values()].filter((g) => g.items.length > 0).sort((a, b) => rank(a.id) - rank(b.id));
  return { top, groups: ordered, menu };
}

function destinations(tree: NavNode[], lang: string): Dest[] {
  const out: Dest[] = [];
  const seen = new Set<string>();
  const walk = (nodes: NavNode[], ctx: NavNode | null) => {
    for (const n of nodes) {
      if (n.href && !seen.has(n.href)) {
        seen.add(n.href);
        out.push({ id: n.id, href: n.href, text: text(n, lang), context: ctx ? text(ctx, lang) : null, node: n, ctx });
      }
      if (n.children) walk(n.children, ctx ?? n);
    }
  };
  walk(tree, null);
  return out;
}

export function AppShell({
  user, viewer, lang, logo, allowed, onLogout, deniedTitle, deniedBody, homeLabel, children,
}: {
  user: ShellUser;
  viewer: Viewer;
  lang: string;
  logo: string | null;
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
  const active = useMemo(() => resolveActive(pathname, locus), [pathname, locus]);
  // What the sidebar (and so the rail) and «المزيد» highlight: the same trail as `active` unless
  // the page's node names `highlightAs` (G-11). The breadcrumb and the page tabs keep `active`.
  const lit = useMemo(() => resolveHighlight(active, tree), [active, tree]);
  const crumbs = useMemo(() => breadcrumb(pathname, locus), [pathname, locus]);
  const visibleSub = useMemo(() => (active.subunit ? tree.flatMap((n) => n.children ?? []).find((c) => c.id === active.subunit!.id) : undefined), [active.subunit, tree]);
  const pages = pagesOf(visibleSub);
  const leafIsPage = !!active.leaf && pages.some((p) => p.id === active.leaf!.id);
  const showSeg = pages.length >= 2 && allowed;

  // What the page says about itself.
  const [title, setTitle] = useState<string | null>(null);
  const [phoneHeader, setPhoneHeader] = useState<PhoneHeader | null>(null);
  const setTitleStable = useCallback((t: string | null) => setTitle(t), []);
  const setPhoneStable = useCallback((h: PhoneHeader | null) => setPhoneHeader(h), []);

  // The trail (reference `.top .crumb`): module / section / page — a list page keeps its own
  // crumb even with the section's pages in the Segmented control («المبيعات / العملاء / العملاء
  // المحتملون», N-17); a record page ends with the record's own name instead of the page
  // («المبيعات / الصفقات / محمصة النخبة — …»).
  const trail = useMemo(() => {
    const base = showSeg && leafIsPage && title ? crumbs.slice(0, -1) : crumbs;
    const parts: { key: string; text: string; href: string | null }[] = base.map((c, i) => ({
      key: c.id, text: text(c, lang), href: i === base.length - 1 && !title ? null : firstDestination(viewer, c),
    }));
    if (title) parts.push({ key: "title", text: title, href: null });
    // A top-level entry the frames list under a group names that group first (shell.trailGroup):
    // «التشغيل / لوحة التشغيل» (20:236 top bar 101:6411). The group is a label, not a link.
    const head = base[0];
    if (head?.shell?.trailGroup && head.shell.group) {
      const mod = NAV.find((n) => n.id === head.shell!.group);
      const g = SHELL_GROUPS[head.shell.group];
      const label = mod ? text(mod, lang) : g ? (lang === "ar" ? g.ar : g.en) : null;
      if (label) parts.unshift({ key: `grp-${head.shell.group}`, text: label, href: null });
    }
    return parts;
  }, [crumbs, showSeg, leafIsPage, title, active.leaf, pathname, lang, viewer]);

  const sectionPages: SectionPages = useMemo(() => showSeg ? {
    label: ar ? "صفحات القسم" : "Section pages",
    pages: pages.map((p) => ({ id: p.id, href: p.href!, text: text(p, lang), current: active.leaf?.id === p.id })),
  } : null, [showSeg, pages, ar, lang, active.leaf]);

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
  // A top-level entry the frames list under a group (shell.group, e.g. the dashboard in «التشغيل»,
  // 20:236) offers that group's create actions, as the frame's top bar «جديد · C» shows.
  const moduleId = active.group?.id ?? active.leaf?.shell?.group;
  const creates = useMemo(() => (allowed ? createActions(viewer, moduleId) : []), [viewer, moduleId, allowed]);
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
  const navItem = (it: Item, parent?: NavNode) => {
    const label = text(it.node, lang);
    return (
      <li key={it.node.id}>
        <Link href={it.href} className="d21-nav" aria-current={it.current} data-testid={`nav-${it.node.id}`} title={label}>
          <NodeIcon node={it.node} fallback={parent} />
          <span>{label}</span>
        </Link>
      </li>
    );
  };

  const groupHref = active.group ? firstDestination(viewer, active.group) : null;
  const meNode = tree.find((n) => n.id === "me");
  const dests = useMemo(() => destinations(tree, lang), [tree, lang]);
  // The phone header keeps naming the section on a list page with a Segmented control (reference
  // crm-390: «الصفقات» over the pipeline); otherwise it names the last crumb.
  const sectionCrumbs = showSeg && leafIsPage && !title && active.leaf?.href && pathname === active.leaf.href ? crumbs.slice(0, -1) : null;
  const lastCrumb = sectionCrumbs?.length ? text(sectionCrumbs[sectionCrumbs.length - 1], lang) : trail.length ? trail[trail.length - 1].text : "";
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
    <PhoneContext value={setPhoneStable}>
    <SectionPagesContext value={sectionPages}>
    <div className="d21" lang={lang} dir={ar ? "rtl" : "ltr"} data-shell="d21">
      {/* IBM Plex, self-hosted (public/fonts): the same faces, files and unicode-range subsets
          Google Fonts served, so nothing is fetched from a third party. */}
      <link rel="stylesheet" precedence="default" href="/fonts/ibm-plex.css" />
      <a className="d21-skip" href="#d21-content">{ar ? "تجاوز إلى المحتوى" : "Skip to content"}</a>
      <div className="d21-app" inert={palette || more}>
        <aside className="d21-side" aria-label={ar ? "القائمة الجانبية" : "Sidebar"}>
          <div className="d21-brandbar">
            <span className={`d21-mark${logo ? " has-logo" : ""}`}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              {logo ? <img src={logo} alt="" /> : null}
            </span>
            {/* The EN frames write the name in Latin letters (N-18); the Arabic shell keeps «حِقبة». */}
            <div className="t"><b>{ar ? "حِقبة" : "Hiqbah"}</b><span>{ar ? "مقهى ومحمصة" : "Café & roastery"}</span></div>
          </div>
          <button type="button" className="d21-find" onClick={openPalette} aria-label={ar ? "بحث أو انتقال (Ctrl K)" : "Search or jump (Ctrl K)"} aria-haspopup="dialog">
            <Ico name="search" small />
            <span className="lbl">{ar ? "بحث أو انتقال" : "Search or jump"}</span>
            <span className="d21-kbd" aria-hidden>Ctrl K</span>
          </button>
          <nav aria-label={ar ? "التنقل الرئيسي" : "Main"}>
            <ul className="d21-navlist">{top.map((it) => navItem(it))}</ul>
            {groups.map((g) => {
              const gid = `d21-grp-${g.id}`;
              const mod = NAV.find((n) => n.id === g.id);
              return (
                <div key={g.id} role="group" aria-labelledby={g.label ? gid : undefined}>
                  <p className="d21-grp" id={gid} data-testid={`navgroup-${g.id}`}>{g.label ?? " "}</p>
                  <ul className="d21-navlist">{g.items.map((it) => navItem(it, mod))}</ul>
                </div>
              );
            })}
          </nav>
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
                <Link role="menuitem" href="/dashboard/profile" onClick={() => setMenu(false)}>{ar ? "الملف الشخصي" : "Profile"}</Link>
                {menuItems.map((it) => (
                  <Link key={it.node.id} role="menuitem" href={it.href} data-testid={`nav-${it.node.id}`} onClick={() => setMenu(false)}>{text(it.node, lang)}</Link>
                ))}
                <button role="menuitem" type="button" className="danger" onClick={onLogout}>{ar ? "تسجيل الخروج" : "Sign out"}</button>
              </div>
            ) : null}
          </div>
        </aside>

        {/* The phone header (reference `.ph-top`): the mark, the page title, the search — or a
            record page's back arrow and the page's own action. */}
        <header className="d21-mtop">
          <span className={`d21-mark sm${logo ? " has-logo" : ""}`}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            {logo ? <img src={logo} alt="" /> : null}
          </span>
          {phoneHeader?.back ? (
            <Link href={phoneHeader.back} className="d21-ib back" aria-label={ar ? "رجوع" : "Back"}><Ico name="back" /></Link>
          ) : null}
          <div className="t">
            <h2>{phoneTitle}</h2>
            {phoneHeader?.sub ? <div className="sub">{phoneHeader.sub}</div> : null}
          </div>
          <span className="sp" />
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
                  <Link href="/dashboard" className="d21-btn p">{homeLabel}</Link>
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
            <Link href="/dashboard" aria-current={pathname === "/dashboard" ? "page" : undefined}><Ico name="home" />{ar ? "الرئيسية" : "Home"}</Link>
            {active.group && groupHref ? <Link href={groupHref} aria-current="true"><NodeIcon node={active.group} />{text(active.group, lang)}</Link> : null}
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
          {/* Every section, flat, as the approved «المزيد» frame lists them. */}
          {[...top, ...groups.flatMap((g) => g.items)].map((it) => {
            const mod = groups.find((g) => g.items.includes(it));
            const parent = mod ? NAV.find((n) => n.id === mod.id) : undefined;
            return (
              <Link key={it.node.id} href={it.href} className="d21-more-row" aria-current={it.current ? "page" : undefined} data-testid={`more-${it.node.id}`}>
                <NodeIcon node={it.node} fallback={parent} /><span>{text(it.node, lang)}</span><Ico name="chev" small className="chev" />
              </Link>
            );
          })}
          <Link href="/dashboard/profile" className="d21-more-row"><UserRound aria-hidden /><span>{ar ? "الملف الشخصي" : "Profile"}</span><Ico name="chev" small className="chev" /></Link>
          {menuItems.map((it) => (
            <Link key={it.node.id} href={it.href} className="d21-more-row"><NodeIcon node={it.node} /><span>{text(it.node, lang)}</span><Ico name="chev" small className="chev" /></Link>
          ))}
          <button type="button" className="d21-more-row danger" onClick={onLogout}><LogOut aria-hidden /><span>{ar ? "تسجيل الخروج" : "Sign out"}</span></button>
        </MoreSheet>
      ) : null}
    </div>
    </SectionPagesContext>
    </PhoneContext>
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
  const list = query ? dests.filter((d) => d.text.includes(query) || (d.context ?? "").includes(query) || d.text.toLowerCase().includes(query.toLowerCase())) : dests;
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
          <ul id="d21-pal-list" role="listbox" aria-label={ar ? "الصفحات" : "Pages"}>
            {list.map((d, i) => (
              <li key={d.id} role="option" id={`d21-pal-${d.id}`} aria-selected={i === cur}>
                <a href={d.href} tabIndex={-1} data-active={i === cur} onMouseEnter={() => setSel(i)} onClick={(e) => { e.preventDefault(); go(d); }}>
                  <NodeIcon node={d.node} fallback={d.ctx ?? undefined} /><span><b>{d.text}</b>{d.context ? <small>{d.context}</small> : null}</span>
                </a>
              </li>
            ))}
          </ul>
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
