"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { ChevronDown, LogOut, UserCircle, X } from "lucide-react";
import { ROLE_LABELS } from "@/lib/auth-shared";
import { useI18n } from "@/lib/i18n/context";
import {
  visibleNav, resolveActive, firstDestination,
  type NavNode, type Viewer,
} from "@/lib/nav/registry";

type Props = {
  viewer: Viewer;
  userName: string;
  logoBase64: string | null;
  open: boolean;
  onClose: () => void;
  onLogout: () => void;
};

/**
 * The sidebar — levels one and two of the navigation.
 *
 * Level three (a subunit's own pages) is not drawn here. It belongs beside the content it
 * filters, so it renders as a contextual bar inside the page; see ContextualNav.
 *
 * ── Links, not handlers ──
 * Every destination is a real `<a href>`, so middle-click, ctrl-click, "open in new tab"
 * and the browser's own history all behave. Only the group disclosures are `<button>`s,
 * because expanding a group navigates nowhere.
 */
export function Nav({ viewer, userName, logoBase64, open, onClose, onLogout }: Props) {
  const pathname = usePathname();
  const { t, lang } = useI18n();
  const tree = visibleNav(viewer);
  const active = resolveActive(pathname);
  const panelRef = useRef<HTMLElement | null>(null);

  const label = (n: NavNode) => (lang === "ar" ? n.ar : n.en);

  // A group starts open when the current page is inside it. Anything the operator opens
  // or closes by hand is remembered for the rest of the visit, so a group they collapsed
  // does not spring back open the moment they navigate within it.
  const [manual, setManual] = useState<Record<string, boolean>>({});
  const isOpen = (n: NavNode) => manual[n.id] ?? active.group?.id === n.id;

  // ── Drawer behaviour (below lg, where the sidebar is an overlay) ──
  // Escape closes it and focus returns to whatever opened it. Without the return, closing
  // the drawer drops the caret at the top of the document and a keyboard user has to tab
  // back through the whole page to get where they were.
  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement as HTMLElement | null;

    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") { e.stopPropagation(); onClose(); return; }
      if (e.key !== "Tab" || !panelRef.current) return;
      // Keep Tab inside the drawer: while it covers the page, the content behind it is
      // inert to the eye but not to the keyboard.
      const focusable = panelRef.current.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])'
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }

    document.addEventListener("keydown", onKey);
    panelRef.current?.querySelector<HTMLElement>("a[href], button")?.focus();
    return () => {
      document.removeEventListener("keydown", onKey);
      if (opener && document.contains(opener)) opener.focus();
    };
  }, [open, onClose]);

  return (
    <aside
      ref={panelRef}
      id="primary-navigation"
      aria-label={lang === "ar" ? "التنقل الرئيسي" : "Primary navigation"}
      className={`fixed lg:static top-0 z-50 h-[100dvh] w-[260px] shrink-0 flex flex-col
        bg-oo-bg-default border-e border-oo-border-default
        transform transition-transform duration-200 ease-out
        ltr:left-0 rtl:right-0 ${open ? "translate-x-0" : "max-lg:ltr:-translate-x-full max-lg:rtl:translate-x-full"}`}
    >
      {/* Brand */}
      <div className="flex items-center gap-3 px-5 py-4 border-b border-oo-border-default">
        <div className="w-9 h-9 rounded-oo-medium bg-oo-bg-subtle border border-oo-border-default flex items-center justify-center shrink-0 overflow-hidden">
          {logoBase64
            ? <img src={logoBase64} alt="" className="w-full h-full object-contain p-0.5" />
            : <span className="text-oo-action-primary text-base font-bold leading-none">ح</span>}
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="text-[13px] font-bold tracking-[0.12em] text-oo-text-primary">HIQBAH</h2>
          <p className="text-[10.5px] text-oo-text-muted truncate">مقهى و محمصة حِقبة</p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label={lang === "ar" ? "إغلاق القائمة" : "Close menu"}
          className="lg:hidden text-oo-text-muted hover:text-oo-text-primary p-1 -m-1"
        >
          <X size={18} />
        </button>
      </div>

      {/* Navigation tree */}
      <nav className="flex-1 overflow-y-auto px-3 py-3">
        <ul className="flex flex-col gap-0.5 list-none m-0 p-0">
          {tree.map((node) => {
            const Icon = node.icon;

            // A leaf at the top level — Dashboard, Employees, Settings.
            if (!node.children) {
              const current = active.leaf?.id === node.id;
              return (
                <li key={node.id}>
                  <a
                    href={node.href}
                    onClick={onClose}
                    aria-current={current ? "page" : undefined}
                    className={`flex items-center gap-2.5 px-2.5 py-2.5 rounded-oo-small text-[13px] transition-colors
                      ${current
                        ? "bg-oo-action-primary-subtle text-oo-action-primary font-semibold"
                        : "text-oo-text-secondary hover:bg-oo-bg-subtle hover:text-oo-text-primary"}`}
                  >
                    {Icon && <Icon size={18} strokeWidth={current ? 2.25 : 1.75} className="shrink-0" />}
                    <span className="truncate">{label(node)}</span>
                  </a>
                </li>
              );
            }

            const expanded = isOpen(node);
            const inGroup = active.group?.id === node.id;
            return (
              <li key={node.id}>
                <button
                  type="button"
                  onClick={() => setManual((m) => ({ ...m, [node.id]: !expanded }))}
                  aria-expanded={expanded}
                  aria-controls={`nav-group-${node.id}`}
                  className={`w-full flex items-center gap-2.5 px-2.5 py-2.5 rounded-oo-small text-[13px] transition-colors
                    ${inGroup || expanded
                      ? "text-oo-text-primary font-semibold bg-oo-bg-subtle"
                      : "text-oo-text-secondary hover:bg-oo-bg-subtle hover:text-oo-text-primary"}`}
                >
                  {Icon && <Icon size={18} strokeWidth={inGroup ? 2.25 : 1.75} className="shrink-0" />}
                  <span className="flex-1 text-start truncate">{label(node)}</span>
                  <ChevronDown
                    size={14}
                    aria-hidden="true"
                    className={`shrink-0 text-oo-text-muted transition-transform duration-200 ${expanded ? "" : "ltr:-rotate-90 rtl:rotate-90"}`}
                  />
                </button>

                {expanded && (
                  <ul id={`nav-group-${node.id}`} className="flex flex-col gap-0.5 mt-0.5 list-none m-0 p-0">
                    {node.children.map((child) => {
                      const href = firstDestination(viewer, child);
                      if (!href) return null;
                      const current = active.subunit?.id === child.id || active.leaf?.id === child.id;
                      return (
                        <li key={child.id}>
                          <a
                            href={href}
                            onClick={onClose}
                            aria-current={current ? "page" : undefined}
                            className={`flex items-center ps-8 pe-3 py-2 rounded-oo-small text-[12.5px] transition-colors border-s-2
                              ${current
                                ? "bg-oo-action-primary-subtle text-oo-action-primary font-semibold border-oo-action-primary"
                                : "text-oo-text-secondary border-transparent hover:bg-oo-bg-subtle hover:text-oo-text-primary"}`}
                          >
                            <span className="truncate">{label(child)}</span>
                          </a>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      </nav>

      {/* Identity and sign-out */}
      <div className="border-t border-oo-border-default p-3 flex flex-col gap-0.5">
        <a
          href="/dashboard/profile"
          onClick={onClose}
          className="flex items-center gap-2.5 px-2.5 py-2 rounded-oo-small hover:bg-oo-bg-subtle transition-colors"
        >
          <span className="w-7 h-7 rounded-full bg-oo-action-primary-subtle text-oo-action-primary text-xs font-bold flex items-center justify-center shrink-0">
            {userName.charAt(0)}
          </span>
          <span className="min-w-0 flex-1 text-start">
            <span className="block text-[12.5px] font-semibold text-oo-text-primary truncate">{userName}</span>
            <span className="block text-[10.5px] text-oo-text-muted">{ROLE_LABELS[viewer.role] || viewer.role}</span>
          </span>
          <UserCircle size={15} className="text-oo-text-muted shrink-0" aria-hidden="true" />
        </a>
        <button
          type="button"
          onClick={onLogout}
          className="flex items-center gap-2.5 px-2.5 py-2 rounded-oo-small text-[12.5px] text-oo-text-secondary hover:bg-oo-status-blocked-bg hover:text-oo-status-blocked transition-colors"
        >
          <LogOut size={16} strokeWidth={1.75} className="shrink-0" />
          {t("signOut")}
        </button>
      </div>
    </aside>
  );
}
