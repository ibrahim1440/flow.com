"use client";

import { useEffect, useState } from "react";
import { Btn, Empty, Notice, OpsBanner, OpsLoading, OpsRoot } from "@/components/ops/ui";
import { useD21Phone } from "@/components/shell/page-context";
import { api, useLang } from "../../sales/_components/ui";
import { AutomationHeader, ChannelIcon, MESSAGE_STATUS, MessageStatusBadge, Phone, when, whenParts } from "../_components/shared";
import { SettingsFrame } from "../../_components/tools-ui";

/**
 * «الأرشيف» (batch 25; owner decision 31 Oct 2026): what customers were sent more than 180 days ago, kept in our own
 * database for legal claims. The daily job moves the text here from the message log; nothing is ever deleted or
 * changed here. The administrator searches by customer, date range and subject (the server asks to confirm who they
 * are first). Attachments are not kept: an e-mail names its document and the fingerprint of the PDF that was sent.
 */
type Row = {
  id: string; channel: "whatsapp" | "email"; customerId: string | null; customerName: string | null; recipientName: string | null; address: string | null;
  subject: string | null; body: string; ruleName: string | null; docKind: string | null; docRefId: string | null; docSha256: string | null; status: string;
  messageCreatedAt: string; sentAt: string | null; archivedAt: string;
};

export default function MessageArchivePage() {
  const lang = useLang();
  const ar = lang === "ar";
  const L = (a: string, e: string) => (ar ? a : e);
  // Fix round 2: the administrator, a manager or a rep (the API scopes the rows and answers 403 to anyone else).
  const [refused, setRefused] = useState("");
  const [f, setF] = useState({ customer: "", from: "", to: "", subject: "", channel: "" });
  const [applied, setApplied] = useState(f);
  const [page, setPage] = useState(1);
  const [data, setData] = useState<{ rows: Row[]; total: number; perPage: number; truncated?: boolean } | null>(null);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState("");
  const [open, setOpen] = useState<string | null>(null);

  useD21Phone({ title: L("الأرشيف", "Archive"), sub: L("رسائل العملاء التلقائية", "Automated customer messages") });

  useEffect(() => {
    let cancelled = false;
    const p = new URLSearchParams({ page: String(page) });
    for (const [k, v] of Object.entries(applied)) if (v.trim()) p.set(k, v.trim());
    api<{ rows: Row[]; total: number; perPage: number }>(`/api/automation/archive?${p}`).then((r) => {
      if (cancelled) return;
      if (r.ok) { setData(r.data); setError(""); setRefused(""); }
      else if (r.status === 403) setRefused(r.data.error ?? "");
      else setError(r.data.error ?? L("تعذّر فتح الأرشيف.", "Could not open the archive."));
    });
    return () => { cancelled = true; };
  }, [applied, page]); // eslint-disable-line react-hooks/exhaustive-deps -- L depends on `ar` only

  if (refused) {
    return (
      <OpsRoot className="tl-root"><SettingsFrame>
        <AutomationHeader lang={lang} conn={null} />
        <Notice tone="info">{L("الأرشيف لمدير النظام والمدراء والمندوبين (كل واحد لعملائه).", "The archive is for an administrator, managers and reps (each for their own customers).")}</Notice>
      </SettingsFrame></OpsRoot>
    );
  }
  const pages = data ? Math.max(1, Math.ceil(data.total / data.perPage)) : 1;

  /** CSV of the current search (up to 2,000 messages), with the document reference and the PDF's sha256 in full. */
  async function exportCsv() {
    setExporting(true);
    const p = new URLSearchParams({ all: "1" });
    for (const [k, v] of Object.entries(applied)) if (v.trim()) p.set(k, v.trim());
    const r = await api<{ rows: Row[] }>(`/api/automation/archive?${p}`);
    setExporting(false);
    if (!r.ok) return setError(r.data.error ?? L("تعذّر التصدير.", "Could not export."));
    // Fix round 2: a cell starting with = + - @ (or a tab / CR) is not run as a formula by a spreadsheet — prefixed with '.
    const cell = (v: unknown) => {
      const t = String(v ?? "");
      return `"${(/^[=+\-@\t\r]/.test(t) ? `'${t}` : t).replace(/"/g, '""')}"`;
    };
    // Riyadh local time, as on the screen (dd/mm/yyyy HH:mm), and the status in Arabic.
    const at = (v: string | null) => (v ? `${when(v)} (الرياض)` : "");
    const st = (v: string) => MESSAGE_STATUS[v]?.ar ?? v;
    const head = ["القناة", "تاريخ الرسالة", "وقت الإرسال", "العميل", "المستلم", "العنوان", "الموضوع", "النص", "القاعدة", "الحالة", "نوع المستند", "مرجع المستند", "sha256 للملف المرسل", "تاريخ الأرشفة"];
    const lines = r.data.rows.map((x) => [x.channel === "email" ? "إيميل" : "واتساب", at(x.messageCreatedAt), at(x.sentAt), x.customerName ?? "", x.recipientName ?? "", x.address ?? "", x.subject ?? "", x.body, x.ruleName ?? "", st(x.status), x.docKind ?? "", x.docRefId ?? "", x.docSha256 ?? "", at(x.archivedAt)].map(cell).join(","));
    const blob = new Blob(["\uFEFF" + [head.map(cell).join(","), ...lines].join("\r\n")], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `archive-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });

  return (
    <OpsRoot className="tl-root">
      <SettingsFrame>
        <AutomationHeader lang={lang} conn={null} />
        <p className="tl-note" style={{ marginTop: 0 }}>{L("هنا نص الرسائل اللي مضى عليها أكثر من 180 يوم. تنحفظ للمطالبات القانونية، وما تنحذف ولا تتعدّل. المرفقات ما تنحفظ: نحفظ رقم المستند وبصمة الملف اللي انرسل.", "Messages older than 180 days. Kept for legal claims; never deleted or changed. Attachments are not kept: the document and the fingerprint of the file sent are.")}</p>
        {error && <OpsBanner tone="danger" onClose={() => setError("")}>{error}</OpsBanner>}
        <form className="tl-arch-filters" onSubmit={(e) => { e.preventDefault(); setPage(1); setApplied(f); }} data-testid="archive-filters">
          <label className="hr-field"><span className="hr-label">{L("العميل", "Customer")}</span><input className="hr-input" value={f.customer} onChange={set("customer")} placeholder={L("اسم العميل", "Customer name")} data-testid="archive-customer" /></label>
          <label className="hr-field"><span className="hr-label">{L("من تاريخ", "From")}</span><input className="hr-input" type="date" value={f.from} onChange={set("from")} data-testid="archive-from" /></label>
          <label className="hr-field"><span className="hr-label">{L("إلى تاريخ", "To")}</span><input className="hr-input" type="date" value={f.to} onChange={set("to")} data-testid="archive-to" /></label>
          <label className="hr-field"><span className="hr-label">{L("الموضوع", "Subject")}</span><input className="hr-input" value={f.subject} onChange={set("subject")} data-testid="archive-subject" /></label>
          <label className="hr-field"><span className="hr-label">{L("القناة", "Channel")}</span>
            <select className="hr-select" value={f.channel} onChange={set("channel")} data-testid="archive-channel">
              <option value="">{L("الكل", "All")}</option><option value="whatsapp">{L("واتساب", "WhatsApp")}</option><option value="email">{L("إيميل", "E-mail")}</option>
            </select>
          </label>
          <Btn variant="primary" type="submit" data-testid="archive-search">{L("ابحث", "Search")}</Btn>
          <Btn type="button" onClick={exportCsv} busy={exporting} disabled={!data || data.total === 0} data-testid="archive-export">{L("تصدير CSV للمحامي", "Export CSV")}</Btn>
        </form>
        {!data && !error ? <OpsLoading /> : data && data.rows.length === 0 ? (
          <div className="tl-empty"><Empty title={L("ما فيه رسائل في الأرشيف", "Nothing in the archive")} body={L("تنتقل الرسائل هنا تلقائيًا بعد 180 يوم من إرسالها.", "Messages move here automatically 180 days after they were sent.")} /></div>
        ) : data ? (
          <div className="hr-tablewrap">
            <table className="hr-table is-mrow" aria-label={L("الأرشيف", "Archive")} data-testid="archive-table">
              <thead><tr>
                <th style={{ width: 36 }}><span className="hr-sr">{L("القناة", "Channel")}</span></th>
                <th style={{ width: 110 }}>{L("التاريخ", "Date")}</th>
                <th>{L("العميل", "Customer")}</th>
                <th>{L("الرسالة", "Message")}</th>
                <th style={{ width: 130 }}>{L("الحالة", "Status")}</th>
              </tr></thead>
              <tbody>
                {data.rows.map((r) => {
                  const [d, t] = whenParts(r.sentAt ?? r.messageCreatedAt);
                  const isOpen = open === r.id;
                  return (
                    <tr key={r.id} data-testid={`archive-row-${r.id}`}>
                      <td><ChannelIcon channel={r.channel} lang={lang} /></td>
                      <td><span className="hr-num" style={{ display: "block" }}>{d}</span><span className="hr-num stk-sub">{t}</span></td>
                      <td className="m-title">
                        <span style={{ display: "block", fontWeight: 500 }}>{r.customerName ?? r.recipientName ?? "—"}</span>
                        <span className="hr-msub"><bdi dir="ltr">{d} {t}</bdi>{r.subject ? ` · ${r.subject}` : ""}</span>
                        <span className="stk-sub hr-num">{r.channel === "email" ? (r.address ? <bdi dir="ltr">{r.address}</bdi> : "—") : r.address ? <Phone value={r.address} /> : "—"}</span>
                      </td>
                      <td>
                        <button type="button" className="tl-body-btn" onClick={() => setOpen(isOpen ? null : r.id)} aria-expanded={isOpen} dir="auto">
                          {r.subject ? <span style={{ display: "block", fontWeight: 600, fontSize: 13.5 }}>{r.subject}</span> : null}
                          <span className={isOpen ? "" : "tl-clamp"} style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", fontSize: 13.5 }}>{r.body}</span>
                        </button>
                        {r.docKind === "quote_pdf" ? (
                          <span className="stk-sub" style={{ display: "block" }}>
                            {L("مرفق: عرض سعر", "Attached: quotation")} <bdi dir="ltr">{r.docRefId}</bdi>
                            <span style={{ display: "block", overflowWrap: "anywhere" }}>{L("بصمة الملف (sha256): ", "File fingerprint (sha256): ")}<bdi dir="ltr" data-testid="archive-sha">{r.docSha256}</bdi></span>
                          </span>
                        ) : null}
                      </td>
                      <td className="m-end"><MessageStatusBadge status={r.status} lang={lang} /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : null}
        {data ? <p className="tl-foot">{L(`${data.total} رسالة · صفحة ${page} من ${pages}`, `${data.total} messages · page ${page} of ${pages}`)}{data.truncated ? L(" · البحث بالاسم وجد عملاء كثير: حدّد الاسم أكثر", " · many customers match: narrow the name") : ""}</p> : null}
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
