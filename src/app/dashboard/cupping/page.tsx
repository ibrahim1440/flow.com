"use client";

import { useState } from "react";
import { FlaskConical, CheckCircle } from "lucide-react";
import CuppingForm, { type CuppingFormData } from "./CuppingForm";

export default function CuppingPage() {
  const [submitted, setSubmitted] = useState<CuppingFormData | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(data: CuppingFormData) {
    setSubmitting(true);
    // Session API will be wired up in the next step
    await new Promise((r) => setTimeout(r, 600));
    setSubmitted(data);
    setSubmitting(false);
  }

  return (
    <div className="max-w-xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-extrabold text-charcoal flex items-center gap-3">
          <FlaskConical className="text-orange" size={28} />
          SCA Cupping Form
        </h1>
        <p className="text-brown text-sm mt-1">
          Specialty Coffee Association — Interactive Sensory Evaluation
        </p>
      </div>

      {submitted ? (
        <div className="bg-white rounded-2xl border border-green-200 p-8 text-center space-y-3">
          <CheckCircle size={40} className="text-green-500 mx-auto" />
          <p className="text-xl font-extrabold text-charcoal">Score Recorded</p>
          <p className="text-4xl font-black text-green-600">{submitted.finalScore.toFixed(2)}</p>
          <p className="text-sm text-brown/60">
            {submitted.flavorDescriptors.length > 0 && (
              <>Descriptors: <strong>{submitted.flavorDescriptors.join(", ")}</strong></>
            )}
          </p>
          <button
            onClick={() => setSubmitted(null)}
            className="mt-4 px-6 py-2.5 rounded-xl bg-orange text-white font-bold text-sm hover:bg-orange/90 transition-colors"
          >
            New Evaluation
          </button>
        </div>
      ) : (
        <CuppingForm
          onSubmit={handleSubmit}
          submitting={submitting}
          submitLabel="Submit Score"
        />
      )}
    </div>
  );
}
