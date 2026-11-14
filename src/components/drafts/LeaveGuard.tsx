"use client";
// P2 ب9 / UXM-02 (owner decision; the wording is the owner's Modern Standard Arabic, 13 Nov 2026 — Figma 7أ/7ب):
//   · «هل تريد المغادرة؟» before an unsaved form is left: an in-app link (the tab bar, the menu, the header's back), the
//     page's ✕ / «إلغاء» (they call `ask`), and — the browser's own prompt — closing or reloading the tab;
//   · «استرجعنا مسودتك غير المحفوظة.» when a kept draft was put back on the form.
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { D21Dialog } from "@/components/ui/Dialog";
import { clearDraft, loadDraft, saveDraft } from "@/lib/drafts/local-draft";
import "./drafts.css";

export const LEAVE_TEXT = {
  title: "هل تريد المغادرة؟",
  body: "لم يُحفظ ما أدخلته، وسيُفقد عند المغادرة.",
  stay: "البقاء",
  leave: "المغادرة وحذف المُدخلات",
  restored: "استرجعنا مسودتك غير المحفوظة.",
  keep: "متابعة",
  discard: "حذف المسودة",
  note: "تُحفظ المسودة على هذا الجهاز مدة 24 ساعة، وتُحذف عند تسجيل الخروج. صورة الإيصال لا تُحفظ.", // Q19 (Figma 7ب)
  // Abu Fahd R2 (low): a form with no receipt (the lead, the sample) does not mention one.
  noteNoReceipt: "تُحفظ المسودة على هذا الجهاز مدة 24 ساعة، وتُحذف عند تسجيل الخروج.",
} as const;
const LEAVE_EN = {
  title: "Leave this page?", body: "What you entered is not saved and will be lost if you leave.", stay: "Stay", leave: "Leave and discard",
  restored: "We restored your unsaved draft.", keep: "Continue", discard: "Delete the draft",
  note: "The draft is kept on this device for 24 hours and deleted at sign-out. The receipt image is not kept.",
  noteNoReceipt: "The draft is kept on this device for 24 hours and deleted at sign-out.",
} as const;
export const leaveText = (ar: boolean) => (ar ? LEAVE_TEXT : LEAVE_EN);

/**
 * The form's draft: restored once on mount (onRestore), saved (debounced) while `dirty`, removed when the form is empty,
 * sent or discarded. `value` must be plain JSON — never a File.
 */
export function useLocalDraft<T>(user: string | null | undefined, name: string | null, value: T, dirty: boolean, onRestore: (data: T) => boolean | void) {
  const [restored, setRestored] = useState(false);
  const ready = useRef(false);
  const restore = useRef(onRestore);
  useEffect(() => { restore.current = onRestore; });
  useEffect(() => {
    if (!name || !user || ready.current) return;
    ready.current = true;
    const d = loadDraft<T>(user, name);
    // onRestore may decline (false): a draft for another customer than the one the page was opened for.
    if (d && restore.current(d.data) !== false) setRestored(true);
  }, [name, user]);
  const json = JSON.stringify(value);
  useEffect(() => {
    if (!name || !user || !ready.current) return;
    const t = window.setTimeout(() => { if (dirty) saveDraft(user, name, JSON.parse(json) as T); else clearDraft(user, name); }, 300);
    return () => window.clearTimeout(t);
  }, [user, name, json, dirty]);
  const clear = useCallback(() => { if (name) clearDraft(user, name); setRestored(false); }, [user, name]);
  // Save now (no debounce) — before a same-tab move the form means to come back from (gate A3: «افتحه»).
  const flush = useCallback(() => { if (name && user && dirty) saveDraft(user, name, JSON.parse(json) as T); }, [user, name, dirty, json]);
  return { restored, dismiss: () => setRestored(false), clear, flush };
}

/** «استرجعنا مسودتك غير المحفوظة.» — «متابعة» keeps it, «حذف المسودة» empties the form. */
export function DraftBanner({ ar, onKeep, onDiscard, receipt = false }: { ar: boolean; onKeep: () => void; onDiscard: () => void; receipt?: boolean }) {
  const t = leaveText(ar);
  return (
    <div className="draft-banner" role="status" data-testid="draft-banner">
      <b>{t.restored}</b>
      <p data-testid="draft-note">{receipt ? t.note : t.noteNoReceipt}</p>
      <div className="draft-banner-acts">
        <button type="button" className="draft-btn p" onClick={onKeep} data-testid="draft-keep">{t.keep}</button>
        <button type="button" className="draft-btn" onClick={onDiscard} data-testid="draft-discard">{t.discard}</button>
      </div>
    </div>
  );
}

/**
 * While `dirty`: in-app links ask first, and the browser asks before the tab closes / reloads. `ask(href)` is for the
 * page's own ✕ / «إلغاء». Leaving clears the draft (`onLeave`) — «المغادرة وحذف المُدخلات».
 */
export function useLeaveGuard({ ar, dirty, onLeave }: { ar: boolean; dirty: boolean; onLeave: () => void }): { ask: (to: string | (() => void)) => void; dialog: ReactNode } {
  const router = useRouter();
  // Where «المغادرة» goes: a path, or the page's own close (a dialog's ✕ / «إلغاء»).
  const [to, setTo] = useState<{ go: string | (() => void) } | null>(null);
  const live = useRef(dirty);
  useEffect(() => { live.current = dirty; }, [dirty]);
  useEffect(() => {
    if (!dirty) return;
    const unload = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ""; };
    // Capture phase: before next/link's own handler navigates.
    const click = (e: MouseEvent) => {
      if (!live.current || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!a || a.target === "_blank" || a.hasAttribute("download") || a.dataset.leaveOk != null) return;
      const url = new URL(a.href, window.location.href);
      if (url.origin !== window.location.origin) return;
      if (url.pathname === window.location.pathname && url.search === window.location.search) return;
      e.preventDefault();
      e.stopPropagation();
      setTo({ go: url.pathname + url.search + url.hash });
    };
    window.addEventListener("beforeunload", unload);
    document.addEventListener("click", click, true);
    return () => { window.removeEventListener("beforeunload", unload); document.removeEventListener("click", click, true); };
  }, [dirty]);
  const ask = useCallback((go: string | (() => void)) => { if (live.current) setTo({ go }); else if (typeof go === "string") router.push(go); else go(); }, [router]);
  const t = leaveText(ar);
  const dialog = to ? (
    <D21Dialog lang={ar ? "ar" : "en"} title={t.title} onClose={() => setTo(null)} testId="leave-dialog" width={420}
      actions={<>
        <button type="button" className="d21-dlg-btn is-primary" onClick={() => setTo(null)} data-testid="leave-stay">{t.stay}</button>
        <button type="button" className="d21-dlg-btn" data-testid="leave-go" onClick={() => { const { go } = to; live.current = false; setTo(null); onLeave(); if (typeof go === "string") router.push(go); else go(); }}>{t.leave}</button>
      </>}>
      <p className="draft-leave-body" data-testid="leave-body">{t.body}</p>
    </D21Dialog>
  ) : null;
  return { ask, dialog };
}
