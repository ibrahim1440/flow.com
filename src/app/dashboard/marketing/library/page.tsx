"use client";

import { useRef, useState } from "react";
import { useLang, PageHeader, Spinner, Button, Banner, Sec, Chip, useLoad, useMkt, usePageTitle, api, fmtDate, Modal, Field, TextInput, Select, TextArea, Alert, SearchField } from "../_components/ui";
import { ASPECT_GUIDE, ASPECT_FORMAT_EN } from "@/lib/marketing/platforms";
import { localizeApiError } from "@/lib/i18n/api-errors";

/**
 * «مكتبة التصاميم» — designs, photos, videos, source files and approved copy. Every upload is a new
 * version; version 1 is the original and is kept. Rights and source are recorded per asset.
 */

type Version = { id: string; version: number; isOriginal: boolean; fileName: string; mimeType: string; sizeBytes: number; width: number | null; height: number | null; createdAt: string; note: string | null };
type Asset = { id: string; title: string; kind: string; tags: string[]; rights: string; rightsNote: string | null; text: string | null; aiGenerated: boolean; archived: boolean; createdAt: string; campaign: { id: string; name: string } | null; product: { id: string; name: string } | null; versions: Version[]; usedInPosts: number };

const KINDS_AR: Record<string, string> = { IMAGE: "صورة", VIDEO: "فيديو", DESIGN_SOURCE: "ملف تصميم مصدري", DOCUMENT: "مستند", COPY: "نص معتمد" };
const KINDS_EN: Record<string, string> = { IMAGE: "Image", VIDEO: "Video", DESIGN_SOURCE: "Design source file", DOCUMENT: "Document", COPY: "Approved copy" };
const RIGHTS_AR: Record<string, string> = { OWNED: "ملك الشركة", LICENSED: "مرخّص", UGC_PERMISSION: "محتوى عملاء بإذن", STOCK: "مكتبة صور", UNKNOWN: "غير محدد" };
const RIGHTS_EN: Record<string, string> = { OWNED: "Company-owned", LICENSED: "Licensed", UGC_PERMISSION: "Customer content with permission", STOCK: "Stock library", UNKNOWN: "Unspecified" };
/** The kind / rights label maps in the viewer's language. */
function useMaps() {
  const lang = useLang();
  return { lang, KINDS: lang === "ar" ? KINDS_AR : KINDS_EN, RIGHTS: lang === "ar" ? RIGHTS_AR : RIGHTS_EN, L: (ar: string, en: string) => (lang === "ar" ? ar : en) };
}

export default function LibraryPage() {
  const { lang, KINDS, L } = useMaps();
  usePageTitle("مكتبة التصاميم", "Asset library", lang);
  const { can } = useMkt();
  const [q, setQ] = useState("");
  const [kind, setKind] = useState("");
  const [archived, setArchived] = useState(false);
  const { data, error, loading, reload } = useLoad<{ rows: Asset[] }>(`/api/marketing/assets?q=${encodeURIComponent(q)}&kind=${kind}&archived=${archived ? 1 : 0}`);
  const [upload, setUpload] = useState<"file" | "copy" | null>(null);
  const [open, setOpen] = useState<Asset | null>(null);

  return (
    <div className="mkt" data-testid="mkt-library">
      <PageHeader title={L("مكتبة التصاميم والمحتوى", "Design & content library")} subtitle={L("كل رفع جديد إصدار جديد؛ الإصدار الأصلي محفوظ دائماً.", "Every upload is a new version; the original version is always kept.")} actions={can("content_manage") ? <><Button onClick={() => setUpload("file")} testId="upload">{L("رفع ملف", "Upload file")}</Button><Button variant="secondary" onClick={() => setUpload("copy")}>{L("نص معتمد", "Approved copy")}</Button></> : null} />
      <div className="mkt-toolbar">
        <SearchField value={q} onChange={setQ} placeholder={L("ابحث بالعنوان أو الوسم أو النص", "Search by title, tag or text")} label={L("بحث", "Search")} />
        <div className="mkt-narrow"><Select id="k" value={kind} onChange={setKind}><option value="">{L("كل الأنواع", "All types")}</option>{Object.entries(KINDS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select></div>
        <label className="mkt-chip"><input type="checkbox" checked={archived} onChange={(e) => setArchived(e.target.checked)} /> {L("المؤرشف", "Archived")}</label>
      </div>
      <Banner>{error}</Banner>
      {loading && !data ? <Spinner /> : data && data.rows.length === 0 ? <Sec title={L("المكتبة فارغة", "The library is empty")}><p className="mkt-muted">{q || kind ? L("لا نتائج لهذه الفلاتر.", "No results for these filters.") : L("ارفع أول تصميم أو صورة.", "Upload the first design or photo.")}</p></Sec> : (
        <div className="mkt-assets" data-testid="assets">{data?.rows.map((a) => {
          const v = a.versions[0];
          return (
            <button key={a.id} type="button" className="mkt-asset" onClick={() => setOpen(a)} style={{ textAlign: "start" }} data-testid={`asset-${a.id}`}>
              <div className="thumb">{v && v.mimeType.startsWith("image/") && v.mimeType !== "image/vnd.adobe.photoshop" ? // eslint-disable-next-line @next/next/no-img-element -- private, session-authorised route; next/image cannot proxy it
                <img src={`/api/marketing/assets/versions/${v.id}`} alt={a.title} loading="lazy" /> : a.kind === "COPY" ? <span className="mkt-pre" style={{ padding: 8 }}>{(a.text ?? "").slice(0, 120)}</span> : <span>{KINDS[a.kind]} · {v?.fileName}</span>}</div>
              <div className="body">
                <strong className="text-sm">{a.title}</strong>
                <span className="mkt-muted">{KINDS[a.kind]}{v ? ` · v${v.version}${v.width ? ` · ${v.width}×${v.height}` : ""}` : ""} · {(lang === "ar" ? RIGHTS_AR : RIGHTS_EN)[a.rights]}</span>
                <span className="mkt-toolbar">{a.tags.slice(0, 4).map((t) => <Chip key={t}>{t}</Chip>)}{a.aiGenerated ? <Chip tone="info">AI</Chip> : null}</span>
              </div>
            </button>
          );
        })}</div>
      )}
      <Sec title={L("دليل المقاسات", "Size guide")} caption={L("المقاسات الموصى بها حسب المنصة (للتصميم قبل الرفع).", "Recommended sizes per platform (for designing before upload).")}>
        <div className="mkt-scroll"><table className="mkt-table"><thead><tr><th>{L("المنصة", "Platform")}</th><th>{L("الصيغة", "Format")}</th><th>{L("النسبة", "Ratio")}</th><th>{L("البكسل", "Pixels")}</th></tr></thead><tbody>{ASPECT_GUIDE.map((g, i) => <tr key={i}><td>{g.platform}</td><td>{lang === "ar" ? g.format : ASPECT_FORMAT_EN[g.format] ?? g.format}</td><td><bdi>{lang === "ar" ? g.ratio : g.ratio.replace(/ أو /g, " or ")}</bdi></td><td><bdi>{g.px}</bdi></td></tr>)}</tbody></table></div>
      </Sec>
      {upload ? <UploadDialog mode={upload} onClose={() => setUpload(null)} onDone={() => { setUpload(null); reload(); }} /> : null}
      {open ? <AssetDialog asset={open} onClose={() => setOpen(null)} onChanged={() => { setOpen(null); reload(); }} canEdit={can("content_manage")} /> : null}
    </div>
  );
}

function MetaFields({ f, set }: { f: Record<string, string>; set: (k: string) => (v: string) => void }) {
  const { RIGHTS, L } = useMaps();
  const campaigns = useLoad<{ rows: { id: string; name: string }[] }>("/api/marketing/campaigns");
  const products = useLoad<{ rows: { id: string; name: string }[] }>("/api/marketing/products");
  return (
    <div className="mkt-grid-2">
      <Field id="a-title" label={L("العنوان", "Title")} required><TextInput id="a-title" value={f.title} onChange={set("title")} /></Field>
      <Field id="a-tags" label={L("الوسوم (بفاصلة)", "Tags (comma separated)")}><TextInput id="a-tags" value={f.tags} onChange={set("tags")} /></Field>
      <Field id="a-camp" label={L("الحملة", "Campaign")}><Select id="a-camp" value={f.campaignId} onChange={set("campaignId")}><option value="">—</option>{campaigns.data?.rows.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select></Field>
      <Field id="a-prod" label={L("المنتج", "Product")}><Select id="a-prod" value={f.productId} onChange={set("productId")}><option value="">—</option>{products.data?.rows.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select></Field>
      <Field id="a-rights" label={L("حقوق الاستخدام", "Usage rights")}><Select id="a-rights" value={f.rights} onChange={set("rights")}>{Object.entries(RIGHTS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select></Field>
      <Field id="a-rn" label={L("مصدر الحقوق / المصمم", "Rights source / designer")}><TextInput id="a-rn" value={f.rightsNote} onChange={set("rightsNote")} /></Field>
    </div>
  );
}

function UploadDialog({ mode, onClose, onDone }: { mode: "file" | "copy"; onClose: () => void; onDone: () => void }) {
  const { KINDS, L, lang } = useMaps();
  const [f, setF] = useState<Record<string, string>>({ title: "", tags: "", campaignId: "", productId: "", rights: "OWNED", rightsNote: "", kind: "IMAGE", text: "", note: "" });
  const file = useRef<HTMLInputElement>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const set = (k: string) => (v: string) => setF((s) => ({ ...s, [k]: v }));
  async function save() {
    setBusy(true); setErr("");
    if (mode === "copy") {
      const r = await api("/api/marketing/assets", { method: "POST", body: { ...f, kind: "COPY", tags: f.tags.split(/[,،]/).map((t) => t.trim()).filter(Boolean), campaignId: f.campaignId || null, productId: f.productId || null } });
      setBusy(false);
      return r.ok ? onDone() : setErr(r.data.error ?? "");
    }
    const fd = new FormData();
    const fl = file.current?.files?.[0];
    if (!fl) { setBusy(false); return setErr(L("اختر ملفاً.", "Choose a file.")); }
    fd.set("file", fl);
    for (const k of ["title", "tags", "campaignId", "productId", "rights", "rightsNote", "kind", "note"]) fd.set(k, f[k]);
    const res = await fetch("/api/marketing/assets", { method: "POST", body: fd });
    const body = await res.json().catch(() => ({}));
    setBusy(false);
    return res.ok ? onDone() : setErr(localizeApiError(body, lang) ?? L("تعذر الرفع.", "Upload failed."));
  }
  return (
    <Modal title={mode === "file" ? L("رفع ملف", "Upload file") : L("نص معتمد", "Approved copy")} onClose={onClose} wide testId="upload-dialog" footer={<><Button variant="secondary" onClick={onClose}>{L("إلغاء", "Cancel")}</Button><Button onClick={save} disabled={busy} testId="save-asset">{L("حفظ", "Save")}</Button></>}>
      {err ? <Alert kind="error">{err}</Alert> : null}
      {mode === "file" ? <>
        <Field id="a-file" label={L("الملف", "File")} hint={L("JPG, PNG, WEBP, GIF, MP4, MOV, PDF, PSD — حتى 4 ميغابايت في هذه المرحلة.", "JPG, PNG, WEBP, GIF, MP4, MOV, PDF, PSD — up to 4 MB at this stage.")}><input id="a-file" ref={file} type="file" accept="image/jpeg,image/png,image/webp,image/gif,video/mp4,video/quicktime,application/pdf,.psd" /></Field>
        <Field id="a-kind" label={L("النوع", "Type")}><Select id="a-kind" value={f.kind} onChange={set("kind")}>{Object.entries(KINDS).filter(([k]) => k !== "COPY").map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select></Field>
      </> : <Field id="a-text" label={L("النص", "Text")} required><TextArea id="a-text" value={f.text} onChange={set("text")} rows={6} /></Field>}
      <MetaFields f={f} set={set} />
    </Modal>
  );
}

function AssetDialog({ asset, onClose, onChanged, canEdit }: { asset: Asset; onClose: () => void; onChanged: () => void; canEdit: boolean }) {
  const { KINDS, RIGHTS, L, lang } = useMaps();
  const file = useRef<HTMLInputElement>(null);
  const [err, setErr] = useState("");
  async function newVersion() {
    const fl = file.current?.files?.[0];
    if (!fl) return setErr(L("اختر ملفاً.", "Choose a file."));
    const fd = new FormData();
    fd.set("file", fl);
    fd.set("note", prompt(L("ملاحظة الإصدار:", "Version note:")) ?? "");
    const res = await fetch(`/api/marketing/assets/${asset.id}`, { method: "POST", body: fd });
    const b = await res.json().catch(() => ({}));
    if (!res.ok) return setErr(localizeApiError(b, lang) ?? "");
    onChanged();
  }
  async function archive() {
    const r = await api(`/api/marketing/assets/${asset.id}`, { method: "PATCH", body: { archived: !asset.archived } });
    if (!r.ok) return setErr(r.data.error ?? "");
    onChanged();
  }
  return (
    <Modal title={asset.title} onClose={onClose} wide testId="asset-dialog" footer={<>{canEdit ? <Button variant="secondary" onClick={archive}>{asset.archived ? L("إلغاء الأرشفة", "Unarchive") : L("أرشفة", "Archive")}</Button> : null}<Button variant="secondary" onClick={onClose}>{L("إغلاق", "Close")}</Button></>}>
      {err ? <Alert kind="error">{err}</Alert> : null}
      <p className="mkt-muted">{KINDS[asset.kind]} · {RIGHTS[asset.rights]}{asset.rightsNote ? ` (${asset.rightsNote})` : ""} · {L("الحملة:", "Campaign:")} {asset.campaign?.name ?? "—"} · {L("المنتج:", "Product:")} {asset.product?.name ?? "—"} · {L(`مستخدم في ${asset.usedInPosts} منشور`, `Used in ${asset.usedInPosts} posts`)}</p>
      {asset.text ? <p className="mkt-pre mkt-sec">{asset.text}</p> : null}
      {asset.versions.length ? <table className="mkt-table"><thead><tr><th>{L("الإصدار", "Version")}</th><th>{L("الملف", "File")}</th><th>{L("الأبعاد", "Dimensions")}</th><th className="n">{L("الحجم", "Size")}</th><th>{L("التاريخ", "Date")}</th><th /></tr></thead><tbody>{asset.versions.map((v) => (
        <tr key={v.id}><td>v{v.version}{v.isOriginal ? L(" (الأصل)", " (original)") : ""}</td><td><bdi>{v.fileName}</bdi>{v.note ? <div className="mkt-muted">{v.note}</div> : null}</td><td><bdi>{v.width ? `${v.width}×${v.height}` : "—"}</bdi></td><td className="n">{(v.sizeBytes / 1024).toFixed(0)} KB</td><td className="mkt-muted">{fmtDate(v.createdAt, true)}</td><td><a className="mkt-chip" href={`/api/marketing/assets/versions/${v.id}?download=1`}>{L("تنزيل", "Download")}</a></td></tr>
      ))}</tbody></table> : null}
      {canEdit && asset.kind !== "COPY" && !asset.archived ? <Field id="nv" label={L("رفع إصدار جديد (لا يستبدل الأصل)", "Upload a new version (does not replace the original)")}><div className="mkt-toolbar"><input id="nv" ref={file} type="file" /><Button variant="secondary" onClick={newVersion}>{L("رفع الإصدار", "Upload version")}</Button></div></Field> : null}
    </Modal>
  );
}
