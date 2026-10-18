"use client";
/**
 * The print certification gate in the UI (owner decision on A-8). The screens ask the server
 * (GET /api/print/status) whether label printing is enabled and, while it is not — or while the
 * answer is unknown — keep their print actions disabled with the bilingual explanation below.
 * This is presentation only: every printing endpoint refuses on the server with 409
 * PRINTING_NOT_CERTIFIED whatever the page shows.
 */
import { useEffect, useState } from "react";
import { Notice } from "@/components/hr/ui";
import { useL } from "@/components/ops/ui";
import { PRINT_NOT_CERTIFIED_CODE, PRINT_NOT_CERTIFIED_MESSAGE, PRINT_PHASE1_NOTE } from "@/lib/print/certification";

export const PRINT_GATE_NOTE_ID = "print-not-certified-note";

/** null while loading (treated as not enabled: fail-closed), then the server's answer. */
export function usePrintCertified(): boolean | null {
  const [certified, setCertified] = useState<boolean | null>(null);
  useEffect(() => {
    let alive = true;
    fetch("/api/print/status", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : { certified: false }))
      .then((b: { certified?: unknown }) => { if (alive) setCertified(b.certified === true); })
      .catch(() => { if (alive) setCertified(false); });
    return () => { alive = false; };
  }, []);
  return certified;
}

/** The localized refusal text when an API answer is the certification refusal, else null. */
export function notCertifiedText(body: { code?: string } | null | undefined, lang: "ar" | "en"): string | null {
  return body?.code === PRINT_NOT_CERTIFIED_CODE ? PRINT_NOT_CERTIFIED_MESSAGE[lang] : null;
}

/** The explanation beside a disabled print action (Direction 2.1 notice, warning tone). */
export function PrintNotCertifiedNotice({ id = PRINT_GATE_NOTE_ID }: { id?: string }) {
  const L = useL();
  return (
    <Notice tone="warning">
      <span id={id} data-testid="print-not-certified">
        <strong>{L(PRINT_PHASE1_NOTE.ar, PRINT_PHASE1_NOTE.en)}</strong>{" — "}
        {L(PRINT_NOT_CERTIFIED_MESSAGE.ar, PRINT_NOT_CERTIFIED_MESSAGE.en)}
      </span>
    </Notice>
  );
}

export const PRINT_PHASE1_NOTE_ID = "print-phase1-note";

/**
 * Owner decision D1: every plain-document «Print» action (payslips, …) is unavailable while the
 * same PRINT_CERTIFIED gate is off. The action is rendered disabled and points at this note.
 */
export function PrintPhase1Notice({ id = PRINT_PHASE1_NOTE_ID, className }: { id?: string; className?: string }) {
  const L = useL();
  return (
    <div className={className}>
      <Notice tone="warning">
        <span id={id} data-testid="print-phase1-note">{L(PRINT_PHASE1_NOTE.ar, PRINT_PHASE1_NOTE.en)} — {L(
          "سيُتاح زر الطباعة بعد اعتماد الطباعة.",
          "The Print action returns once printing is approved.",
        )}</span>
      </Notice>
    </div>
  );
}
