"use client";

// Pipeline v2 — the pieces the board and the deal page share, built to Figma page «08 — مسار الصفقات v2»
// (components 1762:3; annotations 1773:1674). Every rule shown here is computed on the server (`nextStep`,
// services/sales/next-step.ts); these components only render it and send the person's choice back.
import { useEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { D21Dialog } from "@/components/ui/Dialog";
import { Ico } from "@/components/shell/icons";
import { SAMPLE_SKIP_CODES, SAMPLE_SKIP_LABELS, type SampleSkipCode } from "@/lib/services/sales/stages";
import { LOST_REASON_CODES, LOST_REASON_LABELS } from "@/lib/services/sales/needs";
import type { QuoteState } from "@/lib/services/sales/next-step";
import "./pv2.css";

export type Tone = "neutral" | "info" | "warn" | "ok" | "danger" | "primary";

/** PV2 · Chip (1762:22): the label is always there; the tone only reinforces it. */
export function Chip({ tone = "neutral", label, dot = true, dashed, testId, title }: {
  tone?: Tone; label: ReactNode; dot?: boolean; dashed?: boolean; testId?: string; title?: string;
}) {
  const cls = ["pv2-chip", tone !== "neutral" ? tone : "", dot ? "" : "nodot", dashed ? "dashed" : ""].filter(Boolean).join(" ");
  return <span className={cls} data-testid={testId} title={title}><span className="t">{label}</span></span>;
}

/** The quotation sub-status tones (annotation 3): green only for success, red only for danger. */
export const QUOTE_TONE: Record<QuoteState, Tone> = {
  NONE: "neutral", DRAFT: "neutral", REVISING: "primary", AWAITING_DISCOUNT: "warn", DISCOUNT_REFUSED: "danger",
  SENT: "info", LAPSED: "danger", REJECTED: "danger", ACCEPTED: "ok", ORDERED: "ok",
};

/** The board's per-deal `nextStep` (opportunities route, stable shape). */
export type CardNextStep = {
  phase: "QUALIFIED" | "SAMPLES" | "QUOTE" | "CLOSED";
  quoteState: QuoteState;
  quoteStateLabel: { ar: string; en: string };
  requiredNow: { key: string; ar: string; en: string } | null;
  nextAction: { key: string; ar: string; en: string; disabled: boolean } | null;
};

/**
 * The card's state chip. In «عرض السعر والتفاوض» it is the quotation's sub-status (owner decision 2); before
 * that it says where the stage's own work stands — derived from the same server answer, never stored.
 */
export function cardChip(ns: CardNextStep, ar: boolean): { label: string; tone: Tone } {
  const L = (a: string, e: string) => (ar ? a : e);
  const inPlay = !["NONE", "DRAFT"].includes(ns.quoteState);
  if (ns.phase === "QUOTE" || inPlay || ns.phase === "CLOSED") {
    return { label: ar ? ns.quoteStateLabel.ar : ns.quoteStateLabel.en, tone: QUOTE_TONE[ns.quoteState] };
  }
  const k = ns.nextAction?.key;
  if (ns.phase === "QUALIFIED") {
    return k === "RECORD_NEEDS" ? { label: L("تحليل الاحتياج ناقص", "Needs analysis incomplete"), tone: "neutral" }
      : { label: L("تحليل الاحتياج مكتمل", "Needs analysis complete"), tone: "ok" };
  }
  switch (k) {
    case "RECORD_SAMPLE_EVALUATION": return { label: L("أُرسلت · بلا رأي بعد", "Sent · no view yet"), tone: "info" };
    case "WAIT_SAMPLE": return { label: ar ? ns.nextAction!.ar : ns.nextAction!.en, tone: "warn" };
    case "SEND_SAMPLE": return { label: L("مسجّلة · قيد التجهيز", "Recorded · being prepared"), tone: "neutral" };
    case "REQUEST_SAMPLE": return { label: L("بلا عيّنة بعد", "No sample yet"), tone: "neutral" };
    case "ISSUE_QUOTE": return { label: L("مسودة عرض", "Draft quotation"), tone: "neutral" };
    default: return { label: L("وصل الرأي", "View received"), tone: "ok" };
  }
}

// ── Automatic moves (annotation 2): reason `Automatic: <why>` (services/sales/lifecycle.ts) ──
const WHY_AR: Record<string, string> = {
  "a sample was requested": "لأنك طلبت عيّنة",
  "a sample was recorded": "لأنك سجّلت عيّنة",
  "a sample was sent": "لأن العيّنة أُرسلت",
  "the sample was issued by dispatch": "لأن قسم الشحن صرف العيّنة",
  "a quotation was issued": "لأنك أصدرت عرض السعر",
  "the customer accepted the quotation": "لأنك سجّلت قبول العميل للعرض",
};
const AUTO = "Automatic: ";
/** Was this stage event an automatic move? */
export function isAutoReason(reason: string | null | undefined): boolean {
  return !!reason && reason.includes(AUTO);
}
/** «لأنك طلبت عيّنة» — the why of an automatic move, in the page's language; null when it was not automatic. */
export function autoWhy(reason: string | null | undefined, ar: boolean): string | null {
  if (!reason || !reason.includes(AUTO)) return null;
  const why = reason.slice(reason.indexOf(AUTO) + AUTO.length).split(" · ")[0].trim();
  if (!ar) return `because ${why}`;
  return WHY_AR[why] ?? "تلقائيًا";
}
/** The stored reason without its machine prefixes: the manual note, or a documented skip. */
export function humanReason(reason: string | null | undefined): string | null {
  if (!reason) return null;
  const parts = reason.split(" · ").filter((p) => !p.startsWith(AUTO));
  return parts.join(" · ").trim() || null;
}

// ── PV2 · StageStep (1762:43) ──
export type Step = { key: string; label: string; sub?: string; state: "done" | "cur" | "skip" | "up"; testId?: string };
export function StageStepper({ steps, ar, note }: { steps: Step[]; ar: boolean; note?: ReactNode }) {
  const out: ReactNode[] = [];
  steps.forEach((s, i) => {
    if (i > 0) {
      const lit = s.state === "done" || s.state === "cur" || s.state === "skip";
      out.push(<li key={`ln-${s.key}`} className={`ln${lit ? " done" : ""}`} aria-hidden />);
    }
    out.push(
      <li key={s.key} className={s.state} data-testid={s.testId} aria-current={s.state === "cur" ? "step" : undefined}>
        <span className="mk" aria-hidden>{s.state === "done" ? <Ico name="tick" small /> : null}</span>
        <span className="lb">{s.label}</span>
        {s.sub ? <span className="sb">{s.sub}</span> : null}
        {s.state === "skip" ? <span className="sr-only">{ar ? "(تُخطّيت)" : "(skipped)"}</span> : null}
      </li>,
    );
  });
  return (
    <div className="pv2-stepper-card" data-testid="deal-stepper">
      <ol className="pv2-stepper" aria-label={ar ? "مراحل الصفقة" : "Deal stages"}>{out}</ol>
      {note ? <div className="pv2-stepper-note">{note}</div> : null}
    </div>
  );
}

/** Toast · انتقال تلقائي (1764:544): role=status, 5 s, pauses while hovered or focused, never takes focus. */
export function AutoToast({ title, why, href, ar, onDone, testId = "auto-move-toast" }: {
  title: ReactNode; why: ReactNode; href?: string; ar: boolean; onDone: () => void; testId?: string;
}) {
  const [leaving, setLeaving] = useState(false);
  const paused = useRef(false);
  const left = useRef(5000);
  const doneRef = useRef(onDone);
  useEffect(() => { doneRef.current = onDone; }, [onDone]);
  useEffect(() => {
    let last = Date.now();
    const iv = window.setInterval(() => {
      const now = Date.now();
      if (!paused.current) left.current -= now - last;
      last = now;
      if (left.current <= 0) { window.clearInterval(iv); setLeaving(true); window.setTimeout(() => doneRef.current(), 150); }
    }, 200);
    return () => window.clearInterval(iv);
  }, []);
  return (
    <div className={`pv2-toast${leaving ? " out" : ""}`} role="status" aria-live="polite" data-testid={testId}
      onMouseEnter={() => { paused.current = true; }} onMouseLeave={() => { paused.current = false; }}
      onFocus={() => { paused.current = true; }} onBlur={() => { paused.current = false; }}>
      <Ico name="check" small />
      <div className="t"><b>{title}</b><span>{why}</span></div>
      {href ? <Link href={href}>{ar ? "فتح الصفقة" : "Open deal"}</Link> : null}
    </div>
  );
}

function RadioChips<K extends string>({ items, value, onChange, label, testId }: {
  items: { key: K; label: string }[]; value: K | ""; onChange: (k: K) => void; label: string; testId?: string;
}) {
  return (
    <div className="pv2-radio" role="radiogroup" aria-label={label} data-testid={testId}>
      {items.map((it) => (
        <button key={it.key} type="button" role="radio" aria-checked={value === it.key} data-testid={`${testId}-${it.key}`}
          onClick={() => onChange(it.key)}>{it.label}</button>
      ))}
    </div>
  );
}

const lang = (ar: boolean) => (ar ? "ar" : "en") as "ar" | "en";

/**
 * «العميل ما يحتاج عينات» (1770:1591; sheet 1770:1758): a coded reason, «أخرى» opens a short text. Sends
 * `{ skipSamples: true, skipReasonCode, skipReason }`; the server moves the deal to the quotation stage.
 */
export function SkipSamplesSheet({ ar, busy, dealName, targetName, error, onClose, onSubmit }: {
  ar: boolean; busy: boolean; dealName: string; targetName: string; error?: string;
  onClose: () => void; onSubmit: (code: Exclude<SampleSkipCode, "QUOTE_ISSUED">, text: string) => void;
}) {
  const [code, setCode] = useState<Exclude<SampleSkipCode, "QUOTE_ISSUED"> | "">("");
  const [text, setText] = useState("");
  const ok = !!code && (code !== "OTHER" || text.trim().length >= 2);
  return (
    <D21Dialog lang={lang(ar)} width={524} testId="skip-samples-dialog" onClose={onClose}
      title={ar ? "العميل ما يحتاج عينات" : "The customer needs no sample"}
      sub={ar ? `${dealName} · ستنتقل الصفقة مباشرة إلى «${targetName}».` : `${dealName} · the deal moves straight to “${targetName}”.`}
      actions={<>
        <button type="button" className="d21-dlg-btn is-primary" disabled={busy || !ok} data-testid="confirm-skip-samples"
          onClick={() => code && onSubmit(code, text.trim())}>{ar ? "تخطّي العيّنات" : "Skip samples"}</button>
        <button type="button" className="d21-dlg-btn" onClick={onClose}>{ar ? "إلغاء" : "Cancel"}</button>
      </>}>
      {error ? <p className="d21-dlg-alert" role="alert">{error}</p> : null}
      <div className="d21-dlg-field">
        <span className="d21-dlg-label" id="skip-reason-l">{ar ? "لماذا لا يحتاج عيّنة؟" : "Why is no sample needed?"}</span>
        <RadioChips label={ar ? "سبب التخطّي" : "Reason"} testId="skip-reason" value={code} onChange={setCode}
          items={SAMPLE_SKIP_CODES.map((c) => ({ key: c, label: ar ? SAMPLE_SKIP_LABELS[c].ar : SAMPLE_SKIP_LABELS[c].en }))} />
      </div>
      <p className="pv2-dlg-hint">{ar ? "اختر سببًا واحدًا. «أخرى» يفتح حقلًا قصيرًا لكتابة السبب." : "Choose one. “Other” opens a short field."}</p>
      {code === "OTHER" && (
        <label className="d21-dlg-field">
          <span className="d21-dlg-label">{ar ? "السبب" : "Reason"}</span>
          <input className="d21-dlg-input" id="skip-reason" value={text} onChange={(e) => setText(e.target.value)} maxLength={300} autoFocus />
        </label>
      )}
      <p className="pv2-dlg-note">{ar ? "يُحفظ السبب في سجل الصفقة. لا يُلغى شيء، وتبقى المرحلة ظاهرة كـ«تُخطّيت»." : "The reason is kept in the deal's history; the stage stays visible as “skipped”."}</p>
    </D21Dialog>
  );
}

/** «تسجيل خسارة الصفقة» (1770:1663; sheet 1770:1832). */
export function LossSheet({ ar, busy, dealLine, error, onClose, onSubmit }: {
  ar: boolean; busy: boolean; dealLine: string; error?: string; onClose: () => void; onSubmit: (reason: string, code: string | null) => void;
}) {
  const [code, setCode] = useState<(typeof LOST_REASON_CODES)[number] | "">("");
  const [text, setText] = useState("");
  const enough = text.trim().length >= 2 || (!!code && code !== "OTHER");
  return (
    <D21Dialog lang={lang(ar)} width={524} testId="lost-dialog" onClose={onClose}
      title={ar ? "تسجيل خسارة الصفقة" : "Mark the deal lost"} sub={dealLine}
      actions={<>
        <button type="button" className="d21-dlg-btn is-danger" disabled={busy || !enough} data-testid="confirm-lost"
          onClick={() => onSubmit(text.trim(), code || null)}>{ar ? "تأكيد الخسارة" : "Confirm lost"}</button>
        <button type="button" className="d21-dlg-btn" onClick={onClose}>{ar ? "إلغاء" : "Cancel"}</button>
      </>}>
      {error ? <p className="d21-dlg-alert" role="alert">{error}</p> : null}
      <div className="d21-dlg-field">
        <span className="d21-dlg-label">{ar ? "السبب الرئيسي" : "Main reason"}</span>
        <RadioChips label={ar ? "السبب الرئيسي" : "Main reason"} testId="lost-code" value={code} onChange={setCode}
          items={LOST_REASON_CODES.map((c) => ({ key: c, label: ar ? LOST_REASON_LABELS[c].ar : LOST_REASON_LABELS[c].en }))} />
      </div>
      <label className="d21-dlg-field">
        <span className="d21-dlg-label">{code && code !== "OTHER" ? (ar ? "تفاصيل تساعد الفريق (اختياري)" : "Details for the team (optional)") : (ar ? "السبب" : "Reason")}</span>
        <textarea className="d21-dlg-input ta" id="lost-reason" rows={2} value={text} onChange={(e) => setText(e.target.value)} maxLength={500} />
      </label>
      <p className="pv2-dlg-hint">{ar ? "تظهر في سجل الصفقة وتقارير أسباب الخسارة." : "Shown in the deal's history and the loss-reason reports."}</p>
      <p className="pv2-dlg-note warn">{ar ? "ستُغلق متابعة الصفقة المفتوحة. يمكن لمن يملك الصلاحية إعادة فتحها لاحقًا." : "The deal's open follow-up closes. Someone with the permission can reopen the deal later."}</p>
    </D21Dialog>
  );
}

const pad = (n: number) => String(n).padStart(2, "0");
const localInput = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;

/**
 * «جدولة متابعة» (1770:1731; sheet 1770:1906): ONE follow-up per deal — saving moves it (PATCH `nextFollowUpAt`
 * + `followUpSubject`; the server keeps the one keyed task, `deal-follow-up:<id>`).
 */
export function FollowUpSheet({ ar, busy, dealName, current, error, onClose, onSubmit }: {
  ar: boolean; busy: boolean; dealName: string; current?: { dueAt: string; label: string } | null; error?: string;
  onClose: () => void; onSubmit: (dueAt: Date, subject: string) => void;
}) {
  const [kind, setKind] = useState<"CALL" | "WHATSAPP" | "VISIT">("CALL");
  // The moment the sheet opened: the presets are computed from it once, not on every render.
  const [opened] = useState(() => Date.now());
  const at = (days: number, h: number, m = 0) => { const d = new Date(opened); d.setDate(d.getDate() + days); d.setHours(h, m, 0, 0); return d; };
  const presets = [
    { key: "today", label: ar ? "اليوم 4:00 م" : "Today 4:00 pm", d: at(0, 16) },
    { key: "tomorrow", label: ar ? "غدًا 10:00 ص" : "Tomorrow 10:00 am", d: at(1, 10) },
    { key: "3d", label: ar ? "بعد 3 أيام" : "In 3 days", d: at(3, 10) },
    { key: "other", label: ar ? "تاريخ آخر…" : "Other date…", d: null as Date | null },
  ].filter((p) => !p.d || p.d.getTime() > opened);
  const [pick, setPick] = useState<string>(presets.find((p) => p.key === "tomorrow") ? "tomorrow" : presets[0].key);
  const [custom, setCustom] = useState(localInput(at(1, 10)));
  const [note, setNote] = useState("");
  const chosen = pick === "other" ? (custom ? new Date(custom) : null) : presets.find((p) => p.key === pick)?.d ?? null;
  const valid = !!chosen && !Number.isNaN(chosen.getTime());
  const kindLabel = { CALL: ar ? "اتصال" : "Call", WHATSAPP: ar ? "واتساب" : "WhatsApp", VISIT: ar ? "زيارة" : "Visit" };
  const whenText = valid ? chosen!.toLocaleString(ar ? "ar-SA-u-nu-latn-ca-gregory" : "en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric", hour: "numeric", minute: "2-digit", timeZone: "Asia/Riyadh" }) : "";
  return (
    <D21Dialog lang={lang(ar)} width={524} testId="follow-up-dialog" onClose={onClose}
      title={ar ? "جدولة متابعة" : "Schedule a follow-up"} sub={ar ? `${dealName} · متابعة واحدة لكل صفقة` : `${dealName} · one follow-up per deal`}
      actions={<>
        <button type="button" className="d21-dlg-btn is-primary" disabled={busy || !valid} data-testid="save-follow-up"
          onClick={() => valid && onSubmit(chosen!, [kindLabel[kind], note.trim()].filter(Boolean).join(" · "))}>{ar ? "حفظ المتابعة" : "Save follow-up"}</button>
        <button type="button" className="d21-dlg-btn" onClick={onClose}>{ar ? "إلغاء" : "Cancel"}</button>
      </>}>
      {error ? <p className="d21-dlg-alert" role="alert">{error}</p> : null}
      <div className="d21-dlg-field">
        <span className="d21-dlg-label">{ar ? "نوع المتابعة" : "Kind"}</span>
        <div className="pv2-seg" role="radiogroup" aria-label={ar ? "نوع المتابعة" : "Kind"}>
          {(["CALL", "WHATSAPP", "VISIT"] as const).map((k) => (
            <button key={k} type="button" role="radio" aria-checked={kind === k} onClick={() => setKind(k)}>{kindLabel[k]}</button>
          ))}
        </div>
      </div>
      <div className="d21-dlg-field">
        <span className="d21-dlg-label">{ar ? "متى؟" : "When?"}</span>
        <RadioChips label={ar ? "متى؟" : "When?"} testId="follow-up-when" value={pick} onChange={setPick}
          items={presets.map((p) => ({ key: p.key, label: p.label }))} />
        {pick === "other" && (
          <input type="datetime-local" className="d21-dlg-input" data-testid="follow-up-at" value={custom}
            min={localInput(new Date(opened))} onChange={(e) => setCustom(e.target.value)} aria-label={ar ? "التاريخ والوقت" : "Date and time"} />
        )}
        {valid ? <b style={{ font: "500 13px/22px var(--f-ui)" }}>{whenText} {ar ? "(توقيت الرياض)" : "(Riyadh time)"}</b> : null}
      </div>
      <label className="d21-dlg-field">
        <span className="d21-dlg-label">{ar ? "ملاحظة (اختياري)" : "Note (optional)"}</span>
        <input className="d21-dlg-input" value={note} onChange={(e) => setNote(e.target.value)} maxLength={160} data-testid="follow-up-note" />
      </label>
      {current ? (
        <p className="pv2-dlg-note warn">{ar ? `لديك متابعة لهذه الصفقة ${current.label}. الحفظ ينقلها إلى الموعد الجديد ولا يضيف ثانية.` : `This deal already has a follow-up ${current.label}. Saving moves it; it does not add a second.`}</p>
      ) : null}
    </D21Dialog>
  );
}

/**
 * «نقل إلى…» — the keyboard alternative to dragging (annotation 6). With `deal_stage_move` (or `lead_assign`)
 * the move happens; otherwise it is a request a supervisor approves (owner decision 3) — said before sending.
 */
export function MoveSheet({ ar, busy, dealName, stages, currentStageId, initialTo, direct, error, onClose, onSubmit }: {
  ar: boolean; busy: boolean; dealName: string; stages: { id: string; nameAr: string; nameEn: string }[];
  currentStageId: string; initialTo?: string; direct: boolean; error?: string; onClose: () => void; onSubmit: (toStageId: string, reason: string) => void;
}) {
  const options = stages.filter((s) => s.id !== currentStageId);
  const [to, setTo] = useState(initialTo && options.some((o) => o.id === initialTo) ? initialTo : options[0]?.id ?? "");
  const [reason, setReason] = useState("");
  const ok = !!to && (direct || reason.trim().length >= 2);
  return (
    <D21Dialog lang={lang(ar)} width={480} testId="move-dialog" onClose={onClose}
      title={direct ? (ar ? "نقل الصفقة" : "Move the deal") : (ar ? "طلب نقل الصفقة" : "Request a stage move")}
      sub={direct
        ? (ar ? `${dealName} · يُسجَّل النقل يدويًا في سجل الصفقة.` : `${dealName} · recorded as a manual move.`)
        : (ar ? `${dealName} · يصل الطلب إلى المشرف، ولا تتحرك الصفقة قبل اعتماده.` : `${dealName} · your supervisor approves it before the deal moves.`)}
      actions={<>
        <button type="button" className="d21-dlg-btn is-primary" disabled={busy || !ok} data-testid="confirm-move"
          onClick={() => onSubmit(to, reason.trim())}>{direct ? (ar ? "نقل" : "Move") : (ar ? "إرسال الطلب" : "Send request")}</button>
        <button type="button" className="d21-dlg-btn" onClick={onClose}>{ar ? "إلغاء" : "Cancel"}</button>
      </>}>
      {error ? <p className="d21-dlg-alert" role="alert">{error}</p> : null}
      <div className="d21-dlg-field">
        <span className="d21-dlg-label">{ar ? "إلى المرحلة" : "To stage"}</span>
        <RadioChips label={ar ? "إلى المرحلة" : "To stage"} testId="move-to" value={to} onChange={setTo}
          items={options.map((s) => ({ key: s.id, label: ar ? s.nameAr : s.nameEn }))} />
      </div>
      <label className="d21-dlg-field">
        <span className="d21-dlg-label">{direct ? (ar ? "السبب (اختياري)" : "Reason (optional)") : (ar ? "السبب" : "Reason")}</span>
        <input className="d21-dlg-input" data-testid="move-reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />
      </label>
      <p className="pv2-dlg-hint">{ar ? "لا تحتاج النقل اليدوي عادةً: طلب عيّنة أو إصدار عرض ينقل الصفقة تلقائيًا." : "Usually not needed: requesting a sample or issuing a quotation moves the deal automatically."}</p>
    </D21Dialog>
  );
}

/** A decision on a pending move request (approve / reject with a note). */
export function DecideMoveSheet({ ar, busy, line, error, onClose, onSubmit }: {
  ar: boolean; busy: boolean; line: string; error?: string; onClose: () => void; onSubmit: (decision: "APPROVE" | "REJECT", note: string) => void;
}) {
  const [note, setNote] = useState("");
  return (
    <D21Dialog lang={lang(ar)} width={480} testId="decide-move-dialog" onClose={onClose}
      title={ar ? "طلب نقل الصفقة" : "Stage move request"} sub={line}
      actions={<>
        <button type="button" className="d21-dlg-btn is-primary" disabled={busy} data-testid="approve-move" onClick={() => onSubmit("APPROVE", note.trim())}>{ar ? "اعتماد النقل" : "Approve"}</button>
        <button type="button" className="d21-dlg-btn" disabled={busy || note.trim().length < 2} data-testid="reject-move" onClick={() => onSubmit("REJECT", note.trim())}>{ar ? "رفض" : "Reject"}</button>
      </>}>
      {error ? <p className="d21-dlg-alert" role="alert">{error}</p> : null}
      <label className="d21-dlg-field">
        <span className="d21-dlg-label">{ar ? "ملاحظة (مطلوبة عند الرفض، يقرؤها المندوب)" : "Note (required to reject; the rep reads it)"}</span>
        <input className="d21-dlg-input" data-testid="decide-note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />
      </label>
    </D21Dialog>
  );
}
