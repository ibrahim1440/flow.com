"use client";
/**
 * «واجهة المحاسب» — the accountant workspace sidebar (Qoyod-parity program, phase 1), drawn by `AppShell` in place
 * of the system groups for a viewer in accountant mode. The tree, its permissions and its labels are
 * `@/lib/nav/accountant` (pure, tested); this file only draws it in the Direction 2.1 sidebar classes, so the rail
 * (768–1279) and the accordion behave as the system menu does.
 *
 *   «الإنشاء السريع»   — a menu of every «+» the viewer may use (top of the sidebar)
 *   a group          — heading + its items; an item: link, «+» quick-new beside it, or «قريباً» (disabled, no link)
 *   «القائمة الكاملة» — the switch back to the system menu (remembered per user, see AppShell)
 */
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import type { ShownGroup, ShownItem } from "@/lib/nav/accountant";
import { Ico } from "./icons";
import "./accountant.css";

type Props = {
  lang: string;
  tree: ShownGroup[];
  creates: { id: string; label: string; href: string }[];
  activeGroup: string | null;
  activeItem: string | null;
  openGroup: string | null;
  onToggleGroup: (id: string) => void;
};

export function QuickCreate({ lang, creates, testId = "acct-quick" }: { lang: string; creates: Props["creates"]; testId?: string }) {
  const ar = lang === "ar";
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", esc);
    return () => { window.removeEventListener("mousedown", close); window.removeEventListener("keydown", esc); };
  }, [open]);
  if (creates.length === 0) return null;
  const label = ar ? "الإنشاء السريع" : "Quick create";
  return (
    <div className="d21-acct-quick" ref={box}>
      <button type="button" className="d21-acct-quick-btn" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((v) => !v)} data-testid={testId} title={label}>
        <Ico name="plus" small /><span className="lbl">{label}</span>
      </button>
      {open ? (
        <div className="d21-menu down d21-acct-quick-menu" role="menu" aria-label={label}>
          {creates.map((c) => (
            <Link key={c.id} role="menuitem" href={c.href} onClick={() => setOpen(false)} data-testid={`${testId}-${c.id}`}>
              <Ico name="plus" small />{c.label}
            </Link>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function Row({ it, icon, lang, current }: { it: ShownItem; icon: ShownGroup["icon"]; lang: string; current: boolean }) {
  const ar = lang === "ar";
  if (it.state === "soon") {
    return (
      <li className="d21-acct-row">
        <span className="d21-nav is-soon" aria-disabled="true" data-testid={`acctnav-${it.id}`} title={it.label}>
          <Ico name={icon} /><span>{it.label}</span>
          <em className="d21-acct-soon">{ar ? "قريباً" : "Soon"}</em>
        </span>
      </li>
    );
  }
  return (
    <li className="d21-acct-row">
      <Link href={it.href!} className="d21-nav" aria-current={current ? "page" : undefined} data-testid={`acctnav-${it.id}`} title={it.label}>
        <Ico name={icon} /><span>{it.label}</span>
      </Link>
      {it.create ? (
        <Link href={it.create} className="d21-acct-plus" aria-label={ar ? `جديد: ${it.label}` : `New: ${it.label}`} title={ar ? `جديد: ${it.label}` : `New: ${it.label}`} data-testid={`acctnew-${it.id}`}>
          <Ico name="plus" small />
        </Link>
      ) : null}
    </li>
  );
}

export function AccountantNav({ lang, tree, creates, activeGroup, activeItem, openGroup, onToggleGroup }: Props) {
  const ar = lang === "ar";
  return (
    <nav aria-label={ar ? "واجهة المحاسب" : "Accountant workspace"} data-testid="acct-nav">
      <QuickCreate lang={lang} creates={creates} />
      {tree.map((g) => {
        if (g.href) {
          return (
            <ul key={g.id} className="d21-navlist">
              <li>
                <Link href={g.href} className="d21-nav" aria-current={activeGroup === g.id ? "page" : undefined} data-testid={`acctnav-${g.id}`} title={g.label}>
                  <Ico name={g.icon} /><span>{g.label}</span>
                </Link>
              </li>
            </ul>
          );
        }
        const gid = `d21-acct-grp-${g.id}`;
        const pid = `d21-acct-panel-${g.id}`;
        const isOpen = openGroup === g.id;
        return (
          <div key={g.id} className="d21-grpbox" role="group" aria-labelledby={gid}>
            <button type="button" className="d21-grp" id={gid} data-testid={`acctgroup-${g.id}`} aria-expanded={isOpen} aria-controls={pid}
              data-current={activeGroup === g.id ? "true" : undefined} title={g.label} onClick={() => onToggleGroup(g.id)}>
              <Ico name={g.icon} /><span>{g.label}</span><Ico name="chevd" small className="chev" />
            </button>
            <div className="d21-acc" id={pid} data-open={isOpen ? "true" : undefined}>
              <div className="d21-acc-in">
                <ul className="d21-navlist">{g.items.map((it) => <Row key={it.id} it={it} icon={g.icon} lang={lang} current={activeItem === it.id} />)}</ul>
              </div>
            </div>
          </div>
        );
      })}
    </nav>
  );
}

/** «القائمة الكاملة» / «واجهة المحاسب»: the switch between the two sidebars (a toggle button, pressed = full menu). */
export function WorkspaceSwitch({ lang, accountant, onChange, variant = "side" }: { lang: string; accountant: boolean; onChange: (accountant: boolean) => void; variant?: "side" | "row" }) {
  const ar = lang === "ar";
  const label = accountant ? (ar ? "القائمة الكاملة" : "Full menu") : (ar ? "واجهة المحاسب" : "Accountant workspace");
  const hint = accountant
    ? (ar ? "عرض قائمة النظام الكاملة" : "Show the full system menu")
    : (ar ? "العودة إلى واجهة المحاسب" : "Back to the accountant workspace");
  return (
    <button type="button" className={variant === "row" ? "d21-more-row d21-acct-switch-row" : "d21-acct-switch"} onClick={() => onChange(!accountant)}
      title={hint} data-testid={variant === "row" ? "acct-switch-more" : "acct-switch"}>
      <Ico name={accountant ? "cols" : "invoice"} small /><span>{label}</span>
    </button>
  );
}

/** The phone «المزيد» sheet's accountant sections: the same tree, in the sheet's row style. */
export function AccountantMore({ lang, tree, activeGroup, activeItem, openGroup, onToggleGroup }: Omit<Props, "creates">) {
  const ar = lang === "ar";
  return (
    <>
      {tree.map((g) => {
        if (g.href) return (
          <div key={g.id} role="group" data-testid={`moreacct-${g.id}`}>
            <Link href={g.href} className="d21-more-row" aria-current={activeGroup === g.id ? "page" : undefined}>
              <Ico name={g.icon} /><span>{g.label}</span><Ico name="chev" small className="chev" />
            </Link>
          </div>
        );
        const hid = `d21-more-acct-${g.id}`;
        const pid = `d21-more-acct-panel-${g.id}`;
        const isOpen = openGroup === g.id;
        return (
          <div key={g.id} role="group" aria-labelledby={hid} data-testid={`moreacct-${g.id}`}>
            <button type="button" className="d21-more-grp" id={hid} aria-expanded={isOpen} aria-controls={pid}
              data-current={activeGroup === g.id ? "true" : undefined} onClick={() => onToggleGroup(g.id)}>
              <Ico name={g.icon} /><span>{g.label}</span><Ico name="chevd" small className="chev" />
            </button>
            <div className="d21-acc" id={pid} data-open={isOpen ? "true" : undefined}>
              <div className="d21-acc-in">
                {g.items.map((it) => it.state === "soon" ? (
                  <span key={it.id} className="d21-more-row is-soon" aria-disabled="true">
                    <Ico name={g.icon} /><span>{it.label}</span><em className="d21-acct-soon">{ar ? "قريباً" : "Soon"}</em>
                  </span>
                ) : (
                  <span key={it.id} className="d21-acct-morerow">
                    <Link href={it.href!} className="d21-more-row" aria-current={activeItem === it.id ? "page" : undefined}>
                      <Ico name={g.icon} /><span>{it.label}</span><Ico name="chev" small className="chev" />
                    </Link>
                    {it.create ? <Link href={it.create} className="d21-acct-plus is-more" aria-label={ar ? `جديد: ${it.label}` : `New: ${it.label}`}><Ico name="plus" small /></Link> : null}
                  </span>
                ))}
              </div>
            </div>
          </div>
        );
      })}
    </>
  );
}
