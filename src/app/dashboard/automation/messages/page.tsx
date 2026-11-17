"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Btn, Empty, OpsBanner, OpsLoading, OpsRoot } from "@/components/ops/ui";
import { useD21Phone } from "@/components/shell/page-context";
import { api, useLang } from "../../sales/_components/ui";
import { RECIPIENT_LABELS, type RecipientKind } from "@/lib/automation/catalog";
import { STATUS_RECIPIENT_LABELS, type StatusRecipient } from "@/lib/automation/status-rules/sources";
import { AutomationHeader, ChannelIcon, MESSAGE_STATUS, MessageStatusBadge, Note, noteText, useAutomationAbilities } from "../_components/shared";
import { SettingsFrame } from "../../_components/tools-ui";
import { useUser } from "../../user-context";
import { NeedsReviewBanner, ReviewChips, ReviewFlow, ReviewTable, type ActionResult, type Outcome, type ReviewMessage, type TableRow } from "@/components/messages/review-ui";

/**
 * «سجل رسائل الأتمتة» — WhatsApp and e-mail. R1-e (owner-approved Figma a2 2075:663, with b–h): the provider's delivery
 * status and the manual review in two columns; a message that may have been delivered is never «أُعيد» in one click —
 * «تسجيل نتيجة التحقق», then (only after «لم تصل») «إعادة الإرسال بعد المراجعة». Every row, count and search is limited
 * on the server to the departments the viewer may read (lib/automation/message-access.ts); `canProcess` per row says
 * whether they may also process it. No 24-hour window here (that one is marketing's).
 */

type Department = "test" | "activation" | "qoyod" | "invoices" | "collection" | "orders" | "operations" | "sales" | "finance" | "unknown";
const DEPT: Record<Department, { ar: string; en: string }> = {
  sales: { ar: "المبيعات", en: "Sales" },
  orders: { ar: "الطلبات", en: "Orders" },
  operations: { ar: "الإنتاج والجودة", en: "Production & QC" },
  invoices: { ar: "الفواتير", en: "Invoices" },
  qoyod: { ar: "المحاسبة (قيود)", en: "Accounting (Qoyod)" },
  collection: { ar: "التحصيل", en: "Collection" },
  finance: { ar: "المالية", en: "Finance" },
  activation: { ar: "الموارد البشرية (التفعيل)", en: "HR (activation)" },
  test: { ar: "التجارب", en: "Tests" },
  unknown: { ar: "غير محدد", en: "Undetermined" },
};

type Row = {
  id: string;
  channel: "whatsapp" | "email";
  department: Department;
  canProcess: boolean;
  subject: string | null;
  address: string | null;
  intended: string | null;
  attachmentKind: string | null;
  bodyArchivedAt: string | null;
  ruleName: string | null;
  subjectType: string | null;
  subjectId: string | null;
  recipientKind: string;
  recipientName: string | null;
  body: string;
  status: string;
  statusNote: string | null;
  scheduledAt: string;
  attempts: number;
  sentAt: string | null;
  createdAt: string;
  deliveryDoubt: boolean;
  reviewOutcome: Outcome | null;
  reviewNote: string | null;
  reviewedAt: string | null;
  reviewedBy: { id: string; name: string } | null;
  resendOfMessageId: string | null;
  resend: { id: string; status: string } | null;
  resentBy: { name: string | null; at: string } | null;
  dedupeKey: string;
  /** For a «لم تصل» message not resent: may it be resent now (its type's window + content), and if not, why. */
  resendCheck?: { ok: boolean; code?: string; ar?: string; en?: string; href?: string | null; from?: string | null; until?: string | null };
  sendingStartedAt: string | null;
  interruptedAt: string | null;
};
type List = { rows: Row[]; total: number; perPage: number; counts: Record<string, number>; needsReview: number; pending: number; resent: number; departments: Partial<Record<Department, number>>; canManage: boolean; scopeCapped?: string[] };
type Report = { skipped?: string; eventsProcessed: number; messagesQueued: number; sent: number; sendFailures: number; sendingPaused: string | null; emailsQueued?: number; emailsSent?: number };
type Item = TableRow & { raw: Row };

export default function AutomationMessagesPage() {
  const lang = useLang();
  const ar = lang === "ar";
  const L = (a: string, e: string) => (ar ? a : e);
  const user = useUser();
  const { canManageMessages } = useAutomationAbilities();

  const [status, setStatus] = useState("");
  const [channel, setChannel] = useState("");
  const [review, setReview] = useState("");
  const [department, setDepartment] = useState("");
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<List | null>(null);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  const [busy, setBusy] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);
  const reload = useCallback(() => setReloadToken((t) => t + 1), []);

  useD21Phone({ title: L("سجل الرسائل", "Message log"), sub: L("رسائل الأتمتة", "Automation messages") });

  useEffect(() => {
    let cancelled = false;
    const params = new URLSearchParams({ page: String(page) });
    if (status) params.set("status", status);
    if (channel) params.set("channel", channel);
    if (review) params.set("review", review);
    if (department) params.set("department", department);
    if (q.trim()) params.set("q", q.trim());
    const timer = setTimeout(async () => {
      const r = await api<List>(`/api/automation/messages?${params}`);
      if (cancelled) return;
      if (r.ok) { setData(r.data); setError(""); }
      else setError(r.data.error ?? L("تعذر تحميل السجل.", "Could not load the log."));
    }, q ? 300 : 0);
    return () => { cancelled = true; clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- L is a pure label picker
  }, [status, channel, review, department, q, page, ar, reloadToken]);

  const items: Item[] = useMemo(() => (data?.rows ?? []).map((m) => {
    const kind = RECIPIENT_LABELS[m.recipientKind as RecipientKind] ?? STATUS_RECIPIENT_LABELS[m.recipientKind as StatusRecipient];
    const who = m.recipientName || (kind ? (ar ? kind.ar : kind.en) : m.recipientKind);
    const rule = m.recipientKind === "test" ? (m.channel === "email" ? L("رسالة تجربة (إيميل)", "Test e-mail") : L("اختبار الاتصال", "Connection check")) : m.ruleName ?? "—";
    const dept = DEPT[m.department] ?? DEPT.unknown;
    return {
      raw: m, id: m.id, channel: m.channel, address: m.address,
      source: `${who} · ${rule} · ${ar ? dept.ar : dept.en} · ${m.channel === "email" ? L("بريد", "e-mail") : L("واتساب", "WhatsApp")}`,
      body: m.bodyArchivedAt ? L("انتقل نص الرسالة للأرشيف (أقدم من 180 يوم).", "The text moved to the archive (older than 180 days).") : (m.channel === "email" && m.subject ? `${m.subject} — ${m.body}` : m.body),
      status: m.status, statusNote: m.statusNote, statusNoteText: m.statusNote ? noteText(m.statusNote, lang) : null, deliveryDoubt: m.deliveryDoubt, reviewOutcome: m.reviewOutcome, reviewNote: m.reviewNote,
      reviewedBy: m.reviewedBy, reviewedAt: m.reviewedAt, resend: m.resend, resentBy: m.resentBy, resendOfMessageId: m.resendOfMessageId,
      scheduledAt: m.scheduledAt, sendingStartedAt: m.sendingStartedAt, interruptedAt: m.interruptedAt, attempts: m.attempts, createdAt: m.createdAt,
      updatedAt: m.sentAt ?? m.createdAt, resendWindow: null, canProcess: m.canProcess,
      noResend: m.department === "activation"
        ? { ar: "رابط التفعيل لا يُعاد من السجل — أصدر رابطًا جديدًا من صفحة الموظف.", en: "An activation link is not resent from the log — issue a new one from the employee's page.", href: m.subjectId ? `/dashboard/employees/${m.subjectId}` : "/dashboard/employees" }
        : m.resendCheck && !m.resendCheck.ok ? { ar: m.resendCheck.ar ?? "", en: m.resendCheck.en ?? "", href: m.resendCheck.href ?? null }
        : null,
      resendUntil: m.resendCheck?.ok ? m.resendCheck.until ?? null : null,
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- L is a pure label picker
  }), [data, ar]);
  // The open message: its row as reloaded, or (when a filter dropped it after a review) as it was opened.
  const [opened, setOpened] = useState<Item | null>(null);
  const open = opened ? items.find((i) => i.id === opened.id) ?? opened : null;

  async function act(m: Row, action: "retry" | "cancel") {
    const r = await api(`/api/automation/messages/${m.id}`, { method: "POST", body: { action, channel: m.channel } });
    if (!r.ok) setError(r.data.error ?? "");
    reload();
  }
  const reviewCall = (m: ReviewMessage, outcome: Outcome, note: string) =>
    api(`/api/automation/messages/${m.id}`, { method: "POST", body: { action: "review", channel: m.channel, outcome, note } }) as Promise<ActionResult>;
  const resendCall = async (m: ReviewMessage) => {
    const r = await api<{ resend?: { id: string } }>(`/api/automation/messages/${m.id}`, { method: "POST", body: { action: "resend", channel: m.channel, confirm: true } });
    return { ...r, data: { ...r.data, resendId: r.data.resend?.id } } as ActionResult & { data: { resendId?: string } };
  };

  async function runNow() {
    setBusy(true);
    const r = await api<Report>("/api/automation/dispatch", { method: "POST" });
    setBusy(false);
    if (!r.ok) return setError(r.data.error ?? "");
    const d = r.data;
    if (d.skipped) { setInfo(L("فيه تشغيل مجدول شغّال الحين — ما شغّلنا ثاني. حدّث الصفحة بعد دقيقة.", "A scheduled run is going on now — not run twice. Refresh in a minute.")); return reload(); }
    setInfo(
      (ar
        ? `عولج ${d.eventsProcessed} حدث، وأضيفت ${d.messagesQueued + (d.emailsQueued ?? 0)} رسالة، وانرسل ${d.sent} واتساب و${d.emailsSent ?? 0} إيميل`
        : `${d.eventsProcessed} events processed, ${d.messagesQueued + (d.emailsQueued ?? 0)} queued, ${d.sent} WhatsApp and ${d.emailsSent ?? 0} e-mails sent`) +
        (d.sendFailures ? L(`، وفشلت ${d.sendFailures}`, `, ${d.sendFailures} failed`) : "") +
        (d.sendingPaused ? ` — ${noteText(d.sendingPaused, lang)}` : "."),
    );
    reload();
  }

  const pages = data ? Math.max(1, Math.ceil(data.total / data.perPage)) : 1;
  const depts = (Object.keys(DEPT) as Department[]).filter((d) => (data?.departments?.[d] ?? 0) > 0);
  const first = data && data.total ? (page - 1) * data.perPage + 1 : 0;
  const last = data ? Math.min(data.total, page * data.perPage) : 0;

  return (
    <OpsRoot className="tl-root">
      <SettingsFrame>
        <AutomationHeader lang={lang} />

        {error && <OpsBanner tone="danger" onClose={() => setError("")}>{error}</OpsBanner>}
        {info && <OpsBanner tone="info" onClose={() => setInfo("")}>{info}</OpsBanner>}

        {depts.length ? (
          <div className="mr-chips" role="group" aria-label={L("القسم", "Department")} data-testid="msg-departments">
            <span className="mr-lbl">{L("القسم (حسب صلاحياتك):", "Department (by your permissions):")}</span>
            {depts.map((d) => (
              <button key={d} type="button" className="mr-chip" aria-pressed={department === d} onClick={() => { setDepartment(department === d ? "" : d); setPage(1); }} data-testid={`msg-dept-${d}`}>
                <span>{ar ? DEPT[d].ar : DEPT[d].en}</span><span className="mr-count mr-num">{data?.departments?.[d] ?? 0}</span>
              </button>
            ))}
            <span className="mr-micro">{L("لا تظهر رسائل الأقسام التي لا تملك صلاحيتها.", "Departments you hold no permission for do not appear.")}</span>
          </div>
        ) : null}

        <NeedsReviewBanner automation count={data?.needsReview ?? 0} lang={lang} onShow={() => { setReview("needed"); setPage(1); }} />
        {data?.scopeCapped?.length ? (
          <p className="mr-note" role="status" data-testid="msg-scope-capped">
            {L("سجلّاتك في هذا القسم أكثر من 20,000، فبعض رسائلها لا تظهر هنا. ضيّق البحث، أو اطلب من المدير مراجعتها.", "You have more than 20,000 records in this department, so some of their messages are not listed here. Narrow the search, or ask an administrator.")}
          </p>
        ) : null}

        <div className="mr-toolbar">
          <input type="search" className="hr-input hr-search" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }}
            placeholder={L("بحث بالجوال أو البريد أو الاسم", "Search a phone, an address or a name")} aria-label={L("بحث", "Search")} data-testid="msg-search" />
          <ReviewChips lang={lang} value={review} onChange={(v) => { setReview(v); setPage(1); }} counts={{ needed: data?.needsReview ?? 0, pending: data?.pending ?? 0, resent: data?.resent ?? 0 }} />
        </div>
        <div className="mr-toolbar">
          <span className="mr-lbl">{L("حالة التسليم (من المزوّد):", "Delivery status (provider):")}</span>
          <div className="mr-seg" role="group" aria-label={L("القناة", "Channel")} data-testid="msg-channel">
            {([["", L("الكل", "All")], ["whatsapp", L("واتساب", "WhatsApp")], ["email", L("إيميل", "E-mail")]] as const).map(([k, label]) => (
              <button key={k || "all"} type="button" aria-pressed={channel === k} onClick={() => { setChannel(k); setPage(1); }} data-testid={`msg-channel-${k || "all"}`}>{label}</button>
            ))}
          </div>
          <div className="mr-seg" role="group" aria-label={L("الحالة", "Status")} data-testid="msg-status">
            <button type="button" aria-pressed={status === ""} onClick={() => { setStatus(""); setPage(1); }}>{L("الكل", "All")}</button>
            {Object.entries(MESSAGE_STATUS).filter(([k]) => k !== "SENDING" && k !== "COMPLAINED").map(([k, s]) => (
              <button key={k} type="button" aria-pressed={status === k} onClick={() => { setStatus(k); setPage(1); }} data-testid={`msg-status-${k}`}>
                <span>{ar ? s.ar : s.en}</span>{data ? <span className="mr-num">{data.counts[k] ?? 0}</span> : null}
              </button>
            ))}
          </div>
          <span style={{ flex: 1 }} />
          {canManageMessages ? <Btn onClick={runNow} disabled={busy} busy={busy} data-testid="run-dispatch">{L("أرسل المنتظر الحين", "Send what is waiting now")}</Btn> : null}
        </div>

        {!data && !error ? <OpsLoading /> : data && data.rows.length === 0 ? (
          <div className="tl-empty">
            <Empty
              title={review || status || q || department ? L("لا نتائج", "No results") : L("لا توجد رسائل", "No messages")}
              body={review || status || q || department
                ? L("لا رسالة تطابق البحث أو المرشّحات. امسح المرشّحات لترى الكل.", "No message matches the search or filters. Clear them to see everything.")
                : L("تظهر هنا رسائل أقسامك: ما أُرسل، وما ينتظر، وما فشل أو لم يُرسل ولماذا.", "Your departments' messages appear here: sent, waiting, failed or not sent, and why.")}
            />
          </div>
        ) : data ? (
          <div className="hr-tablewrap">
            <ReviewTable
              rows={items} lang={lang} onOpen={(m) => setOpened(m)} selectedId={opened?.id ?? null}
              label={L("سجل الرسائل", "Message log")} testId="messages-table" statusHeadTestId="messages-status-head"
              addressHeader={L("الجوال / البريد والمصدر", "Phone / e-mail and source")}
              renderAddress={(m) => (
                <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
                  <ChannelIcon channel={m.channel} lang={lang} />
                  <bdi dir="ltr" className="mr-num" style={{ fontSize: 12.5 }}>{m.address ?? "—"}</bdi>
                  {m.raw.intended ? <span className="mr-micro">{L("بدلًا من", "instead of")} <bdi dir="ltr">{m.raw.intended}</bdi></span> : null}
                </span>
              )}
              renderProvider={(m) => (
                <>
                  <MessageStatusBadge status={m.status} note={m.statusNote} lang={lang} testId={`msg-status-${m.id}`} />
                  <Note note={m.statusNote} lang={lang} className="mr-micro" />
                </>
              )}
              extraAction={(m) => m.canProcess && !m.deliveryDoubt && m.status === "FAILED" ? (
                <Btn size="sm" onClick={() => act(m.raw, "retry")} data-testid={`retry-${m.id}`}>{L("إعادة", "Retry")}</Btn>
              ) : m.canProcess && m.status === "QUEUED" ? (
                <Btn size="sm" onClick={() => act(m.raw, "cancel")} data-testid={`cancel-${m.id}`}>{L("إلغاء", "Cancel")}</Btn>
              ) : null}
            />
          </div>
        ) : null}

        {data ? (
          <div className="mr-legend">
            <span className="mr-micro">{L("المشكوك فيها غير المراجَعة لا تُحسب «أُرسلت». لا مهلة ٢٤ ساعة عامة للأتمتة.", "Unreviewed doubtful messages are not counted as sent. No general 24-hour window for automation.")}</span>
            <span className="mr-micro mr-num">{L(`عرض ${first}–${last} من ${data.total}`, `Showing ${first}–${last} of ${data.total}`)}</span>
          </div>
        ) : null}
        {pages > 1 && (
          <div className="tl-pager">
            <Btn size="sm" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1}>{L("السابق", "Previous")}</Btn>
            <span>{ar ? `صفحة ${page} من ${pages}` : `Page ${page} of ${pages}`}</span>
            <Btn size="sm" onClick={() => setPage((p) => Math.min(pages, p + 1))} disabled={page >= pages}>{L("التالي", "Next")}</Btn>
          </div>
        )}

        <ReviewFlow open={open} lang={lang} reviewer={user?.name ?? ""} marketing={false}
          onClose={() => setOpened(null)} onChanged={reload} review={reviewCall} resend={resendCall} />
      </SettingsFrame>
    </OpsRoot>
  );
}
