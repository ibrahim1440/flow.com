"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { OpsRoot } from "@/components/ops/ui";
import { PRINT_PHASE1_NOTE_ID, PrintPhase1Notice, usePrintDocuments } from "@/components/print/Certification";
import { useI18n } from "@/lib/i18n/context";
import "./document.css";

/**
 * The screen around a printed A4 document that reads its data from a print endpoint — the roast
 * sheet «ورقة التحميص» and the delivery note «إشعار التسليم» (feat/print-docs). Same chrome as the
 * quotation document (A-12 toolbar: the way back, the other language, «طباعة / حفظ PDF»); nothing
 * of it reaches paper.
 *
 * ── The document gate ──
 * Both documents follow PRINT_DOCUMENTS_ENABLED (usePrintDocuments; unknown = off). While it is off
 * the «Print» button is disabled, points at the Phase 1 note, and the document is not requested:
 * its endpoint (/api/print/documents/**) refuses with 409 DOCUMENT_PRINTING_DISABLED anyway. The
 * page renders the document only when `printing === true`.
 */
export function DocumentPrintPage({
  back, title, controls, otherLanguageHref, docLang, testId, children,
}: {
  back: { href: string; label: ReactNode };
  title: ReactNode;
  /** Extra toolbar controls (the roaster picker). */
  controls?: ReactNode;
  otherLanguageHref: string;
  docLang: "ar" | "en";
  testId: string;
  /** The document, asked for only while document printing is on. */
  children: (printing: true) => ReactNode;
}) {
  const { lang } = useI18n();
  const ar = lang === "ar";
  const printing = usePrintDocuments();

  return (
    <OpsRoot>
    <div className="hr-page dsh-page" data-testid={testId}>
      <div className="dsh-bar">
        <Link href={back.href} className="num" data-doc>{back.label}</Link>
        <span className="ttl">{title}</span>
        <span className="sp" />
        {controls}
        <Link href={otherLanguageHref} className="hr-btn" data-doc data-testid="doc-other-language">
          {docLang === "ar" ? "English" : "العربية"}
        </Link>
        <button
          type="button"
          className="hr-btn is-primary"
          data-testid="print-document"
          disabled={printing !== true}
          aria-describedby={printing === true ? undefined : PRINT_PHASE1_NOTE_ID}
          onClick={() => { if (printing === true) window.print(); }}
        >
          {ar ? "طباعة / حفظ PDF" : "Print / save as PDF"}
        </button>
      </div>
      {printing === false ? <PrintPhase1Notice className="dsh-wrap dsh-gate" /> : null}
      {printing === null ? <p className="dsh-wrap dsh-wait" role="status">{ar ? "جارٍ التحميل…" : "Loading…"}</p> : null}
      {printing === true ? children(true) : null}
      <style dangerouslySetInnerHTML={{ __html: CHROME_PRINT_CSS }} />
    </div>
    </OpsRoot>
  );
}

/** What the application chrome does on paper (as on the quotation document page). */
const CHROME_PRINT_CSS = `
@media print {
  nav, aside, button { display: none !important; }
  a[href]:not([data-doc]) { display: none !important; }
  body { background: #fff !important; }
  .d21, .d21-app, .d21-main, .d21-sheet, .d21-body { background: #fff !important; }
  .pg, .hr-page { padding: 0 !important; margin: 0 !important; max-width: none !important; background: #fff !important; }
}
`;
