"use client";
// P2 UXM-10 (owner decision ب3, approved Figma 8أ): an action that cannot be undone with one tap asks first, NAMING what
// happens — «حوّله لفرصة», «إصدار العرض», «قَبِل العميل». «ارجع» is the safe answer; the confirm button repeats the verb.
import type { ReactNode } from "react";
import { D21Dialog } from "@/components/ui/Dialog";

export function ResultConfirm({ ar, title, body, fact, confirmLabel, busy, onConfirm, onClose, testId }: {
  ar: boolean; title: ReactNode; body: ReactNode;
  /** One labelled figure under the body (e.g. «الإجمالي شامل الضريبة · 4,416.00 ⃁»). */
  fact?: { label: ReactNode; value: ReactNode } | null;
  confirmLabel: ReactNode; busy?: boolean; onConfirm: () => void; onClose: () => void; testId: string;
}) {
  return (
    <D21Dialog lang={ar ? "ar" : "en"} title={title} onClose={busy ? undefined : onClose} testId={testId} width={420}
      actions={<>
        <button type="button" className="d21-dlg-btn is-primary" disabled={busy} onClick={onConfirm} data-testid={`${testId}-yes`}>{busy ? "…" : confirmLabel}</button>
        <button type="button" className="d21-dlg-btn" disabled={busy} onClick={onClose} data-testid={`${testId}-back`}>{ar ? "ارجع" : "Back"}</button>
      </>}>
      <p className="rc-body">{body}</p>
      {fact ? <p className="rc-fact"><span>{fact.label}</span><b><bdi>{fact.value}</bdi></b></p> : null}
      <style>{`.rc-body{margin:0;font-size:14px;line-height:24px;color:var(--text-primary)}.rc-fact{display:flex;justify-content:space-between;gap:8px;margin:12px 0 0;font-size:14px}.rc-fact span{color:var(--text-muted)}`}</style>
    </D21Dialog>
  );
}
