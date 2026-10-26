"use client";

import { useState, useEffect, use } from "react";
import CuppingForm, { type CuppingFormData } from "@/app/dashboard/cupping/CuppingForm";
import { GuestShell } from "../GuestShell";
import { useGuestLang } from "@/app/guest-cupping/guest-lang";

type SessionInfo = { id: string; name: string; status: string };

type Step = "loading" | "closed" | "not-found" | "name" | "form" | "done";

// Guest scoring of a single-sample session by link — Direction 2.1, GX-G G-08 (Figma
// 1228:5609 name, 1228:103453 scoring, 1228:107763 done). The requests, their bodies and the
// one-score-per-name guard are unchanged; only how the page is drawn changed.
export default function GuestCuppingPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);

  // Owner language decision 2: the guest's browser language first; the toggle switches.
  const [lang, setLang] = useGuestLang();
  const L = (ar: string, en: string) => (lang === "ar" ? ar : en);
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [step, setStep] = useState<Step>("loading");
  const [name, setName] = useState("");
  const [nameError, setNameError] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState("");
  const [finalScore, setFinalScore] = useState(0);

  useEffect(() => {
    fetch(`/api/public/cupping/${id}/score`)
      .then(async (r) => {
        if (!r.ok) { setStep("not-found"); return; }
        const s: SessionInfo = await r.json();
        setSession(s);
        setStep(s.status === "Open" ? "name" : "closed");
      })
      .catch(() => setStep("not-found"));
  }, [id]);

  function handleNameSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) { setNameError(true); return; }
    setNameError(false);
    setStep("form");
  }

  async function handleSubmit(data: CuppingFormData) {
    setSubmitting(true);
    setSubmitError("");
    const res = await fetch(`/api/public/cupping/${id}/score`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...data, externalName: name }),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      // E6 / C-3: one score per guest name per session (server-side guard).
      setSubmitError(j.code === "CUPPING_ALREADY_SCORED"
        ? L("قيّمت هذه الجلسة مسبقًا بهذا الاسم.", "You have already scored this session under this name.")
        : j.error || L("تعذّر إرسال التقييم.", "Failed to submit score"));
      setSubmitting(false);
      return;
    }
    setFinalScore(data.finalScore);
    setStep("done");
    setSubmitting(false);
  }

  const shell = (children: React.ReactNode, opts: { step?: "name" | "cups" | "done"; foot?: boolean } = {}) => (
    <GuestShell lang={lang} onLang={setLang} title={session?.name} step={opts.step} foot={opts.foot}>{children}</GuestShell>
  );

  // ── States ────────────────────────────────────────────────────────────────────

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

  if (step === "done") {
    return shell(
      <div className="gc-done" data-testid="guest-done">
        <span>{L("تقييمك", "Your score")}</span>
        <strong className="cf-num">{finalScore.toFixed(2)}</strong>
        <b>{L("أُرسل تقييمك", "Score submitted")}</b>
        <p>{L(`شكرًا ${name}. سُجّل تقييمك. لا تظهر النتائج للضيوف.`, `Thank you, ${name}. Your score has been recorded. Results are not shown to guests.`)}</p>
      </div>,
      { step: "done" },
    );
  }

  if (step === "name") {
    return shell(
      <form onSubmit={handleNameSubmit} className="gc-form" noValidate>
        <p className="gc-note"><b>{L("تذوق", "Cupping")} <span className="cf-num">SCA</span>.</b> {L("أدخل اسمك ثم قيّم الكوب. يُسجَّل تقييم واحد لكل اسم.", "Enter your name, then score the cup. One score is recorded per name.")}</p>
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

  // step === "form"
  return shell(
    <>
      <p className="gc-cap">{L(`التقييم باسم ${name}`, `Scoring as ${name}`)}</p>
      {submitError ? <div className="hr-notice tone-danger" role="alert">{submitError}</div> : null}
      <CuppingForm
        lang={lang}
        variant="guest"
        onSubmit={handleSubmit}
        submitting={submitting}
        submitLabel={L("إرسال تقييمي", "Submit my score")}
      />
    </>,
    { step: "cups", foot: true },
  );
}
