"use client";

import { useState, useEffect, use } from "react";
import { CheckCircle2, XCircle, Coffee, Loader2 } from "lucide-react";

type BatchInfo = {
  batchNumber: string;
  origin: string;
  processing: string;
  roastedKg: number;
  status: string;
  isOpen: boolean;
};

export default function GuestQCPage({ params }: { params: Promise<{ batchId: string; token: string }> }) {
  const { batchId, token } = use(params);

  const [batch, setBatch] = useState<BatchInfo | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  const [testerName, setTesterName] = useState("");
  const [decision, setDecision] = useState<"Accept" | "Reject" | "">("");
  const [underDeveloped, setUnderDeveloped] = useState(false);
  const [overDeveloped, setOverDeveloped] = useState(false);
  const [color, setColor] = useState("");
  const [remarks, setRemarks] = useState("");

  useEffect(() => {
    fetch(`/api/guest-qc/${batchId}/${token}`)
      .then(async (r) => {
        if (!r.ok) { setNotFound(true); return; }
        setBatch(await r.json());
      })
      .catch(() => setNotFound(true))
      .finally(() => setLoading(false));
  }, [batchId, token]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!decision) { setError("Please select Accept or Reject"); return; }
    if (!testerName.trim()) { setError("Please enter your name"); return; }
    setError("");
    setSubmitting(true);
    try {
      const res = await fetch(`/api/guest-qc/${batchId}/${token}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ testerName, decision, color, remarks, underDeveloped, overDeveloped }),
      });
      if (!res.ok) {
        const d = await res.json();
        setError(d.error || "Submission failed");
        return;
      }
      setSubmitted(true);
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-cream flex items-center justify-center">
        <Loader2 size={32} className="animate-spin text-orange" />
      </div>
    );
  }

  if (notFound) {
    return (
      <div className="min-h-screen bg-cream flex items-center justify-center p-6">
        <div className="bg-white rounded-2xl p-8 max-w-sm w-full text-center shadow-lg">
          <XCircle size={48} className="text-red-400 mx-auto mb-3" />
          <h1 className="text-xl font-extrabold text-charcoal mb-2">Link Not Found</h1>
          <p className="text-brown/70 text-sm">This QC link is invalid or has expired.</p>
        </div>
      </div>
    );
  }

  if (!batch?.isOpen) {
    return (
      <div className="min-h-screen bg-cream flex items-center justify-center p-6">
        <div className="bg-white rounded-2xl p-8 max-w-sm w-full text-center shadow-lg">
          <CheckCircle2 size={48} className="text-green-500 mx-auto mb-3" />
          <h1 className="text-xl font-extrabold text-charcoal mb-2">QC Closed</h1>
          <p className="text-brown/70 text-sm">This batch has already been finalized.</p>
          <p className="text-sm font-bold text-charcoal mt-2">{batch?.batchNumber}</p>
        </div>
      </div>
    );
  }

  if (submitted) {
    return (
      <div className="min-h-screen bg-cream flex items-center justify-center p-6">
        <div className="bg-white rounded-2xl p-8 max-w-sm w-full text-center shadow-lg">
          <div className={`w-16 h-16 rounded-full flex items-center justify-center mx-auto mb-4 ${decision === "Accept" ? "bg-green-100" : "bg-red-100"}`}>
            {decision === "Accept"
              ? <CheckCircle2 size={36} className="text-green-600" />
              : <XCircle size={36} className="text-red-600" />}
          </div>
          <h1 className="text-xl font-extrabold text-charcoal mb-1">Thank you, {testerName}!</h1>
          <p className="text-brown/70 text-sm mb-3">Your QC record has been submitted.</p>
          <div className="bg-cream rounded-xl p-3 text-left text-sm">
            <p className="font-medium text-charcoal">{batch?.batchNumber}</p>
            <p className="text-brown/60">{batch?.origin} — {batch?.processing}</p>
            <p className={`font-bold mt-1 ${decision === "Accept" ? "text-green-600" : "text-red-600"}`}>
              {decision}
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-cream flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-lg w-full max-w-md">
        {/* Header */}
        <div className="bg-charcoal rounded-t-2xl p-5 text-white">
          <div className="flex items-center gap-3 mb-1">
            <Coffee size={22} />
            <span className="text-sm font-medium opacity-70">Hiqbah Coffee — Panel QC</span>
          </div>
          <h1 className="text-lg font-extrabold">{batch?.batchNumber}</h1>
          <p className="text-sm opacity-80 mt-0.5">{batch?.origin}{batch?.processing ? ` · ${batch.processing}` : ""}</p>
          <p className="text-xs opacity-50 mt-0.5">{batch?.roastedKg} kg roasted</p>
        </div>

        <form onSubmit={handleSubmit} className="p-5 space-y-4">
          {/* Tester name */}
          <div>
            <label className="block text-sm font-semibold text-charcoal mb-1">Your Name *</label>
            <input
              type="text"
              value={testerName}
              onChange={(e) => setTesterName(e.target.value)}
              placeholder="Enter your name"
              className="w-full px-3 py-2.5 border-2 border-gray-200 rounded-xl focus:border-orange outline-none transition-colors text-sm"
              required
            />
          </div>

          {/* Decision */}
          <div>
            <label className="block text-sm font-semibold text-charcoal mb-2">Verdict *</label>
            <div className="grid grid-cols-2 gap-3">
              <button
                type="button"
                onClick={() => { setDecision("Accept"); setUnderDeveloped(false); setOverDeveloped(false); }}
                className={`flex items-center justify-center gap-2 py-3.5 rounded-xl border-2 font-bold text-sm transition-all ${
                  decision === "Accept" ? "border-green-500 bg-green-50 text-green-700" : "border-gray-200 text-gray-400 hover:border-green-300"
                }`}
              >
                <CheckCircle2 size={20} /> Accept
              </button>
              <button
                type="button"
                onClick={() => setDecision("Reject")}
                className={`flex items-center justify-center gap-2 py-3.5 rounded-xl border-2 font-bold text-sm transition-all ${
                  decision === "Reject" ? "border-red-500 bg-red-50 text-red-700" : "border-gray-200 text-gray-400 hover:border-red-300"
                }`}
              >
                <XCircle size={20} /> Reject
              </button>
            </div>
          </div>

          {/* Rejection reason */}
          {decision === "Reject" && (
            <div className="space-y-2 bg-red-50 rounded-xl p-3">
              <label className="block text-sm font-semibold text-charcoal">Rejection Reason</label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="radio" name="reason" checked={underDeveloped} onChange={() => { setUnderDeveloped(true); setOverDeveloped(false); }} className="w-4 h-4 accent-amber-500" />
                <span className="text-sm font-medium text-amber-700">Under Developed</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="radio" name="reason" checked={overDeveloped} onChange={() => { setUnderDeveloped(false); setOverDeveloped(true); }} className="w-4 h-4 accent-red-500" />
                <span className="text-sm font-medium text-red-700">Over Developed</span>
              </label>
            </div>
          )}

          {/* Color + Remarks */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-semibold text-charcoal mb-1">Color (Agtron)</label>
              <input
                type="number"
                value={color}
                onChange={(e) => setColor(e.target.value)}
                placeholder="e.g. 65"
                className="w-full px-3 py-2 border-2 border-gray-200 rounded-xl focus:border-orange outline-none transition-colors text-sm"
              />
            </div>
            <div>
              <label className="block text-sm font-semibold text-charcoal mb-1">Remarks</label>
              <input
                type="text"
                value={remarks}
                onChange={(e) => setRemarks(e.target.value)}
                placeholder="Optional notes"
                className="w-full px-3 py-2 border-2 border-gray-200 rounded-xl focus:border-orange outline-none transition-colors text-sm"
              />
            </div>
          </div>

          {error && (
            <p className="text-red-600 text-sm font-medium bg-red-50 rounded-xl px-3 py-2">{error}</p>
          )}

          <button
            type="submit"
            disabled={submitting}
            className="w-full py-3 bg-orange text-white rounded-xl font-bold text-sm hover:bg-orange-dark active:scale-[0.98] transition-all disabled:opacity-50 flex items-center justify-center gap-2"
          >
            {submitting ? <><Loader2 size={16} className="animate-spin" /> Submitting...</> : "Submit QC Record"}
          </button>
        </form>
      </div>
    </div>
  );
}
