"use client";

import { usePathname } from "next/navigation";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useI18n } from "@/lib/i18n/context";
import { breadcrumb, firstDestination, type Viewer } from "@/lib/nav/registry";

/**
 * Module › Subunit › Page, above the content.
 *
 * A deep link — a production order opened from a notification, a bookmark two levels down
 * — otherwise arrives with no indication of where it sits. The sidebar highlights the
 * branch, but the sidebar is not visible on a phone and is easy to miss on a wide screen.
 *
 * The last crumb is the current page and is not a link; it is marked `aria-current="page"`
 * so it is announced as the destination rather than read as one more place to go.
 * Consecutive duplicates are already collapsed by `breadcrumb()`.
 *
 * Direction is handled by the document: the list is laid out in logical order and the
 * separator chevron points along the reading direction, so Arabic reads right-to-left
 * from the module inward without the order being mirrored by hand.
 */
export function Breadcrumbs({ viewer }: { viewer: Viewer }) {
  const pathname = usePathname();
  const { lang } = useI18n();
  const trail = breadcrumb(pathname);

  // One crumb is the page naming itself — the page title already says that.
  if (trail.length < 2) return null;

  const Chevron = lang === "ar" ? ChevronLeft : ChevronRight;

  return (
    <nav aria-label={lang === "ar" ? "مسار التنقل" : "Breadcrumb"}>
      <ol className="flex items-center gap-2 list-none m-0 p-0 text-[12px]">
        {trail.map((node, i) => {
          const last = i === trail.length - 1;
          const href = last ? null : firstDestination(viewer, node);
          return (
            <li key={node.id} className="flex items-center gap-2 min-w-0">
              {i > 0 && <Chevron size={12} className="text-oo-border-strong shrink-0" aria-hidden="true" />}
              {last || !href ? (
                <span
                  aria-current={last ? "page" : undefined}
                  className={last ? "font-semibold text-oo-text-primary truncate" : "text-oo-text-muted truncate"}
                >
                  {lang === "ar" ? node.ar : node.en}
                </span>
              ) : (
                <a href={href} className="text-oo-text-muted hover:text-oo-text-primary transition-colors truncate">
                  {lang === "ar" ? node.ar : node.en}
                </a>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
