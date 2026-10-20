"use client";
// One evaluation, one tap (production simplification item 5; prototype «تقييمك»): مقبولة or
// مرفوضة, a reason chip when rejected (required, as on the server), Agtron and a note optional.
// POST /api/qc/[batchId]/records — unchanged; the chips map onto its existing fields.
import { useState } from "react";
import { OpsPane, useL } from "@/components/ops/ui";
import { Chips, Cta, NumIn, parseNum } from "@/components/ops/station";
import { useI18n } from "@/lib/i18n/context";

export const REJECT_REASONS = [
  { key: "burnt", ar: "محروقة", en: "Burnt" },
  { key: "uneven", ar: "غير متجانسة", en: "Uneven" },
  { key: "under", ar: "تحت التطوير", en: "Underdeveloped" },
  { key: "odour", ar: "رائحة غريبة", en: "Off odour" },
  { key: "other", ar: "أخرى", en: "Other" },
] as const;
export type RejectKey = (typeof REJECT_REASONS)[number]["key"];

/** The record fields a reason chip writes (underDeveloped / overDeveloped are the existing flags). */
export function reasonFields(key: RejectKey | null, note: string, lang: "ar" | "en") {
  const r = REJECT_REASONS.find((x) => x.key === key);
  const label = r ? (lang === "ar" ? r.ar : r.en) : "";
  const remarks = [key && key !== "other" ? label : "", note.trim()].filter(Boolean).join(" · ");
  return { underDeveloped: key === "under", overDeveloped: key === "burnt", remarks };
}

export function EvalSheet({ batch, min, onClose, onSaved }: {
  batch: { id: string; batchNumber: string; product: string; count: number };
  min: number;
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const L = useL();
  const { lang } = useI18n();
  const [res, setRes] = useState<"Accept" | "Reject" | null>(null);
  const [reason, setReason] = useState<RejectKey | null>(null);
  const [note, setNote] = useState("");
  const [whole, setWhole] = useState("");
  const [ground, setGround] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const needNote = res === "Reject" && reason === "other" && !note.trim();
  const ready = !!res && !(res === "Reject" && !reason) && !needNote;
  const label = !res ? L("اختر النتيجة", "Choose the result") : res === "Reject" && !reason ? L("اختر السبب", "Choose the reason") : needNote ? L("اكتب السبب", "Write the reason") : L("أرسل التقييم", "Send the evaluation");

  async function save() {
    if (!ready || busy) return;
    setBusy(true); setError("");
    const w = parseNum(whole), gr = parseNum(ground);
    const fields = res === "Reject" ? reasonFields(reason, note, lang) : { underDeveloped: false, overDeveloped: false, remarks: note.trim() };
    try {
      const r = await fetch(`/api/qc/${batch.id}/records`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision: res, ...fields, remarks: fields.remarks || null, colorWhole: Number.isFinite(w) ? w : null, colorGround: Number.isFinite(gr) ? gr : null }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setError(j.error || L("تعذّر الإرسال.", "Could not send.")); return; }
      const n = batch.count + 1;
      onSaved(n >= min ? L("سُجّل تقييمك · اكتمل الحد الأدنى والدفعة جاهزة للقرار", "Your evaluation is recorded · the minimum is reached") : L(`سُجّل تقييمك · بقي ${min - n} تقييم`, `Your evaluation is recorded · ${min - n} more needed`));
    } catch {
      setError(L("تعذّر الاتصال. أعد المحاولة.", "Network error. Try again."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <OpsPane testId="qc-eval-sheet" label={L("تقييمك", "Your evaluation")} title={L("تقييمك", "Your evaluation")}
      sub={<>{batch.product} · <span className="ops-serial">{batch.batchNumber}</span> · <bdi>{L(`${batch.count} من ${min} تقييمات`, `${batch.count} of ${min} evaluations`)}</bdi></>}
      busy={busy} onClose={onClose}
      footer={<Cta testId="qc-eval-save" disabled={!ready} busy={busy} onClick={save}>{label}</Cta>}>
      <div className="st-body">
        <div className="st-two" role="group" aria-label={L("النتيجة", "Result")}>
          <button type="button" className="st-verdict is-ok" aria-pressed={res === "Accept"} data-autofocus="" data-testid="qc-eval-accept" onClick={() => { setRes("Accept"); setReason(null); }}>
            <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6l7-3z" /><path d="M9 12l2 2 4-4" /></svg>
            {L("مقبولة", "Accept")}
          </button>
          <button type="button" className="st-verdict is-bad" aria-pressed={res === "Reject"} data-testid="qc-eval-reject" onClick={() => setRes("Reject")}>
            <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M8 8l8 8M16 8l-8 8" /></svg>
            {L("مرفوضة", "Reject")}
          </button>
        </div>
        {res === "Reject" ? (
          <div className="st-field">
            <span className="st-label">{L("السبب", "Reason")}</span>
            <Chips testId="qc-eval-reasons" label={L("السبب", "Reason")} value={reason} onChange={setReason}
              options={REJECT_REASONS.map((r) => ({ value: r.key, label: lang === "ar" ? r.ar : r.en }))} />
          </div>
        ) : null}
        {res === "Reject" && reason === "other" ? (
          <NumIn id="qc-eval-note-req" text small inputMode="text" label={L("اكتب السبب", "Write the reason")} value={note} onChange={setNote} />
        ) : null}
        <details className="st-more">
          <summary>{L("قراءات Agtron وملاحظات (اختياري)", "Agtron readings and a note (optional)")}</summary>
          <div>
            <div className="st-two">
              <NumIn id="qc-eval-whole" small label={L("حبة", "Whole bean")} value={whole} onChange={setWhole} />
              <NumIn id="qc-eval-ground" small label={L("مطحون", "Ground")} value={ground} onChange={setGround} />
            </div>
            {!(res === "Reject" && reason === "other") ? <NumIn id="qc-eval-note" text small inputMode="text" label={L("ملاحظة", "Note")} value={note} onChange={setNote} /> : null}
          </div>
        </details>
        {error ? <p className="hr-notice tone-danger" role="alert" style={{ margin: 0 }}>{error}</p> : null}
      </div>
    </OpsPane>
  );
}
