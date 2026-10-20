"use client";

// Direction 2.1 dialog for surfaces that render OUTSIDE the shell's `.d21` root — today the
// step-up «تأكيد الهوية», which the dashboard layout mounts next to AppShell, not inside it.
// Without its own root such a dialog fell back to the legacy :root palette (purple primary,
// purple focus ring, Tajawal). This one carries the `.d21` root itself, so every token, the
// focus ring and IBM Plex apply whatever it is mounted under.
//
// Phone (< 768): the shell's bottom sheet (grip, 20 px top corners, the «المزيد» / Select sheet).
// Wider: a centred modal (14 px corners, --shadow-pop) over the E1 scrim.
// Behaviour: role="dialog" + aria-modal, labelled by its title; Esc closes when `onClose` is
// given; Tab is held inside; focus returns to where it was when the dialog closes.
import { useEffect, useId, useRef, type ReactNode } from "react";
import "@/components/shell/direction-2.1.css";
import "./dialog.css";

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function D21Dialog({ lang, title, sub, icon, onClose, children, actions, testId, width = 400 }: {
  lang: "ar" | "en";
  title: ReactNode;
  sub?: ReactNode;
  icon?: ReactNode;
  /** Esc and the scrim close the dialog through this; omit it for a dialog that must be answered. */
  onClose?: () => void;
  children: ReactNode;
  /** The action row (primary first in reading order). */
  actions?: ReactNode;
  testId?: string;
  width?: number;
}) {
  const ar = lang === "ar";
  const titleId = useId();
  const subId = useId();
  const panel = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  useEffect(() => { closeRef.current = onClose; }, [onClose]);

  useEffect(() => {
    const returnTo = document.activeElement as HTMLElement | null;
    const el = panel.current;
    // Focus the first field (an autoFocus inside wins: it has already taken focus).
    if (el && !el.contains(document.activeElement)) {
      (el.querySelector<HTMLElement>("input, " + FOCUSABLE) ?? el).focus();
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && closeRef.current) { e.stopPropagation(); closeRef.current(); return; }
      if (e.key !== "Tab" || !el) return;
      const items = Array.from(el.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((n) => n.offsetParent !== null);
      if (items.length === 0) { e.preventDefault(); return; }
      const first = items[0], last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      if (returnTo && document.contains(returnTo)) returnTo.focus();
    };
  }, []);

  return (
    <div className="d21 d21-dlg-layer" lang={lang} dir={ar ? "rtl" : "ltr"}>
      {/* IBM Plex, self-hosted (public/fonts), as AppShell / ShellStates load it; React dedupes it. */}
      {/* eslint-disable-next-line @next/next/no-css-tags */}
      <link rel="stylesheet" precedence="default" href="/fonts/ibm-plex.css" />
      <div className="d21-dlg-scrim" aria-hidden onClick={() => onClose?.()} />
      <div ref={panel} className="d21-dlg" role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={sub ? subId : undefined}
        tabIndex={-1} data-testid={testId} style={{ ["--d21-dlg-w" as string]: `${width}px` }}>
        <div className="d21-dlg-grip" aria-hidden />
        <div className="d21-dlg-head">
          {icon ? <span className="d21-dlg-ico" aria-hidden>{icon}</span> : null}
          <div className="d21-dlg-t">
            <h2 id={titleId}>{title}</h2>
            {sub ? <p id={subId}>{sub}</p> : null}
          </div>
        </div>
        <div className="d21-dlg-body">{children}</div>
        {actions ? <div className="d21-dlg-actions">{actions}</div> : null}
      </div>
    </div>
  );
}
