"use client";
/**
 * Pages of a print job: each page is a box of exactly the (oriented) paper size in mm, and each
 * label an absolutely positioned box at its slot's (x, y) mm (Layout Engine). Used by the preview
 * (scaled to the panel, cut lines and «empty» slots drawn) and by the print output (unscaled,
 * nothing but the labels).
 */
import { createPortal } from "react-dom";
import { useEffect, useState, type ReactNode } from "react";
import { pageCss, pageSize, type LayoutPage, type LayoutProfile } from "@/lib/print/layout";
import type { LabelData } from "@/lib/print/content";
import { cssMm } from "@/lib/print/units";
import { LabelView, type LabelOptions } from "./LabelView";
import "./print.css";

export function SheetPage({ page, profile, byRef, opts, mode, emptyText }: {
  page: LayoutPage; profile: LayoutProfile; byRef: Map<string, LabelData>; opts: LabelOptions; mode: "preview" | "print"; emptyText?: string;
}) {
  const { w, h } = pageSize(profile);
  return (
    <div dir="ltr" className={`pl-page is-${mode}`} style={{ width: cssMm(w), height: cssMm(h) }} data-page={page.index + 1} data-testid={mode === "print" ? "print-page" : "preview-page"}>
      {page.slots.map((s) => {
        const d = s.ref ? byRef.get(s.ref) : null;
        return (
          <div key={s.slot} className={`pl-slot${d ? "" : " is-empty"}`} data-slot={s.slot}
            style={{ left: cssMm(s.xMm), top: cssMm(s.yMm), width: cssMm(s.wMm), height: cssMm(s.hMm) }}>
            {d ? <LabelView data={d} opts={opts} wMm={s.wMm} hMm={s.hMm} refAttr={d.ref} /> : mode === "preview" ? <span className="pl-empty">{emptyText}</span> : null}
          </div>
        );
      })}
    </div>
  );
}

/**
 * A print-only portal in <body>: its own <style> carries the @page rule of the profile and hides
 * the application while printing. `onReady` fires once fonts and images have loaded.
 */
export function PrintPortal({ profile, onReady, children }: { profile: LayoutProfile; onReady?: () => void; children: ReactNode }) {
  const [host, setHost] = useState<HTMLElement | null>(null);
  useEffect(() => {
    const el = document.createElement("div");
    el.className = "pl-print-root";
    el.dir = "ltr"; // physical layout: slots are positioned from the paper's top-left in every language
    el.setAttribute("data-testid", "print-root");
    document.body.appendChild(el);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the portal host exists only after mount
    setHost(el);
    return () => { el.remove(); };
  }, []);
  useEffect(() => {
    if (!host || !onReady) return;
    // Wait for the label fonts and the logo before handing over to the print dialog.
    let cancelled = false;
    const imgs = Array.from(host.querySelectorAll("img"));
    Promise.all([document.fonts?.ready, ...imgs.map((i) => (i.complete ? null : new Promise((r) => { i.onload = r; i.onerror = r; })))])
      .then(() => { if (!cancelled) onReady(); });
    return () => { cancelled = true; };
  }, [host, onReady]);
  if (!host) return null;
  return createPortal(
    <>
      <style>{`${pageCss(profile)}\n@media print { body > *:not(.pl-print-root) { display: none !important; } html, body { margin: 0 !important; padding: 0 !important; background: #fff !important; min-height: 0 !important; height: auto !important; } }`}</style>
      {children}
    </>,
    host,
  );
}

/** The print output of an authorized job. */
export function PrintRoot({ pages, profile, byRef, opts, onReady }: {
  pages: LayoutPage[]; profile: LayoutProfile; byRef: Map<string, LabelData>; opts: LabelOptions; onReady?: () => void;
}) {
  return (
    <PrintPortal profile={profile} onReady={onReady}>
      {pages.map((p) => <SheetPage key={p.index} page={p} profile={profile} byRef={byRef} opts={opts} mode="print" />)}
    </PrintPortal>
  );
}
