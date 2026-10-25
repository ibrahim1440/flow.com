"use client";

import { useState } from "react";
import { useLang, PageHeader, Spinner, Button, Banner, Sec, StatusChip, useLoad, useMkt, usePageTitle, api, platformName, fmtDate, VARIANT_STATUS, Modal, Field, TextInput, Alert } from "../_components/ui";
import { PLATFORMS } from "@/lib/marketing/platforms";

/**
 * «مركز النشر الموحد» — the publishing queue. A platform with an implemented, connected adapter is
 * published through its official API and verified; any other is MANUAL: the prepared text is here
 * to copy, a person publishes it and confirms with the live URL. Nothing is marked published without
 * either the platform's answer or that URL.
 */

type Open = { variantId: string; platform: string; status: string; lastError: string | null; post: { id: string; title: string; scheduledAt: string | null }; job: { attempts: number; runAt: string; status: string; lastError: string | null } | null; preparedText: string };
type Recent = { variantId: string; platform: string; status: string; url: string | null; publishedAt: string | null; post: { id: string; title: string } };

export default function PublishingPage() {
  const lang = useLang();
  usePageTitle("مركز النشر", "Publishing hub", lang);
  const { can } = useMkt();
  const { data, error, loading, reload } = useLoad<{ open: Open[]; recent: Recent[] }>("/api/marketing/publishing");
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const [confirming, setConfirming] = useState<Open | null>(null);
  const [busy, setBusy] = useState(false);

  async function runNow() {
    setBusy(true);
    const r = await api<{ duePosts: number; jobsRun: number; published: number; manual: number; failed: number; skipped: string | null }>("/api/marketing/publishing", { method: "POST" });
    setBusy(false);
    if (!r.ok) return setErr(r.data.error ?? "");
    setMsg(r.data.skipped ? "الإيقاف الطارئ للنشر مفعّل؛ لم يُنشر شيء." : `منشورات حان موعدها: ${r.data.duePosts} · عمليات: ${r.data.jobsRun} · نُشر: ${r.data.published} · يدوي: ${r.data.manual} · فشل: ${r.data.failed}`);
    reload();
  }
  async function retry(o: Open) {
    let confirmNotPublished = false;
    if (o.lastError?.includes("قد يكون نُشر")) {
      confirmNotPublished = confirm("نتيجة المحاولة السابقة غير معروفة. هل تأكدت من المنصة أن المنشور لم يُنشر؟");
      if (!confirmNotPublished) return;
    }
    const r = await api(`/api/marketing/publishing/${o.variantId}`, { method: "POST", body: { action: "retry", confirmNotPublished } });
    if (!r.ok) return setErr(r.data.error ?? "");
    reload();
  }

  return (
    <div className="mkt" data-testid="mkt-publishing">
      <PageHeader title="مركز النشر الموحد" subtitle="النشر العضوي فقط؛ الإعلانات المدفوعة مسار منفصل في الحملات." actions={can("publish") ? <Button onClick={runNow} disabled={busy} testId="run-publisher">تشغيل قائمة النشر الآن</Button> : null} />
      <Banner tone="info" onClose={() => setMsg("")}>{msg}</Banner>
      <Banner onClose={() => setErr("")}>{err || error}</Banner>
      {loading && !data ? <Spinner /> : data ? (
        <>
          <Sec title={`بانتظار إجراء (${data.open.length})`} testId="open">
            {data.open.length === 0 ? <p className="mkt-muted">لا شيء في القائمة.</p> : <div className="mkt-list">{data.open.map((o) => (
              <div key={o.variantId} className="mkt-item" data-testid={`open-${o.variantId}`}>
                <div style={{ minWidth: 0 }}>
                  <div className="t">{o.post.title} · {platformName(o.platform)}</div>
                  <div className="s">موعده {fmtDate(o.post.scheduledAt, true)}{o.job ? ` · محاولات ${o.job.attempts}` : ""}{o.lastError ? ` · ${o.lastError}` : ""}</div>
                  {o.status === "MANUAL_REQUIRED" ? <details><summary className="mkt-muted">النص الجاهز للنسخ</summary><p className="mkt-pre">{o.preparedText}</p><button type="button" className="mkt-chip" onClick={() => navigator.clipboard?.writeText(o.preparedText)}>نسخ النص</button></details> : null}
                </div>
                <div className="mkt-toolbar">
                  <StatusChip map={VARIANT_STATUS} value={o.status} />
                  {can("publish") && (o.status === "MANUAL_REQUIRED" || o.status === "FAILED") ? <Button variant="secondary" onClick={() => setConfirming(o)} testId={`confirm-${o.variantId}`}>تأكيد النشر اليدوي</Button> : null}
                  {can("publish") && o.status === "FAILED" ? <Button variant="secondary" onClick={() => retry(o)}>إعادة المحاولة</Button> : null}
                </div>
              </div>
            ))}</div>}
          </Sec>
          <Sec title="آخر ما نُشر" testId="recent">
            {data.recent.length === 0 ? <p className="mkt-muted">لا شيء بعد.</p> : <div className="mkt-scroll"><table className="mkt-table"><thead><tr><th>المنشور</th><th>المنصة</th><th>الحالة</th><th>التاريخ</th><th>الرابط</th></tr></thead><tbody>{data.recent.map((r) => (
              <tr key={r.variantId}><td>{r.post.title}</td><td>{platformName(r.platform)}</td><td><StatusChip map={VARIANT_STATUS} value={r.status} /></td><td className="mkt-muted">{fmtDate(r.publishedAt, true)}</td><td>{r.url ? <a href={r.url} target="_blank" rel="noreferrer" className="mkt-chip">فتح</a> : "—"}</td></tr>
            ))}</tbody></table></div>}
          </Sec>
          <Sec title="ما تتيحه كل منصة في هذا الإصدار" caption="حسب الواجهات الرسمية وما طُبّق فعلياً (مصدره ملف تعريف المنصات).">
            <div className="mkt-scroll"><table className="mkt-table"><thead><tr><th>المنصة</th><th>النشر</th><th>ملاحظة</th></tr></thead><tbody>{PLATFORMS.filter((p) => p.organic).map((p) => (
              <tr key={p.key}><td>{p.ar}</td><td>{p.organic!.adapter === "IMPLEMENTED" ? "آلي عبر API (بعد الربط والتحقق)" : p.organic!.adapter === "MANUAL" ? "يدوي مع تأكيد الرابط" : "مخطط"}</td><td className="mkt-muted">{p.organic!.noteAr}</td></tr>
            ))}</tbody></table></div>
          </Sec>
        </>
      ) : null}
      {confirming ? <ConfirmManual o={confirming} onClose={() => setConfirming(null)} onDone={() => { setConfirming(null); reload(); }} /> : null}
    </div>
  );
}

function ConfirmManual({ o, onClose, onDone }: { o: Open; onClose: () => void; onDone: () => void }) {
  const [url, setUrl] = useState("");
  const [err, setErr] = useState("");
  async function save() {
    const r = await api(`/api/marketing/publishing/${o.variantId}`, { method: "POST", body: { action: "confirm", url } });
    if (!r.ok) return setErr(r.data.error ?? "");
    onDone();
  }
  return (
    <Modal title={`تأكيد نشر «${o.post.title}» على ${platformName(o.platform)}`} onClose={onClose} testId="confirm-manual" footer={<><Button variant="secondary" onClick={onClose}>إلغاء</Button><Button onClick={save} testId="confirm-save">تأكيد</Button></>}>
      {err ? <Alert kind="error">{err}</Alert> : null}
      <p className="mkt-muted">انشر النص الجاهز على المنصة أولاً، ثم الصق رابط المنشور الفعلي. يُسجل التأكيد باسمك.</p>
      <Field id="url" label="رابط المنشور" required><TextInput id="url" value={url} onChange={setUrl} placeholder="https://" /></Field>
    </Modal>
  );
}
