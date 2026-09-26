"use client";

import { usePathname } from "next/navigation";
import { useI18n } from "@/lib/i18n/context";
import { resolveActive, visibleNav, nodePermitted, type NavNode, type Viewer } from "@/lib/nav/registry";

/**
 * Level three — the pages of the subunit the operator is currently inside.
 *
 * It sits in the content area rather than the sidebar on purpose. Putting every page of
 * every subunit in the sidebar is what produced the wall of nineteen equal-weight links
 * this navigation replaced: the sidebar answers "which part of the business", and this
 * answers "which view of it".
 *
 * ── Links, not tabs ──
 * These are `<a href>`s to distinct routes inside a `<nav>`, deliberately NOT
 * `role="tablist"`/`role="tab"`. Tab semantics promise a panel swapped in the same
 * document, and announce a position like "tab 2 of 3" that a full navigation does not
 * honour — the browser leaves the page. The current page carries `aria-current="page"`.
 */
export function ContextualNav({ viewer }: { viewer: Viewer }) {
  const pathname = usePathname();
  const { lang } = useI18n();
  const { subunit } = resolveActive(pathname);

  // Find the permitted version of this subunit, so a page the viewer cannot open is not
  // offered here even though it exists in the tree.
  const permitted = findById(visibleNav(viewer), subunit?.id);
  const pages = (permitted?.children ?? []).filter((c) => c.href && nodePermitted(viewer, c));

  // A strip with one tab is noise, and a subunit with no children has nothing to offer.
  if (pages.length < 2) return null;

  return (
    <nav
      aria-label={lang === "ar" ? "صفحات القسم" : "Section pages"}
      className="bg-oo-bg-default border-b border-oo-border-default px-5 lg:px-7"
    >
      <ul className="flex items-stretch gap-6 list-none m-0 p-0 overflow-x-auto">
        {pages.map((page) => {
          const current = pathname === page.href || pathname.startsWith(page.href + "/");
          return (
            <li key={page.id}>
              <a
                href={page.href}
                aria-current={current ? "page" : undefined}
                className={`block whitespace-nowrap pt-3.5 pb-3 border-b-2 -mb-px text-[13px] transition-colors
                  ${current
                    ? "border-oo-action-primary text-oo-action-primary font-semibold"
                    : "border-transparent text-oo-text-secondary hover:text-oo-text-primary"}`}
              >
                {lang === "ar" ? page.ar : page.en}
              </a>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

function findById(tree: NavNode[], id: string | undefined): NavNode | undefined {
  if (!id) return undefined;
  for (const n of tree) {
    if (n.id === id) return n;
    const hit = findById(n.children ?? [], id);
    if (hit) return hit;
  }
  return undefined;
}
