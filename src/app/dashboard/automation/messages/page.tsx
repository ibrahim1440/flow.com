"use client";

import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import {
  Alert, Button, Card, DataTable, EmptyState, FilterSelect, PageHeader, SearchField, Spinner, Td, Toolbar, Tr, ROW_ACTION, api, useLang,
} from "../../sales/_components/ui";
import { getEvent, RECIPIENT_LABELS, type RecipientKind } from "@/lib/automation/catalog";
import { MESSAGE_STATUS, MessageStatusBadge, Note, Phone, noteText, useAutomationAbilities, when } from "../_components/shared";

/**
 * Every WhatsApp message the system produced: sent, waiting, failed, or deliberately not sent
 * and why. "Not sent" is shown, not hidden — a rule that skips every customer because none
 * has a phone number is a problem somebody should see.
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

  if (!data && !error) return <Spinner />;
  const pages = data ? Math.max(1, Math.ceil(data.total / data.perPage)) : 1;

  return (
    <div className="space-y-[18px]">
      <PageHeader
        title={ar ? "سجل الرسائل" : "Message log"}
        subtitle={ar ? "كل رسالة أنشأتها القواعد: ما أرسل، وما ينتظر، وما فشل أو لم يرسل ولماذا." : "Every message the rules produced, and what happened to it."}
        actions={
          canManageMessages ? (
            <Button variant="secondary" onClick={runNow} disabled={busy} testId="run-dispatch">
              <RefreshCw size={15} aria-hidden className={busy ? "animate-spin" : ""} /> {ar ? "معالجة الآن" : "Process now"}
            </Button>
          ) : undefined
        }
      />

      {error && <Alert kind="error" onDismiss={() => setError("")}>{error}</Alert>}
      {info && <Alert kind="info" onDismiss={() => setInfo("")}>{info}</Alert>}

      <Toolbar>
        <SearchField value={q} onChange={(v) => { setQ(v); setPage(1); }} placeholder={ar ? "ابحث باسم أو رقم أو قاعدة" : "Search a name, number or rule"} label={ar ? "بحث" : "Search"} testId="msg-search" />
        <FilterSelect value={status} onChange={(v) => { setStatus(v); setPage(1); }} label={ar ? "الحالة" : "Status"} testId="msg-status">
          <option value="">{ar ? "كل الحالات" : "All statuses"}</option>
          {Object.entries(MESSAGE_STATUS).map(([k, s]) => (
            <option key={k} value={k}>
              {(ar ? s.ar : s.en) + (data?.counts[k] ? ` (${data.counts[k]})` : "")}
            </option>
          ))}
        </FilterSelect>
      </Toolbar>

      {data && data.rows.length === 0 ? (
        <Card>
          <EmptyState>{ar ? "لا توجد رسائل." : "No messages."}</EmptyState>
        </Card>
      ) : (
        data && (
          <DataTable
            testId="messages-table"
            minWidth={980}
            cols={[
              { label: ar ? "الوقت" : "Time", w: "w-[150px]" },
              { label: ar ? "القاعدة" : "Rule", w: "w-[190px]" },
              { label: ar ? "المستلم" : "Recipient", w: "w-[200px]" },
              { label: ar ? "الرسالة" : "Message", w: "min-w-[260px]" },
              { label: ar ? "الحالة" : "Status", w: "w-[200px]" },
              ...(canManageMessages ? [{ label: <span className="sr-only">{ar ? "إجراء" : "Action"}</span>, w: "w-[110px]" }] : []),
            ]}
          >
            {data.rows.map((m) => {
              const ev = m.eventType ? getEvent(m.eventType) : null;
              const kind = RECIPIENT_LABELS[m.recipientKind as RecipientKind];
              const open = expanded === m.id;
              return (
                <Tr key={m.id} testId={`msg-${m.id}`}>
                  <Td className="text-[13px]">
                    {/* Sent: when it went. Waiting: when it is due. Anything else: when it was decided. */}
                    <span className="block">{when(m.status === "SENT" ? m.sentAt : m.status === "QUEUED" ? m.scheduledAt : m.createdAt, lang)}</span>
                    {m.status === "QUEUED" && new Date(m.scheduledAt) > new Date() && (
                      <span className="block text-[12px] text-oo-text-muted">{ar ? "مجدولة" : "scheduled"}</span>
                    )}
                    {m.attempts > 1 && <span className="block text-[12px] text-oo-text-muted">{ar ? `${m.attempts} محاولات` : `${m.attempts} attempts`}</span>}
                  </Td>
                  <Td className="text-[13px]">
                    <span className="block">{m.recipientKind === "test" ? (ar ? "رسالة تجريبية" : "Test message") : m.ruleName ?? "—"}</span>
                    {ev && <span className="block text-[12px] text-oo-text-muted">{ar ? ev.ar : ev.en}</span>}
                  </Td>
                  <Td className="text-[13px]">
                    <span className="block">{m.recipientName || (kind ? (ar ? kind.ar : kind.en) : m.recipientKind)}</span>
                    <span className="block text-[12px] text-oo-text-muted">
                      <Phone value={m.phone} />
                      {m.intendedPhone && (
                        <>
                          {" "}
                          {ar ? "بدلا من" : "instead of"} <Phone value={m.intendedPhone} />
                        </>
                      )}
                    </span>
                  </Td>
                  <Td className="text-[13px]">
                    <button type="button" onClick={() => setExpanded(open ? null : m.id)} className="text-start w-full" dir="auto">
                      <span className={`block whitespace-pre-wrap break-words ${open ? "" : "line-clamp-2"}`}>{m.body}</span>
                    </button>
                  </Td>
                  <Td>
                    <MessageStatusBadge status={m.status} lang={lang} testId={`msg-status-${m.id}`} />
                    <Note note={m.statusNote} lang={lang} className="mt-1 block text-[12px] leading-[18px] text-oo-text-muted" />
                  </Td>
                  {canManageMessages && (
                    <Td>
                      {m.status === "FAILED" && m.phone && (
                        <button type="button" onClick={() => act(m.id, "retry")} className={`${ROW_ACTION} hover:border-oo-action-primary`} data-testid={`retry-${m.id}`}>
                          {ar ? "إعادة" : "Retry"}
                        </button>
                      )}
                      {m.status === "QUEUED" && (
                        <button type="button" onClick={() => act(m.id, "cancel")} className={`${ROW_ACTION} hover:border-oo-status-blocked`} data-testid={`cancel-${m.id}`}>
                          {ar ? "إلغاء" : "Cancel"}
                        </button>
                      )}
                    </Td>
                  )}
                </Tr>
              );
            })}
          </DataTable>
        )
      )}

      {pages > 1 && (
        <div className="flex items-center justify-center gap-3 text-[13px]">
          <Button variant="secondary" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1}>
            {ar ? "السابق" : "Previous"}
          </Button>
          <span>{ar ? `صفحة ${page} من ${pages}` : `Page ${page} of ${pages}`}</span>
          <Button variant="secondary" onClick={() => setPage((p) => Math.min(pages, p + 1))} disabled={page >= pages}>
            {ar ? "التالي" : "Next"}
          </Button>
        </div>
      )}
    </div>
  );
}
