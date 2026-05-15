"use client";

import { useState, useEffect, use } from "react";
import { FlaskConical, CheckCircle, Coffee, ChevronRight, ArrowLeft } from "lucide-react";
import CuppingForm, { type CuppingFormData } from "@/app/dashboard/cupping/CuppingForm";

type CupSlot = { id: string; order: number }; // blind — no bean info
type SessionInfo = { id: string; name: string; status: string; sessionBatches: CupSlot[] };
type Step = "loading" | "closed" | "not-found" | "name" | "cup-list" | "scoring" | "all-done";

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-cream">
      <div className="max-w-xl mx-auto px-4 py-8">
        <div className="flex items-center gap-2 mb-6">
          <div className="w-8 h-8 rounded-lg bg-orange flex items-center justify-center shrink-0">
            <FlaskConical size={16} className="text-white" />
          </div>
          <div>
            <p className="text-xs font-extrabold text-charcoal leading-none">HIQBAH COFFEE</p>
            <p className="text-[10px] text-brown/50 leading-none mt-0.5">SCA Blind Cupping</p>
          </div>
        </div>
        {children}
      </div>
    </div>
  );
}

export default function GuestSessionPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);

  const [session, setSession] = useState<SessionInfo | null>(null);
  const [step, setStep] = useState<Step>("loading");
  const [name, setName] = useState("");
  const [nameError, setNameError] = useState("");
  const [activeCupId, setActiveCupId] = useState<string | null>(null);
  const [scoredIds, setScoredIds] = useState<Set<string>>(new Set());
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState("");
  const [lastScore, setLastScore] = useState(0);

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
    if (!name.trim()) { setNameError("Please enter your name / أدخل اسمك"); return; }
    setNameError("");
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
      const j = await res.json();
      setSubmitError(j.error || "Failed to submit score");
      setSubmitting(false);
      return;
    }

    setLastScore(data.finalScore);
    setScoredIds((prev) => new Set([...prev, activeCupId]));
    setSubmitting(false);

    const allDone = session.sessionBatches.every(
      (b) => b.id === activeCupId || scoredIds.has(b.id)
    );
    setActiveCupId(null);
    setStep(allDone ? "all-done" : "cup-list");
  }

  // ── Render states ─────────────────────────────────────────────────────────

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
          <p className="text-xl font-extrabold text-charcoal">This cupping session has been closed.</p>
          <p className="text-lg font-bold text-charcoal/60">عذراً، تم إغلاق جلسة التذوق هذه.</p>
          <p className="text-sm text-brown/50 mt-2">Thank you for your interest!</p>
        </div>
      </Shell>
    );
  }

  if (step === "all-done") {
    return (
      <Shell>
        <div className="text-center py-12 space-y-4 px-4">
          <CheckCircle size={56} className="text-green-500 mx-auto" />
          <p className="text-2xl font-extrabold text-charcoal">All Cups Scored!</p>
          <p className="text-5xl font-black text-green-600">{lastScore.toFixed(2)}</p>
          <p className="text-sm text-brown/60 mt-1">
            Thank you, <strong className="text-charcoal">{name}</strong>! All {session?.sessionBatches.length} cups recorded.
          </p>
          <p className="text-xs text-brown/40 mt-4">شكراً لك! تم تسجيل جميع تقييماتك.</p>
        </div>
      </Shell>
    );
  }

  if (step === "name") {
    return (
      <Shell>
        <div className="space-y-6 px-1">
          <div className="text-center">
            <div className="w-14 h-14 bg-orange/10 rounded-2xl flex items-center justify-center mx-auto mb-3">
              <FlaskConical size={28} className="text-orange" />
            </div>
            <h2 className="text-xl font-extrabold text-charcoal">{session?.name}</h2>
            <p className="text-sm text-brown/60 mt-1">
              Blind SCA Cupping · {session?.sessionBatches.length} cups
            </p>
            <p className="text-xs text-brown/40 mt-1">
              تقييم عمياء · {session?.sessionBatches.length} أكواب
            </p>
          </div>

          <div className="bg-amber-50 border border-amber-200 rounded-2xl p-4 text-center space-y-1">
            <p className="text-sm font-bold text-amber-800">🔒 Blind Tasting Protocol</p>
            <p className="text-xs text-amber-700">You will evaluate {session?.sessionBatches.length} cups labeled Cup 1, Cup 2… The coffee identities are hidden until the session is closed by the admin.</p>
          </div>

          <form onSubmit={handleNameSubmit} className="space-y-4">
            <div className="bg-white rounded-2xl border border-border p-5 space-y-3">
              <label className="block text-sm font-extrabold text-charcoal uppercase tracking-wide">
                Enter your name to start
                <span className="block text-xs text-brown/50 normal-case tracking-normal mt-0.5 font-normal">أدخل اسمك للبدء</span>
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

  if (step === "cup-list") {
    const cups = session?.sessionBatches ?? [];
    const remaining = cups.filter((c) => !scoredIds.has(c.id));
    return (
      <Shell>
        <div className="space-y-5">
          <div>
            <p className="text-xs font-bold text-brown/50 uppercase tracking-widest">Cupping as</p>
            <p className="text-lg font-extrabold text-charcoal">{name}</p>
            <p className="text-xs text-brown/40">{session?.name}</p>
          </div>

          {remaining.length > 0 ? (
            <>
              <p className="text-sm font-bold text-charcoal">
                {scoredIds.size > 0 ? `${remaining.length} cup${remaining.length !== 1 ? "s" : ""} remaining` : "Select a cup to begin scoring"}
              </p>
              <div className="space-y-2">
                {cups.map((cup, i) => {
                  const done = scoredIds.has(cup.id);
                  return (
                    <button
                      key={cup.id}
                      onClick={() => !done && startScoring(cup.id)}
                      disabled={done}
                      className={`w-full flex items-center gap-4 p-4 rounded-2xl border-2 transition-all text-left ${
                        done
                          ? "border-green-200 bg-green-50 opacity-75 cursor-default"
                          : "border-border bg-white hover:border-orange hover:shadow-md active:scale-[0.99]"
                      }`}
                    >
                      <div className={`w-12 h-12 rounded-xl flex items-center justify-center shrink-0 font-extrabold text-lg ${
                        done ? "bg-green-100 text-green-600" : "bg-orange/10 text-orange"
                      }`}>
                        {done ? <CheckCircle size={24} /> : i + 1}
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className={`font-extrabold ${done ? "text-green-700" : "text-charcoal"}`}>
                          كوب {i + 1} — Cup {i + 1}
                        </p>
                        <p className="text-xs text-brown/50 mt-0.5">
                          {done ? "✓ Scored" : "Tap to score this cup"}
                        </p>
                      </div>
                      {!done && <ChevronRight size={18} className="text-brown/30 shrink-0" />}
                    </button>
                  );
                })}
              </div>
            </>
          ) : (
            <div className="text-center py-8 space-y-3">
              <CheckCircle size={48} className="text-green-500 mx-auto" />
              <p className="text-xl font-extrabold text-charcoal">All cups scored!</p>
              <p className="text-sm text-brown/60">Thank you, {name}!</p>
            </div>
          )}
        </div>
      </Shell>
    );
  }

  // step === "scoring"
  const cups = session?.sessionBatches ?? [];
  const activeCupIndex = cups.findIndex((c) => c.id === activeCupId);

  return (
    <Shell>
      <div className="space-y-4">
        <div className="flex items-center gap-3">
          <button
            onClick={() => { setActiveCupId(null); setStep("cup-list"); }}
            className="flex items-center gap-1.5 text-sm font-bold text-brown/60 hover:text-charcoal transition-colors"
          >
            <ArrowLeft size={16} />
            Back
          </button>
          <div>
            <p className="text-xs text-brown/50 font-medium">Scoring as {name}</p>
            <p className="font-extrabold text-charcoal">كوب {activeCupIndex + 1} — Cup {activeCupIndex + 1}</p>
            <p className="text-xs text-brown/40">{session?.name}</p>
          </div>
        </div>

        {submitError && (
          <div className="bg-red-50 border border-red-200 rounded-xl px-4 py-3 text-sm text-red-600 font-medium">
            {submitError}
          </div>
        )}

        <CuppingForm
          onSubmit={handleSubmitScore}
          submitting={submitting}
          submitLabel={`Submit Cup ${activeCupIndex + 1} Score →`}
        />
      </div>
    </Shell>
  );
}
