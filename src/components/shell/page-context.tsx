"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { createContext, useContext, useEffect, useRef, useSyncExternalStore } from "react";
import type { D21IconName } from "./icons";

/**
 * What a page tells the Direction 2.1 shell about itself, and what the shell tells a page.
 *
 * Kept apart from the shell so a page can name itself without pulling in the shell's
 * navigation, and so the shell can be rendered without any page.
 */

// ── The page's own name ──────────────────────────────────────────────────────────────────
/**
 * The last crumb of the top bar (the reference trail ends with the record: «المبيعات /
 * الصفقات / محمصة النخبة — خلطة خاصة») and, on a phone, the header title unless the page
 * names a phone header of its own.
 */
export const TitleContext = createContext<(t: string | null) => void>(() => {});

export function useD21Title(title: string | null | undefined) {
  const set = useContext(TitleContext);
  useEffect(() => {
    set(title ?? null);
    return () => set(null);
  }, [title, set]);
}

// ── The phone ────────────────────────────────────────────────────────────────────────────
/**
 * The phone layout of the approved frames (rc.css `.phone`; CRM 390 `173:586`, `173:722`,
 * `178:1285`, `183:2040`; HR M-01…): below 768 the page sits on a rounded sheet under a
 * phone header, with the bottom tab bar or a page's own sticky action bar in its place.
 * The shell's chrome switches by CSS alone; this hook is for pages that lay their content
 * out differently on a phone.
 */
const PHONE = "(max-width: 767.98px)";

function subscribe(cb: () => void) {
  const m = window.matchMedia(PHONE);
  m.addEventListener("change", cb);
  return () => m.removeEventListener("change", cb);
}

/** True below 768. False on the server and on the first client render, so hydration matches. */
export function usePhone(): boolean {
  return useSyncExternalStore(subscribe, () => window.matchMedia(PHONE).matches, () => false);
}

export type PhoneHeader = {
  /** The page name, or the record's name on a detail page. */
  title: string;
  /** A second line under the title (the reference: «صفقة · خلطة خاصة»). */
  sub?: string;
  /** A detail page has a back arrow to its list instead of the search button. */
  back?: string;
  /** The header's own action in place of search (leads 390: «+» opens the new-lead form). */
  action?: { href: string; label: string; icon: "plus" };
  /** The page draws its own sticky action bar, so the shell leaves out the tab bar. */
  ownBar?: boolean;
};

export const PhoneContext = createContext<(h: PhoneHeader | null) => void>(() => {});

/** A page names its phone header. Strings only, so the effect re-runs only when they change. */
export function useD21Phone(h: PhoneHeader | null) {
  const set = useContext(PhoneContext);
  const key = h ? JSON.stringify(h) : "";
  useEffect(() => {
    set(key ? (JSON.parse(key) as PhoneHeader) : null);
    return () => set(null);
  }, [key, set]);
}

// ── The section's pages ──────────────────────────────────────────────────────────────────
/**
 * A subunit's own pages (registry level 3), as the approved Segmented control. The shell
 * resolves them from the registry; the PAGE draws them in its header's action area — the
 * place the reference puts a Segmented control (`.ph .act .seg`), not the top bar (owner
 * ruling on A-1 / OQ3). Links, not tabs: separate URLs that survive a refresh and Back.
 */
export type SectionPage = { id: string; href: string; text: string; current: boolean };
export type SectionPages = { pages: SectionPage[]; label: string } | null;

export const SectionPagesContext = createContext<SectionPages>(null);

/** The subunit's pages, or null when there is only one (one tab is decoration). */
export function useSectionPages(): SectionPages {
  return useContext(SectionPagesContext);
}

/** The Segmented control of the section's pages; renders nothing when there is no choice. */
export function SectionPages({ className = "" }: { className?: string }) {
  const s = useSectionPages();
  if (!s) return null;
  return (
    <nav aria-label={s.label} data-testid="contextual-nav" className={className || undefined}>
      <ul className="d21-seg">
        {s.pages.map((p) => (
          <li key={p.id}><Link href={p.href} aria-current={p.current ? "page" : undefined} data-testid={`ctx-${p.id}`}>{p.text}</Link></li>
        ))}
      </ul>
    </nav>
  );
}

// ── «جديد» arriving on a page ────────────────────────────────────────────────────────────
/**
 * The shell's «جديد» / «+» links to a module page with `?new=<kind>` (`./creates`). The page
 * opens the form for that kind once it knows the viewer may (`enabled`), and the parameter is
 * then removed — so closing the form and asking again opens it again, and a reload does not
 * reopen a form the person already closed. A page with several create forms calls this once
 * per kind.
 */
export function useCreateRequest(kind: string, open: () => void, enabled = true) {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const search = params.toString();
  const asked = params.get("new") === kind;
  const run = useRef(open);
  // One opening per request: the same URL is not acted on twice, even if a re-render happens
  // before the router has replaced it.
  const handled = useRef<string | null>(null);
  useEffect(() => { run.current = open; });
  useEffect(() => {
    if (!asked) { handled.current = null; return; }
    if (!enabled || handled.current === search) return;
    handled.current = search;
    run.current();
    const q = new URLSearchParams(search);
    q.delete("new");
    const rest = q.toString();
    router.replace(rest ? `${pathname}?${rest}` : pathname, { scroll: false });
  }, [asked, enabled, search, pathname, router]);
}

export type { D21IconName };
