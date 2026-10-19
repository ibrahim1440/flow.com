"use client";

import { useState, useEffect, use } from "react";
import CuppingForm, { type CuppingFormData } from "@/app/dashboard/cupping/CuppingForm";
import { GuestShell, type GuestLang } from "../../GuestShell";

type CupSlot = { id: string; order: number }; // blind — no bean info
type SessionInfo = { id: string; name: string; status: string; sessionBatches: CupSlot[] };
type Step = "loading" | "closed" | "not-found" | "name" | "cup-list" | "scoring" | "all-done";

/** «كوبان متبقيان» / «3 أكواب متبقية» / «2 cups remaining». */
function remainingText(n: number, lang: GuestLang): string {
  if (lang === "en") return `${n} ${n === 1 ? "cup" : "cups"} remaining`;
  if (n === 1) return "كوب واحد متبقٍ";
  if (n === 2) return "كوبان متبقيان";
  if (n <= 10) return `${n} أكواب متبقية`;
  return `${n} كوبًا متبقيًا`;
}

/** «3 أكواب» / «3 cups». */
function cupsText(n: number, lang: GuestLang): string {
  if (lang === "en") return `${n} ${n === 1 ? "cup" : "cups"}`;
  if (n === 1) return "كوب واحد";
  if (n === 2) return "كوبان";
  if (n <= 10) return `${n} أكواب`;
  return `${n} كوبًا`;
}

// Blind guest scoring by session link — Direction 2.1, GX-G G-08 (Figma 1228:5609 name,
// 1228:103453 cups and scoring with the open cup's form inline, 1228:107763 done; 390:
// 1225:7062, 1228:5556, 1228:5595). The token handling, the requests and their bodies are
// unchanged; only how the page is drawn changed.
export default function GuestSessionPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);

  const [lang, setLang] = useState<GuestLang>("ar");
  const L = (ar: string, en: string) => (lang === "ar" ? ar : en);
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [step, setStep] = useState<Step>("loading");
  const [name, setName] = useState("");
  const [nameError, setNameError] = useState(false);
  const [activeCupId, setActiveCupId] = useState<string | null>(null);
  const [scoredIds, setScoredIds] = useState<Set<string>>(new Set());
  // The guest's own submitted scores, per cup — shown back to them only («قيّمته · 81.50»).
  const [myScores, setMyScores] = useState<Record<string, number>>({});
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState("");

  useEffect(() => {
    fetch(`/api/public/cupping/session/${token}`)
      .then(async (r) => {
        if (!r.ok) { setStep("not-found"); return; }
        const s: SessionInfo = await r.json();
        setSession(s);
        setStep(s.status === "Open" ? "name" : "closed");
      })
      .catch(() => setStep("not-found"));
  }, [token]);

  function handleNameSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) { setNameError(true); return; }
    setNameError(false);
    setStep("cup-list");
  }

  function startScoring(cupId: string) {
    setActiveCupId(cupId);
    setSubmitError("");
    setStep("scoring");
  }

  async function handleSubmitScore(data: CuppingFormData) {
    if (!activeCupId || !session) return;
    setSubmitting(true);
    setSubmitError("");

    const res = await fetch(`/api/public/cupping/session/${token}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...data, sessionBatchId: activeCupId, externalName: name }),
    });

    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      setSubmitError(j.error || L("تعذّر إرسال التقييم.", "Failed to submit score"));
      setSubmitting(false);
      return;
    }

    setMyScores((p) => ({ ...p, [activeCupId]: data.finalScore }));
    setScoredIds((prev) => new Set([...prev, activeCupId]));
    setSubmitting(false);

    const allDone = session.sessionBatches.every(
      (b) => b.id === activeCupId || scoredIds.has(b.id)
    );
    setActiveCupId(null);
    setStep(allDone ? "all-done" : "cup-list");
  }

  const shell = (children: React.ReactNode, opts: { step?: "name" | "cups" | "done"; foot?: boolean } = {}) => (
    <GuestShell lang={lang} onLang={setLang} title={session?.name} step={opts.step} foot={opts.foot}>{children}</GuestShell>
  );

  // ── Render states ─────────────────────────────────────────────────────────

  if (step === "loading") {
    return shell(<div className="gc-state" aria-busy="true"><span>{L("جارٍ التحميل…", "Loading…")}</span></div>);
  }

  if (step === "not-found") {
    return shell(
      <div className="gc-state">
        <b>{L("الجلسة غير موجودة", "Session not found")}</b>
        <span>{L("تحقّق من الرابط ثم أعد المحاولة.", "Please check your link and try again.")}</span>
      </div>,
    );
  }

  if (step === "closed") {
    return shell(
      <div className="gc-state">
        <b>{L("أُغلقت جلسة التذوق هذه.", "This cupping session has been closed.")}</b>
        <span>{L("شكرًا لاهتمامك.", "Thank you for your interest!")}</span>
      </div>,
    );
  }

  const cups = session?.sessionBatches ?? [];

  if (step === "all-done") {
    // «متوسط تقييماتك» (1228:107763): the mean of the scores this guest sent, from this page.
    const sent = Object.values(myScores);
    const mean = sent.length > 0 ? sent.reduce((a, b) => a + b, 0) / sent.length : 0;
    return shell(
      <div className="gc-done" data-testid="guest-done">
        <span>{L("متوسط تقييماتك", "Your average score")}</span>
        <strong className="cf-num">{mean.toFixed(2)}</strong>
        <b>{L("أُرسلت تقييماتك كلها", "All your scores are sent")}</b>
        <p>{L(`شكرًا ${name}. سُجّلت تقييمات ${cupsText(cups.length, "ar")}. لا تظهر النتائج للضيوف.`, `Thank you, ${name}. Your scores for ${cupsText(cups.length, "en")} are recorded. Results are not shown to guests.`)}</p>
      </div>,
      { step: "done" },
    );
  }

  if (step === "name") {
    return shell(
      <form onSubmit={handleNameSubmit} className="gc-form" noValidate>
        <p className="gc-note">
          <b>{L("تذوق معمّى", "Blind cupping")} · {cupsText(cups.length, lang)}.</b>{" "}
          {L(`تقيّم «${cups.map((_, i) => `كوب ${i + 1}`).join("، ")}». تُكشف هوية البن عند إغلاق الجلسة.`,
             `You score «${cups.map((_, i) => `Cup ${i + 1}`).join(", ")}». The coffees are revealed when the session is closed.`)}
        </p>
        <div className="gc-field">
          <label htmlFor="guest-name">{L("اسمك", "Your name")} <i aria-hidden="true">*</i></label>
          <input id="guest-name" className="gc-input" autoFocus value={name} onChange={(e) => setName(e.target.value)}
            aria-invalid={nameError || undefined} aria-describedby={nameError ? "guest-name-err" : undefined} autoComplete="name" />
          {nameError ? <span id="guest-name-err" className="gc-err">{L("أدخل اسمك", "Please enter your name")}</span> : null}
        </div>
        <button type="submit" className="hr-btn is-primary">{L("ابدأ التذوق", "Start cupping")}</button>
      </form>,
      { step: "name", foot: true },
    );
  }

  // step === "cup-list" | "scoring": the cups, the open one with its form inline (1228:103479).
  const remaining = cups.filter((c) => !scoredIds.has(c.id)).length;
  const nextId = cups.find((c) => !scoredIds.has(c.id))?.id ?? null;
  return shell(
    <>
      <p className="gc-cap">{L(`التقييم باسم ${name}`, `Scoring as ${name}`)} · {remainingText(remaining, lang)}</p>
      <ul className="gc-cups">
        {cups.map((cup, i) => {
          const done = scoredIds.has(cup.id);
          const open = step === "scoring" && activeCupId === cup.id;
          return (
            <li key={cup.id} className={open ? "is-open" : undefined}>
              <button type="button" className="gc-cuphead" disabled={done} aria-expanded={done ? undefined : open}
                onClick={() => { if (done) return; if (open) { setActiveCupId(null); setStep("cup-list"); } else startScoring(cup.id); }}
                data-testid={`guest-cup-${i + 1}`}>
                <span className="gc-cupmain">
                  <b>{L("كوب", "Cup")} <span className="cf-num">{i + 1}</span></b>
                  <span>
                    {done ? <>{L("قيّمته", "You scored it")} · <span className="cf-num">{(myScores[cup.id] ?? 0).toFixed(2)}</span></>
                      : open ? L("معمّى · لا تظهر لك تقييمات الآخرين", "Blind · other scores are hidden from you")
                      : L("اضغط للتقييم", "Tap to score")}
                  </span>
                </span>
                {done ? <span className="hr-dot tone-success"><span>{L("قُيّم", "Scored")}</span></span>
                  : open ? <span className="hr-dot tone-info"><span>{L("قيد التقييم", "Scoring")}</span></span>
                  : <span className={`hr-btn is-sm${cup.id === nextId && step !== "scoring" ? " is-primary" : ""}`} aria-hidden="true">{L("تقييم", "Score")}</span>}
              </button>
              {open ? (
                <div className="gc-open">
                  {submitError ? <div className="hr-notice tone-danger" role="alert" style={{ marginTop: 12 }}>{submitError}</div> : null}
                  <CuppingForm
                    key={cup.id}
                    lang={lang}
                    variant="guest"
                    onSubmit={handleSubmitScore}
                    submitting={submitting}
                    submitLabel={L(`إرسال تقييم الكوب ${i + 1}`, `Submit cup ${i + 1} score`)}
                  />
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </>,
    { step: "cups", foot: true },
  );
}
