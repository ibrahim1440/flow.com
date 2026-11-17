"use client";

// R1-e (owner-approved Figma 1JbZgpMqmPkUVne8ms9Ozz, page «R1-e · معالجة رسائل التسويق»: a 2057:18, a2 2075:663,
// b 2059:178, b2 2074:583, c 2061:226, d 2062:287, e 2061:343, g 2062:359, h 2064:483, h4 2074:721): ONE processing
// experience for a message that may have been delivered — the campaign log and the automation log use these pieces.
//   · two badges in two columns: the provider's delivery status (read-only) and the manual review — never one for the other;
//   · the drawer (a bottom sheet under 768px): both boxes, the reason, the timeline, the text, «كيف تتحقق؟», and a footer
//     whose only action is «تسجيل نتيجة التحقق»; «إعادة الإرسال بعد المراجعة» stays locked until «لم تصل»;
//   · the review dialog (three outcomes, a required note, the reviewer and the time filled in) and the resend confirmation;
//   · every refusal says what happened and what did not (nothing recorded / nothing sent) — the server decides (409/403).
import { useEffect, useRef, useState, type ReactNode } from "react";
import "./review-ui.css";

export type Lang = "ar" | "en";
export type Outcome = "DELIVERED" | "NOT_DELIVERED" | "UNCERTAIN";
export type ActionResult = { ok: boolean; status: number; data: { error?: string; errorEn?: string; code?: string; href?: string | null } };

/** A message, normalised from either log. */
export type ReviewMessage = {
  id: string;
  /** For the drawer title: «رسالة واتساب منقطعة» / «إيميل منقطع». */
  channel: "whatsapp" | "email";
  address: string | null;
  /** «حملة الجمعة البيضاء · تسويقية» / «تذكير موعد التسليم · المبيعات · واتساب». */
  source: string;
  body: string | null;
  /** The provider's status (status column) and its note. */
  status: string;
  statusNote: string | null;
  /** The status note as the viewer reads it (the automation log translates its stored English notes). */
  statusNoteText?: string | null;
  deliveryDoubt: boolean;
  reviewOutcome: Outcome | null;
  reviewNote: string | null;
  reviewedBy: { name: string } | null;
  reviewedAt: string | null;
  resend: { id: string; status: string } | null;
  /** «أعاد إرسالها: الاسم · الوقت». */
  resentBy?: { name: string | null; at: string } | null;
  resendOfMessageId: string | null;
  scheduledAt: string | null;
  sendingStartedAt: string | null;
  interruptedAt: string | null;
  attempts: number;
  createdAt: string;
  /** Marketing only (owner decision 4): the 24-hour window from the first send attempt. null = no window. */
  resendWindow: { from: string; until: string; open: boolean } | null;
  /** May this viewer review / resend it (the server decides again). */
  canProcess: boolean;
  /** Not resendable from the log (an activation link; an automation type's window closed or its content changed) —
   *  the reason and where to go instead. */
  noResend?: { ar: string; en: string; href?: string | null } | null;
  /** Automation: the end of the type's resend window, when it has one. */
  resendUntil?: string | null;
};

const t = (lang: Lang, ar: string, en: string) => (lang === "ar" ? ar : en);

/** dd/MM HH:mm in Riyadh, Latin digits (the design's «16/11 10:42»). */
export function shortWhen(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  const p = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Riyadh", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(d);
  const g = (k: string) => p.find((x) => x.type === k)?.value ?? "";
  return `${g("day")}/${g("month")} ${g("hour")}:${g("minute")}`;
}
function longWhen(iso: string): string {
  const p = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Riyadh", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(new Date(iso));
  const g = (k: string) => p.find((x) => x.type === k)?.value ?? "";
  return `${g("day")}/${g("month")}/${g("year")} · ${g("hour")}:${g("minute")}`;
}

// ── Icons (Lucide shapes, stroke 1.5, currentColor — the page's R1e Icon set) ──────────────────────────────────────────
const P: Record<string, ReactNode> = {
  alert: <><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" /><path d="M12 9v4M12 17h.01" /></>,
  clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
  help: <><circle cx="12" cy="12" r="9" /><path d="M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6V14M12 17h.01" /></>,
  check: <><rect x="4" y="4" width="16" height="16" rx="3" /><path d="m8.5 12 2.5 2.5 4.5-5" /></>,
  close: <path d="M6 6l12 12M18 6 6 18" />,
  repeat: <><path d="m17 2 4 4-4 4" /><path d="M3 11V9a3 3 0 0 1 3-3h15M7 22l-4-4 4-4" /><path d="M21 13v2a3 3 0 0 1-3 3H3" /></>,
  dash: <path d="M6 12h12" />,
  lock: <><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></>,
  user: <><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></>,
  info: <><circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 8h.01" /></>,
  send: <path d="M22 2 11 13M22 2l-7 20-4-9-9-4Z" />,
  cal: <><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M16 3v4M8 3v4M3 10h18" /></>,
  note: <><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9Z" /><path d="M14 3v6h6" /></>,
  link: <><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" /><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" /></>,
  refresh: <><path d="M21 12a9 9 0 1 1-3-6.7L21 8" /><path d="M21 3v5h-5" /></>,
};
export function Icon({ name, size = 16 }: { name: keyof typeof P | string; size?: number }) {
  return (
    <svg className="mr-ic" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {P[name]}
    </svg>
  );
}

type Tone = "warning" | "danger" | "success" | "info" | "muted";
export function Badge({ tone, icon, children, testId }: { tone: Tone; icon: string; children: ReactNode; testId?: string }) {
  return <span className={`mr-badge is-${tone}`} data-testid={testId}><span>{children}</span><Icon name={icon} /></span>;
}

const PROVIDER: Record<string, { ar: string; en: string; tone: Tone; icon: string }> = {
  QUEUED: { ar: "مجدولة", en: "Scheduled", tone: "muted", icon: "clock" },
  SENDING: { ar: "تُرسل", en: "Sending", tone: "info", icon: "send" },
  SENT: { ar: "أُرسلت", en: "Sent", tone: "success", icon: "check" },
  DELIVERED: { ar: "سُلّمت", en: "Delivered", tone: "success", icon: "check" },
  READ: { ar: "قُرئت", en: "Read", tone: "success", icon: "check" },
  BOUNCED: { ar: "ارتدّت", en: "Bounced", tone: "danger", icon: "close" },
  COMPLAINED: { ar: "شكوى بريد مزعج", en: "Marked as spam", tone: "danger", icon: "close" },
  FAILED: { ar: "فشلت — رفضها المزوّد", en: "Failed — refused by the provider", tone: "danger", icon: "close" },
  SKIPPED: { ar: "لم تُرسل", en: "Not sent", tone: "muted", icon: "dash" },
  CANCELLED: { ar: "ملغاة", en: "Cancelled", tone: "muted", icon: "dash" },
};

/** «حالة التسليم (من المزوّد)» — what the provider said, or that it never answered. Never the review. */
export function ProviderBadge({ m, lang, testId }: { m: Pick<ReviewMessage, "status" | "deliveryDoubt">; lang: Lang; testId?: string }) {
  if (m.status === "FAILED" && m.deliveryDoubt) return <Badge tone="warning" icon="alert" testId={testId}>{t(lang, "انقطع — لم يرد المزوّد", "Interrupted — no answer")}</Badge>;
  const s = PROVIDER[m.status] ?? { ar: m.status, en: m.status, tone: "muted" as Tone, icon: "dash" };
  return <Badge tone={s.tone} icon={s.icon} testId={testId}>{t(lang, s.ar, s.en)}</Badge>;
}

export type ReviewState = "none" | "needed" | "uncertain" | "delivered" | "resent" | "notResent" | "expired";
export function reviewStateOf(m: ReviewMessage): ReviewState {
  if (!(m.status === "FAILED" && m.deliveryDoubt)) return "none";
  if (m.reviewOutcome === "DELIVERED") return "delivered";
  if (m.reviewOutcome === "UNCERTAIN") return "uncertain";
  if (m.reviewOutcome === "NOT_DELIVERED") return m.resend ? "resent" : m.resendWindow && !m.resendWindow.open ? "expired" : "notResent";
  return m.resend ? "resent" : "needed";
}

/** «نتيجة المراجعة (يدوي)» — what a person recorded, with who and when under it. */
export function ReviewBadge({ m, lang, testId, audit = true }: { m: ReviewMessage; lang: Lang; testId?: string; audit?: boolean }) {
  const st = reviewStateOf(m);
  const b =
    st === "needed" ? <Badge tone="warning" icon="clock" testId={testId}>{t(lang, "تحتاج مراجعة", "Needs review")}</Badge>
    : st === "uncertain" ? <Badge tone="warning" icon="help" testId={testId}>{t(lang, "معلّقة — تعذّر التأكد", "Open — could not confirm")}</Badge>
    : st === "delivered" ? <Badge tone="success" icon="check" testId={testId}>{t(lang, "وصلت — أُغلقت", "Delivered — closed")}</Badge>
    : st === "resent" ? <Badge tone="info" icon="repeat" testId={testId}>{t(lang, "لم تصل — أُعيد إرسالها", "Not delivered — resent")}</Badge>
    : st === "notResent" || st === "expired" ? <Badge tone="danger" icon={st === "expired" ? "clock" : "close"} testId={testId}>{t(lang, "لم تصل — لم يُعد إرسالها", "Not delivered — not resent")}</Badge>
    : <Badge tone="muted" icon="dash" testId={testId}>{t(lang, "لا تحتاج مراجعة", "No review needed")}</Badge>;
  return (
    <span className="mr-cellstack">
      {b}
      {audit && m.reviewedBy && m.reviewedAt ? <span className="mr-micro">{t(lang, "راجعها", "Reviewed by")}: {m.reviewedBy.name} · <bdi className="mr-num">{shortWhen(m.reviewedAt)}</bdi></span> : null}
      {audit && m.resentBy ? <span className="mr-micro" data-testid="mr-resent-by">{t(lang, "أعاد إرسالها", "Resent by")}: {m.resentBy.name ?? "—"} · <bdi className="mr-num">{shortWhen(m.resentBy.at)}</bdi></span> : null}
    </span>
  );
}

/** The row's one action (column «إجراء»). */
export function RowAction({ m, lang, onOpen, selected }: { m: ReviewMessage; lang: Lang; onOpen: () => void; selected?: boolean }) {
  const st = reviewStateOf(m);
  if (st === "none") return <button type="button" className="mr-btn is-sm is-ghost" onClick={onOpen} data-testid={`mr-open-${m.id}`}>{t(lang, "عرض", "View")}</button>;
  if (m.canProcess && st === "needed") {
    return <button type="button" className={`mr-btn is-sm ${selected ? "is-primary" : ""}`} onClick={onOpen} data-testid={`mr-review-${m.id}`}><span>{t(lang, "تسجيل نتيجة التحقق", "Record the check")}</span><Icon name="note" /></button>;
  }
  if (m.canProcess && st === "uncertain") return <button type="button" className="mr-btn is-sm" onClick={onOpen} data-testid={`mr-review-${m.id}`}>{t(lang, "عرض وتحديث النتيجة", "View and update")}</button>;
  if (m.canProcess && st === "notResent" && !m.noResend) return <button type="button" className="mr-btn is-sm" onClick={onOpen} data-testid={`mr-resend-${m.id}`}><span>{t(lang, "إعادة الإرسال بعد المراجعة", "Resend after review")}</span><Icon name="repeat" /></button>;
  return <button type="button" className="mr-btn is-sm is-ghost" onClick={onOpen} data-testid={`mr-open-${m.id}`}>{t(lang, "عرض", "View")}</button>;
}

// ── Dialog shell (focus in, Esc, focus back to the opener) ────────────────────────────────────────────────────────────
function useModal(onClose: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const first = ref.current?.querySelector<HTMLElement>("[data-autofocus], button, textarea, input");
    first?.focus();
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", key);
    return () => { document.removeEventListener("keydown", key); opener?.focus?.(); };
  }, [onClose]);
  return ref;
}

function Scrim({ children, onClose, kind, label, testId }: { children: ReactNode; onClose: () => void; kind: "drawer" | "dialog"; label: string; testId: string }) {
  const ref = useModal(onClose);
  return (
    <div className={`mr-scrim is-${kind}`} onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={ref} className={`mr-${kind}`} role="dialog" aria-modal="true" aria-label={label} data-testid={testId} dir="auto">
        {children}
      </div>
    </div>
  );
}

/** A refusal box: what happened, and that nothing was recorded / sent (state g). */
function Refusal({ tone, title, body, children, testId }: { tone: Tone; title: string; body: string; children?: ReactNode; testId?: string }) {
  return (
    <div className={`mr-box is-${tone}`} role="alert" data-testid={testId}>
      <div className="mr-boxrow"><div className="mr-col"><strong>{title}</strong><p>{body}</p></div><Icon name={tone === "info" ? "user" : tone === "danger" ? "alert" : "refresh"} /></div>
      {children}
    </div>
  );
}

function refusalOf(r: ActionResult, lang: Lang, step: "review" | "resend"): { tone: Tone; title: string; body: string; code: string; href?: string | null } {
  const code = r.data.code ?? "";
  const server = lang === "ar" ? r.data.error ?? "" : r.data.errorEn ?? r.data.error ?? "";
  if (r.status === 0) return { tone: "danger", code: "NETWORK", title: t(lang, "تعذّر الحفظ", "Could not save"), body: step === "review" ? t(lang, "انقطع الاتصال بالخادم. لم يُسجَّل شيء ولم يُرسل شيء. اختيارك وملاحظتك محفوظان في النافذة.", "The connection dropped. Nothing was recorded and nothing was sent. Your choice and note are kept.") : t(lang, "انقطع الاتصال بالخادم. لم يُرسل شيء.", "The connection dropped. Nothing was sent.") };
  if (r.status === 403) return { tone: "muted", code: "FORBIDDEN", title: t(lang, "بدون صلاحية", "No permission"), body: t(lang, "معالجة هذه الرسالة لمن يملك صلاحية «إدارة الرسائل» وصلاحية قسمها. لم يُسجَّل شيء.", "Processing this message needs «manage messages» and its department's permission. Nothing was recorded.") };
  if (code === "ALREADY_REVIEWED" || code === "REVIEW_FROZEN") return { tone: "info", code, title: t(lang, "سبقك أحد", "Someone got there first"), body: t(lang, "سجّل زميل نتيجة لهذه الرسالة قبلك. لم يُسجَّل اختيارك ولم تُرسل رسالة. حدّث لترى النتيجة الحالية.", "A colleague recorded a result first. Your choice was not recorded and nothing was sent. Reload to see it.") };
  if (code === "ALREADY_RESENT") return { tone: "muted", code, title: t(lang, "أُعيد إرسال هذه الرسالة مسبقاً", "Already resent"), body: t(lang, "أعادها زميل قبلك. لم نُنشئ رسالة ثانية.", "A colleague resent it first. No second message was created.") };
  if (code === "NOT_IN_DOUBT") return { tone: "warning", code, title: t(lang, "تغيّرت حالة الرسالة", "The message changed"), body: t(lang, "لم تعد «فشلت» (مثلاً أُرسلت أو أُلغيت)، فلا تحتاج مراجعة. حدّث الصفحة لترى حالتها.", "It is no longer «failed», so it needs no review. Reload to see it.") };
  if (code === "RESEND_TOO_LATE") return { tone: "warning", code, title: t(lang, "انتهت مهلة الإعادة", "The resend window has closed"), body: server };
  return { tone: "danger", code, title: step === "review" ? t(lang, "لم تُسجَّل النتيجة", "Not recorded") : t(lang, "لم تُرسل", "Not sent"), body: server || t(lang, "رفض الخادم الطلب.", "The server refused."), href: r.data.href ?? null };
}

// ── c / e: «تسجيل نتيجة التحقق» ───────────────────────────────────────────────────────────────────────────────────────
export function ReviewDialog({ m, lang, reviewer, onClose, onSaved, review }: {
  m: ReviewMessage; lang: Lang; reviewer: string; onClose: () => void;
  onSaved: (outcome: Outcome) => void;
  review: (outcome: Outcome, note: string) => Promise<ActionResult>;
}) {
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [note, setNote] = useState("");
  const [noteErr, setNoteErr] = useState(false);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<ReturnType<typeof refusalOf> | null>(null);
  const now = new Date().toISOString();
  async function save() {
    if (!outcome) return;
    if (!note.trim()) { setNoteErr(true); return; }
    setBusy(true); setRefusal(null);
    let r: ActionResult;
    try { r = await review(outcome, note.trim()); } catch { r = { ok: false, status: 0, data: {} }; }
    setBusy(false);
    if (r.ok) return onSaved(outcome);
    if (r.status === 400 && r.data.code === "REVIEW_NOTE") { setNoteErr(true); return; }
    setRefusal(refusalOf(r, lang, "review"));
  }
  const options: [Outcome, string, string, string, Tone][] = [
    ["DELIVERED", t(lang, "وصلت الرسالة", "It was delivered"), t(lang, "تأكدت أن العميل استلمها. تُغلق الحالة ولا يُعاد الإرسال.", "You confirmed the customer received it. It closes; nothing is resent."), "check", "success"],
    ["NOT_DELIVERED", t(lang, "لم تصل الرسالة", "It was not delivered"), t(lang, "تأكدت أنها لم تصل. يُتاح بعدها «إعادة الإرسال بعد المراجعة» مع تأكيد.", "You confirmed it did not arrive. «Resend after review» becomes available, with a confirmation."), "close", "danger"],
    ["UNCERTAIN", t(lang, "تعذّر التأكد", "Could not confirm"), t(lang, "لم أستطع التأكد. تبقى «معلّقة» ويمكن تحديثها لاحقاً. لا إعادة إرسال من هنا.", "You could not confirm. It stays open and can be updated later. No resend from here."), "help", "warning"],
  ];
  return (
    <Scrim kind="dialog" onClose={busy ? () => undefined : onClose} label={t(lang, "تسجيل نتيجة التحقق", "Record the check")} testId="mr-review-dialog">
      <header className="mr-head">
        <div className="mr-col">
          <h2>{t(lang, "تسجيل نتيجة التحقق", "Record the check")}</h2>
          <p className="mr-meta">{m.source} · {t(lang, "محاولة", "attempt")} {Math.max(1, m.attempts)} {t(lang, "في", "at")} <bdi className="mr-num">{shortWhen(m.interruptedAt ?? m.sendingStartedAt ?? m.createdAt)}</bdi></p>
          {m.address ? <p className="mr-meta"><bdi dir="ltr" className="mr-num">{m.address}</bdi></p> : null}
        </div>
        <button type="button" className="mr-iconbtn" onClick={onClose} aria-label={t(lang, "إغلاق", "Close")} disabled={busy}><Icon name="close" /></button>
      </header>
      <div className="mr-body">
        <div className="mr-strip"><span className="mr-lbl"><Icon name="lock" size={14} />{t(lang, "حالة التسليم (من المزوّد):", "Delivery status (from the provider):")}</span><ProviderBadge m={m} lang={lang} /><span className="mr-micro">{t(lang, "لن تتغيّر بتسجيلك.", "Your review does not change it.")}</span></div>
        <fieldset className="mr-fieldset" disabled={busy}>
          <legend>{t(lang, "ماذا وجدت بعد التحقق؟", "What did you find?")} <span className="mr-req">*</span></legend>
          {options.map(([k, title, body, icon, tone]) => (
            <label key={k} className={`mr-option${outcome === k ? " is-on" : ""}`} data-testid={`mr-outcome-${k}`}>
              <input type="radio" name="mr-outcome" value={k} checked={outcome === k} onChange={() => setOutcome(k)} />
              <span className="mr-col"><span className={`mr-optitle is-${tone}`}><strong>{title}</strong><Icon name={icon} /></span><span className="mr-small">{body}</span></span>
            </label>
          ))}
        </fieldset>
        {outcome === "UNCERTAIN" ? (
          <div className="mr-box is-warning" data-testid="mr-uncertain-warning">
            <div className="mr-boxrow"><div className="mr-col"><strong>{t(lang, "لا إعادة إرسال تحت «تعذّر التأكد»", "No resend under «could not confirm»")}</strong><p>{t(lang, "قد تكون الرسالة وصلت؛ إعادة إرسالها قد تكرّرها عند العميل. الحفظ يسجّل النتيجة فقط ولا يرسل شيئاً. إذا تأكدت لاحقاً أنها لم تصل، حدّث النتيجة إلى «لم تصل».", "It may have arrived; resending could duplicate it. Saving records the result only and sends nothing. If you later confirm it did not arrive, update it to «not delivered».")}</p></div><Icon name="alert" /></div>
          </div>
        ) : null}
        <label className="mr-lbl2" htmlFor="mr-note">{t(lang, "ملاحظة التحقق", "Review note")} <span className="mr-req">*</span></label>
        <textarea id="mr-note" className={`mr-textarea${noteErr ? " is-err" : ""}`} value={note} maxLength={1000} rows={4} disabled={busy}
          onChange={(e) => { setNote(e.target.value); if (e.target.value.trim()) setNoteErr(false); }}
          placeholder={t(lang, "كيف تحققت؟", "How did you check?")} aria-invalid={noteErr} aria-describedby="mr-note-help" data-testid="mr-note" />
        <div className="mr-notefoot" id="mr-note-help">
          {noteErr ? <span className="mr-err" data-testid="mr-note-error"><Icon name="alert" size={14} />{t(lang, "اكتب كيف تحققت قبل الحفظ.", "Write how you checked before saving.")}</span> : <span className="mr-micro">{t(lang, "مطلوبة لكل النتائج الثلاث: اكتب كيف تحققت.", "Required for all three results: write how you checked.")}</span>}
          <span className="mr-micro mr-num">{note.length} / 1000</span>
        </div>
        <div className="mr-auto">
          <span className="mr-col"><span className="mr-micro">{t(lang, "المراجِع (تلقائي)", "Reviewer (automatic)")}</span><strong><Icon name="user" size={14} /> {reviewer}</strong></span>
          <span className="mr-col"><span className="mr-micro">{t(lang, "وقت المراجعة (يُثبَّت عند الحفظ)", "Review time (set on save)")}</span><strong className="mr-num"><Icon name="clock" size={14} /> {longWhen(now)}</strong></span>
          <span className="mr-micro"><Icon name="lock" size={12} /> {t(lang, "للقراءة فقط", "Read-only")}</span>
        </div>
        {refusal ? <Refusal tone={refusal.tone} title={refusal.title} body={refusal.body} testId={`mr-refusal-${refusal.code}`} /> : null}
      </div>
      <footer className="mr-foot">
        <span className="mr-micro">{outcome === "NOT_DELIVERED" ? t(lang, "لن يُرسل شيء قبل أن تؤكّد في الخطوة التالية.", "Nothing is sent before you confirm in the next step.") : t(lang, "الحفظ يسجّل النتيجة فقط ولا يرسل شيئاً.", "Saving records the result only; nothing is sent.")}</span>
        <span className="mr-btns">
          <button type="button" className="mr-btn" onClick={onClose} disabled={busy}>{t(lang, "إلغاء", "Cancel")}</button>
          <button type="button" className="mr-btn is-primary" onClick={save} disabled={busy || !outcome} aria-busy={busy} data-testid="mr-review-save">
            {busy ? t(lang, "جارٍ التسجيل…", "Saving…") : outcome === "NOT_DELIVERED" ? t(lang, "سجّل «لم تصل» وتابع", "Record «not delivered» and continue") : t(lang, "سجّل النتيجة", "Record the result")}
          </button>
        </span>
      </footer>
    </Scrim>
  );
}

// ── d: «إعادة إرسال الرسالة بعد المراجعة؟» ──────────────────────────────────────────────────────────────────────────
export function ResendConfirm({ m, lang, onClose, onDone, resend, marketing }: {
  m: ReviewMessage; lang: Lang; onClose: () => void; onDone: (newId: string | null) => void;
  resend: () => Promise<ActionResult & { data: { resendId?: string } }>; marketing: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<ReturnType<typeof refusalOf> | null>(null);
  async function go() {
    setBusy(true); setRefusal(null);
    let r: ActionResult & { data: { resendId?: string } };
    try { r = await resend(); } catch { r = { ok: false, status: 0, data: {} }; }
    setBusy(false);
    if (r.ok) return onDone(r.data.resendId ?? null);
    setRefusal(refusalOf(r, lang, "resend"));
  }
  return (
    <Scrim kind="dialog" onClose={busy ? () => undefined : onClose} label={t(lang, "إعادة إرسال الرسالة بعد المراجعة", "Resend after review")} testId="mr-resend-dialog">
      <div className="mr-body mr-confirm">
        <span className="mr-bigicon"><Icon name="repeat" size={22} /></span>
        <h2>{t(lang, "إعادة إرسال الرسالة بعد المراجعة؟", "Resend the message after review?")}</h2>
        <p>{t(lang, "ستُنشأ رسالة جديدة مرتبطة بالرسالة الأصلية، إلى", "A new message linked to the original will be created, to")} {m.channel === "email" ? t(lang, "البريد:", "the address:") : t(lang, "الرقم:", "the number:")}<br /><bdi dir="ltr" className="mr-num">{m.address ?? "—"}</bdi></p>
        <div className="mr-strip is-col">
          <span className="mr-lbl">{t(lang, "نتيجة المراجعة (يدوي):", "Review (manual):")} <Badge tone="danger" icon="close">{t(lang, "لم تصل الرسالة", "Not delivered")}</Badge></span>
          {m.reviewedBy ? <span className="mr-small">{t(lang, "راجعها", "Reviewed by")}: {m.reviewedBy.name} · <bdi className="mr-num">{shortWhen(m.reviewedAt)}</bdi>{m.reviewNote ? ` · «${m.reviewNote}»` : ""}</span> : null}
        </div>
        <ul className="mr-list">
          <li><Icon name="check" /> {t(lang, "رسالة جديدة بنفس النص، حالتها «مجدولة»، ومرتبطة بالأصل.", "A new message with the same text, «scheduled», linked to the original.")}</li>
          <li><Icon name="lock" /> {t(lang, "الأصل لا يتغيّر: يبقى «انقطع — لم يرد المزوّد» مع مراجعتك، وتُقفل مراجعته.", "The original does not change: it stays «interrupted» with your review, which is then frozen.")}</li>
          <li><Icon name="clock" /> {t(lang, "تمر بالفحوص العادية: الموافقة ووضع الإرسال" + (marketing ? "، ساعات الهدوء، والحد اليومي" : "") + " — قد تتأخر أو لا تُرسل.", "It goes through the usual checks (consent, send mode" + (marketing ? ", quiet hours, daily cap" : "") + ") — it may wait or not go.")}</li>
          <li><Icon name="repeat" /> {t(lang, "إعادة واحدة فقط لكل رسالة. وإن انقطعت هي أيضاً فلن تُعاد تلقائياً.", "One resend per message. If it is interrupted too, it is not resent automatically.")}</li>
        </ul>
        {refusal ? (
          <Refusal tone={refusal.tone} title={refusal.title} body={refusal.body} testId={`mr-refusal-${refusal.code}`}>
            {refusal.href ? <a className="mr-link" href={refusal.href}><Icon name="link" size={14} /> {t(lang, "افتح الصفحة", "Open the page")}</a> : null}
          </Refusal>
        ) : null}
        <div className="mr-btns is-end">
          <button type="button" className="mr-btn" onClick={onClose} disabled={busy} data-testid="mr-resend-later">{t(lang, "ليس الآن", "Not now")}</button>
          <button type="button" className="mr-btn is-primary" onClick={go} disabled={busy || !!refusal} aria-busy={busy} data-testid="mr-resend-confirm"><span>{busy ? t(lang, "جارٍ الإرسال…", "Sending…") : t(lang, "أعد الإرسال الآن", "Resend now")}</span><Icon name="repeat" /></button>
        </div>
        <p className="mr-micro">{t(lang, "«ليس الآن» يُبقي النتيجة «لم تصل» ويبقى زر إعادة الإرسال متاحاً في الدرج.", "«Not now» keeps «not delivered»; the resend button stays in the drawer.")}</p>
      </div>
    </Scrim>
  );
}

// ── b / b2 / h / h4: the drawer ─────────────────────────────────────────────────────────────────────────────────────────
export function MessageDrawer({ m, lang, onClose, onReview, onResend, marketing }: {
  m: ReviewMessage; lang: Lang; onClose: () => void; onReview: () => void; onResend: () => void; marketing: boolean;
}) {
  const st = reviewStateOf(m);
  const doubt = m.status === "FAILED" && m.deliveryDoubt;
  const reviewable = doubt && m.canProcess && (st === "needed" || st === "uncertain");
  const resendable = doubt && m.canProcess && st === "notResent" && !m.noResend;
  const title = doubt
    ? (m.channel === "email" ? t(lang, "إيميل منقطع", "Interrupted e-mail") : t(lang, "رسالة واتساب منقطعة", "Interrupted WhatsApp message"))
    : (m.channel === "email" ? t(lang, "إيميل", "E-mail") : t(lang, "رسالة واتساب", "WhatsApp message"));
  const expiredReason = m.resendWindow
    ? t(lang, `مرّت أكثر من ٢٤ ساعة على أول محاولة إرسال (${shortWhen(m.resendWindow.from)})، والرسالة التسويقية المتأخرة لا تُرسل.`, `More than 24 hours have passed since the first send attempt (${shortWhen(m.resendWindow.from)}); a late marketing message is not sent.`)
    : "";
  const timeline: [string, string, string, string | null][] = [];
  if (m.scheduledAt) timeline.push([m.scheduledAt, "cal", t(lang, "جُدولت للإرسال", "Scheduled"), m.source]);
  if (m.sendingStartedAt) timeline.push([m.sendingStartedAt, "send", t(lang, "محاولة 1: بدأ الإرسال", "Attempt 1: sending started"), t(lang, "وصل طلب الإرسال إلى المزوّد", "The request reached the provider")]);
  if (doubt && m.interruptedAt) {
    timeline.push([m.interruptedAt, "alert", t(lang, "انقطع الاتصال قبل وصول الرد", "The connection dropped before the answer"), t(lang, "لا نعرف هل قبِل المزوّد الرسالة أم لا", "We do not know whether the provider accepted it")]);
    timeline.push([m.interruptedAt, "close", t(lang, "صارت «فشلت — قد تكون وصلت»", "Became «failed — may have been delivered»"), t(lang, "لم تُعد تلقائياً · أُرسل تنبيه «إرسال انقطع ويحتاج مراجعة»", "Not resent automatically · the «send interrupted» alert was raised")]);
  }
  if (m.reviewedAt && m.reviewedBy) timeline.push([m.reviewedAt, "user", t(lang, "سُجّلت نتيجة التحقق", "Review recorded"), `${m.reviewedBy.name}${m.reviewNote ? ` · «${m.reviewNote}»` : ""}`]);
  if (m.resend) timeline.push([m.resentBy?.at ?? m.reviewedAt ?? m.createdAt, "repeat", t(lang, "أُعيد إرسالها برسالة جديدة مرتبطة", "Resent as a new linked message"), m.resentBy?.name ? `${t(lang, "أعاد إرسالها", "Resent by")}: ${m.resentBy.name}` : null]);
  if (st === "expired" && m.resendWindow) timeline.push([m.resendWindow.until, "clock", t(lang, "انتهت مهلة الإعادة — لم يُعد إرسالها", "Resend window closed — not resent"), null]);
  return (
    <Scrim kind="drawer" onClose={onClose} label={title} testId="mr-drawer">
      <header className="mr-head">
        <div className="mr-col">
          <h2>{title}</h2>
          {m.address ? <p className="mr-addr"><bdi dir="ltr" className="mr-num">{m.address}</bdi></p> : null}
          <p className="mr-meta">{m.source}</p>
        </div>
        <button type="button" className="mr-iconbtn" onClick={onClose} aria-label={t(lang, "إغلاق", "Close")}><Icon name="close" /></button>
      </header>
      <div className="mr-body">
        <div className="mr-two">
          <section className="mr-statbox is-provider" aria-label={t(lang, "حالة التسليم (من المزوّد)", "Delivery status (from the provider)")}>
            <span className="mr-lbl"><Icon name="lock" size={14} />{t(lang, "حالة التسليم (من المزوّد)", "Delivery status (from the provider)")}</span>
            <ProviderBadge m={m} lang={lang} testId="mr-drawer-provider" />
            <span className="mr-micro">{t(lang, "يُحدَّث من المزوّد فقط ولا يُعدَّل يدوياً.", "Updated by the provider only; never edited by hand.")}</span>
          </section>
          <section className="mr-statbox is-review" aria-label={t(lang, "نتيجة المراجعة (يدوي)", "Review (manual)")}>
            <span className="mr-lbl"><Icon name="user" size={14} />{t(lang, "نتيجة المراجعة (يدوي)", "Review (manual)")}</span>
            <ReviewBadge m={m} lang={lang} testId="mr-drawer-review" />
            {m.reviewNote ? <span className="mr-micro">«{m.reviewNote}»</span> : doubt ? <span className="mr-micro">{t(lang, "لم يسجّل أحد نتيجة بعد. يسجّلها موظف بعد التحقق.", "Nobody recorded a result yet. A person records it after checking.")}</span> : null}
          </section>
        </div>
        {doubt ? (
          <div className="mr-box is-warning">
            <div className="mr-boxrow"><div className="mr-col"><strong>{t(lang, "السبب: انقطع الإرسال أثناءه", "Why: the send was interrupted")}</strong><p>{t(lang, "وصل طلب الإرسال إلى المزوّد ثم انقطع الاتصال قبل أن يصلنا الرد. قد تكون الرسالة وصلت للعميل وقد لا تكون. لذلك لن يعيدها النظام تلقائياً.", "The request reached the provider and the connection dropped before the answer. It may or may not have reached the customer, so the system never resends it by itself.")}</p></div><Icon name="alert" /></div>
            {m.statusNote ? <p className="mr-micro">{t(lang, "نص النظام:", "System note:")} «{m.statusNoteText ?? m.statusNote}»</p> : null}
          </div>
        ) : m.statusNote ? <p className="mr-small">{m.statusNoteText ?? m.statusNote}</p> : null}
        {timeline.length ? (
          <>
            <h3>{t(lang, "سجل المحاولات", "Attempts")}</h3>
            <ol className="mr-timeline" data-testid="mr-timeline">
              {timeline.map(([at, icon, what, sub], i) => (
                <li key={i}><Icon name={icon} /><span className="mr-col"><span>{what}</span>{sub ? <span className="mr-micro">{sub}</span> : null}</span><bdi className="mr-num mr-micro">{shortWhen(at)}</bdi></li>
              ))}
              {st === "needed" ? <li><Icon name="clock" /><span className="mr-col"><span>{t(lang, "بانتظار تسجيل نتيجة التحقق", "Waiting for the review")}</span></span><span className="mr-micro">{t(lang, "الآن", "now")}</span></li> : null}
            </ol>
          </>
        ) : null}
        {m.body ? (<><h3>{t(lang, "نص الرسالة كما يراه العميل", "The text as the customer sees it")}</h3><div className="mr-preview" dir="auto">{m.body}</div></>) : null}
        {doubt && (st === "needed" || st === "uncertain") ? (
          <div className="mr-box is-info">
            <div className="mr-boxrow"><div className="mr-col"><strong>{t(lang, "كيف تتحقق؟", "How to check?")}</strong><p>{m.channel === "email" ? t(lang, "اسأل العميل مباشرة أو راجع سجل المزوّد. لا تعتمد على أن «الرسالة فشلت» — المزوّد لم يقل ذلك.", "Ask the customer or check the provider's log. Do not rely on «failed» — the provider did not say so.") : t(lang, "افتح محادثة العميل في واتساب للأعمال على الرقم المرتبط، أو اسأل العميل مباشرة. لا تعتمد على أن «الرسالة فشلت» — المزوّد لم يقل ذلك.", "Open the customer's chat in WhatsApp Business on the linked number, or ask the customer. Do not rely on «failed» — the provider did not say so.")}</p></div><Icon name="info" /></div>
          </div>
        ) : null}
      </div>
      {doubt ? (
        <footer className="mr-foot is-stack">
          {st === "expired" ? (
            <div className="mr-box is-warning" data-testid="mr-expired">
              <div className="mr-boxrow"><div className="mr-col"><strong>{t(lang, "انتهت مهلة الإعادة", "The resend window has closed")}</strong><p>{expiredReason}</p></div><Icon name="alert" /></div>
              <p className="mr-micro">{t(lang, "المراجعة والسجل متاحان. لم يُرسل شيء.", "The review and the history stay. Nothing was sent.")}</p>
            </div>
          ) : null}
          {!m.canProcess && (st === "needed" || st === "uncertain") ? <button type="button" className="mr-btn is-block" disabled aria-disabled="true" data-testid="mr-drawer-review-btn"><span>{t(lang, "تسجيل نتيجة التحقق", "Record the check")}</span><Icon name="note" /></button> : null}
          {reviewable ? <button type="button" className="mr-btn is-primary is-block" onClick={onReview} data-testid="mr-drawer-review-btn"><span>{st === "uncertain" ? t(lang, "تحديث نتيجة التحقق", "Update the result") : t(lang, "تسجيل نتيجة التحقق", "Record the check")}</span><Icon name="note" /></button> : null}
          {m.resend ? null : (
            <button type="button" className={`mr-btn is-block${resendable ? "" : " is-disabled"}`} onClick={resendable ? onResend : undefined} disabled={!resendable} aria-disabled={!resendable} data-testid="mr-drawer-resend-btn">
              <span>{t(lang, "إعادة الإرسال بعد المراجعة", "Resend after review")}</span><Icon name="repeat" />
            </button>
          )}
          <span className="mr-micro mr-why" data-testid="mr-resend-why">
            <Icon name="lock" size={14} />
            {m.resend ? t(lang, "أُعيد إرسالها برسالة جديدة مرتبطة بالأصل.", "Resent as a new message linked to the original.")
              : !m.canProcess ? (marketing ? t(lang, "للتسويق تحتاج صلاحية «إدارة الرسائل» (المالك أو مدير التسويق).", "Marketing needs «manage messages» (the owner or the marketing manager).") : t(lang, "لرسائل الأتمتة تحتاج صلاحية «إدارة الرسائل» وصلاحية القسم الذي تتبعه الرسالة.", "Automation messages need «manage messages» and the message's department permission."))
              : m.noResend ? <>{t(lang, m.noResend.ar, m.noResend.en)}{m.noResend.href ? <> · <a className="mr-link" href={m.noResend.href}>{t(lang, "افتح الصفحة", "Open the page")}</a></> : null}</>
              : st === "expired" ? t(lang, "إعادة الإرسال غير متاحة: انتهت المهلة (تسويق فقط).", "Resend unavailable: the window has closed (marketing only).")
              : st === "uncertain" ? t(lang, "«تعذّر التأكد» لا تسمح بإعادة الإرسال أبداً.", "«Could not confirm» never allows a resend.")
              : st === "delivered" ? t(lang, "وصلت — لا إعادة.", "Delivered — no resend.")
              : st === "notResent" ? (m.resendWindow ? t(lang, `متاحة حتى ${shortWhen(m.resendWindow.until)} (٢٤ ساعة من أول محاولة).`, `Available until ${shortWhen(m.resendWindow.until)} (24 h from the first attempt).`)
                : m.resendUntil ? t(lang, `متاحة حتى ${shortWhen(m.resendUntil)} (مهلة هذا النوع من أول محاولة إرسال)، ما دام محتواها صحيحاً.`, `Available until ${shortWhen(m.resendUntil)} (this type's window from the first attempt), while its content is still true.`)
                : t(lang, "متاحة بعد «لم تصل» مع تأكيد، ما دام محتواها صحيحاً.", "Available after «not delivered», with a confirmation, while its content is still true."))
              : t(lang, "إعادة الإرسال مقفلة حتى تُسجَّل «لم تصل الرسالة».", "Resend is locked until «not delivered» is recorded.")}
          </span>
        </footer>
      ) : null}
    </Scrim>
  );
}

/** «تحتاج مراجعة» banner — only when there are interrupted messages not reviewed yet; gone at zero. */
export function NeedsReviewBanner({ count, lang, onShow, automation }: { count: number; lang: Lang; onShow: () => void; automation?: boolean }) {
  if (!count) return null;
  return (
    <div className="mr-banner" role="status" data-testid="mr-banner">
      <Icon name="alert" size={20} />
      <span className="mr-col">
        <strong>{automation ? t(lang, `${count} من رسائل الأتمتة انقطع إرسالها ولا نعرف هل وصلت`, `${count} automation messages were interrupted and may or may not have arrived`) : t(lang, `${count} رسائل انقطع إرسالها ولا نعرف هل وصلت للعميل`, `${count} messages were interrupted and may or may not have reached the customer`)}</strong>
        <span>{t(lang, "لن يعيد النظام إرسالها تلقائياً. افتح كل رسالة وسجّل نتيجة التحقق قبل أي إعادة إرسال.", "The system never resends them by itself. Open each and record the check before any resend.")}</span>
      </span>
      <button type="button" className="mr-btn is-sm is-warn" onClick={onShow} data-testid="mr-banner-show">{t(lang, "اعرض الرسائل التي تحتاج مراجعة", "Show the messages that need review")}</button>
    </div>
  );
}

/** The manual-review filter chips: «تحتاج مراجعة» · «معلّقة — تعذّر التأكد» · «أُعيد إرسالها». */
export function ReviewChips({ value, onChange, counts, lang }: { value: string; onChange: (v: string) => void; counts: { needed: number; pending: number; resent: number }; lang: Lang }) {
  const chips: [string, string, string, number, boolean][] = [
    ["needed", t(lang, "تحتاج مراجعة", "Needs review"), "clock", counts.needed, true],
    ["pending", t(lang, "معلّقة — تعذّر التأكد", "Open — could not confirm"), "help", counts.pending, true],
    ["resent", t(lang, "أُعيد إرسالها", "Resent"), "repeat", counts.resent, false],
  ];
  return (
    <div className="mr-chips" role="group" aria-label={t(lang, "نتيجة المراجعة (يدوي)", "Review (manual)")}>
      <span className="mr-lbl">{t(lang, "نتيجة المراجعة (يدوي):", "Review (manual):")}</span>
      {chips.map(([k, label, icon, n, warn]) => (
        <button key={k} type="button" className={`mr-chip${warn ? " is-warn" : ""}`} aria-pressed={value === k} onClick={() => onChange(value === k ? "" : k)} data-testid={`mr-chip-${k}`}>
          <Icon name={icon} /><span>{label}</span><span className="mr-count mr-num">{n}</span>
        </button>
      ))}
    </div>
  );
}

// ── a / a2: the two-status table, and the flow drawer → dialog → confirm ────────────────────────────────────────────
export type TableRow = ReviewMessage & { updatedAt?: string | null };

function lastUpdate(m: TableRow, lang: Lang): [string | null, string] {
  const st = reviewStateOf(m);
  if (st === "delivered" || st === "resent") return [m.reviewedAt, t(lang, "مغلقة", "closed")];
  if (st === "notResent") return [m.reviewedAt, t(lang, "بانتظار إعادة", "awaiting resend")];
  if (st === "expired") return [m.reviewedAt, t(lang, "انتهت المهلة", "window closed")];
  if (m.status === "FAILED" && !m.deliveryDoubt) return [m.updatedAt ?? m.createdAt, t(lang, "نهائي", "final")];
  return [m.interruptedAt ?? m.updatedAt ?? m.createdAt, `${t(lang, "محاولة", "attempt")} ${Math.max(1, m.attempts)}`];
}

export function ReviewTable<R extends TableRow>({ rows, lang, onOpen, selectedId, extraAction, addressHeader, label, testId, renderProvider, renderAddress, statusHeadTestId }: {
  rows: R[]; lang: Lang; onOpen: (m: R) => void; selectedId?: string | null;
  extraAction?: (m: R) => ReactNode; addressHeader: string; label: string; testId: string;
  /** The provider column for a row that is not in doubt (each log keeps its own status words). */
  renderProvider?: (m: R) => ReactNode; renderAddress?: (m: R) => ReactNode; statusHeadTestId?: string;
}) {
  const H = [addressHeader, t(lang, "نص الرسالة", "Message"), t(lang, "حالة التسليم (من المزوّد)", "Delivery status (provider)"), t(lang, "نتيجة المراجعة (يدوي)", "Review (manual)"), t(lang, "آخر تحديث", "Last update"), t(lang, "إجراء", "Action")];
  return (
    <div className="mr-tablewrap">
    <table className="mr-table" aria-label={label} data-testid={testId}>
      <colgroup><col className="mr-c-addr" /><col className="mr-c-body" /><col className="mr-c-stat" /><col className="mr-c-stat" /><col className="mr-c-date" /><col className="mr-c-act" /></colgroup>
      <thead><tr>{H.map((h, i) => <th key={h} scope="col" className={i === 1 ? "mr-c-body" : undefined} data-testid={i === 2 ? statusHeadTestId : undefined}>{h}</th>)}</tr></thead>
      <tbody>
        {rows.map((m) => {
          const [at, sub] = lastUpdate(m, lang);
          const doubt = m.status === "FAILED" && m.deliveryDoubt;
          return (
            <tr key={`${m.channel}-${m.id}`} className={`${selectedId === m.id ? "is-selected" : ""} ${m.resendOfMessageId ? "is-child" : ""}`} data-testid={`mr-row-${m.id}`}>
              <td data-label={H[0]}>
                <span className="mr-col">
                  {renderAddress ? renderAddress(m) : <bdi dir="ltr" className="mr-num" style={{ textAlign: "start", fontSize: 12.5 }}>{m.address ?? "—"}</bdi>}
                  <span className="mr-meta">{m.resendOfMessageId ? t(lang, "إعادة إرسال للرسالة الأصلية · ", "Resend of the original · ") : ""}{m.source}</span>
                  {m.resendOfMessageId ? <span className="mr-micro" style={{ color: "var(--text-link, #5c5c38)", display: "inline-flex", gap: 4, alignItems: "center" }}><Icon name="link" size={14} />{t(lang, "مرتبطة بالأصل · لا تغيّر حالته", "Linked to the original · does not change it")}</span> : null}
                </span>
              </td>
              <td data-label={H[1]} className="mr-c-body"><span className="mr-clamp" dir="auto">{m.body ?? "—"}</span></td>
              <td data-label={H[2]}>
                <span className="mr-cellstack">
                  {!doubt && renderProvider ? renderProvider(m) : <ProviderBadge m={m} lang={lang} testId={`mr-provider-${m.id}`} />}
                  {!doubt && renderProvider ? null : doubt ? <span className="mr-micro">{t(lang, "الطلب وصل للمزوّد ثم انقطع الاتصال", "Reached the provider, then the connection dropped")}</span> : m.status === "FAILED" && m.statusNote ? <span className="mr-micro">{m.statusNote}</span> : null}
                </span>
              </td>
              <td data-label={H[3]}><ReviewBadge m={m} lang={lang} testId={`mr-reviewcol-${m.id}`} /></td>
              <td data-label={H[4]}><span className="mr-col"><bdi className="mr-num" style={{ fontSize: 12 }}>{shortWhen(at)}</bdi><span className="mr-micro">{sub}</span></span></td>
              <td data-label={H[5]}><span className="mr-btns"><RowAction m={m} lang={lang} onOpen={() => onOpen(m)} selected={selectedId === m.id} />{extraAction?.(m)}</span></td>
            </tr>
          );
        })}
      </tbody>
    </table>
    </div>
  );
}

/**
 * The drawer and its two steps for one message. `open` is the message as the list has it now (refreshed after each
 * step through `onChanged`); «لم تصل» goes straight on to the confirmation, as in the design (c → d).
 */
export function ReviewFlow(props: {
  open: ReviewMessage | null; lang: Lang; reviewer: string; marketing: boolean; onClose: () => void; onChanged: () => void;
  review: (m: ReviewMessage, outcome: Outcome, note: string) => Promise<ActionResult>;
  resend: (m: ReviewMessage) => Promise<ActionResult & { data: { resendId?: string } }>;
}) {
  // One flow per message: a new message starts at the drawer (keyed remount, no state copied in an effect).
  return props.open ? <ReviewFlowFor key={props.open.id} {...props} open={props.open} /> : null;
}

function ReviewFlowFor({ open, lang, reviewer, marketing, onClose, onChanged, review, resend }: {
  open: ReviewMessage; lang: Lang; reviewer: string; marketing: boolean; onClose: () => void; onChanged: () => void;
  review: (m: ReviewMessage, outcome: Outcome, note: string) => Promise<ActionResult>;
  resend: (m: ReviewMessage) => Promise<ActionResult & { data: { resendId?: string } }>;
}) {
  const [step, setStep] = useState<"drawer" | "review" | "confirm">("drawer");
  // What this flow just did, shown at once while the list reloads behind (the reloaded row says the same).
  const [patch, setPatch] = useState<Partial<ReviewMessage>>({});
  const m: ReviewMessage = { ...open, ...patch };
  if (step === "review") {
    return <ReviewDialog m={m} lang={lang} reviewer={reviewer} onClose={() => setStep("drawer")} review={(o, n) => review(m, o, n)}
      onSaved={(o) => {
        setPatch((p) => ({ ...p, reviewOutcome: o, reviewedBy: { name: reviewer }, reviewedAt: new Date().toISOString() }));
        onChanged();
        // «لم تصل» continues to the confirmation (step d); the others back to the drawer.
        setStep(o === "NOT_DELIVERED" && !m.noResend && (!m.resendWindow || m.resendWindow.open) ? "confirm" : "drawer");
      }} />;
  }
  if (step === "confirm") {
    return <ResendConfirm m={m} lang={lang} marketing={marketing} onClose={() => setStep("drawer")} resend={() => resend(m)}
      onDone={(newId) => { setPatch((p) => ({ ...p, resend: { id: newId ?? "new", status: "QUEUED" } })); onChanged(); setStep("drawer"); }} />;
  }
  return <MessageDrawer m={m} lang={lang} marketing={marketing} onClose={onClose} onReview={() => setStep("review")} onResend={() => setStep("confirm")} />;
}
