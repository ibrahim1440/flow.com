"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Mail, MessageCircle } from "lucide-react";
import { api } from "../../../sales/_components/ui";
import { useUser } from "../../../user-context";

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

const SOURCE_AR: Record<string, string> = { customer_link: "أوقفها العميل من رابط الإيميل", staff: "أوقفها موظف", complaint: "بلّغ عن إيميل كسبام", bounce: "الإيميل ارتدّ" };

export function MessagingCard({ customerId, ar, onSaved }: { customerId: string; ar: boolean; onSaved?: (text: string) => void }) {
  const L = (a: string, e: string) => (ar ? a : e);
  const isAdmin = useUser()?.role === "admin";
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
    // dd/mm/yyyy HH:mm (24-hour, no ص/م, no bidi marks) — shown in an LTR <bdi> (batch 25b, as in «الرسائل المرسلة»).
    ? (() => {
        const p = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Riyadh", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(m.last.at));
        const g = (t: string) => p.find((x) => x.type === t)?.value ?? "";
        return `${g("day")}/${g("month")}/${g("year")} ${g("hour")}:${g("minute")}`;
      })()
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
              <bdi dir="ltr" className="n" data-testid="cm-last-when" style={{ unicodeBidi: "isolate" }}>{lastText}</bdi>
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
      {isAdmin ? <ArchiveAdmin customerId={customerId} L={L} /> : null}
    </section>
  );
}

/**
 * «الأرشيف القانوني» (batch 25b, the administrator only): the customer's legal hold, and «حذف رسائل العميل من الأرشيف» — the
 * data-subject erasure (reason required; refused under a legal hold). Read only when opened: every call steps up.
 */
function ArchiveAdmin({ customerId, L }: { customerId: string; L: (a: string, e: string) => string }) {
  const [info, setInfo] = useState<{ legalHold: boolean; archived: number } | null>(null);
  const [reason, setReason] = useState("");
  const [confirmErase, setConfirmErase] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const url = `/api/customers/${encodeURIComponent(customerId)}/message-archive`;
  const load = async () => {
    const r = await api<{ legalHold: boolean; archived: number }>(url);
    if (r.ok) setInfo(r.data); else setMsg({ ok: false, text: r.data.error ?? L("تعذّر فتح الأرشيف.", "Could not open the archive.") });
  };
  async function send(method: "PUT" | "POST", body: Record<string, unknown>, done: (d: Record<string, unknown>) => string) {
    setBusy(true); setMsg(null);
    const r = await api<Record<string, unknown>>(url, { method, body: { ...body, reason } });
    setBusy(false);
    if (!r.ok) return setMsg({ ok: false, text: r.data.error ?? L("ما انحفظ.", "Not saved.") });
    setMsg({ ok: true, text: done(r.data) }); setReason(""); setConfirmErase(false); await load();
  }
  return (
    <details style={{ marginTop: 14 }} data-testid="cm-archive-admin" onToggle={(e) => { if ((e.target as HTMLDetailsElement).open && !info) void load(); }}>
      <summary style={{ cursor: "pointer", fontSize: 13.5, fontWeight: 600 }}>{L("الأرشيف القانوني (مدير النظام)", "Legal archive (administrator)")}</summary>
      {info ? (
        <div style={{ display: "grid", gap: 8, marginTop: 8, fontSize: 13 }}>
          <p style={{ margin: 0 }} data-testid="cm-archive-count">{L(`رسائل هذا العميل في الأرشيف: ${info.archived}. تنحفظ 5 سنوات ثم تنحذف تلقائيًا.`, `Archived messages of this customer: ${info.archived}. Kept 5 years, then destroyed automatically.`)}</p>
          <p style={{ margin: 0 }} data-testid="cm-legal-hold" data-on={info.legalHold ? "1" : "0"}>
            {info.legalHold ? L("⚖ عليها حجز قانوني: ما تنحذف رسائله أبدًا (لا بعد 5 سنوات ولا بطلب حذف) لين ينشال الحجز.", "⚖ Under a legal hold: nothing is destroyed until the hold is lifted.") : L("ما عليها حجز قانوني.", "No legal hold.")}
          </p>
          <label>
            <span style={{ fontSize: 12.5 }}>{L("السبب (إلزامي)", "Reason (required)")}</span>
            <textarea className="hr-textarea" rows={2} value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} data-testid="cm-archive-reason" />
          </label>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button type="button" className="hr-btn is-sm" disabled={busy || reason.trim().length < 5} data-testid="cm-legal-hold-toggle"
              onClick={() => send("PUT", { legalHold: !info.legalHold }, () => (info.legalHold ? L("انشال الحجز القانوني.", "Legal hold lifted.") : L("انحط حجز قانوني.", "Legal hold set.")))}>
              {info.legalHold ? L("شيل الحجز القانوني", "Lift the legal hold") : L("حط حجز قانوني", "Set a legal hold")}
            </button>
            {!confirmErase ? (
              <button type="button" className="hr-btn is-danger is-sm" disabled={busy || info.legalHold || info.archived === 0} data-testid="cm-archive-erase" onClick={() => setConfirmErase(true)}>
                {L("حذف رسائل العميل من الأرشيف", "Erase this customer's archived messages")}
              </button>
            ) : (
              <span style={{ display: "inline-flex", gap: 8, alignItems: "center" }} data-testid="cm-archive-erase-confirm-row">
                <strong style={{ color: "var(--status-danger, #b42318)" }}>{L(`تنحذف ${info.archived} رسالة نهائيًا. متأكد؟`, `${info.archived} messages will be destroyed for good. Sure?`)}</strong>
                <button type="button" className="hr-btn is-danger is-sm" disabled={busy || reason.trim().length < 5} data-testid="cm-archive-erase-confirm"
                  onClick={() => send("POST", { action: "erase" }, (d) => L(`انحذفت ${String(d.erased ?? 0)} رسالة من الأرشيف، وانسجل السبب.`, `${String(d.erased ?? 0)} archived messages erased; the reason was recorded.`))}>{L("احذف", "Erase")}</button>
                <button type="button" className="hr-btn is-sm" onClick={() => setConfirmErase(false)}>{L("إلغاء", "Cancel")}</button>
              </span>
            )}
          </div>
        </div>
      ) : null}
      {msg ? <p role={msg.ok ? "status" : "alert"} style={{ margin: "6px 0 0", fontSize: 13, color: msg.ok ? "inherit" : "var(--status-danger, #b42318)" }} data-testid="cm-archive-msg">{msg.text}</p> : null}
    </details>
  );
}
