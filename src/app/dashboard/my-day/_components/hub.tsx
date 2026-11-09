"use client";

// «يومي» (D16 «خطتي», owner-approved Figma D16, 9 Nov 2026): two tabs — «اليوم» and «خطتي» (it replaces «مهامي وخطتي»
// and «مهامي»; the calendar is «مساحة عملي»'s own page) — and ONE «أضف» with two actions: «أضف لخطتي» and
// «سجّل زيارة/مكالمة صارت».
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Ico, type D21IconName } from "@/components/shell/icons";
import { LogActivityPicker } from "../../sales/activities/LogActivityPicker";

export type HubTab = "today" | "plan";
export const HUB_TABS: { id: HubTab; ar: string; en: string; icon: D21IconName }[] = [
  { id: "today", ar: "اليوم", en: "Today", icon: "home" },
  { id: "plan", ar: "خطتي", en: "My plan", icon: "flag" },
];
/** `?tab=plan` — and the old `?tab=tasks` links — open «خطتي»; anything else «اليوم». */
export const hubTabOf = (v: string | null): HubTab => (v === "plan" || v === "tasks" ? "plan" : "today");

export function HubTabs({ tab, ar, onTab }: { tab: HubTab; ar: boolean; onTab: (t: HubTab) => void }) {
  return (
    <div className="md-tabs" role="tablist" aria-label={ar ? "أقسام يومي" : "My day sections"} data-testid="md-tabs">
      {HUB_TABS.map((t) => (
        <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} className={tab === t.id ? "on" : undefined}
          onClick={() => onTab(t.id)}
          data-testid={`md-tab-${t.id}`}>
          <Ico name={t.icon} small />{ar ? t.ar : t.en}
        </button>
      ))}
    </div>
  );
}

type QuickLink = { href: string; ar: string; en: string; id: string };

/**
 * «أضف» (D16): «أضف لخطتي» — what the rep means to do (the page opens the one sheet) — and «سجّل زيارة/مكالمة صارت» —
 * what just happened (the activity dialog, the customer chosen first); then the sales documents the rep may start.
 */
export function AddMenu({ ar, links, onDone, onPlan }: { ar: boolean; links: QuickLink[]; onDone: (msg: string) => void; onPlan: () => void }) {
  const [open, setOpen] = useState(false);
  const [what, setWhat] = useState<null | "activity">(null);
  const box = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const off = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("mousedown", off); window.addEventListener("keydown", esc);
    return () => { window.removeEventListener("mousedown", off); window.removeEventListener("keydown", esc); };
  }, [open]);
  const pick = (w: "activity" | "plan") => {
    setOpen(false);
    if (w === "plan") { onPlan(); return; }
    setWhat(w);
  };
  const opts: { w: "activity" | "plan"; icon: D21IconName; ar: string; en: string; subAr: string; subEn: string }[] = [
    { w: "plan", icon: "plus", ar: "أضف لخطتي", en: "Add to my plan", subAr: "زيارة، مكالمة، عرض سعر… لليوم أو بعدين", subEn: "A visit, call, quotation… today or later" },
    { w: "activity", icon: "check", ar: "سجّل زيارة/مكالمة صارت", en: "Log a visit/call that happened", subAr: "صار شي الحين وتبي تسجّل وش صار", subEn: "Record what just happened" },
  ];
  return (
    <div className="md-add" ref={box}>
      <button type="button" className="btn p md-add-btn" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((v) => !v)} data-testid="md-add">
        <Ico name="plus" small />{ar ? "أضف" : "Add"}
      </button>
      {open ? (
        <div className="md-add-menu" role="menu" data-testid="md-add-menu">
          {opts.map((o) => (
            <button key={o.w} type="button" role="menuitem" className="md-add-opt" onClick={() => pick(o.w)} data-testid={`md-add-${o.w}`}>
              <span className="md-add-ico" aria-hidden><Ico name={o.icon} /></span>
              <span><b>{ar ? o.ar : o.en}</b><small>{ar ? o.subAr : o.subEn}</small></span>
            </button>
          ))}
          {links.length ? <div className="md-add-sep" role="separator" /> : null}
          {links.map((l) => <Link key={l.id} role="menuitem" className="md-add-link" href={l.href} onClick={() => setOpen(false)} data-testid={l.id}>{ar ? l.ar : l.en}</Link>)}
        </div>
      ) : null}
      {what === "activity" ? <LogActivityPicker lang={ar ? "ar" : "en"} onClose={() => setWhat(null)} onDone={() => { setWhat(null); onDone(ar ? "تم التسجيل." : "Logged."); }} /> : null}
    </div>
  );
}
