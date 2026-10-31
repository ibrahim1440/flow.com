"use client";

import { useEffect, useState } from "react";
import { Btn, Empty, OpsBanner, OpsLoading, OpsRoot } from "@/components/ops/ui";
import { useD21Phone } from "@/components/shell/page-context";
import { api, useLang } from "../../sales/_components/ui";
import { getEvent, RECIPIENT_LABELS, type RecipientKind } from "@/lib/automation/catalog";
import { STATUS_RECIPIENT_LABELS, type StatusRecipient } from "@/lib/automation/status-rules/sources";
import { AutomationHeader, ChannelIcon, MESSAGE_STATUS, MessageStatusBadge, Note, Phone, noteText, useAutomationAbilities, when, whenParts } from "../_components/shared";
import { SettingsFrame } from "../../_components/tools-ui";

/**
 * Every WhatsApp message the system produced: sent, waiting, failed, or deliberately not sent
 * and why. "Not sent" is shown, not hidden — a rule that skips every customer because none
 * has a phone number is a problem somebody should see.
 *
 * Direction 2.1 (UI batch 2; GX E-P03, Figma 1228:101517 at 1440, EN 1230:134545, 1024
 * 1228:104573, phone 1429:8620). Visual port only: the same list request (page, status, q), the
 * same retry / cancel actions and the same «process now» dispatch, behind the same gates.
 */

type Row = {
  id: string;
  /** Batch 25: every row names its channel. */
  channel: "whatsapp" | "email";
  subject: string | null;
  address: string | null;
  intended: string | null;
  attachmentKind: string | null;
  deliveredAt: string | null;
  bodyArchivedAt: string | null;
  ruleId: string | null;
  ruleName: string | null;
  eventType: string | null;
  recipientKind: string;
  recipientName: string | null;
  phone: string | null;
  intendedPhone: string | null;
  body: string;
  status: string;
  statusNote: string | null;
  scheduledAt: string;
  attempts: number;
  sentAt: string | null;
  createdAt: string;
};

type Report = { eventsProcessed: number; messagesQueued: number; sent: number; sendFailures: number; sendingPaused: string | null; emailsQueued?: number; emailsSent?: number };

export default function AutomationMessagesPage() {
  const lang = useLang();
  const ar = lang === "ar";
  const { canManageMessages } = useAutomationAbilities();

  const [status, setStatus] = useState("");
  const [channel, setChannel] = useState("");
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<{ rows: Row[]; total: number; perPage: number; counts: Record<string, number> } | null>(null);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);
  const reload = () => setReloadToken((t) => t + 1);

  useD21Phone({ title: ar ? "سجل الرسائل" : "Message log", sub: ar ? "رسائل العملاء التلقائية" : "Automated customer messages" });

  useEffect(() => {
    let cancelled = false;
    const params = new URLSearchParams({ page: String(page) });
    if (status) params.set("status", status);
    if (channel) params.set("channel", channel);
    if (q.trim()) params.set("q", q.trim());
    const timer = setTimeout(async () => {
      const r = await api<{ rows: Row[]; total: number; perPage: number; counts: Record<string, number> }>(`/api/automation/messages?${params}`);
      if (cancelled) return;
      if (r.ok) setData(r.data);
      else setError(r.data.error ?? (ar ? "تعذر تحميل السجل." : "Could not load the log."));
    }, q ? 300 : 0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [status, channel, q, page, ar, reloadToken]);

  async function act(id: string, action: "retry" | "cancel", ch: "whatsapp" | "email" = "whatsapp") {
    const r = await api(`/api/automation/messages/${id}`, { method: "POST", body: { action, channel: ch } });
    if (!r.ok) setError(r.data.error ?? "");
    reload();
  }

  async function runNow() {
    setBusy(true);
    const r = await api<Report>("/api/automation/dispatch", { method: "POST" });
    setBusy(false);
    if (!r.ok) return setError(r.data.error ?? "");
    const d = r.data;
    setInfo(
      (ar
        ? `عولج ${d.eventsProcessed} حدث، وأضيفت ${d.messagesQueued + (d.emailsQueued ?? 0)} رسالة، وانرسل ${d.sent} واتساب و${d.emailsSent ?? 0} إيميل`
        : `${d.eventsProcessed} events processed, ${d.messagesQueued + (d.emailsQueued ?? 0)} queued, ${d.sent} WhatsApp and ${d.emailsSent ?? 0} e-mails sent`) +
        (d.sendFailures ? (ar ? `، وفشلت ${d.sendFailures}` : `, ${d.sendFailures} failed`) : "") +
        (d.sendingPaused ? ` — ${noteText(d.sendingPaused, lang)}` : "."),
    );
    reload();
  }

  const pages = data ? Math.max(1, Math.ceil(data.total / data.perPage)) : 1;
  const L = (a: string, e: string) => (ar ? a : e);

  return (
    <OpsRoot className="tl-root">
      <SettingsFrame>
        <AutomationHeader lang={lang} />

        {error && <OpsBanner tone="danger" onClose={() => setError("")}>{error}</OpsBanner>}
        {info && <OpsBanner tone="info" onClose={() => setInfo("")}>{info}</OpsBanner>}

        <div className="tl-tool tl-msgtool">
          <input
            type="search"
            className="hr-input hr-search"
            value={q}
            onChange={(e) => { setQ(e.target.value); setPage(1); }}
            placeholder={L("ابحث باسم أو رقم أو قاعدة", "Search a name, number or rule")}
            aria-label={L("بحث", "Search")}
            data-testid="msg-search"
          />
          <div className="tl-seg" role="group" aria-label={L("القناة", "Channel")} data-testid="msg-channel">
            {([["", L("الكل", "All")], ["whatsapp", L("واتساب", "WhatsApp")], ["email", L("إيميل", "E-mail")]] as const).map(([k, label]) => (
              <button key={k || "all"} type="button" aria-pressed={channel === k} onClick={() => { setChannel(k); setPage(1); }} data-testid={`msg-channel-${k || "all"}`}>{label}</button>
            ))}
          </div>
          <div className="tl-seg" role="group" aria-label={L("الحالة", "Status")} data-testid="msg-status">
            <button type="button" aria-pressed={status === ""} onClick={() => { setStatus(""); setPage(1); }}>{L("الكل", "All")}</button>
            {/* GX E-04 / E-04e: five statuses, each with its count (0 included); «يرسل الآن» is a
                moment, not a filter — those rows are under «الكل». */}
            {Object.entries(MESSAGE_STATUS).filter(([k]) => k !== "SENDING" && k !== "COMPLAINED").map(([k, s]) => (
              <button key={k} type="button" aria-pressed={status === k} onClick={() => { setStatus(k); setPage(1); }} data-testid={`msg-status-${k}`}>
                {ar ? s.ar : s.en}
                {data ? <span className="hr-count">{data.counts[k] ?? 0}</span> : null}
              </button>
            ))}
          </div>
          <span className="tl-sp" />
          {canManageMessages ? (
            <Btn onClick={runNow} disabled={busy} busy={busy} data-testid="run-dispatch">{L("أرسل المنتظر الحين", "Send what is waiting now")}</Btn>
          ) : null}
        </div>

        {!data && !error ? <OpsLoading /> : data && data.rows.length === 0 ? (
          <div className="tl-empty">
            <Empty
              title={L("لا توجد رسائل", "No messages")}
              body={status || q
                ? L("لا رسالة تطابق البحث أو الحالة.", "No message matches the search or status.")
                : L("تظهر هنا كل رسالة تنشئها القواعد: ما أُرسل، وما ينتظر، وما فشل أو لم يُرسل ولماذا.", "Every message the rules create appears here: what was sent, what is waiting, and what failed or was not sent, and why.")}
            />
          </div>
        ) : data ? (
          <div className="hr-tablewrap">
            <table className="hr-table is-mrow" aria-label={L("سجل الرسائل", "Message log")} data-testid="messages-table" style={{ tableLayout: "fixed", width: "100%" }}>
              <thead>
                <tr>
                  <th style={{ width: 36 }}><span className="hr-sr">{L("القناة", "Channel")}</span></th>
                  <th style={{ width: 92 }}>{L("الوقت", "Time")}</th>
                  <th style={{ width: "17%" }}>{L("القاعدة", "Rule")}</th>
                  <th style={{ width: "21%" }}>{L("المستلم", "Recipient")}</th>
                  <th className="hr-hide-compact">{L("الرسالة", "Message")}</th>
                  <th style={{ width: 150 }} data-testid="messages-status-head">{L("الحالة", "Status")}</th>
                  {canManageMessages ? <th style={{ width: 76 }}><span className="hr-sr">{L("إجراء", "Action")}</span></th> : null}
                </tr>
              </thead>
              <tbody>
                {data.rows.map((m) => {
                  const ev = m.eventType ? getEvent(m.eventType) : null;
                  const kind = RECIPIENT_LABELS[m.recipientKind as RecipientKind] ?? STATUS_RECIPIENT_LABELS[m.recipientKind as StatusRecipient];
                  const open = expanded === m.id;
                  // Sent: when it went. Waiting: when it is due. Anything else: when it was decided.
                  const at = m.status === "DELIVERED" ? m.deliveredAt ?? m.sentAt : m.status === "SENT" ? m.sentAt : m.status === "QUEUED" ? m.scheduledAt : m.createdAt;
                  const email = m.channel === "email";
                  const [day, time] = whenParts(at);
                  const ruleName = m.recipientKind === "test" ? (email ? L("رسالة تجربة (إيميل)", "Test e-mail") : L("اختبار الاتصال", "Connection check")) : m.ruleName ?? "—";
                  const who = m.recipientName || (kind ? (ar ? kind.ar : kind.en) : m.recipientKind);
                  return (
                    <tr key={`${m.channel}-${m.id}`} data-testid={`msg-${m.id}`} data-channel={m.channel} className={m.status === "FAILED" || m.status === "BOUNCED" ? "tl-hl" : undefined} style={{ overflowWrap: "anywhere" }}>
                      <td><ChannelIcon channel={m.channel} lang={lang} /></td>
                      <td title={when(at, lang)} style={{ whiteSpace: "nowrap" }}>
                        <span className="hr-num" style={{ display: "block", fontWeight: 500 }}>{day}</span>
                        <span className="hr-num stk-sub">{time}</span>
                        {m.status === "QUEUED" && new Date(m.scheduledAt) > new Date() && (
                          <span className="stk-sub">{L("مجدولة", "scheduled")}</span>
                        )}
                        {m.attempts > 1 && <span className="stk-sub">{ar ? `${m.attempts} محاولات` : `${m.attempts} attempts`}</span>}
                      </td>
                      <td className="m-title">
                        <span className="hr-desktop-only" style={{ display: "block", fontWeight: 500 }}>{ruleName}</span>
                        {ev && <span className="stk-sub hr-desktop-only">{ar ? ev.ar : ev.en}</span>}
                        <span className="hr-mobile-only" style={{ fontWeight: 600 }}><span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}><ChannelIcon channel={m.channel} lang={lang} />{who}</span></span>
                        <span className="hr-msub">{ruleName} · <span className="hr-num">{day.slice(0, 5)} {time}</span></span>
                      </td>
                      <td>
                        <span style={{ display: "block", fontWeight: 500 }}>{who}</span>
                        <span className="stk-sub hr-num">
                          {email ? (m.address ? <bdi dir="ltr" style={{ overflowWrap: "anywhere" }}>{m.address}</bdi> : "—") : m.phone ? <Phone value={m.phone} /> : "—"}
                          {email && m.intended ? <>{" "}{L("بدلًا من", "instead of")} <bdi dir="ltr">{m.intended}</bdi></> : null}
                          {!email && m.intendedPhone && (
                            <>
                              {" "}
                              {L("بدلا من", "instead of")} <Phone value={m.intendedPhone} />
                            </>
                          )}
                        </span>
                      </td>
                      <td className="hr-hide-compact">
                        <button type="button" onClick={() => setExpanded(open ? null : m.id)} className="tl-body-btn" dir="auto" aria-expanded={open}>
                          {email && m.subject ? <span style={{ display: "block", fontWeight: 600, fontSize: 13.5 }}>{m.subject}{m.attachmentKind === "quote_pdf" ? L(" · مرفق عرض السعر PDF", " · quotation PDF attached") : ""}</span> : null}
                          <span className={open ? "" : "tl-clamp"} style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", fontSize: 13.5 }}>{m.bodyArchivedAt ? L("انتقل نص الرسالة للأرشيف (أقدم من 180 يوم).", "The text moved to the archive (older than 180 days).") : m.body}</span>
                        </button>
                      </td>
                      <td className="m-end is-stack">
                        <MessageStatusBadge status={m.status} note={m.statusNote} lang={lang} testId={`msg-status-${m.id}`} />
                        <Note note={m.statusNote} lang={lang} className="stk-sub hr-desktop-only" />
                        {canManageMessages && ((m.status === "FAILED" && (m.phone || email)) || m.status === "QUEUED") ? (
                          <span className="hr-mobile-only">
                            {m.status === "FAILED" ? <Btn size="sm" onClick={() => act(m.id, "retry", m.channel)}>{L("إعادة", "Retry")}</Btn> : <Btn size="sm" onClick={() => act(m.id, "cancel", m.channel)}>{L("إلغاء", "Cancel")}</Btn>}
                          </span>
                        ) : null}
                      </td>
                      {canManageMessages ? (
                        <td style={{ textAlign: "end" }}>
                          {m.status === "FAILED" && (m.phone || email) && (
                            <Btn size="sm" onClick={() => act(m.id, "retry", m.channel)} data-testid={`retry-${m.id}`}>{L("إعادة", "Retry")}</Btn>
                          )}
                          {m.status === "QUEUED" && (
                            <Btn size="sm" onClick={() => act(m.id, "cancel", m.channel)} data-testid={`cancel-${m.id}`}>{L("إلغاء", "Cancel")}</Btn>
                          )}
                        </td>
                      ) : null}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : null}

        {data ? (
          <p className="tl-foot">
            {L(`الأحدث أولًا · ${data.perPage} لكل صفحة · صفحة ${page} من ${pages} · «وصل» و«ارتدّ» للإيميل فقط (الواتساب ما يرجّع إيصال)`, `Newest first · ${data.perPage} per page · page ${page} of ${pages} · «delivered» and «bounced» are known for e-mail only`)}
          </p>
        ) : null}
        {pages > 1 && (
          <div className="tl-pager">
            <Btn size="sm" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1}>{L("السابق", "Previous")}</Btn>
            <span>{ar ? `صفحة ${page} من ${pages}` : `Page ${page} of ${pages}`}</span>
            <Btn size="sm" onClick={() => setPage((p) => Math.min(pages, p + 1))} disabled={page >= pages}>{L("التالي", "Next")}</Btn>
          </div>
        )}
      </SettingsFrame>
    </OpsRoot>
  );
}
