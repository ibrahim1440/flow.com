"use client";

import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { DocCell, DocColumn } from "@/lib/print/quote-document";
import "./document.css";

/**
 * The A4 business document: the quotation (Figma QP-05 1295:987, QP-03 1295:754, EN 1373:791)
 * and, sharing the same layout, the tax invoice (ZT-04 1284:46933). One component draws it on
 * screen, on paper and in «Save as PDF», so what the user previews is what the customer gets.
 *
 * It knows nothing about quotations: the caller hands it the texts and the figures (already
 * formatted), and it lays them out —
 *   logo (start) · seller block under it  |  title block (end)
 *   banner (a draft, a superseded document)
 *   meta (start: number, validity)  |  buyer (end)
 *   lines table (header repeated on every printed page)
 *   totals box (end): label at the start, amount at the end, a rule, then the grand total
 *   notes · bank transfer details
 *   footer on every page: the legal line, «page X of Y · status», the document number.
 *
 * ── The footer on paper ──
 * Printed, it is drawn in the page's bottom margin (@page margin boxes), so it repeats on every
 * sheet with the real «X of Y» (counter(page) / counter(pages)). Chromium-based browsers draw
 * them (Chrome / Edge 131+), which is the «Save as PDF» path the app documents; a browser without
 * margin boxes prints the document without its running footer. On screen the footer closes the
 * sheet, with the page count the content will take at A4.
 */

export type DocRow = {
  label: string;
  value: ReactNode;
  /** The value is an identifier: the monospace face (a number, an IBAN). */
  mono?: boolean;
  /** The whole row reads in the muted colour (the buyer's VAT number, as drawn). */
  muted?: boolean;
  testId?: string;
};

export type DocTotal = { label: ReactNode; value: string; grand?: boolean; testId?: string };

export type DocumentSheetProps = {
  lang: "ar" | "en";
  testId?: string;
  logo: { src: string; alt: string; width: number; height: number };
  seller?: { name: string | null; lines: ReactNode[]; testId?: string } | null;
  title: { main: string; lines: ReactNode[] };
  banner?: { tone: "warning" | "danger"; title: string; text?: string | null; testId?: string } | null;
  metaStart: DocRow[];
  metaEnd: DocRow[];
  columns: DocColumn[];
  rows: DocCell[][];
  totals: DocTotal[];
  notes?: { label: string; text: string; testId?: string } | null;
  bank?: { label: string; rows: DocRow[]; testId?: string } | null;
  footer: {
    legal: string;
    /** «الصفحة X من Y · <status>» — X and Y are filled in on paper by the page counters. */
    page: { before: string; between: string; after: string };
    docNumber: string;
  };
};

/** A4 at 96 dpi, less the printed top and bottom margins: the content height of one sheet. */
const PAGE_CONTENT_PX = Math.round(((297 - 10 - 22) / 25.4) * 96);

/** A CSS string literal: quotes, backslashes and line breaks escaped. */
const cssString = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\A ")}"`;

/** The print rules that depend on the document (its direction and its footer texts). */
export function documentPageCss(footer: DocumentSheetProps["footer"], rtl: boolean): string {
  const start = rtl ? "bottom-right" : "bottom-left";
  const end = rtl ? "bottom-left" : "bottom-right";
  const box = `vertical-align: top; padding-top: 9px; border-top: 1px solid #efeadf; color: #6e6a61; font-size: 9.4pt; line-height: 16.5pt;`;
  return `
@page {
  size: A4;
  margin: 10mm 12.7mm 22mm;
  @${start} {
    content: ${cssString(footer.legal)} "\\A " ${cssString(footer.page.before)} counter(page) ${cssString(footer.page.between)} counter(pages) ${cssString(footer.page.after)};
    white-space: pre; text-align: ${rtl ? "right" : "left"}; direction: ${rtl ? "rtl" : "ltr"};
    font-family: ${rtl ? '"IBM Plex Sans Arabic", "IBM Plex Sans"' : '"IBM Plex Sans", "IBM Plex Sans Arabic"'}, sans-serif;
    width: 70%; ${box}
  }
  @${end} {
    content: "\\A " ${cssString(footer.docNumber)};
    white-space: pre; text-align: ${rtl ? "left" : "right"}; direction: ltr;
    font-family: "IBM Plex Mono", monospace;
    width: 30%; ${box}
  }
}`;
}

export function DocumentSheet(p: DocumentSheetProps) {
  const rtl = p.lang === "ar";
  const bodyRef = useRef<HTMLDivElement>(null);
  const [pages, setPages] = useState(1);
  // The page count the screen footer states: the content's height against one A4 sheet's.
  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const measure = () => setPages(Math.max(1, Math.ceil(el.scrollHeight / PAGE_CONTENT_PX)));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return (
    <article className="dsh" dir={rtl ? "rtl" : "ltr"} lang={p.lang} data-testid={p.testId}>
      <div className="dsh-body" ref={bodyRef}>
        <div className="dsh-logo">
          {/* An <img>, so it reaches paper and «Save as PDF» without "print backgrounds". */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={p.logo.src} alt={p.logo.alt} width={p.logo.width} height={p.logo.height} data-testid="doc-logo" />
        </div>

        <div className="dsh-head">
          <address className="dsh-seller" data-testid={p.seller?.testId}>
            {p.seller?.name && <b>{p.seller.name}</b>}
            {p.seller?.lines.map((l, i) => <span key={i}>{l}</span>)}
          </address>
          <div className="dsh-title">
            <h1>{p.title.main}</h1>
            {p.title.lines.map((l, i) => <span key={i}>{l}</span>)}
          </div>
        </div>

        {p.banner && (
          <div className={`dsh-banner ${p.banner.tone}`} role="note" data-testid={p.banner.testId}>
            <b>{p.banner.title}</b>
            {p.banner.text && <span>{p.banner.text}</span>}
          </div>
        )}

        <hr className="dsh-rule" />

        <div className="dsh-meta">
          <Props rows={p.metaStart} className="dsh-meta-start" />
          <Props rows={p.metaEnd} className="dsh-meta-end" />
        </div>

        {/* A real table: printed, its header row repeats on every sheet the lines run onto. */}
        <table className="dsh-lines">
          <thead>
            <tr>
              {p.columns.map((c) => (
                <th key={c.key} className={c.numeric ? "num" : undefined} scope="col">{c.label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {p.rows.map((cells, r) => (
              <tr key={r}>
                {cells.map((cell, i) => {
                  const col = p.columns[i];
                  return (
                    <td key={col.key} className={[col.numeric ? "num" : "", col.muted ? "mu" : "", col.key].filter(Boolean).join(" ")}>
                      <span className="m"><bdi>{cell.main}</bdi></span>
                      {cell.sub && <span className={cell.subMono ? "s mono" : "s"}><bdi>{cell.sub}</bdi></span>}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>

        <dl className="dsh-totals" data-testid="doc-totals">
          {p.totals.map((t, i) => (
            <div key={i} className={t.grand ? "g" : undefined} data-testid={t.testId}>
              <dt>{t.label}</dt>
              <dd><bdi>{t.value}</bdi></dd>
            </div>
          ))}
        </dl>

        {p.notes && (
          <section className="dsh-notes" data-testid={p.notes.testId}>
            <h2>{p.notes.label}</h2>
            <p><bdi>{p.notes.text}</bdi></p>
          </section>
        )}

        {p.bank && p.bank.rows.length > 0 && (
          <section className="dsh-bank" data-testid={p.bank.testId}>
            <h2>{p.bank.label}</h2>
            <Props rows={p.bank.rows} />
          </section>
        )}
      </div>

      {/* Screen footer (the printed one is drawn in the page margin on every sheet). */}
      <footer className="dsh-foot" data-testid="doc-footer">
        <p>{p.footer.legal}</p>
        <div>
          <span>
            {p.footer.page.before}<bdi>{pages}</bdi>{p.footer.page.between}<bdi>{pages}</bdi>{p.footer.page.after}
          </span>
          <bdi className="mono" dir="ltr">{p.footer.docNumber}</bdi>
        </div>
      </footer>
      <style dangerouslySetInnerHTML={{ __html: documentPageCss(p.footer, rtl) }} />
    </article>
  );
}

function Props({ rows, className }: { rows: DocRow[]; className?: string }) {
  if (rows.length === 0) return <div className={className} />;
  return (
    <dl className={["dsh-props", className].filter(Boolean).join(" ")}>
      {rows.map((r, i) => (
        <div key={i} className={r.muted ? "mu" : undefined} data-testid={r.testId}>
          <dt>{r.label}</dt>
          <dd className={r.mono ? "mono" : undefined}>{r.value}</dd>
        </div>
      ))}
    </dl>
  );
}
