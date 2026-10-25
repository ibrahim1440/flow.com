"use client";

import { useRef, useState } from "react";
import { useLang, PageHeader, Spinner, Button, Banner, Sec, Chip, useLoad, useMkt, usePageTitle, api, fmtDate, Modal, Field, TextInput, Select, TextArea, Alert, SearchField } from "../_components/ui";
import { ASPECT_GUIDE } from "@/lib/marketing/platforms";

/**
 * «مكتبة التصاميم» — designs, photos, videos, source files and approved copy. Every upload is a new
 * version; version 1 is the original and is kept. Rights and source are recorded per asset.
 */

type Version = { id: string; version: number; isOriginal: boolean; fileName: string; mimeType: string; sizeBytes: number; width: number | null; height: number | null; createdAt: string; note: string | null };
type Asset = { id: string; title: string; kind: string; tags: string[]; rights: string; rightsNote: string | null; text: string | null; aiGenerated: boolean; archived: boolean; createdAt: string; campaign: { id: string; name: string } | null; product: { id: string; name: string } | null; versions: Version[]; usedInPosts: number };

const KINDS: Record<string, string> = { IMAGE: "صورة", VIDEO: "فيديو", DESIGN_SOURCE: "ملف تصميم مصدري", DOCUMENT: "مستند", COPY: "نص معتمد" };
const RIGHTS: Record<string, string> = { OWNED: "ملك الشركة", LICENSED: "مرخّص", UGC_PERMISSION: "محتوى عملاء بإذن", STOCK: "مكتبة صور", UNKNOWN: "غير محدد" };

export default function LibraryPage() {
  const lang = useLang();
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
      <PageHeader title="مكتبة التصاميم والمحتوى" subtitle="كل رفع جديد إصدار جديد؛ الإصدار الأصلي محفوظ دائماً." actions={can("content_manage") ? <><Button onClick={() => setUpload("file")} testId="upload">رفع ملف</Button><Button variant="secondary" onClick={() => setUpload("copy")}>نص معتمد</Button></> : null} />
      <div className="mkt-toolbar">
        <SearchField value={q} onChange={setQ} placeholder="ابحث بالعنوان أو الوسم أو النص" label="بحث" />
        <div className="mkt-narrow"><Select id="k" value={kind} onChange={setKind}><option value="">كل الأنواع</option>{Object.entries(KINDS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select></div>
        <label className="mkt-chip"><input type="checkbox" checked={archived} onChange={(e) => setArchived(e.target.checked)} /> المؤرشف</label>
      </div>
      <Banner>{error}</Banner>
      {loading && !data ? <Spinner /> : data && data.rows.length === 0 ? <Sec title="المكتبة فارغة"><p className="mkt-muted">{q || kind ? "لا نتائج لهذه الفلاتر." : "ارفع أول تصميم أو صورة."}</p></Sec> : (
        <div className="mkt-assets" data-testid="assets">{data?.rows.map((a) => {
          const v = a.versions[0];
          return (
            <button key={a.id} type="button" className="mkt-asset" onClick={() => setOpen(a)} style={{ textAlign: "start" }} data-testid={`asset-${a.id}`}>
              <div className="thumb">{v && v.mimeType.startsWith("image/") && v.mimeType !== "image/vnd.adobe.photoshop" ? // eslint-disable-next-line @next/next/no-img-element -- private, session-authorised route; next/image cannot proxy it
                <img src={`/api/marketing/assets/versions/${v.id}`} alt={a.title} loading="lazy" /> : a.kind === "COPY" ? <span className="mkt-pre" style={{ padding: 8 }}>{(a.text ?? "").slice(0, 120)}</span> : <span>{KINDS[a.kind]} · {v?.fileName}</span>}</div>
              <div className="body">
                <strong className="text-sm">{a.title}</strong>
                <span className="mkt-muted">{KINDS[a.kind]}{v ? ` · v${v.version}${v.width ? ` · ${v.width}×${v.height}` : ""}` : ""} · {RIGHTS[a.rights]}</span>
                <span className="mkt-toolbar">{a.tags.slice(0, 4).map((t) => <Chip key={t}>{t}</Chip>)}{a.aiGenerated ? <Chip tone="info">AI</Chip> : null}</span>
              </div>
            </button>
          );
        })}</div>
      )}
      <Sec title="دليل المقاسات" caption="المقاسات الموصى بها حسب المنصة (للتصميم قبل الرفع).">
        <div className="mkt-scroll"><table className="mkt-table"><thead><tr><th>المنصة</th><th>الصيغة</th><th>النسبة</th><th>البكسل</th></tr></thead><tbody>{ASPECT_GUIDE.map((g, i) => <tr key={i}><td>{g.platform}</td><td>{g.format}</td><td><bdi>{g.ratio}</bdi></td><td><bdi>{g.px}</bdi></td></tr>)}</tbody></table></div>
      </Sec>
      {upload ? <UploadDialog mode={upload} onClose={() => setUpload(null)} onDone={() => { setUpload(null); reload(); }} /> : null}
      {open ? <AssetDialog asset={open} onClose={() => setOpen(null)} onChanged={() => { setOpen(null); reload(); }} canEdit={can("content_manage")} /> : null}
    </div>
  );
}

function MetaFields({ f, set }: { f: Record<string, string>; set: (k: string) => (v: string) => void }) {
  const campaigns = useLoad<{ rows: { id: string; name: string }[] }>("/api/marketing/campaigns");
  const products = useLoad<{ rows: { id: string; name: string }[] }>("/api/marketing/products");
  return (
    <div className="mkt-grid-2">
      <Field id="a-title" label="العنوان" required><TextInput id="a-title" value={f.title} onChange={set("title")} /></Field>
      <Field id="a-tags" label="الوسوم (بفاصلة)"><TextInput id="a-tags" value={f.tags} onChange={set("tags")} /></Field>
      <Field id="a-camp" label="الحملة"><Select id="a-camp" value={f.campaignId} onChange={set("campaignId")}><option value="">—</option>{campaigns.data?.rows.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select></Field>
      <Field id="a-prod" label="المنتج"><Select id="a-prod" value={f.productId} onChange={set("productId")}><option value="">—</option>{products.data?.rows.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select></Field>
      <Field id="a-rights" label="حقوق الاستخدام"><Select id="a-rights" value={f.rights} onChange={set("rights")}>{Object.entries(RIGHTS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select></Field>
      <Field id="a-rn" label="مصدر الحقوق / المصمم"><TextInput id="a-rn" value={f.rightsNote} onChange={set("rightsNote")} /></Field>
    </div>
  );
}

function UploadDialog({ mode, onClose, onDone }: { mode: "file" | "copy"; onClose: () => void; onDone: () => void }) {
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
    if (!fl) { setBusy(false); return setErr("اختر ملفاً."); }
    fd.set("file", fl);
    for (const k of ["title", "tags", "campaignId", "productId", "rights", "rightsNote", "kind", "note"]) fd.set(k, f[k]);
    const res = await fetch("/api/marketing/assets", { method: "POST", body: fd });
    const body = await res.json().catch(() => ({}));
    setBusy(false);
    return res.ok ? onDone() : setErr((body as { error?: string }).error ?? "تعذر الرفع.");
  }
  return (
    <Modal title={mode === "file" ? "رفع ملف" : "نص معتمد"} onClose={onClose} wide testId="upload-dialog" footer={<><Button variant="secondary" onClick={onClose}>إلغاء</Button><Button onClick={save} disabled={busy} testId="save-asset">حفظ</Button></>}>
      {err ? <Alert kind="error">{err}</Alert> : null}
      {mode === "file" ? <>
        <Field id="a-file" label="الملف" hint="JPG, PNG, WEBP, GIF, MP4, MOV, PDF, PSD — حتى 4 ميغابايت في هذه المرحلة."><input id="a-file" ref={file} type="file" accept="image/jpeg,image/png,image/webp,image/gif,video/mp4,video/quicktime,application/pdf,.psd" /></Field>
        <Field id="a-kind" label="النوع"><Select id="a-kind" value={f.kind} onChange={set("kind")}>{Object.entries(KINDS).filter(([k]) => k !== "COPY").map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select></Field>
      </> : <Field id="a-text" label="النص" required><TextArea id="a-text" value={f.text} onChange={set("text")} rows={6} /></Field>}
      <MetaFields f={f} set={set} />
    </Modal>
  );
}

function AssetDialog({ asset, onClose, onChanged, canEdit }: { asset: Asset; onClose: () => void; onChanged: () => void; canEdit: boolean }) {
  const file = useRef<HTMLInputElement>(null);
  const [err, setErr] = useState("");
  async function newVersion() {
    const fl = file.current?.files?.[0];
    if (!fl) return setErr("اختر ملفاً.");
    const fd = new FormData();
    fd.set("file", fl);
    fd.set("note", prompt("ملاحظة الإصدار:") ?? "");
    const res = await fetch(`/api/marketing/assets/${asset.id}`, { method: "POST", body: fd });
    const b = await res.json().catch(() => ({}));
    if (!res.ok) return setErr((b as { error?: string }).error ?? "");
    onChanged();
  }
  async function archive() {
    const r = await api(`/api/marketing/assets/${asset.id}`, { method: "PATCH", body: { archived: !asset.archived } });
    if (!r.ok) return setErr(r.data.error ?? "");
    onChanged();
  }
  return (
    <Modal title={asset.title} onClose={onClose} wide testId="asset-dialog" footer={<>{canEdit ? <Button variant="secondary" onClick={archive}>{asset.archived ? "إلغاء الأرشفة" : "أرشفة"}</Button> : null}<Button variant="secondary" onClick={onClose}>إغلاق</Button></>}>
      {err ? <Alert kind="error">{err}</Alert> : null}
      <p className="mkt-muted">{KINDS[asset.kind]} · {RIGHTS[asset.rights]}{asset.rightsNote ? ` (${asset.rightsNote})` : ""} · الحملة: {asset.campaign?.name ?? "—"} · المنتج: {asset.product?.name ?? "—"} · مستخدم في {asset.usedInPosts} منشور</p>
      {asset.text ? <p className="mkt-pre mkt-sec">{asset.text}</p> : null}
      {asset.versions.length ? <table className="mkt-table"><thead><tr><th>الإصدار</th><th>الملف</th><th>الأبعاد</th><th className="n">الحجم</th><th>التاريخ</th><th /></tr></thead><tbody>{asset.versions.map((v) => (
        <tr key={v.id}><td>v{v.version}{v.isOriginal ? " (الأصل)" : ""}</td><td><bdi>{v.fileName}</bdi>{v.note ? <div className="mkt-muted">{v.note}</div> : null}</td><td><bdi>{v.width ? `${v.width}×${v.height}` : "—"}</bdi></td><td className="n">{(v.sizeBytes / 1024).toFixed(0)} KB</td><td className="mkt-muted">{fmtDate(v.createdAt, true)}</td><td><a className="mkt-chip" href={`/api/marketing/assets/versions/${v.id}?download=1`}>تنزيل</a></td></tr>
      ))}</tbody></table> : null}
      {canEdit && asset.kind !== "COPY" && !asset.archived ? <Field id="nv" label="رفع إصدار جديد (لا يستبدل الأصل)"><div className="mkt-toolbar"><input id="nv" ref={file} type="file" /><Button variant="secondary" onClick={newVersion}>رفع الإصدار</Button></div></Field> : null}
    </Modal>
  );
}
