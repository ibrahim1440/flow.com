"use client";

// «عمولة عرض المحاسب» (owner decision, 1 Nov 2026): on an accountant's quotation for a rep's customer — who issued it,
// the rep, the commission state, and (for a sales / accounting supervisor or the owner) the two decisions with a reason.
import { useState } from "react";
import { api } from "../../_components/ui";

export type CommissionInfo = {
  channel: string;
  commissionDecision: string | null;
  commissionReason: string | null;
  commissionDecidedAt: string | null;
  commissionRep: { id: string; name: string } | null;
  commissionDecidedBy: { id: string; name: string } | null;
};

const at = (v: string | null) => (v ? new Date(v).toLocaleString("en-GB", { timeZone: "Asia/Riyadh", dateStyle: "short", timeStyle: "short" }) : "");

export function CommissionPanel({ quoteId, info, issuer, canDecide, ar, onDone }: { quoteId: string; info: CommissionInfo; issuer: string | null; canDecide: boolean; ar: boolean; onDone: () => void }) {
  const L = (a: string, e: string) => (ar ? a : e);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const fromAccounting = info.channel === "ACCOUNTING" || !!info.commissionDecision;
  if (!fromAccounting) return null;
  const d = info.commissionDecision;
  const state = d === "PENDING" ? L("بانتظار قرار العمولة", "Waiting for the commission decision")
    : d === "ASSIGNED" ? L(`العمولة مُسندة للمندوب ${info.commissionRep?.name ?? ""}`, `Commission assigned to ${info.commissionRep?.name ?? "the rep"}`)
    : d === "NONE" ? L("بدون عمولة", "No commission")
    : L("بدون عمولة (العميل غير تابع لمندوب)", "No commission (the customer has no rep)");
  const decide = async (decision: "ASSIGNED" | "NONE") => {
    setErr(null);
    if (reason.trim().length < 3) { setErr(L("اكتب سبب القرار.", "Give the reason.")); return; }
    setBusy(true);
    const r = await api<{ decision: string }>(`/api/sales/quotes/${quoteId}/commission`, { method: "POST", body: { decision, reason } });
    setBusy(false);
    if (!r.ok) { setErr((ar ? r.data.error : (r.data as { errorEn?: string }).errorEn ?? r.data.error) ?? "Error"); return; }
    setReason("");
    onDone();
  };
  return (
    <section className="qt-commission" data-testid="quote-commission" style={{ border: "1px solid var(--d21-line, #e3dccb)", borderRadius: 10, padding: "12px 14px", margin: "12px 0", display: "grid", gap: 8 }}>
      <b>{L("صادر من المحاسبة", "Issued by the accounting section")}{issuer ? ` · ${issuer}` : ""}</b>
      <span data-testid="quote-commission-state">
        {info.commissionRep && d === "PENDING" ? L(`العميل تابع للمندوب ${info.commissionRep.name} · `, `Customer of ${info.commissionRep.name} · `) : ""}{state}
      </span>
      {d === "ASSIGNED" || d === "NONE" ? (
        <span style={{ fontSize: 13, opacity: 0.8 }}>{L("القرار", "Decision")}: {info.commissionDecidedBy?.name ?? ""} · {at(info.commissionDecidedAt)} — {info.commissionReason}</span>
      ) : null}
      {canDecide && d === "PENDING" ? (
        <div style={{ display: "grid", gap: 8 }}>
          <input className="hr-input" placeholder={L("سبب القرار (مطلوب)", "Reason (required)")} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} data-testid="quote-commission-reason" />
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button type="button" className="hr-btn is-primary" disabled={busy} onClick={() => decide("ASSIGNED")} data-testid="quote-commission-assign">{L("إسناد العمولة للمندوب", "Assign the commission to the rep")}</button>
            <button type="button" className="hr-btn" disabled={busy} onClick={() => decide("NONE")} data-testid="quote-commission-none">{L("بدون عمولة", "No commission")}</button>
          </div>
          <span style={{ fontSize: 12, opacity: 0.75 }}>{L("الإسناد ينقل العرض لصفقة باسم المندوب، ويُسجَّل تحصيله على الصفقة وتنحسب العمولة حسب خطته. بعد تسجيل أول تحصيل ما يمديك تُسند.", "Assigning moves the quotation onto a deal of the rep; its collection is recorded on the deal and earns per the rep's plan. Not possible once a payment is recorded.")}</span>
        </div>
      ) : null}
      {err ? <div className="hr-notice tone-danger" role="alert">{err}</div> : null}
    </section>
  );
}
