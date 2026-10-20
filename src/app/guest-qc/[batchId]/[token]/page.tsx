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
// The reasons a guest gives for a rejection — the same chips as an internal evaluation (gap G25:
// a guest rejection carries its reason exactly like a staff one; the API refuses one without).
const REASONS = [
  { key: "burnt", ar: "محروقة", en: "Burnt" },
  { key: "uneven", ar: "غير متجانسة", en: "Uneven" },
  { key: "under", ar: "تحت التطوير", en: "Underdeveloped" },
  { key: "odour", ar: "رائحة غريبة", en: "Off odour" },
  { key: "other", ar: "أخرى", en: "Other" },
] as const;

export default function GuestQCPage({ params, searchParams }: { params: Promise<{ batchId: string; token: string }>; searchParams: Promise<{ name?: string | string[] }> }) {
  const { batchId, token } = use(params);
  // A guest present on the inviting device arrives with their name already typed (?name=…).
  const presetName = (() => { const n = use(searchParams).name; return (Array.isArray(n) ? n[0] : n ?? "").slice(0, 120); })();

  const [batch, setBatch] = useState<BatchInfo | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [lang, setLang] = useState<GuestLang>("ar");
  const L = (ar: string, en: string) => (lang === "ar" ? ar : en);

  const [testerName, setTesterName] = useState(presetName);
  const [decision, setDecision] = useState<"Accept" | "Reject" | "">("");
  const [reason, setReason] = useState<(typeof REASONS)[number]["key"] | "">("");
  const [colorWhole, setColorWhole] = useState("");
  const [colorGround, setColorGround] = useState("");
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
    if (decision === "Reject" && (!reason || (reason === "other" && !remarks.trim()))) { setError(L("اختر سبب الرفض.", "Please choose the rejection reason.")); return; }
    setError("");
    setSubmitting(true);
    try {
      const res = await fetch(`/api/guest-qc/${batchId}/${token}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify((() => {
          const r = REASONS.find((x) => x.key === reason);
          const label = decision === "Reject" && r && r.key !== "other" ? (lang === "ar" ? r.ar : r.en) : "";
          return {
            testerName, decision,
            underDeveloped: decision === "Reject" && reason === "under",
            overDeveloped: decision === "Reject" && reason === "burnt",
            remarks: [label, remarks.trim()].filter(Boolean).join(" · "),
            colorWhole: colorWhole.trim() || null,
            colorGround: colorGround.trim() || null,
          };
        })()),
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
            onClick={() => { setDecision("Accept"); setReason(""); }}>
            {L("قبول", "Accept")}
          </button>
          <button type="button" className="is-negative" aria-pressed={decision === "Reject"} data-testid="guest-qc-reject"
            onClick={() => setDecision("Reject")}>
            {L("رفض", "Reject")}
          </button>
        </span>
      </div>

      {decision === "Reject" && (
        <fieldset className="gq-reasons" data-testid="guest-qc-reasons">
          <legend>{L("سبب الرفض", "Rejection reason")} <i aria-hidden>*</i></legend>
          <span className="gq-chips">
            {REASONS.map((r) => (
              <button key={r.key} type="button" className="gq-chip" aria-pressed={reason === r.key} onClick={() => setReason(r.key)}>{lang === "ar" ? r.ar : r.en}</button>
            ))}
          </span>
        </fieldset>
      )}

      <div className="gq-grid">
        <div className="gc-field">
          <label htmlFor="gq-whole">{L("Agtron حبة (اختياري)", "Agtron, whole bean (optional)")}</label>
          <input id="gq-whole" type="number" dir="ltr" value={colorWhole} onChange={(e) => setColorWhole(e.target.value)} placeholder={L("مثال: 65", "e.g. 65")} className="gc-input gq-ltr" inputMode="decimal" />
        </div>
        <div className="gc-field">
          <label htmlFor="gq-ground">{L("Agtron مطحون (اختياري)", "Agtron, ground (optional)")}</label>
          <input id="gq-ground" type="number" dir="ltr" value={colorGround} onChange={(e) => setColorGround(e.target.value)} placeholder={L("مثال: 72", "e.g. 72")} className="gc-input gq-ltr" inputMode="decimal" />
        </div>
      </div>
      <div className="gc-field">
        <label htmlFor="gq-remarks">{decision === "Reject" && reason === "other" ? <>{L("اكتب السبب", "Write the reason")} <i aria-hidden>*</i></> : L("ملاحظات", "Remarks")}</label>
        <input id="gq-remarks" type="text" value={remarks} onChange={(e) => setRemarks(e.target.value)} placeholder={L("اختياري", "Optional notes")} className="gc-input" />
      </div>

      {error && <p className="hr-notice tone-danger gq-error" role="alert">{error}</p>}

      <button type="submit" disabled={submitting} aria-busy={submitting || undefined} className="hr-btn is-primary gq-submit" data-testid="guest-qc-submit">
        {submitting ? L("جارٍ الإرسال…", "Submitting…") : L("إرسال سجل الفحص", "Submit QC record")}
      </button>
    </form>
  ), <>{facts ? <bdi>{facts}</bdi> : null}{facts ? " · " : null}{kgText}</>);
}
