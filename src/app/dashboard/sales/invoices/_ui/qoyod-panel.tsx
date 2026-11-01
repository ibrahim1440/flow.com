"use client";

// «وضع التجربة مع قيود» (owner's pilot) on the invoice page: the pilot notice, Qoyod's tax invoice attached by the
// accountant (number + PDF), and the rep's «إرسال» to the customer (WhatsApp file + e-mail attachment), with what each
// channel did. The customer never receives this system's own document during the pilot.
import { useState } from "react";
import { Msg, useApi, useLang, useWrite } from "./inv";
import { Banner } from "./request-ui";

type Message = { id: string; channel: "whatsapp" | "email"; status: string; note: string | null; address: string | null; intended: string | null; createdAt: string; sentAt: string | null; deliveredAt: string | null };
type Data = {
  pilot: { until: string | null; active: boolean; internalCopy: boolean };
  copy: { id: string; qoyodNumber: string; filename: string; byteSize: number; version: number; uploadedAt: string; uploadedBy: string; sendCount: number; lastSentAt: string | null; lastSentBy: string | null; messages: Message[] } | null;
  can: { attach: boolean; send: boolean };
};
type Outcome = { channel: "whatsapp" | "email"; status: string; note: string | null; test: boolean };

const STATUS: Record<string, [string, string, string]> = {
  QUEUED: ["في الطابور", "Queued", "is-info"], SENDING: ["يُرسل الآن", "Sending", "is-info"], SENT: ["أُرسل", "Sent", "is-ok"],
  FAILED: ["فشل", "Failed", "is-warn"], SKIPPED: ["لم يُرسل", "Not sent", "is-warn"], CANCELLED: ["أُلغي", "Cancelled", "is-warn"],
};
const at = (v: string | null) => (v ? new Date(v).toLocaleString("en-GB", { timeZone: "Asia/Riyadh", dateStyle: "short", timeStyle: "short" }) : "—");

export function QoyodPanel({ invoiceId, status }: { invoiceId: string; status: string }) {
  const { L } = useLang();
  const api = useApi<Data>(`/api/sales/invoices/${invoiceId}/qoyod`);
  const w = useWrite();
  const [number, setNumber] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [replace, setReplace] = useState(false);
  const [ch, setCh] = useState({ whatsapp: true, email: true });
  const [outcomes, setOutcomes] = useState<Outcome[] | null>(null);
  const d = api.data;
  if (!d) return null;
  // Nothing to show outside the pilot unless a copy exists.
  if (!d.pilot.until && !d.copy) return null;

  const upload = async () => {
    if (!file || !number.trim()) { w.setError(L("اكتب رقم فاتورة قيود واختر ملف PDF.", "Give Qoyod's number and choose the PDF.")); return; }
    setUploading(true); w.setError(null); w.setDone(null);
    try {
      const fd = new FormData();
      fd.set("qoyodNumber", number.trim());
      fd.set("file", file);
      const r = await fetch(`/api/sales/invoices/${invoiceId}/qoyod`, { method: "POST", body: fd });
      const b = await r.json().catch(() => ({}));
      if (!r.ok) { w.setError(L(b.error ?? `HTTP ${r.status}`, b.errorEn ?? b.error ?? `HTTP ${r.status}`)); return; }
      w.setDone(b.replayed ? L("الملف نفسه مرفق من قبل.", "The same file is already attached.") : L("أُرفقت فاتورة قيود، ووصل إشعار للمندوب.", "Qoyod's invoice attached; the rep was notified."));
      setNumber(""); setFile(null); setReplace(false); api.reload();
    } finally { setUploading(false); }
  };
  const send = async () => {
    setOutcomes(null);
    const r = await w.run<{ outcomes: Outcome[]; queued: number }>("qoyod-send", `/api/sales/invoices/${invoiceId}/qoyod/send`, "POST", ch);
    if (r) {
      setOutcomes(r.outcomes);
      w.setDone(r.queued > 0 ? L("انضافت للطابور وتُرسل خلال ثوانٍ.", "Queued; it goes out within seconds.") : L("ما انرسل شيء — شوف السبب تحت.", "Nothing was sent — see why below."));
      api.reload();
      setTimeout(() => api.reload(), 8000);
    }
  };
  const showForm = d.can.attach && (!d.copy || replace);

  return (
    <section className="acct-card" data-testid="qoyod-panel">
      <h2>{L("فاتورة قيود الضريبية", "Qoyod tax invoice")}</h2>
      {d.pilot.internalCopy ? (
        <Banner tone="warning" testId="pilot-internal">
          <b>{L("نسخة داخلية — ليست فاتورة ضريبية", "Internal copy — not a tax invoice")}</b>
          <span>{L(`فترة التجربة حتى ${d.pilot.until}: الفاتورة اللي تروح للعميل هي فاتورة قيود المرفقة هنا، مو هذي.`, `Pilot until ${d.pilot.until}: the customer receives Qoyod's invoice attached here, not this one.`)}</span>
        </Banner>
      ) : null}
      <Msg error={w.error} done={w.done} onClose={() => { w.setError(null); w.setDone(null); }} />

      {d.copy ? (
        <dl className="acct-kv-grid" data-testid="qoyod-copy">
          <div><dt>{L("رقم الفاتورة في قيود", "Qoyod invoice no.")}</dt><dd><bdi className="acct-code" data-testid="qoyod-number">{d.copy.qoyodNumber}</bdi></dd></div>
          <div><dt>{L("الملف", "File")}</dt><dd><a href={`/api/sales/invoices/${invoiceId}/qoyod/pdf`} target="_blank" rel="noopener" data-testid="qoyod-pdf">{L("عرض PDF", "Open PDF")}</a> <span className="acct-hint">· {Math.ceil(d.copy.byteSize / 1024)} KB{d.copy.version > 1 ? L(` · نسخة ${d.copy.version}`, ` · version ${d.copy.version}`) : ""}</span></dd></div>
          <div><dt>{L("رفعها", "Attached by")}</dt><dd><bdi>{d.copy.uploadedBy}</bdi> · <span className="hr-num">{at(d.copy.uploadedAt)}</span></dd></div>
          <div><dt>{L("الإرسال للعميل", "Sent to the customer")}</dt><dd>{d.copy.sendCount ? <><span className="hr-num">{d.copy.sendCount}×</span> · <bdi>{d.copy.lastSentBy}</bdi> · <span className="hr-num">{at(d.copy.lastSentAt)}</span></> : L("لم تُرسل بعد", "Not sent yet")}</dd></div>
        </dl>
      ) : (
        <p className="acct-hint" data-testid="qoyod-missing">{status === "ISSUED" ? L("ما أُرفقت فاتورة قيود بعد. المحاسب يصدرها في قيود ويرفع ملفها هنا.", "Qoyod's invoice is not attached yet. The accountant issues it in Qoyod and uploads it here.") : L("تُرفق فاتورة قيود بعد إصدار المستند.", "Qoyod's invoice is attached once the document is issued.")}</p>
      )}

      {showForm ? (
        <div className="acct-row" data-testid="qoyod-upload">
          <label className="hr-field"><span className="hr-label">{L("رقم الفاتورة في قيود", "Qoyod invoice no.")}</span>
            <input className="hr-input" dir="ltr" maxLength={60} value={number} onChange={(e) => setNumber(e.target.value)} data-testid="qoyod-number-input" /></label>
          <label className="hr-field acct-grow"><span className="hr-label">{L("ملف PDF من قيود", "PDF from Qoyod")}</span>
            <input className="hr-input" type="file" accept="application/pdf,.pdf" onChange={(e) => setFile(e.target.files?.[0] ?? null)} data-testid="qoyod-file" /></label>
          <button type="button" className="hr-btn is-primary" disabled={uploading} onClick={upload} data-testid="qoyod-upload-btn">{d.copy ? L("استبدال", "Replace") : L("إرفاق", "Attach")}</button>
          {replace ? <button type="button" className="hr-btn" onClick={() => setReplace(false)}>{L("تراجع", "Cancel")}</button> : null}
        </div>
      ) : d.copy && d.can.attach ? (
        <button type="button" className="hr-btn" onClick={() => setReplace(true)} data-testid="qoyod-replace">{L("استبدال الملف أو الرقم", "Replace the file or number")}</button>
      ) : null}

      {d.copy && d.can.send ? (
        <div className="acct-foot" data-testid="qoyod-send">
          <label className="acct-check"><input type="checkbox" checked={ch.whatsapp} onChange={(e) => setCh({ ...ch, whatsapp: e.target.checked })} /> {L("واتساب (ملف PDF)", "WhatsApp (PDF file)")}</label>
          <label className="acct-check"><input type="checkbox" checked={ch.email} onChange={(e) => setCh({ ...ch, email: e.target.checked })} /> {L("إيميل (مرفق PDF)", "E-mail (PDF attached)")}</label>
          <button type="button" className="hr-btn is-primary" disabled={!!w.busy || (!ch.whatsapp && !ch.email)} onClick={send} data-testid="qoyod-send-btn">
            {d.copy.sendCount ? L("إعادة الإرسال للعميل", "Send to the customer again") : L("إرسال للعميل", "Send to the customer")}
          </button>
        </div>
      ) : null}

      {outcomes ? (
        <ul className="inv-check" data-testid="qoyod-outcomes">
          {outcomes.map((o) => (
            <li key={o.channel}>{o.channel === "whatsapp" ? L("واتساب", "WhatsApp") : L("إيميل", "E-mail")}: {L(STATUS[o.status]?.[0] ?? o.status, STATUS[o.status]?.[1] ?? o.status)}{o.test ? L(" (وضع الاختبار: يروح لرقم/إيميل الاختبار)", " (test mode: goes to the test number / address)") : ""}{o.note ? <span className="acct-hint"> — {o.note}</span> : null}</li>
          ))}
        </ul>
      ) : null}

      {d.copy?.messages.length ? (
        <table className="acct-table" data-testid="qoyod-log">
          <thead><tr><th>{L("القناة", "Channel")}</th><th>{L("الحالة", "Status")}</th><th>{L("إلى", "To")}</th><th>{L("الوقت", "Time")}</th></tr></thead>
          <tbody>{d.copy.messages.map((m) => (
            <tr key={`${m.channel}:${m.id}`}>
              <td>{m.channel === "whatsapp" ? L("واتساب", "WhatsApp") : L("إيميل", "E-mail")}</td>
              <td><span className={`inv-chip ${STATUS[m.status]?.[2] ?? ""}`}>{L(STATUS[m.status]?.[0] ?? m.status, STATUS[m.status]?.[1] ?? m.status)}</span>{m.note && m.status !== "SENT" ? <span className="acct-hint"> {m.note}</span> : null}</td>
              <td><bdi dir="ltr">{m.address ?? "—"}</bdi>{m.intended ? <span className="acct-hint"> ({L("بدل", "for")} <bdi dir="ltr">{m.intended}</bdi>)</span> : null}</td>
              <td className="hr-num">{at(m.sentAt ?? m.createdAt)}</td>
            </tr>
          ))}</tbody>
        </table>
      ) : null}
    </section>
  );
}
