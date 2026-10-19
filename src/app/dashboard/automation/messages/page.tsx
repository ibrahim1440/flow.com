"use client";

import { useEffect, useState } from "react";
import { Btn, Empty, OpsBanner, OpsLoading, OpsRoot } from "@/components/ops/ui";
import { useD21Phone } from "@/components/shell/page-context";
import { api, useLang } from "../../sales/_components/ui";
import { getEvent, RECIPIENT_LABELS, type RecipientKind } from "@/lib/automation/catalog";
import { AutomationHeader, MESSAGE_STATUS, MessageStatusBadge, Note, Phone, noteText, useAutomationAbilities, when, whenParts } from "../_components/shared";
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

type Report = { eventsProcessed: number; messagesQueued: number; sent: number; sendFailures: number; sendingPaused: string | null };

export default function AutomationMessagesPage() {
  const lang = useLang();
  const ar = lang === "ar";
  const { canManageMessages } = useAutomationAbilities();

  const [status, setStatus] = useState("");
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<{ rows: Row[]; total: number; perPage: number; counts: Record<string, number> } | null>(null);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);
  const reload = () => setReloadToken((t) => t + 1);

  useD21Phone({ title: ar ? "سجل الرسائل" : "Message log", sub: ar ? "الأتمتة والواتساب" : "Automation & WhatsApp" });

  useEffect(() => {
    let cancelled = false;
    const params = new URLSearchParams({ page: String(page) });
    if (status) params.set("status", status);
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
  }, [status, q, page, ar, reloadToken]);

  async function act(id: string, action: "retry" | "cancel") {
    const r = await api(`/api/automation/messages/${id}`, { method: "POST", body: { action } });
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
        ? `عولج ${d.eventsProcessed} حدث، وأضيفت ${d.messagesQueued} رسالة، وأرسلت ${d.sent}`
        : `${d.eventsProcessed} events processed, ${d.messagesQueued} queued, ${d.sent} sent`) +
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

        <div className="tl-tool">
          <input
            type="search"
            className="hr-input hr-search"
            value={q}
            onChange={(e) => { setQ(e.target.value); setPage(1); }}
            placeholder={L("ابحث باسم أو رقم أو قاعدة", "Search a name, number or rule")}
            aria-label={L("بحث", "Search")}
            data-testid="msg-search"
          />
          <div className="tl-seg" role="group" aria-label={L("الحالة", "Status")} data-testid="msg-status">
            <button type="button" aria-pressed={status === ""} onClick={() => { setStatus(""); setPage(1); }}>{L("الكل", "All")}</button>
            {Object.entries(MESSAGE_STATUS).map(([k, s]) => (
              <button key={k} type="button" aria-pressed={status === k} onClick={() => { setStatus(k); setPage(1); }} data-testid={`msg-status-${k}`}>
                {ar ? s.ar : s.en}
                {data?.counts[k] ? <span className="hr-count">{data.counts[k]}</span> : null}
              </button>
            ))}
          </div>
          <span className="tl-sp" />
          {canManageMessages ? (
            <Btn onClick={runNow} disabled={busy} busy={busy} data-testid="run-dispatch">{L("معالجة الآن", "Process now")}</Btn>
          ) : null}
        </div>

        {!data && !error ? <OpsLoading /> : data && data.rows.length === 0 ? (
          <Empty title={L("لا توجد رسائل.", "No messages.")} body={status || q ? L("لا رسالة تطابق البحث أو الحالة.", "No message matches the search or status.") : undefined} />
        ) : data ? (
          <div className="hr-tablewrap">
            <table className="hr-table is-mrow" aria-label={L("سجل الرسائل", "Message log")} data-testid="messages-table">
              <thead>
                <tr>
                  <th style={{ width: 100 }}>{L("الوقت", "Time")}</th>
                  <th style={{ minWidth: 170 }}>{L("القاعدة", "Rule")}</th>
                  <th style={{ minWidth: 150 }}>{L("المستلم", "Recipient")}</th>
                  <th className="hr-hide-compact" style={{ minWidth: 220 }}>{L("الرسالة", "Message")}</th>
                  <th style={{ width: 170, minWidth: 150 }}>{L("الحالة", "Status")}</th>
                  {canManageMessages ? <th style={{ width: 1 }}><span className="hr-sr">{L("إجراء", "Action")}</span></th> : null}
                </tr>
              </thead>
              <tbody>
                {data.rows.map((m) => {
                  const ev = m.eventType ? getEvent(m.eventType) : null;
                  const kind = RECIPIENT_LABELS[m.recipientKind as RecipientKind];
                  const open = expanded === m.id;
                  // Sent: when it went. Waiting: when it is due. Anything else: when it was decided.
                  const at = m.status === "SENT" ? m.sentAt : m.status === "QUEUED" ? m.scheduledAt : m.createdAt;
                  const [day, time] = whenParts(at);
                  const ruleName = m.recipientKind === "test" ? L("رسالة تجريبية", "Test message") : m.ruleName ?? "—";
                  const who = m.recipientName || (kind ? (ar ? kind.ar : kind.en) : m.recipientKind);
                  return (
                    <tr key={m.id} data-testid={`msg-${m.id}`} className={m.status === "FAILED" ? "tl-hl" : undefined}>
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
                        <span className="hr-mobile-only" style={{ fontWeight: 600 }}>{who}</span>
                        <span className="hr-msub">{ruleName} · <span className="hr-num">{day.slice(0, 5)} {time}</span></span>
                      </td>
                      <td>
                        <span style={{ display: "block", fontWeight: 500 }}>{who}</span>
                        <span className="stk-sub hr-num">
                          {m.phone ? <Phone value={m.phone} /> : "—"}
                          {m.intendedPhone && (
                            <>
                              {" "}
                              {L("بدلا من", "instead of")} <Phone value={m.intendedPhone} />
                            </>
                          )}
                        </span>
                      </td>
                      <td className="hr-hide-compact">
                        <button type="button" onClick={() => setExpanded(open ? null : m.id)} className="tl-body-btn" dir="auto" aria-expanded={open}>
                          <span className={open ? "" : "tl-clamp"} style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", fontSize: 13.5 }}>{m.body}</span>
                        </button>
                      </td>
                      <td className="m-end is-stack">
                        <MessageStatusBadge status={m.status} lang={lang} testId={`msg-status-${m.id}`} />
                        <Note note={m.statusNote} lang={lang} className="stk-sub hr-desktop-only" />
                        {canManageMessages && ((m.status === "FAILED" && m.phone) || m.status === "QUEUED") ? (
                          <span className="hr-mobile-only">
                            {m.status === "FAILED" ? <Btn size="sm" onClick={() => act(m.id, "retry")}>{L("إعادة", "Retry")}</Btn> : <Btn size="sm" onClick={() => act(m.id, "cancel")}>{L("إلغاء", "Cancel")}</Btn>}
                          </span>
                        ) : null}
                      </td>
                      {canManageMessages ? (
                        <td style={{ textAlign: "end" }}>
                          {m.status === "FAILED" && m.phone && (
                            <Btn size="sm" onClick={() => act(m.id, "retry")} data-testid={`retry-${m.id}`}>{L("إعادة", "Retry")}</Btn>
                          )}
                          {m.status === "QUEUED" && (
                            <Btn size="sm" onClick={() => act(m.id, "cancel")} data-testid={`cancel-${m.id}`}>{L("إلغاء", "Cancel")}</Btn>
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
            {L(`الأحدث أولًا · ${data.perPage} لكل صفحة · صفحة ${page} من ${pages} · لا تُجمع إيصالات التسليم أو القراءة`, `Newest first · ${data.perPage} per page · page ${page} of ${pages} · delivery and read receipts are not collected`)}
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
