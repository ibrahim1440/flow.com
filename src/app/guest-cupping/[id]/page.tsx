"use client";

import { useState, useEffect, use } from "react";
import { FlaskConical, CheckCircle, Coffee } from "lucide-react";
import CuppingForm, { type CuppingFormData } from "@/app/dashboard/cupping/CuppingForm";

type SessionInfo = { id: string; name: string; status: string };

type Step = "loading" | "closed" | "not-found" | "name" | "form" | "done";

export default function GuestCuppingPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);

  const [session, setSession] = useState<SessionInfo | null>(null);
  const [step, setStep] = useState<Step>("loading");
  const [name, setName] = useState("");
  const [nameError, setNameError] = useState("");
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
    if (!name.trim()) { setNameError("Please enter your name"); return; }
    setNameError("");
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
      const j = await res.json();
      setSubmitError(j.error || "Failed to submit score");
      setSubmitting(false);
      return;
    }
    setFinalScore(data.finalScore);
    setStep("done");
    setSubmitting(false);
  }

  // ── States ────────────────────────────────────────────────────────────────────

  if (step === "loading") {
    return (
      <Shell>
        <div className="text-center py-16 text-brown/40 text-sm">Loading…</div>
      </Shell>
    );
  }

  if (step === "not-found") {
    return (
      <Shell>
        <div className="text-center py-16">
          <Coffee size={36} className="text-orange/30 mx-auto mb-3" />
          <p className="font-bold text-charcoal">Session not found</p>
          <p className="text-sm text-brown/50 mt-1">Please check your link and try again.</p>
        </div>
      </Shell>
    );
  }

  if (step === "closed") {
    return (
      <Shell>
        <div className="text-center py-12 space-y-3 px-4">
          <div className="text-5xl mb-2">☕</div>
          <p className="text-xl font-extrabold text-charcoal">
            This cupping session has been closed.
          </p>
          <p className="text-lg font-bold text-charcoal/70">
            عذراً، تم إغلاق جلسة التذوق هذه.
          </p>
          <p className="text-sm text-brown/50 mt-2">Thank you for your interest!</p>
        </div>
      </Shell>
    );
  }

  if (step === "done") {
    return (
      <Shell>
        <div className="text-center py-12 space-y-4 px-4">
          <CheckCircle size={48} className="text-green-500 mx-auto" />
          <p className="text-xl font-extrabold text-charcoal">Score Submitted!</p>
          <p className="text-5xl font-black text-green-600">{finalScore.toFixed(2)}</p>
          <p className="text-sm text-brown/50 mt-1">
            Thank you, <strong className="text-charcoal">{name}</strong>!
            Your score has been recorded.
          </p>
          <p className="text-xs text-brown/40 mt-4">
            شكراً لك! تم تسجيل تقييمك.
          </p>
        </div>
      </Shell>
    );
  }

  if (step === "name") {
    return (
      <Shell>
        <div className="space-y-6 px-1">
          <div className="text-center">
            <FlaskConical size={40} className="text-orange mx-auto mb-3" />
            <h2 className="text-xl font-extrabold text-charcoal">{session?.name}</h2>
            <p className="text-sm text-brown/60 mt-1">SCA Cupping Session</p>
          </div>

          <form onSubmit={handleNameSubmit} className="space-y-4">
            <div className="bg-white rounded-2xl border border-border p-5 space-y-3">
              <label className="block text-sm font-extrabold text-charcoal uppercase tracking-wide">
                Enter your name to start
                <span className="block text-xs text-brown/50 normal-case tracking-normal mt-0.5 font-normal">
                  أدخل اسمك للبدء
                </span>
              </label>
              <input
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Your name / اسمك"
                className="w-full px-4 py-3 rounded-xl border-2 border-border bg-cream text-charcoal text-base focus:outline-none focus:border-orange focus:ring-2 focus:ring-orange/20 transition-colors"
              />
              {nameError && <p className="text-xs text-red-500 font-medium">{nameError}</p>}
            </div>
            <button
              type="submit"
              className="w-full py-4 rounded-xl bg-orange text-white font-extrabold text-base hover:bg-orange/90 transition-colors active:scale-[0.98]"
            >
              Start Cupping →
            </button>
          </form>
        </div>
      </Shell>
    );
  }

  // step === "form"
  return (
    <Shell>
      <div className="space-y-4">
        <div>
          <p className="text-xs text-brown/50 font-medium">Cupping as</p>
          <p className="font-extrabold text-charcoal">{name}</p>
          <p className="text-xs text-brown/40">{session?.name}</p>
        </div>
        {submitError && (
          <div className="bg-red-50 border border-red-200 rounded-xl px-4 py-3 text-sm text-red-600 font-medium">
            {submitError}
          </div>
        )}
        <CuppingForm
          onSubmit={handleSubmit}
          submitting={submitting}
          submitLabel="Submit My Score"
        />
      </div>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-cream">
      <div className="max-w-xl mx-auto px-4 py-8">
        {/* Header */}
        <div className="flex items-center gap-2 mb-6">
          <div className="w-8 h-8 rounded-lg bg-orange flex items-center justify-center shrink-0">
            <FlaskConical size={16} className="text-white" />
          </div>
          <div>
            <p className="text-xs font-extrabold text-charcoal leading-none">HIQBAH COFFEE</p>
            <p className="text-[10px] text-brown/50 leading-none mt-0.5">SCA Cupping</p>
          </div>
        </div>
        {children}
      </div>
    </div>
  );
}
