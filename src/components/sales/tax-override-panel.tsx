"use client";
// P0 C5 (owner-approved Figma 2029-2, frame 3): «طلب تغيير الضريبة» on a DRAFT quotation or invoice draft. VAT is fixed (S
// 15 %); a holder of sales › invoice_tax_override asks for a statutory ZATCA treatment (Z / E / O with its reason code)
// with a written reason, and a SECOND person decides in «بانتظار اعتمادي» — the approval applies it to the draft. The
// server holds every rule (POST /api/sales/tax-overrides); this is the request form and the requests' state.
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Dialog, Field, HrRoot } from "@/components/hr/ui";
import { EXEMPTION_REASONS } from "@/lib/services/invoicing/pricing";
import "./tax-override-panel.css";

type Req = { id: string; status: "PENDING" | "APPROVED" | "REJECTED"; lines: { key: string; taxCategory: string; taxRatePercent: string; exemptionReasonCode: string | null }[]; reason: string; requestedBy: string | null; requestedAt: string; decidedBy: string | null; decisionNote: string | null };
type Data = { can: { request: boolean; approve: boolean }; items: Req[]; lines: { key: string; label: string; labelEn: string }[] };

const CAT: Record<string, [string, string]> = { Z: ["صفرية", "Zero-rated"], E: ["معفاة", "Exempt"], O: ["خارج النطاق", "Out of scope"], S: ["أساسية", "Standard"] };

export function TaxOverridePanel({ documentType, documentId, ar, editable, onApplied, reloadKey }: {
  documentType: "QUOTE" | "INVOICE"; documentId: string; ar: boolean;
  /** Changes when the document was saved: the lines (and their content keys) are read again. */
  reloadKey?: unknown;
  /** A draft only (an issued document is corrected by a credit / debit note). */
  editable: boolean; onApplied?: () => void;
}) {
  const L = (a: string, e: string) => (ar ? a : e);
  const [data, setData] = useState<Data | null>(null);
  const [open, setOpen] = useState(false);
  const [lineKey, setLineKey] = useState("");
  const [code, setCode] = useState(EXEMPTION_REASONS[0].code);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const load = useCallback(() => setTick((t) => t + 1), []);
  // An approval elsewhere changes the draft: a newly APPROVED request reloads the document once (the count seen last).
  const seenApproved = useRef<number | null>(null);
  const applied = useRef(onApplied);
  useEffect(() => { applied.current = onApplied; });
  useEffect(() => {
    let alive = true;
    fetch(`/api/sales/tax-overrides?documentType=${documentType}&documentId=${encodeURIComponent(documentId)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d: Data | null) => {
        if (!alive || !d) return;
        const n = d.items.filter((i) => i.status === "APPROVED").length;
        if (seenApproved.current !== null && n > seenApproved.current) applied.current?.();
        seenApproved.current = n;
        setData(d);
      })
      .catch(() => undefined);
    return () => { alive = false; };
  }, [documentType, documentId, tick, reloadKey]);
  if (!data) return null;
  // The draft's lines as the server keys them (by content — P0 gate M1).
  const lines = data.lines.map((l) => ({ key: l.key, label: ar ? l.label : l.labelEn }));
  const pending = data.items.filter((i) => i.status === "PENDING");
  const lastRejected = data.items.find((i) => i.status === "REJECTED");
  const label = (k: string) => lines.find((l) => l.key === k)?.label ?? k;
  const treat = EXEMPTION_REASONS.find((x) => x.code === code)!;
  const submit = async () => {
    setBusy(true); setErr(null);
    try {
      const r = await fetch("/api/sales/tax-overrides", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ documentType, documentId, reason, lines: [{ key: lineKey || lines[0]?.key, taxCategory: treat.category, taxRatePercent: "0", exemptionReasonCode: treat.code }] }) });
      const b = await r.json().catch(() => ({}));
      if (!r.ok) { setErr((ar ? b.errorAr ?? b.error : b.errorEn ?? b.error) ?? L("تعذّر الإرسال.", "Could not send.")); return; }
      setOpen(false); setReason(""); load();
    } catch { setErr(L("تعذّر الاتصال — حاول مرة ثانية.", "Could not connect — try again.")); } finally { setBusy(false); }
  };
  return (
    <div className="tax-ovr" data-testid="tax-override">
      {pending.map((p) => (
        <div key={p.id} className="inv-banner is-warning" role="status" data-testid="tax-override-pending">
          <b>{L("طلب تغيير الضريبة ينتظر الموافقة", "A VAT change request is waiting for approval")}</b>
          {p.lines.map((l, i) => <span key={i}><bdi>{label(l.key)}</bdi> ← {L(CAT[l.taxCategory]?.[0] ?? l.taxCategory, CAT[l.taxCategory]?.[1] ?? l.taxCategory)} <span className="hr-num">{l.taxRatePercent}٪</span>{l.exemptionReasonCode ? <> (<bdi>{l.exemptionReasonCode}</bdi>)</> : null}{p.requestedBy ? <> · {L("طلبه ", "asked by ")}<bdi>{p.requestedBy}</bdi></> : null}</span>)}
          <span className="inv-sub">{L("يوافق عليه شخص ثاني — ما تقدر توافق على طلبك.", "A second person decides it — you cannot approve your own request.")}</span>
        </div>
      ))}
      {!pending.length && lastRejected ? (
        <div className="inv-banner is-danger" role="status" data-testid="tax-override-rejected">
          <b>{L("انرفض طلب تغيير الضريبة", "The VAT change request was refused")}</b>
          {lastRejected.decisionNote ? <span><bdi>«{lastRejected.decisionNote}»</bdi></span> : null}
        </div>
      ) : null}
      {editable && data.can.request && lines.length ? (
        <button type="button" className="hr-btn" onClick={() => { setOpen(true); setErr(null); setLineKey(lines[0].key); }} data-testid="tax-override-open">{L("طلب تغيير الضريبة", "Request a VAT change")}</button>
      ) : null}
      {open && typeof document !== "undefined" ? createPortal(
        // On the shell root (.d21, where the colour tokens live — as the cupping invite does): the page's own stacking contexts never paint over it.
        <HrRoot>
          <Dialog open title={L("طلب تغيير الضريبة", "Request a VAT change")} onClose={() => { if (!busy) setOpen(false); }} testId="tax-override-dialog"
            actions={<>
              <button type="button" className="hr-btn is-primary" disabled={busy || reason.trim().length < 5} onClick={() => void submit()} data-testid="tax-override-submit">{busy ? L("جارٍ الإرسال…", "Sending…") : L("أرسل الطلب", "Send the request")}</button>
              <button type="button" className="hr-btn" disabled={busy} onClick={() => setOpen(false)}>{L("إلغاء", "Cancel")}</button>
            </>}>
            <div className="hr-form">
              {err ? <p className="hr-err is-wide" role="alert" data-testid="tax-override-error">{err}</p> : null}
              <Field label={L("البند", "Line")} wide>
                <select className="hr-input" value={lineKey} onChange={(e) => setLineKey(e.target.value)} data-testid="tax-override-line">
                  {lines.map((l) => <option key={l.key} value={l.key}>{l.label}</option>)}
                </select>
              </Field>
              <Field label={L("المعاملة الجديدة", "New treatment")} wide help={L("المسموح: صفرية (32/33/34/35) · معفاة (29/30) · خارج النطاق (OOS) — كلها 0٪.", "Allowed: zero-rated (32/33/34/35) · exempt (29/30) · out of scope (OOS) — all at 0%.")}>
                <select className="hr-input" value={code} onChange={(e) => setCode(e.target.value)} data-testid="tax-override-treatment">
                  {EXEMPTION_REASONS.map((x) => <option key={x.code} value={x.code}>{L(CAT[x.category][0], CAT[x.category][1])} · {x.code} — {L(x.ar, x.en)}</option>)}
                </select>
              </Field>
              <Field label={`${L("السبب", "Reason")} *`} wide>
                <textarea className="hr-input" rows={3} maxLength={1000} value={reason} onChange={(e) => setReason(e.target.value)} data-testid="tax-override-reason" />
              </Field>
            </div>
          </Dialog>
        </HrRoot>, document.querySelector<HTMLElement>(".d21") ?? document.body,
      ) : null}
    </div>
  );
}
