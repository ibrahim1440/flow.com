"use client";

import { useState, useEffect, use } from "react";
import { GuestShell, type GuestLang } from "../../../guest-cupping/GuestShell";
import "@/components/ops/ops.css";
import "./guest-qc.css";

type BatchInfo = {
  batchNumber: string;
  origin: string;
  processing: string;
  roastedKg: number;
  status: string;
  isOpen: boolean;
};

/**
 * Guest panel QC by link — Direction 2.1 (UI batch 2). No frame exists for this page (the Phase 9
 * `qx-*` frames are the in-app QC exception), so it is drawn in the guest-cupping frame
 * (GX-G G-08, GuestShell): brand row, «لا يلزم تسجيل الدخول», the batch as the title, one white
 * card. Arabic and English, phone first. The token handling, the request and its payload are
 * unchanged: GET and POST /api/guest-qc/:batchId/:token.
 */
export default function GuestQCPage({ params }: { params: Promise<{ batchId: string; token: string }> }) {
  const { batchId, token } = use(params);

  const [batch, setBatch] = useState<BatchInfo | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [lang, setLang] = useState<GuestLang>("ar");
  const L = (ar: string, en: string) => (lang === "ar" ? ar : en);

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
    if (!decision) { setError(L("اختر «قبول» أو «رفض».", "Please select Accept or Reject")); return; }
    if (!testerName.trim()) { setError(L("اكتب اسمك.", "Please enter your name")); return; }
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
        setError(d.error || L("تعذّر الإرسال.", "Submission failed"));
        return;
      }
      setSubmitted(true);
    } catch {
      setError(L("تعذّر الاتصال. حاول مرة أخرى.", "Network error. Please try again."));
    } finally {
      setSubmitting(false);
    }
  }

  const kicker = lang === "ar" ? "فحص الجودة · رابط ضيف" : "Panel QC · guest link";
  const facts = batch ? [batch.origin, batch.processing].filter(Boolean).join(" · ") : "";
  const kgText = batch ? <><span className="gq-num">{batch.roastedKg}</span> {L("كغ محمّص", "kg roasted")}</> : null;
  const shell = (title: string | null, children: React.ReactNode, sub?: React.ReactNode) => (
    <GuestShell lang={lang} onLang={setLang} title={title} kicker={kicker} headSub={sub} testId="guest-qc-root">{children}</GuestShell>
  );

  if (loading) {
    return shell(null, (
      <div className="gc-state" role="status" aria-live="polite"><span>{L("جارٍ التحميل…", "Loading…")}</span></div>
    ));
  }

  if (notFound) {
    return shell(null, (
      <div className="gc-state" data-testid="guest-qc-not-found">
        <b>{L("الرابط غير صالح", "Link not found")}</b>
        <span>{L("رابط فحص الجودة هذا غير صالح أو انتهت صلاحيته.", "This QC link is invalid or has expired.")}</span>
      </div>
    ));
  }

  if (!batch?.isOpen) {
    return shell(null, (
      <div className="gc-state" data-testid="guest-qc-closed">
        <b>{L("أُغلق فحص الجودة", "QC closed")}</b>
        <span>{L("اعتُمدت نتيجة هذه الدفعة.", "This batch has already been finalized.")}</span>
        {batch?.batchNumber ? <span className="gq-id">{batch.batchNumber}</span> : null}
      </div>
    ));
  }

  if (submitted) {
    const accepted = decision === "Accept";
    return shell(batch?.batchNumber ?? null, (
      <div className="gc-done" data-testid="guest-qc-done">
        <span className={`hr-dot tone-${accepted ? "success" : "danger"}`}><span>{accepted ? L("مقبولة", "Accepted") : L("مرفوضة", "Rejected")}</span></span>
        <b>{L(`شكرًا، ${testerName}`, `Thank you, ${testerName}!`)}</b>
        <p>{L("أُرسل سجل فحص الجودة.", "Your QC record has been submitted.")}</p>
        <dl className="gq-sum">
          <div><dt>{L("الدفعة", "Batch")}</dt><dd className="gq-id">{batch?.batchNumber}</dd></div>
          {facts ? <div><dt>{L("المنشأ", "Origin")}</dt><dd><bdi>{facts}</bdi></dd></div> : null}
          <div><dt>{L("القرار", "Verdict")}</dt><dd>{accepted ? L("قبول", "Accept") : L("رفض", "Reject")}</dd></div>
        </dl>
      </div>
    ), <>{facts ? <bdi>{facts}</bdi> : null}{facts ? " · " : null}{kgText}</>);
  }

  return shell(batch?.batchNumber ?? null, (
    <form onSubmit={handleSubmit} className="gq-form" noValidate={false} data-testid="guest-qc-form">
      <p className="gc-note">{L("سجّل حكمك على هذه الدفعة. يُرسل السجل مرة واحدة باسمك.", "Record your verdict on this batch. The record is sent once, under your name.")}</p>

      <div className="gc-field">
        <label htmlFor="gq-name">{L("اسمك", "Your name")} <i aria-hidden>*</i></label>
        <input id="gq-name" type="text" value={testerName} onChange={(e) => setTesterName(e.target.value)}
          placeholder={L("اكتب اسمك", "Enter your name")} className="gc-input" autoComplete="name" required />
      </div>

      <div className="gc-field">
        <span className="gq-label" id="gq-verdict">{L("القرار", "Verdict")} <i aria-hidden>*</i></span>
        <span className="ops-seg gq-seg" role="group" aria-labelledby="gq-verdict">
          <button type="button" aria-pressed={decision === "Accept"} data-testid="guest-qc-accept"
            onClick={() => { setDecision("Accept"); setUnderDeveloped(false); setOverDeveloped(false); }}>
            {L("قبول", "Accept")}
          </button>
          <button type="button" className="is-negative" aria-pressed={decision === "Reject"} data-testid="guest-qc-reject"
            onClick={() => setDecision("Reject")}>
            {L("رفض", "Reject")}
          </button>
        </span>
      </div>

      {decision === "Reject" && (
        <fieldset className="gq-reasons">
          <legend>{L("سبب الرفض", "Rejection reason")}</legend>
          <label><input type="radio" name="reason" checked={underDeveloped} onChange={() => { setUnderDeveloped(true); setOverDeveloped(false); }} />{L("تحميص ناقص", "Under developed")}</label>
          <label><input type="radio" name="reason" checked={overDeveloped} onChange={() => { setUnderDeveloped(false); setOverDeveloped(true); }} />{L("تحميص زائد", "Over developed")}</label>
        </fieldset>
      )}

      <div className="gq-grid">
        <div className="gc-field">
          <label htmlFor="gq-color">{L("اللون (Agtron)", "Color (Agtron)")}</label>
          <input id="gq-color" type="number" dir="ltr" value={color} onChange={(e) => setColor(e.target.value)} placeholder={L("مثال: 65", "e.g. 65")} className="gc-input gq-ltr" inputMode="decimal" />
        </div>
        <div className="gc-field">
          <label htmlFor="gq-remarks">{L("ملاحظات", "Remarks")}</label>
          <input id="gq-remarks" type="text" value={remarks} onChange={(e) => setRemarks(e.target.value)} placeholder={L("اختياري", "Optional notes")} className="gc-input" />
        </div>
      </div>

      {error && <p className="hr-notice tone-danger gq-error" role="alert">{error}</p>}

      <button type="submit" disabled={submitting} aria-busy={submitting || undefined} className="hr-btn is-primary gq-submit" data-testid="guest-qc-submit">
        {submitting ? L("جارٍ الإرسال…", "Submitting…") : L("إرسال سجل الفحص", "Submit QC record")}
      </button>
    </form>
  ), <>{facts ? <bdi>{facts}</bdi> : null}{facts ? " · " : null}{kgText}</>);
}
