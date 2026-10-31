"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Mail, MessageCircle } from "lucide-react";
import { api } from "../../../sales/_components/ui";

/**
 * «الرسائل» on the customer page (batch 25; concept screen 4): the customer's e-mail with an easy edit, «يستقبل
 * إيميلات» (a switch), «يستقبل واتساب», and «آخر رسالة انرسلت له». Editing: the account owner, a manager or an
 * administrator — the server decides (GET …/messaging → can.edit) and audits every change.
 */
type Messaging = {
  email: string | null; hasEmail: boolean; emailValid: boolean; emailOptOut: boolean; emailOptOutSource: string | null;
  whatsappOptOut: boolean; last: { channel: "email" | "whatsapp"; at: string; status: string } | null; can: { edit: boolean; reenable: boolean };
  /** The customer stopped e-mails themselves (link / complaint / bounce), or the address is suppressed. */
  customerDecided: boolean; suppressed: boolean; history: string[];
};

const AR_LATN = "ar-SA-u-nu-latn-ca-gregory";
const SOURCE_AR: Record<string, string> = { customer_link: "أوقفها العميل من رابط الإيميل", staff: "أوقفها موظف", complaint: "بلّغ عن إيميل كسبام", bounce: "الإيميل ارتدّ" };

export function MessagingCard({ customerId, ar, onSaved }: { customerId: string; ar: boolean; onSaved?: (text: string) => void }) {
  const L = (a: string, e: string) => (ar ? a : e);
  const [m, setM] = useState<Messaging | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  // Fix round 1: switching e-mails back on for a customer who stopped them asks for confirmation and a reason.
  const [reopen, setReopen] = useState(false);
  // Fix round 2 (council b25 seat 5 N4): the confirmation opens in view, with the cursor in «السبب».
  const reasonRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (!reopen) return;
    const el = reasonRef.current;
    el?.scrollIntoView({ block: "center", behavior: "smooth" });
    el?.focus({ preventScroll: true });
  }, [reopen]);
  const [reason, setReason] = useState("");
  const reload = useCallback(async () => {
    const r = await api<Messaging>(`/api/customers/${customerId}/messaging`);
    if (r.ok) setM(r.data);
  }, [customerId]);
  useEffect(() => {
    let cancelled = false;
    api<Messaging>(`/api/customers/${customerId}/messaging`).then((r) => { if (!cancelled && r.ok) setM(r.data); });
    return () => { cancelled = true; };
  }, [customerId]);
  if (!m) return null;

  async function put(body: Record<string, unknown>, ok: string) {
    setBusy(true); setErr("");
    const r = await api(`/api/customers/${customerId}/messaging`, { method: "PUT", body });
    setBusy(false);
    if (!r.ok) { setErr(r.data.error ?? L("تعذّر الحفظ.", "Could not save.")); return false; }
    await reload();
    onSaved?.(ok);
    return true;
  }

  const lastText = m.last
    ? `${new Date(m.last.at).toLocaleString(ar ? AR_LATN : "en-GB", { timeZone: "Asia/Riyadh", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" })}`
    : null;
  return (
    <section data-testid="customer-messaging" style={{ marginTop: 24 }}>
      <div className="lbl acc-side-h">{L("الرسائل", "Messages")}</div>
      <dl className="props acc-props">
        <dt>{L("الإيميل", "E-mail")}</dt>
        <dd data-testid="cm-email">
          {editing ? (
            <form onSubmit={async (e) => { e.preventDefault(); if (await put({ email: draft }, L("انحفظ الإيميل.", "E-mail saved."))) setEditing(false); }} style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              <input className="hr-input" dir="ltr" type="email" inputMode="email" value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="orders@example.com" style={{ flex: "1 1 170px", minWidth: 0 }} data-testid="cm-email-input" autoFocus />
              <button type="submit" className="hr-btn is-primary is-sm" disabled={busy} data-testid="cm-email-save">{L("حفظ", "Save")}</button>
              <button type="button" className="hr-btn is-sm" onClick={() => { setEditing(false); setErr(""); }}>{L("إلغاء", "Cancel")}</button>
            </form>
          ) : (
            <>
              {m.email ? <bdi dir="ltr">{m.email}</bdi> : m.hasEmail ? L("مسجّل", "On record") : <span className="acc-muted">{L("ما له إيميل", "No e-mail")}</span>}
              {m.hasEmail && !m.emailValid ? <span className="acc-muted" style={{ display: "block", fontSize: 12 }}>{L("الإيميل المسجّل غير صحيح", "The e-mail on record is not valid")}</span> : null}
              {m.can.edit ? <button type="button" className="lk-inline" onClick={() => { setDraft(m.email ?? ""); setEditing(true); }} data-testid="cm-email-edit">{m.hasEmail ? L("تعديل", "Edit") : L("أضف إيميل", "Add e-mail")}</button> : null}
            </>
          )}
        </dd>
        <dt>{L("يستقبل إيميلات", "Receives e-mails")}</dt>
        <dd>
          <label className="cu-check" style={{ display: "inline-flex", gap: 8, alignItems: "center" }}>
            <input type="checkbox" role="switch" checked={!m.emailOptOut} disabled={!m.can.edit || busy || (m.emailOptOut && (m.customerDecided || m.suppressed) && !m.can.reenable)} data-testid="cm-email-optin"
              onChange={(e) => {
                if (e.target.checked && (m.customerDecided || m.suppressed)) { setReason(""); setReopen(true); return; }
                void put({ emailOptOut: !e.target.checked }, e.target.checked ? L("رجعت الإيميلات لهذا العميل.", "E-mails switched back on.") : L("وقفت الإيميلات لهذا العميل.", "E-mails stopped for this customer."));
              }} />
            <span>{m.emailOptOut ? L("لا", "No") : L("نعم", "Yes")}</span>
          </label>
          {m.emailOptOut && m.emailOptOutSource ? <span className="acc-muted" style={{ display: "block", fontSize: 12 }}>{ar ? SOURCE_AR[m.emailOptOutSource] ?? "" : m.emailOptOutSource}</span> : null}
          {m.emailOptOut && (m.customerDecided || m.suppressed) && !m.can.reenable ? <span className="acc-muted" style={{ display: "block", fontSize: 12 }} data-testid="cm-manager-only">{L("إرجاعها للمدير فقط، بعد ما يتأكد إن العميل طلبها.", "Only a manager can switch them back on.")}</span> : null}
          {m.history.length ? (
            <details style={{ marginTop: 4 }} data-testid="cm-history">
              <summary className="acc-muted" style={{ fontSize: 12, cursor: "pointer" }}>{L("السجل", "History")}</summary>
              <ul style={{ margin: "4px 0 0", paddingInlineStart: 16, fontSize: 12 }}>{m.history.map((h, i) => <li key={i}><bdi>{h}</bdi></li>)}</ul>
            </details>
          ) : null}
        </dd>
        <dt>{L("يستقبل واتساب", "Receives WhatsApp")}</dt>
        <dd>{m.whatsappOptOut ? L("لا", "No") : L("نعم", "Yes")}</dd>
        <dt>{L("آخر رسالة انرسلت له", "Last message sent")}</dt>
        <dd data-testid="cm-last">
          {m.last ? (
            <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
              {m.last.channel === "email" ? <Mail size={15} strokeWidth={1.6} aria-label={L("إيميل", "E-mail")} /> : <MessageCircle size={15} strokeWidth={1.6} aria-label={L("واتساب", "WhatsApp")} />}
              <bdi className="n">{lastText}</bdi>
              {m.last.status === "DELIVERED" ? L(" · وصل", " · delivered") : m.last.status === "BOUNCED" ? L(" · ارتدّ", " · bounced") : ""}
            </span>
          ) : <span className="acc-muted">{L("ما انرسل له شي بعد", "Nothing sent yet")}</span>}
        </dd>
      </dl>
      {reopen ? (
        <div role="dialog" aria-modal="true" aria-labelledby="cm-reopen-t" className="hr-notice tone-warning" style={{ marginTop: 10 }} data-testid="cm-reopen">
          <strong id="cm-reopen-t" style={{ display: "block" }}>{L("العميل أوقفها بنفسه — تأكد إنه طلب يرجعها", "The customer stopped e-mails themselves — make sure they asked to restart them")}</strong>
          <label style={{ display: "block", marginTop: 6 }}>
            <span style={{ fontSize: 12.5 }}>{L("السبب (إلزامي)", "Reason (required)")}</span>
            <textarea ref={reasonRef} className="hr-textarea" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} data-testid="cm-reopen-reason" placeholder={L("مثلًا: طلبها العميل باتصال يوم 2/11", "e.g. the customer asked by phone on 2 Nov")} />
          </label>
          <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
            <button type="button" className="hr-btn is-primary is-sm" disabled={busy || reason.trim().length < 5} data-testid="cm-reopen-confirm"
              onClick={async () => { if (await put({ emailOptOut: false, reason }, L("رجعت الإيميلات لهذا العميل، وانحفظ السبب.", "E-mails switched back on; the reason was saved."))) setReopen(false); }}>{L("رجّعها", "Switch back on")}</button>
            <button type="button" className="hr-btn is-sm" onClick={() => setReopen(false)}>{L("إلغاء", "Cancel")}</button>
          </div>
        </div>
      ) : null}
      {err ? <p role="alert" className="acc-muted" style={{ color: "var(--status-danger, #b42318)", margin: "6px 0 0" }} data-testid="cm-error">{err}</p> : null}
    </section>
  );
}
