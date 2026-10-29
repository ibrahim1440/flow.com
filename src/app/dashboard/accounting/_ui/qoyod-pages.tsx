"use client";

// Qoyod parity, phase 3 (builder qb-pages): the accountant's 7 daily pages read the way Qoyod reads — the list column
// order, the words, the form's field order and the «حفظ كمسودة / اعتماد» buttons — inside the accountant workspace
// only. The gate is qa-shell's `useWorkspaceMode().accountant` and the words are the shared glossary
// (`@/lib/nav/glossary`, via `useTerm`); a viewer outside the accountant workspace sees today's pages unchanged.
// Display only: no request, payload, permission or posting changes here.
import { useWorkspaceMode } from "@/components/chrome";

/** Whether the accountant workspace («واجهة المحاسب») is drawn for this viewer — THE gate for the Qoyod variant of a page. */
export function useAccountantView(): boolean {
  return useWorkspaceMode().accountant;
}

/** Exact 2-decimal subtraction of two money strings (halalas, no float drift) — a display figure only. */
export function moneyMinus(a: string | null | undefined, b: string | null | undefined): string {
  const c = (v: string | null | undefined) => {
    const m = /^(-?)(\d*)(?:\.(\d{0,2}))?/.exec(String(v ?? "0").trim()) ?? ["", "", "0", ""];
    const n = Number(m[2] || "0") * 100 + Number(((m[3] ?? "") + "00").slice(0, 2));
    return m[1] === "-" ? -n : n;
  };
  const d = c(a) - c(b);
  const s = d < 0 ? "-" : "";
  const abs = Math.abs(d);
  return `${s}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}
