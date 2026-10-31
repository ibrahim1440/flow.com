"use client";

import { useEffect, useState } from "react";
import { Mail, MessageCircle } from "lucide-react";

/**
 * «الرسائل المرسلة» (batch 25; council seat 5: «أبي في صفحة الطلب نفسه سطر: أُرسل إيميل للعميل 10:42 ✓ وصل»): the
 * automated messages about this order or quotation, one short line each — channel, when, plain status. Nothing is
 * drawn when there is none, or when the viewer may not read them (GET /api/automation/sent decides).
 */
type Row = { id: string; channel: "whatsapp" | "email"; status: string; statusNote: string | null; recipientKind: string; sentAt: string | null; deliveredAt: string | null; createdAt: string; attachmentKind: string | null; planMode: string | null };

/** dd/mm HH:mm, Riyadh, 24-hour, Latin digits — no ص/م marker and no bidi marks, so the LTR run cannot be reordered
 * inside Arabic text (fix round 2: «‎/10 12:48 م31»). */
export function shortWhen(value: string | Date): string {
  const p = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Riyadh", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(typeof value === "string" ? new Date(value) : value);
  const g = (t: string) => p.find((x) => x.type === t)?.value ?? "";
  return `${g("day")}/${g("month")} ${g("hour")}:${g("minute")}`;
}
const STATUS: Record<string, [string, string]> = {
  QUEUED: ["ينتظر الإرسال", "queued"], SENDING: ["ينرسل", "sending"], SENT: ["انرسل", "sent"], DELIVERED: ["وصل", "delivered"],
  BOUNCED: ["ارتدّ", "bounced"], COMPLAINED: ["بلّغ عنه كسبام", "marked as spam"], FAILED: ["فشل", "failed"], SKIPPED: ["ما انرسل", "not sent"],
};
const WHO: Record<string, [string, string]> = { customer: ["للعميل", "to the customer"], test: ["تجربة", "test"] };

function why(note: string | null, ar: boolean): string {
  if (!note) return "";
  if (/^No e-mail address|^The e-mail address on record is not valid/.test(note)) return ar ? ": ما له إيميل" : ": no e-mail";
  if (/^This customer asked not to receive/.test(note)) return ar ? ": موقوف بطلب العميل" : ": stopped by the customer";
  if (/turned off|not enabled on this deployment|needs a test e-mail/.test(note)) return ar ? ": الإرسال متوقف" : ": sending is off";
  return "";
}

type QuoteInfo = { status: string | null; rule: { email: boolean; whatsapp: boolean }; emailMode: "OFF" | "TEST" | "LIVE"; canSendEmail: boolean };
type Sent = { rows: Row[]; quote?: QuoteInfo };

const WARN = { color: "var(--warning-text, #8a5a00)" } as const;

function useSent(subjectType: "Order" | "Quote", subjectId: string, reloadKey = 0, poll = 0) {
  const [data, setData] = useState<Sent | null>(null);
  useEffect(() => {
    let cancelled = false;
    let n = 0;
    let timer = 0;
    const tick = () => {
      fetch(`/api/automation/sent?subjectType=${subjectType}&subjectId=${encodeURIComponent(subjectId)}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((d: Sent | null) => {
          if (cancelled) return;
          setData(d ?? { rows: [] });
          // Right after an action the dispatcher runs after the response: look again a few times.
          if (poll && (d?.rows ?? []).every((r) => r.recipientKind !== "customer" || ["QUEUED", "SENDING"].includes(r.status)) && ++n < poll) timer = window.setTimeout(tick, 1500);
        })
        .catch(() => { if (!cancelled) setData({ rows: [] }); });
    };
    timer = window.setTimeout(tick, poll ? 800 : 0);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [subjectType, subjectId, reloadKey, poll]);
  return data;
}

/** Why the quotation's customer got no e-mail (fix round 2: the RIGHT reason — the rule's e-mail, the e-mail mode, or the row's note). */
function quoteEmailGap(d: Sent, ar: boolean): { reason: string; ruleOff: boolean; canSend: boolean } | null {
  const q = d.quote;
  if (!q || (q.status !== "ISSUED" && q.status !== "ACCEPTED")) return null;
  const emails = d.rows.filter((r) => r.channel === "email" && r.recipientKind === "customer");
  const latest = emails[0];
  if (latest && ["QUEUED", "SENDING", "SENT", "DELIVERED"].includes(latest.status)) return null;
  if (latest && ["BOUNCED", "COMPLAINED"].includes(latest.status)) return null;
  let reason: string;
  if (!q.rule.email) reason = ar ? "«إيميل للعميل» مو مفعّل في رسالة «صدر» لعروض الأسعار" : "the «Issued» message has no e-mail switched on";
  else if (q.emailMode === "OFF") reason = ar ? "إرسال الإيميل متوقف من «إعدادات الإرسال»" : "e-mail sending is off";
  else if (latest?.status === "FAILED") reason = ar ? "فشل الإرسال" : "the send failed";
  else if (latest) reason = (why(latest.statusNote, ar) || (ar ? ": ما انرسل" : ": not sent")).replace(/^: /, "");
  else reason = ar ? "ما انرسل له إيميل" : "no e-mail was sent";
  const blockedByCustomer = !!latest && /^No e-mail address|^The e-mail address on record is not valid|^This customer asked not to receive|suppressed/i.test(latest.statusNote ?? "");
  return { reason, ruleOff: !q.rule.email, canSend: q.canSendEmail && q.rule.email && q.emailMode !== "OFF" && !blockedByCustomer };
}

function SendEmailNow({ quoteId, ar, onDone }: { quoteId: string; ar: boolean; onDone: (msg: string, ok: boolean) => void }) {
  const [busy, setBusy] = useState(false);
  return (
    // Self-contained styling: this line sits on the quotation page (sales UI) and the order desk (ops UI) alike.
    <button type="button" data-testid="send-email-now" disabled={busy} aria-busy={busy || undefined}
      style={{ display: "inline-flex", alignItems: "center", gap: 6, marginTop: 6, padding: "6px 12px", borderRadius: 10, border: "1px solid var(--border-strong, #cfc9bc)", background: "var(--bg-default, #fff)", color: "var(--text-primary, #1c1b19)", fontSize: 13, fontWeight: 600, cursor: busy ? "wait" : "pointer" }}
      onClick={async () => {
        setBusy(true);
        const r = await fetch("/api/automation/sent", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ subjectType: "Quote", subjectId: quoteId, action: "send_email" }) });
        const d = (await r.json().catch(() => ({}))) as { error?: string; planMode?: string };
        setBusy(false);
        if (r.ok) onDone(d.planMode === "TEST" ? (ar ? "انضاف للإرسال — في وضع التجربة يروح لإيميل التجربة فقط." : "Queued — in test mode it goes to the test address only.") : (ar ? "انضاف للإرسال للعميل." : "Queued for the customer."), true);
        else onDone(d.error ?? (ar ? "ما قدرنا نرسله." : "Could not send it."), false);
      }}>
      <Mail size={14} strokeWidth={1.6} aria-hidden />
      {busy ? (ar ? "يرسل…" : "Sending…") : ar ? "أرسل الإيميل الحين" : "E-mail it now"}
    </button>
  );
}

export function SentMessagesLine({ subjectType, subjectId, ar, reloadKey = 0, isAdmin = false }: { subjectType: "Order" | "Quote"; subjectId: string; ar: boolean; reloadKey?: number; isAdmin?: boolean }) {
  const [own, setOwn] = useState(0);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const data = useSent(subjectType, subjectId, reloadKey + own, own || reloadKey ? 5 : 0);
  if (!data) return null;
  const rows = data.rows;
  const gap = subjectType === "Quote" ? quoteEmailGap(data, ar) : null;
  if (rows.length === 0 && !gap && !msg) return null;
  return (
    <div data-testid="sent-messages" style={{ marginTop: 12 }}>
      <strong style={{ fontSize: 13.5 }}>{ar ? "الرسائل المرسلة" : "Messages sent"}</strong>
      {rows.length ? (
        <ul style={{ listStyle: "none", margin: "6px 0 0", padding: 0, display: "grid", gap: 4 }}>
          {rows.map((r) => {
            const at = r.deliveredAt ?? r.sentAt ?? r.createdAt;
            const s = STATUS[r.status] ?? [r.status, r.status];
            const who = WHO[r.recipientKind];
            return (
              <li key={`${r.channel}-${r.id}`} style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center", fontSize: 13, color: "var(--text-secondary, #4a473d)" }} data-testid={`sent-${r.channel}-${r.status}`}>
                {r.channel === "email" ? <Mail size={14} strokeWidth={1.6} aria-label={ar ? "إيميل" : "E-mail"} /> : <MessageCircle size={14} strokeWidth={1.6} aria-label={ar ? "واتساب" : "WhatsApp"} />}
                <span>{r.channel === "email" ? (ar ? "إيميل" : "E-mail") : ar ? "واتساب" : "WhatsApp"}{who ? ` ${ar ? who[0] : who[1]}` : ""}</span>
                <bdi dir="ltr" className="n" data-testid="sent-when" style={{ unicodeBidi: "isolate" }}>{shortWhen(at)}</bdi>
                <span>· {ar ? s[0] : s[1]}{why(r.statusNote, ar)}{r.planMode === "TEST" ? (ar ? " (تجربة)" : " (test)") : ""}{r.attachmentKind === "quote_pdf" ? (ar ? " · مع PDF" : " · with PDF") : ""}</span>
              </li>
            );
          })}
        </ul>
      ) : null}
      {gap ? (
        // Persistent (fix round 2, council b25 seat 5 N3/N7): an issued quotation whose customer got no e-mail says so, why, and
        // — when the rule's e-mail is on — offers to send it now (the same path, never twice).
        <p data-testid="sent-email-gap" data-rule-off={gap.ruleOff ? "1" : "0"} style={{ margin: "6px 0 0", fontSize: 13, ...WARN }}>
          {ar ? `ما وصل العميل إيميل بهذا العرض — ${gap.reason}.` : `The customer got no e-mail of this quotation — ${gap.reason}.`}
          {gap.ruleOff ? (isAdmin
            ? <> <a href="/dashboard/automation/statuses?focus=quote:ISSUED" data-testid="sent-gap-link">{ar ? "فعّله من «إشعارات الحالات»" : "Switch it on"}</a></>
            : <> {ar ? "اطلب من المدير تفعيله من «إشعارات الحالات»." : "Ask an administrator to switch it on."}</>) : null}
          {gap.canSend ? <br /> : null}
          {gap.canSend ? <SendEmailNow quoteId={subjectId} ar={ar} onDone={(text, ok) => { setMsg({ text, ok }); setOwn((n) => n + 1); }} /> : null}
        </p>
      ) : null}
      {msg ? <p data-testid="send-email-now-result" style={{ margin: "4px 0 0", fontSize: 13, ...(msg.ok ? {} : WARN) }}>{msg.text}</p> : null}
    </div>
  );
}

/**
 * «وش صار بعد الإصدار؟» (fix round 1, council b25 #12; fix round 2: the right reason, a warning tone when nothing went,
 * and the outcome stays on the page in «الرسائل المرسلة»). Right after a quotation is issued, says what reached the customer.
 */
export function IssueOutcome({ quoteId, ar, isAdmin }: { quoteId: string; ar: boolean; isAdmin: boolean }) {
  const data = useSent("Quote", quoteId, 0, 5);
  if (!data) return <span className="acc-muted" data-testid="issue-outcome" data-state="checking" style={{ display: "block", margin: "6px 0 0", fontSize: 13 }}>{ar ? "نشيك وش انرسل للعميل…" : "Checking what reached the customer…"}</span>;
  const toCustomer = data.rows.filter((r) => r.recipientKind === "customer");
  const lines = toCustomer.map((r) => {
    const ch = r.channel === "email" ? (ar ? "إيميل" : "e-mail") : ar ? "واتساب" : "WhatsApp";
    const testTarget = r.channel === "email" ? (ar ? "لإيميل التجربة" : "to the test address") : ar ? "لرقم التجربة" : "to the test number";
    if (r.planMode === "TEST" && r.status !== "SKIPPED") return ar ? `${ch}: انرسل ${testTarget} فقط (وضع التجربة) — العميل ما وصله شي` : `${ch}: sent ${testTarget} only (test mode)`;
    if (["SENT", "DELIVERED"].includes(r.status)) return ar ? `انرسل ${ch} للعميل${r.attachmentKind === "quote_pdf" ? " مع ملف العرض" : ""}` : `${ch} sent to the customer`;
    if (["QUEUED", "SENDING"].includes(r.status)) return ar ? `${ch} للعميل ينتظر الإرسال` : `${ch} to the customer is waiting`;
    return ar ? `ما انرسل ${ch}${why(r.statusNote, ar) || ""}` : `${ch} not sent${why(r.statusNote, ar)}`;
  });
  const q = data.quote;
  if (lines.length === 0) {
    const ruleOff = !q || (!q.rule.email && !q.rule.whatsapp);
    const reason = ruleOff
      ? (ar ? "رسالة «صدر» لعروض الأسعار مو مفعّلة" : "the «Issued» message is not switched on")
      : q.rule.email && q.emailMode === "OFF" && !q.rule.whatsapp
        ? (ar ? "إرسال الإيميل متوقف من «إعدادات الإرسال»" : "e-mail sending is off")
        : (ar ? "لسا ما انعالجت — تظهر النتيجة تحت في «الرسائل المرسلة»" : "not processed yet — the result appears under «Messages sent»");
    return (
      <span data-testid="issue-outcome" data-state="nothing" style={{ display: "block", margin: "6px 0 0", fontSize: 13, ...WARN }}>
        {ar ? `ما انرسل شيء للعميل — ${reason}. ` : `Nothing was sent to the customer — ${reason}. `}
        {ruleOff ? (isAdmin
          ? <a href="/dashboard/automation/statuses?focus=quote:ISSUED" data-testid="issue-outcome-link">{ar ? "فعّلها من «إشعارات الحالات»" : "Switch it on in «Status notifications»"}</a>
          : (ar ? "اطلب من المدير تفعيلها من «إشعارات الحالات»." : "Ask an administrator to switch it on.")) : null}
      </span>
    );
  }
  const anyMissed = toCustomer.some((r) => !["SENT", "DELIVERED", "QUEUED", "SENDING"].includes(r.status) || r.planMode === "TEST");
  return <span data-testid="issue-outcome" data-state="sent" style={{ display: "block", margin: "6px 0 0", fontSize: 13, ...(anyMissed ? WARN : {}) }} className={anyMissed ? undefined : "acc-muted"}>{lines.join(" · ")}</span>;
}
