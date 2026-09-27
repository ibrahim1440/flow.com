"use client";

import { useEffect } from "react";

/**
 * Stop a navigation from throwing away unsaved work without saying so.
 *
 * Two exits, two mechanisms, because the browser only offers a hook for one of them:
 *
 *   Leaving the application — refresh, close, an external link — fires `beforeunload`, and
 *   the browser shows its own confirmation. The message is not ours to write; browsers
 *   ignore custom text.
 *
 *   Moving WITHIN the application never unloads the document, so `beforeunload` is silent.
 *   The App Router exposes no navigation-start event to hook, so this catches the click
 *   instead: capture phase, find the anchor, ask, and cancel the click if the answer is no.
 *   Capture phase matters — by the bubble phase the router has already been handed the
 *   event.
 *
 * Deliberately a confirmation and not a block. Somebody who wants to abandon a draft is
 * allowed to; what they are not allowed to do is lose it without being asked.
 *
 * `enabled` should be the form's own dirty flag. Passing a constant `true` turns every
 * navigation into a prompt, which teaches people to click through prompts.
 */
export function useUnsavedGuard(enabled: boolean, message?: string) {
  useEffect(() => {
    if (!enabled) return;

    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      // Assigning returnValue is what actually triggers the prompt in several browsers.
      e.returnValue = "";
    };

    const onClick = (e: MouseEvent) => {
      // Let the browser's own handling win for anything that is not a plain left click.
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const anchor = (e.target as HTMLElement | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!anchor) return;
      if (anchor.target && anchor.target !== "_self") return;
      if (anchor.hasAttribute("download")) return;

      const href = anchor.getAttribute("href") ?? "";
      // In-page anchors and non-http schemes are not navigations away from the form.
      if (!href || href.startsWith("#") || /^[a-z]+:/i.test(href) && !href.startsWith("http")) return;

      const url = new URL(anchor.href, window.location.href);
      if (url.origin !== window.location.origin) return;
      if (url.pathname === window.location.pathname) return;

      const ok = window.confirm(
        message ??
          "لديك تعديلات لم تُحفظ على هذه الصفحة. إذا غادرت الآن فستُفقد.\n\n" +
            "You have unsaved changes on this page. Leaving now will discard them.",
      );
      if (!ok) {
        e.preventDefault();
        e.stopPropagation();
      }
    };

    window.addEventListener("beforeunload", onBeforeUnload);
    document.addEventListener("click", onClick, true);
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
      document.removeEventListener("click", onClick, true);
    };
  }, [enabled, message]);
}

/**
 * Is there unsaved work, compared with a baseline the caller already has?
 *
 * A plain comparison rather than a hook holding a snapshot. The first version kept the
 * baseline in a ref written during render, which the React Compiler lint refuses — rightly,
 * because a ref read during render is a value React cannot reason about. Asking the caller
 * for the baseline it already owns is simpler and has no hidden state at all.
 *
 * `active` is what makes this cheap to use: a closed form is never dirty, so a page passes
 * whatever flag reveals its editor.
 *
 * Why not just `active`: prompting somebody who opened a form, typed nothing and clicked
 * away is how people learn to dismiss prompts without reading them.
 */
export function isDirtyAgainst(active: boolean, value: unknown, baseline: unknown): boolean {
  if (!active) return false;
  return JSON.stringify(value) !== JSON.stringify(baseline);
}
