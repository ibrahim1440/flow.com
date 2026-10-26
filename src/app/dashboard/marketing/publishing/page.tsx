"use client";

import { useState } from "react";
import { useLang, PageHeader, Spinner, Button, Banner, Sec, StatusChip, useLoad, useMkt, usePageTitle, api, platformName, fmtDate, VARIANT_STATUS, Modal, Field, TextInput, Alert } from "../_components/ui";
import { PLATFORMS, platformText } from "@/lib/marketing/platforms";

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
  const L = (ar: string, en: string) => (lang === "ar" ? ar : en);
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
    setMsg(r.data.skipped ? L("الإيقاف الطارئ للنشر مفعّل؛ لم يُنشر شيء.", "The publishing emergency stop is on; nothing was published.") : L(`منشورات حان موعدها: ${r.data.duePosts} · عمليات: ${r.data.jobsRun} · نُشر: ${r.data.published} · يدوي: ${r.data.manual} · فشل: ${r.data.failed}`, `Posts due: ${r.data.duePosts} · jobs: ${r.data.jobsRun} · published: ${r.data.published} · manual: ${r.data.manual} · failed: ${r.data.failed}`));
    reload();
  }
  async function retry(o: Open) {
    let confirmNotPublished = false;
    if (o.lastError?.includes("قد يكون نُشر")) {
      confirmNotPublished = confirm(L("نتيجة المحاولة السابقة غير معروفة. هل تأكدت من المنصة أن المنشور لم يُنشر؟", "The previous attempt's result is unknown. Have you checked on the platform that the post was not published?"));
      if (!confirmNotPublished) return;
    }
    const r = await api(`/api/marketing/publishing/${o.variantId}`, { method: "POST", body: { action: "retry", confirmNotPublished } });
    if (!r.ok) return setErr(r.data.error ?? "");
    reload();
  }

  return (
    <div className="mkt" data-testid="mkt-publishing">
      <PageHeader title={L("مركز النشر الموحد", "Unified publishing hub")} subtitle={L("النشر العضوي فقط؛ الإعلانات المدفوعة مسار منفصل في الحملات.", "Organic publishing only; paid ads are a separate track in Campaigns.")} actions={can("publish") ? <Button onClick={runNow} disabled={busy} testId="run-publisher">{L("تشغيل قائمة النشر الآن", "Run the publishing queue now")}</Button> : null} />
      <Banner tone="info" onClose={() => setMsg("")}>{msg}</Banner>
      <Banner onClose={() => setErr("")}>{err || error}</Banner>
      {loading && !data ? <Spinner /> : data ? (
        <>
          <Sec title={L(`بانتظار إجراء (${data.open.length})`, `Awaiting action (${data.open.length})`)} testId="open">
            {data.open.length === 0 ? <p className="mkt-muted">{L("لا شيء في القائمة.", "Nothing in the queue.")}</p> : <div className="mkt-list">{data.open.map((o) => (
              <div key={o.variantId} className="mkt-item" data-testid={`open-${o.variantId}`}>
                <div style={{ minWidth: 0 }}>
                  <div className="t">{o.post.title} · {platformName(o.platform, lang)}</div>
                  <div className="s">{L("موعده", "Due")} {fmtDate(o.post.scheduledAt, true)}{o.job ? L(` · محاولات ${o.job.attempts}`, ` · attempts ${o.job.attempts}`) : ""}{o.lastError ? ` · ${o.lastError}` : ""}</div>
                  {o.status === "MANUAL_REQUIRED" ? <details><summary className="mkt-muted">{L("النص الجاهز للنسخ", "Text ready to copy")}</summary><p className="mkt-pre">{o.preparedText}</p><button type="button" className="mkt-chip" onClick={() => navigator.clipboard?.writeText(o.preparedText)}>{L("نسخ النص", "Copy text")}</button></details> : null}
                </div>
                <div className="mkt-toolbar">
                  <StatusChip map={VARIANT_STATUS} value={o.status} />
                  {can("publish") && (o.status === "MANUAL_REQUIRED" || o.status === "FAILED") ? <Button variant="secondary" onClick={() => setConfirming(o)} testId={`confirm-${o.variantId}`}>{L("تأكيد النشر اليدوي", "Confirm manual publishing")}</Button> : null}
                  {can("publish") && o.status === "FAILED" ? <Button variant="secondary" onClick={() => retry(o)}>{L("إعادة المحاولة", "Retry")}</Button> : null}
                </div>
              </div>
            ))}</div>}
          </Sec>
          <Sec title={L("آخر ما نُشر", "Recently published")} testId="recent">
            {data.recent.length === 0 ? <p className="mkt-muted">{L("لا شيء بعد.", "Nothing yet.")}</p> : <div className="mkt-scroll"><table className="mkt-table"><thead><tr><th>{L("المنشور", "Post")}</th><th>{L("المنصة", "Platform")}</th><th>{L("الحالة", "Status")}</th><th>{L("التاريخ", "Date")}</th><th>{L("الرابط", "Link")}</th></tr></thead><tbody>{data.recent.map((r) => (
              <tr key={r.variantId}><td>{r.post.title}</td><td>{platformName(r.platform, lang)}</td><td><StatusChip map={VARIANT_STATUS} value={r.status} /></td><td className="mkt-muted">{fmtDate(r.publishedAt, true)}</td><td>{r.url ? <a href={r.url} target="_blank" rel="noreferrer" className="mkt-chip">{L("فتح", "Open")}</a> : "—"}</td></tr>
            ))}</tbody></table></div>}
          </Sec>
          <Sec title={L("ما تتيحه كل منصة في هذا الإصدار", "What each platform allows in this release")} caption={L("حسب الواجهات الرسمية وما طُبّق فعلياً (مصدره ملف تعريف المنصات).", "Per the official interfaces and what is actually implemented (from the platform registry).")}>
            <div className="mkt-scroll"><table className="mkt-table"><thead><tr><th>{L("المنصة", "Platform")}</th><th>{L("النشر", "Publishing")}</th><th>{L("ملاحظة", "Note")}</th></tr></thead><tbody>{PLATFORMS.filter((p) => p.organic).map((p) => (
              <tr key={p.key}><td>{L(p.ar, p.en)}</td><td>{p.organic!.adapter === "IMPLEMENTED" ? L("آلي عبر API (بعد الربط والتحقق)", "Automatic via API (after connecting and verifying)") : p.organic!.adapter === "MANUAL" ? L("يدوي مع تأكيد الرابط", "Manual, with the link confirmed") : L("مخطط", "Planned")}</td><td className="mkt-muted">{platformText(p.organic!.noteAr, lang)}</td></tr>
            ))}</tbody></table></div>
          </Sec>
        </>
      ) : null}
      {confirming ? <ConfirmManual o={confirming} onClose={() => setConfirming(null)} onDone={() => { setConfirming(null); reload(); }} /> : null}
    </div>
  );
}

function ConfirmManual({ o, onClose, onDone }: { o: Open; onClose: () => void; onDone: () => void }) {
  const lang = useLang();
  const L = (ar: string, en: string) => (lang === "ar" ? ar : en);
  const [url, setUrl] = useState("");
  const [err, setErr] = useState("");
  async function save() {
    const r = await api(`/api/marketing/publishing/${o.variantId}`, { method: "POST", body: { action: "confirm", url } });
    if (!r.ok) return setErr(r.data.error ?? "");
    onDone();
  }
  return (
    <Modal title={L(`تأكيد نشر «${o.post.title}» على ${platformName(o.platform, lang)}`, `Confirm publishing “${o.post.title}” on ${platformName(o.platform, lang)}`)} onClose={onClose} testId="confirm-manual" footer={<><Button variant="secondary" onClick={onClose}>{L("إلغاء", "Cancel")}</Button><Button onClick={save} testId="confirm-save">{L("تأكيد", "Confirm")}</Button></>}>
      {err ? <Alert kind="error">{err}</Alert> : null}
      <p className="mkt-muted">{L("انشر النص الجاهز على المنصة أولاً، ثم الصق رابط المنشور الفعلي. يُسجل التأكيد باسمك.", "Publish the prepared text on the platform first, then paste the live post's link. The confirmation is recorded under your name.")}</p>
      <Field id="url" label={L("رابط المنشور", "Post link")} required><TextInput id="url" value={url} onChange={setUrl} placeholder="https://" /></Field>
    </Modal>
  );
}
