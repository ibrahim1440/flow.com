"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChevronDown, ChevronRight } from "lucide-react";
import {
  visibleNav, resolveActive, firstDestination, breadcrumb,
  type NavNode, type Viewer,
} from "@/lib/nav/registry";

/**
 * The three levels of the menu, drawn from one registry.
 *
 * ── Why the sidebar stops at two ──
 * A module and its subunits live in the sidebar; a subunit's pages live in a contextual bar
 * inside the page. Putting the leaves in both places is how a sidebar becomes a wall of
 * links again, only indented. So the sidebar's deepest entry is a subunit, and the pages
 * beneath it appear once, where you are already standing.
 *
 * ── Links, not buttons ──
 * Everything that changes the page is an anchor, including the contextual bar that is
 * styled like tabs. Tab semantics describe panels swapped inside one document; these are
 * separate URLs that must survive a bookmark, a refresh and the browser's Back button.
 * Announcing them as tabs would promise a keyboard user arrow-key behaviour that does not
 * and should not exist here.
 */

const label = (n: NavNode, lang: string) => (lang === "ar" ? n.ar : n.en);

/** A subunit's own pages — what the contextual bar offers. */
const pagesOf = (n: NavNode | undefined): NavNode[] => (n?.children ?? []).filter((c) => c.href);

// ─────────────────────────────────────────────────────────────────────────────

export function SidebarNav({
  viewer,
  lang,
  onNavigate,
}: {
  viewer: Viewer;
  lang: string;
  /** Closes the mobile drawer. A drawer that stays open over the page it just opened is a
      drawer covering the thing you asked for. */
  onNavigate: () => void;
}) {
  const pathname = usePathname();
  const tree = useMemo(() => visibleNav(viewer), [viewer]);
  const active = useMemo(() => resolveActive(pathname, tree), [pathname, tree]);

  /**
   * Which groups are open.
   *
   * Derived, not synchronised: the group holding the current page is open unless the reader
   * has said otherwise, and `toggled` records only the ones they have actually pressed.
   * Mirroring the active group into state through an effect would re-open a group the
   * reader had just closed every time the page changed, and would render once with the
   * wrong answer before correcting itself.
   */
  const [toggled, setToggled] = useState<Record<string, boolean>>({});
  const isOpen = (id: string) => toggled[id] ?? active.group?.id === id;

  return (
    <nav aria-label={lang === "ar" ? "التنقل الرئيسي" : "Main"} className="flex-1 overflow-y-auto px-3 py-4 space-y-0.5">
      {tree.map((node) => {
        const Icon = node.icon;

        // A destination hanging off the top level — the dashboard, employees, settings.
        if (!node.children) {
          const current = active.leaf?.id === node.id;
          return (
            <Link
              key={node.id}
              href={node.href!}
              onClick={onNavigate}
              aria-current={current ? "page" : undefined}
              data-testid={`nav-${node.id}`}
              className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-[13px] font-medium transition-colors duration-200 ${
                current
                  ? "bg-orange text-white shadow-md shadow-orange/25"
                  : "text-sidebar-text hover:bg-sidebar-hover hover:text-white"
              }`}
            >
              {Icon && <Icon size={18} strokeWidth={current ? 2.5 : 1.5} />}
              {label(node, lang)}
            </Link>
          );
        }

        const expanded = isOpen(node.id);
        const inThisGroup = active.group?.id === node.id;
        return (
          <div key={node.id}>
            {/* A disclosure, per the WAI-ARIA disclosure-navigation pattern: a real button
                that says whether the region it controls is open. Not hover — a menu that
                needs a mouse hovering is a menu a keyboard and a phone cannot use. */}
            <button
              type="button"
              onClick={() => setToggled((p) => ({ ...p, [node.id]: !expanded }))}
              aria-expanded={expanded}
              aria-controls={`navgroup-${node.id}`}
              data-testid={`navgroup-${node.id}`}
              className={`flex w-full items-center gap-3 px-3 py-2.5 rounded-lg text-[13px] font-medium transition-colors duration-200 ${
                inThisGroup && !expanded
                  ? "bg-sidebar-hover text-white"
                  : "text-sidebar-text hover:bg-sidebar-hover hover:text-white"
              }`}
            >
              {Icon && <Icon size={18} strokeWidth={inThisGroup ? 2.5 : 1.5} />}
              <span className="flex-1 text-start">{label(node, lang)}</span>
              {expanded
                ? <ChevronDown size={14} aria-hidden className="opacity-60" />
                : <ChevronRight size={14} aria-hidden className="opacity-60 rtl:rotate-180" />}
            </button>

            {expanded && (
              <ul id={`navgroup-${node.id}`} className="mt-0.5 space-y-0.5 ps-3">
                {node.children.map((sub) => {
                  // A subunit opens at its first PERMITTED page. Linking to a fixed default
                  // sends whoever lacks it to a refusal.
                  const href = firstDestination(viewer, sub);
                  if (!href) return null;
                  const current = active.subunit?.id === sub.id;
                  const SubIcon = sub.icon;
                  return (
                    <li key={sub.id}>
                      <Link
                        href={href}
                        onClick={onNavigate}
                        // The subunit is not itself the page; the page is marked in the
                        // contextual bar. `aria-current="true"` says "within this section".
                        aria-current={current ? (sub.href ? "page" : "true") : undefined}
                        data-testid={`nav-${sub.id}`}
                        className={`flex items-center gap-2.5 px-3 py-2 rounded-lg text-[12.5px] transition-colors duration-200 ${
                          current
                            ? "bg-orange text-white font-medium shadow-sm shadow-orange/20"
                            : "text-sidebar-text/85 hover:bg-sidebar-hover hover:text-white"
                        }`}
                      >
                        {SubIcon && <SubIcon size={15} strokeWidth={current ? 2.4 : 1.5} aria-hidden />}
                        <span className="min-w-0 flex-1 truncate">{label(sub, lang)}</span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        );
      })}
    </nav>
  );
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * The pages of the subunit you are standing in.
 *
 * ── On the colour ──
 * Uses the SHELL's primary (`--orange`, which has held #7C3AED since the theme refresh in
 * dcefa3d and is no longer orange at all), not the Sales design system's
 * `--oo-action-primary` #4F46E5. Both are deliberate: the shell was recoloured for the whole
 * ERP, and the Sales screens were later built on their own token set. This bar is shell
 * furniture sitting directly beneath the sidebar, so it matches the sidebar rather than
 * showing two different purples inside one navigation system. The wider reconciliation of
 * the two palettes is a design decision, not something a navigation change should settle.
 *
 * Renders nothing when there is no choice to make: a subunit with one destination would
 * otherwise show a single tab, which is decoration pretending to be navigation.
 */
export function ContextualNav({ viewer, lang }: { viewer: Viewer; lang: string }) {
  const pathname = usePathname();
  const tree = useMemo(() => visibleNav(viewer), [viewer]);
  const { subunit, leaf } = useMemo(() => resolveActive(pathname, tree), [pathname, tree]);
  const pages = pagesOf(subunit);
  if (pages.length < 2) return null;

  return (
    <nav
      aria-label={lang === "ar" ? "صفحات القسم" : "Section pages"}
      data-testid="contextual-nav"
      className="border-b border-border bg-white/70 px-5 lg:px-7"
    >
      {/* The bar scrolls, the document does not. A row of Arabic labels at 390px is wider
          than the phone and the page must not be. */}
      <ul className="-mb-px flex gap-1 overflow-x-auto">
        {pages.map((p) => {
          const current = leaf?.id === p.id;
          return (
            <li key={p.id} className="flex-shrink-0">
              <Link
                href={p.href!}
                aria-current={current ? "page" : undefined}
                data-testid={`ctx-${p.id}`}
                className={`inline-flex items-center whitespace-nowrap border-b-2 px-3.5 py-2.5 text-[13px] font-medium transition-colors ${
                  current
                    ? "border-orange text-orange"
                    : "border-transparent text-oo-text-secondary hover:border-oo-border-strong hover:text-oo-text-primary"
                }`}
              >
                {label(p, lang)}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

// ─────────────────────────────────────────────────────────────────────────────

/** Where you are: module › subunit › page. The last crumb is the page and is not a link. */
export function Breadcrumbs({ viewer, lang }: { viewer: Viewer; lang: string }) {
  const pathname = usePathname();
  const tree = useMemo(() => visibleNav(viewer), [viewer]);
  const crumbs = useMemo(() => breadcrumb(pathname, tree), [pathname, tree]);
  if (crumbs.length < 2) return null;

  return (
    <nav aria-label={lang === "ar" ? "مسار التنقل" : "Breadcrumb"} data-testid="breadcrumbs">
      <ol className="flex flex-wrap items-center gap-1 text-[12px] leading-[18px] text-brown">
        {crumbs.map((c, i) => {
          const last = i === crumbs.length - 1;
          const href = last ? null : firstDestination(viewer, c);
          return (
            <li key={c.id} className="flex items-center gap-1">
              {i > 0 && <ChevronRight size={12} aria-hidden className="opacity-50 rtl:rotate-180" />}
              {href ? (
                <Link href={href} className="hover:text-orange hover:underline">{label(c, lang)}</Link>
              ) : (
                <span aria-current="page" className="font-medium text-charcoal">{label(c, lang)}</span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Focus for the mobile drawer.
 *
 * Opening moves focus into the drawer so a keyboard or screen-reader user is where the new
 * content is; closing puts it back on the control they pressed, so they are not dropped at
 * the top of the document. Returns the ref to hang on the drawer's close button.
 */
export function useDrawerFocus(open: boolean, openerRef: React.RefObject<HTMLButtonElement | null>) {
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open) closeRef.current?.focus();
    else if (wasOpen.current) openerRef.current?.focus();
    wasOpen.current = open;
  }, [open, openerRef]);
  return closeRef;
}
