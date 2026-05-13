"use client";

import { useState } from "react";
import { CalendarDays, X, AlertTriangle, Merge, Loader2 } from "lucide-react";
import { useI18n } from "@/lib/i18n/context";

export type EditableBatch = {
  id: string;
  batchNumber: string;
  date: string;
  parentBatchId: string | null;
  parentBatch: { id: string; batchNumber: string } | null;
};

type DatePatchResponse = {
  batchNumber: string;
  oldBatchNumber: string;
  oldDate: string;
  parentBatch: { id: string; batchNumber: string } | null;
  newDateLaterThanParent: boolean;
};

type Props = {
  batch: EditableBatch;
  onClose: () => void;
  onSuccess: (result: {
    batchId: string;
    newBatchNumber: string;
    parentBatchId?: string;
    newParentBatchNumber?: string;
  }) => void;
};

export default function EditDateModal({ batch, onClose, onSuccess }: Props) {
  const { t, lang } = useI18n();

  const todayStr = new Date().toISOString().slice(0, 10);
  const batchDateStr = batch.date ? batch.date.slice(0, 10) : todayStr;

  const [newDate, setNewDate] = useState(batchDateStr);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  // After the first PATCH succeeds, we may need to ask about blends
  const [step, setStep] = useState<"form" | "blend_confirm">("form");
  const [firstResult, setFirstResult] = useState<DatePatchResponse | null>(null);
  const [blendLoading, setBlendLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const res = await fetch(`/api/roasting-batches/${batch.id}/date`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ newDate }),
      });
      const data: DatePatchResponse = await res.json();
      if (!res.ok) {
        setError((data as { error?: string }).error ?? t("error"));
        return;
      }

      if (data.parentBatch && data.newDateLaterThanParent) {
        setFirstResult(data);
        setStep("blend_confirm");
      } else {
        onSuccess({ batchId: batch.id, newBatchNumber: data.batchNumber });
      }
    } catch {
      setError(t("error"));
    } finally {
      setLoading(false);
    }
  }

  async function handleBlendCascade(cascade: boolean) {
    if (!firstResult?.parentBatch) return;

    if (!cascade) {
      onSuccess({ batchId: batch.id, newBatchNumber: firstResult.batchNumber });
      return;
    }

    setBlendLoading(true);
    try {
      const res = await fetch(`/api/roasting-batches/${firstResult.parentBatch.id}/date`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ newDate }),
      });
      const data: DatePatchResponse = await res.json();
      if (!res.ok) {
        setError((data as { error?: string }).error ?? t("error"));
        setStep("form");
        return;
      }
      onSuccess({
        batchId: batch.id,
        newBatchNumber: firstResult.batchNumber,
        parentBatchId: firstResult.parentBatch.id,
        newParentBatchNumber: data.batchNumber,
      });
    } catch {
      setError(t("error"));
      setStep("form");
    } finally {
      setBlendLoading(false);
    }
  }

  return (
    <div
      className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-2xl p-6 w-full max-w-sm shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        {step === "form" && (
          <>
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <CalendarDays size={18} className="text-orange" />
                <h2 className="text-base font-extrabold text-charcoal">{t("editBatchDate")}</h2>
              </div>
              <button onClick={onClose} className="p-1 rounded-lg hover:bg-cream transition-colors">
                <X size={16} className="text-brown/60" />
              </button>
            </div>

            <p className="text-xs text-brown/60 font-mono mb-4">
              {batch.batchNumber}
              {batch.parentBatch && (
                <span className="ltr:ml-2 rtl:mr-2 text-purple-600">
                  ← {t("statusBlended")}: {batch.parentBatch.batchNumber}
                </span>
              )}
            </p>

            {error && (
              <div className="flex items-center gap-2 bg-red-50 border border-red-200 text-red-700 text-xs font-semibold px-3 py-2 rounded-xl mb-3">
                <AlertTriangle size={13} />
                {error}
              </div>
            )}

            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label className="block text-xs font-bold text-brown uppercase tracking-wide mb-1.5">
                  {t("newRoastDate")}
                </label>
                <input
                  type="date"
                  value={newDate}
                  max={todayStr}
                  onChange={(e) => setNewDate(e.target.value)}
                  required
                  className="w-full px-3 py-2.5 border-2 border-border rounded-xl text-sm focus:border-orange focus:ring-2 focus:ring-orange/20 outline-none transition-colors"
                />
              </div>
              <p className="text-[11px] text-brown/50 leading-relaxed">
                {lang === "ar"
                  ? "سيتم إعادة توليد الرقم التسلسلي تلقائياً بناءً على التاريخ الجديد."
                  : "The S/N will be regenerated automatically based on the new date."}
              </p>
              <div className="flex gap-2 pt-1">
                <button
                  type="button"
                  onClick={onClose}
                  className="flex-1 px-4 py-2.5 border-2 border-border text-brown rounded-xl text-sm font-bold hover:bg-cream transition-colors"
                >
                  {t("cancel")}
                </button>
                <button
                  type="submit"
                  disabled={loading || newDate === batchDateStr}
                  className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 bg-orange text-white rounded-xl text-sm font-bold hover:bg-orange/90 disabled:opacity-50 disabled:cursor-not-allowed active:scale-[0.98] transition-all"
                >
                  {loading ? <Loader2 size={14} className="animate-spin" /> : <CalendarDays size={14} />}
                  {t("save")}
                </button>
              </div>
            </form>
          </>
        )}

        {step === "blend_confirm" && firstResult && (
          <>
            <div className="flex items-center gap-2 mb-4">
              <Merge size={18} className="text-purple-600" />
              <h2 className="text-base font-extrabold text-charcoal">{t("updateBlendToo")}?</h2>
            </div>

            <div className="bg-purple-50 border border-purple-200 rounded-xl p-3 mb-4 text-xs text-purple-800 leading-relaxed">
              <p className="font-bold mb-1">
                {t("blendCascadeQuestion")}: <span className="font-mono">{firstResult.parentBatch?.batchNumber}</span>
              </p>
              <p>{t("blendCascadePrompt")}</p>
            </div>

            <p className="text-xs text-brown/60 mb-4">
              {lang === "ar" ? "الرقم التسلسلي الجديد:" : "New S/N:"}{" "}
              <span className="font-mono font-bold text-charcoal">{firstResult.batchNumber}</span>
            </p>

            {error && (
              <div className="flex items-center gap-2 bg-red-50 border border-red-200 text-red-700 text-xs font-semibold px-3 py-2 rounded-xl mb-3">
                <AlertTriangle size={13} />
                {error}
              </div>
            )}

            <div className="flex gap-2">
              <button
                onClick={() => handleBlendCascade(false)}
                disabled={blendLoading}
                className="flex-1 px-3 py-2.5 border-2 border-border text-brown rounded-xl text-xs font-bold hover:bg-cream disabled:opacity-50 transition-colors"
              >
                {t("skipBlendUpdate")}
              </button>
              <button
                onClick={() => handleBlendCascade(true)}
                disabled={blendLoading}
                className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2.5 bg-purple-600 text-white rounded-xl text-xs font-bold hover:bg-purple-700 disabled:opacity-50 active:scale-[0.98] transition-all"
              >
                {blendLoading ? <Loader2 size={13} className="animate-spin" /> : <Merge size={13} />}
                {t("updateBlendToo")}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
