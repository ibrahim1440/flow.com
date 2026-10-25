"use client";

import { useState } from "react";
import { Modal, Button, Field, TextInput, Select, TextArea, Alert, api, useLoad, StatusChip, VARIANT_STATUS, POST_STATUS, APPROVAL_STATUS, Chip, fmtDate, platformName, useMkt } from "../_components/ui";
import { SOCIAL_PLATFORMS, PLATFORM } from "@/lib/marketing/platforms";
import { composeCaption as composeCaptionPreview } from "@/lib/marketing/compose";

export type PostRow = {
  id: string; title: string; objective: string; audience: string | null; contentType: string; caption: string; hashtags: string[]; link: string | null; cta: string | null;
  scheduledAt: string | null; status: string; aiGenerated: boolean; brief: Record<string, string> | null;
  campaign: { id: string; name: string; utmCampaign: string } | null; product: { id: string; name: string } | null;
  variants: { id: string; platform: string; caption: string | null; hashtags: string[]; status: string; externalUrl: string | null; lastError: string | null }[];
  assets: { assetId: string; title: string; kind: string; latest: { id: string; mimeType: string } | null }[];
};

type Detail = {
  post: PostRow;
  readiness: { blocking: string[]; warnings: string[]; perPlatform: Record<string, string[]> };
  history: { id: string; actorName: string | null; field: string; before: string | null; after: string | null; reason: string | null; at: string }[];
  approvals: { id: string; status: string; requestedByName: string | null; decidedByName: string | null; decisionNote: string | null; createdAt: string }[];
};

const OBJ: Record<string, string> = { AWARENESS: "الوعي", ENGAGEMENT: "التفاعل", TRAFFIC: "الزيارات", CONVERSIONS: "التحويلات", SALES: "المبيعات" };
const TYPES: Record<string, string> = { POST: "منشور", REEL: "ريلز", STORY: "قصة", VIDEO: "فيديو", CAROUSEL: "عرض شرائح", SHORT: "Shorts", ARTICLE: "مقال", PIN: "دبوس" };
const toLocalInput = (iso: string | null) => (iso ? new Date(new Date(iso).getTime() + 3 * 3600_000).toISOString().slice(0, 16) : "");

export function PostEditor({ postId, initialDate, onClose, onSaved }: { postId: string | null; initialDate?: string; onClose: () => void; onSaved: () => void }) {
  const detail = useLoad<Detail>(postId ? `/api/marketing/posts/${postId}` : null);
  if (postId && !detail.data) {
    return <Modal title="المنشور" onClose={onClose}>{detail.error ? <Alert kind="error">{detail.error}</Alert> : <p className="mkt-muted">جارٍ التحميل…</p>}</Modal>;
  }
  // Keyed by the post's last update, so a reload after saving starts the form from the stored post.
  return <EditorBody key={detail.data ? `${detail.data.post.id}:${detail.data.post.status}:${detail.data.history[0]?.id ?? ""}` : "new"} postId={postId} detail={detail.data} reload={detail.reload} initialDate={initialDate} onClose={onClose} onSaved={onSaved} />;
}

function initialForm(p: PostRow | null, initialDate?: string) {
  return {
    title: p?.title ?? "", objective: p?.objective ?? "AWARENESS", audience: p?.audience ?? "", contentType: p?.contentType ?? "POST", caption: p?.caption ?? "",
    hashtags: p?.hashtags.join(" ") ?? "", link: p?.link ?? "", cta: p?.cta ?? "", scheduledAt: p ? toLocalInput(p.scheduledAt) : initialDate ? `${initialDate}T19:00` : "",
    campaignId: p?.campaign?.id ?? "", productId: p?.product?.id ?? "", platforms: p?.variants.map((v) => v.platform) ?? ([] as string[]), assetIds: p?.assets.map((a) => a.assetId) ?? ([] as string[]),
    overrides: Object.fromEntries((p?.variants ?? []).filter((v) => v.caption).map((v) => [v.platform, v.caption!])) as Record<string, string>,
    brief: { goal: "", audience: "", message: "", offer: "", cta: "", size: "", platform: "", ...(p?.brief ?? {}) } as Record<string, string>, reason: "",
  };
}

function EditorBody({ postId, detail, reload, initialDate, onClose, onSaved }: { postId: string | null; detail: Detail | null; reload: () => void; initialDate?: string; onClose: () => void; onSaved: () => void }) {
  const { can } = useMkt();
  const campaigns = useLoad<{ rows: { id: string; name: string; landingUrl: string | null }[] }>("/api/marketing/campaigns");
  const products = useLoad<{ rows: { id: string; name: string }[] }>("/api/marketing/products");
  const assets = useLoad<{ rows: { id: string; title: string; kind: string; versions: { id: string; mimeType: string }[] }[] }>("/api/marketing/assets");
  const p = detail?.post ?? null;
  const [f, setF] = useState(() => initialForm(p, initialDate));
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<"content" | "brief" | "preview" | "history">("content");
  const editable = !p || ["DRAFT", "IN_REVIEW", "APPROVED", "SCHEDULED", "FAILED"].includes(p.status);

  const set = (k: keyof typeof f) => (v: string) => setF((s) => ({ ...s, [k]: v }));
  const tog = (k: "platforms" | "assetIds", v: string) => setF((s) => ({ ...s, [k]: s[k].includes(v) ? s[k].filter((x) => x !== v) : [...s[k], v] }));

  function body() {
    return {
      title: f.title, objective: f.objective, audience: f.audience || null, contentType: f.contentType, caption: f.caption,
      hashtags: f.hashtags.split(/[\s,،]+/).filter(Boolean), link: f.link || null, cta: f.cta || null, campaignId: f.campaignId || null, productId: f.productId || null,
      platforms: f.platforms, assetIds: f.assetIds, brief: f.brief, reason: f.reason || null,
      variants: f.platforms.map((pl) => ({ platform: pl, caption: f.overrides[pl] || null, hashtags: [] })),
    };
  }

  async function save(): Promise<string | null> {
    setBusy(true);
    setErr("");
    let id = postId;
    if (!postId) {
      const r = await api<{ id: string }>("/api/marketing/posts", { method: "POST", body: { ...body(), scheduledAt: f.scheduledAt ? `${f.scheduledAt}:00+03:00` : null } });
      setBusy(false);
      if (!r.ok) { setErr(r.data.error ?? ""); return null; }
      id = r.data.id;
    } else {
      const r = await api(`/api/marketing/posts/${postId}`, { method: "PATCH", body: body() });
      if (!r.ok) { setBusy(false); setErr(r.data.error ?? ""); return null; }
      const when = f.scheduledAt ? new Date(`${f.scheduledAt}:00+03:00`).toISOString() : null;
      if (when !== (p?.scheduledAt ? new Date(p.scheduledAt).toISOString() : null)) {
        const s = await api(`/api/marketing/posts/${postId}/schedule`, { method: "POST", body: { scheduledAt: when, reason: f.reason || null } });
        if (!s.ok) { setBusy(false); setErr(s.data.error ?? ""); return null; }
      }
      setBusy(false);
    }
    return id;
  }

  async function saveAndClose() { if (await save()) onSaved(); }
  async function submit() {
    const id = await save();
    if (!id) return;
    const r = await api<{ status: string }>(`/api/marketing/posts/${id}/submit`, { method: "POST", body: { note: f.reason || null } });
    if (!r.ok) { setErr(r.data.error ?? ""); reload(); return; }
    onSaved();
  }
  async function cancel() {
    const reason = prompt("سبب الإلغاء:");
    if (reason === null) return;
    const r = await api(`/api/marketing/posts/${postId}?reason=${encodeURIComponent(reason)}`, { method: "DELETE" });
    if (!r.ok) return setErr(r.data.error ?? "");
    onSaved();
  }

  const campaign = campaigns.data?.rows.find((c) => c.id === f.campaignId);
  return (
    <Modal title={p ? p.title : "منشور جديد"} onClose={onClose} wide testId="post-editor"
      footer={<>
        {p && editable && can("content_manage") ? <Button variant="danger" onClick={cancel}>إلغاء المنشور</Button> : null}
        <Button variant="secondary" onClick={onClose}>إغلاق</Button>
        {editable && can("content_manage") ? <Button variant="secondary" onClick={saveAndClose} disabled={busy} testId="save-post">حفظ</Button> : null}
        {editable && can("publish") && (!p || ["DRAFT", "FAILED"].includes(p.status)) ? <Button onClick={submit} disabled={busy} testId="submit-post">حفظ وإرسال للاعتماد / الجدولة</Button> : null}
      </>}>
      {err ? <Alert kind="error">{err}</Alert> : null}
      {p ? <div className="mkt-toolbar"><StatusChip map={POST_STATUS} value={p.status} testId="post-status" />{p.aiGenerated ? <Chip tone="info">مولّد بالذكاء الاصطناعي — يخضع لسياسة اعتماد محتوى الذكاء الاصطناعي</Chip> : null}{p.campaign ? <Chip>{p.campaign.name}</Chip> : null}</div> : null}
      {detail?.readiness ? <Readiness r={detail.readiness} /> : null}
      <div className="mkt-seg" role="tablist">
        {(["content", "brief", "preview", ...(p ? ["history"] : [])] as const).map((t) => <button key={t} type="button" role="tab" aria-selected={tab === t} onClick={() => setTab(t as typeof tab)}>{{ content: "المحتوى", brief: "الموجز", preview: "المعاينة", history: "السجل" }[t]}</button>)}
      </div>

      {tab === "content" ? (
        <fieldset disabled={!editable || !can("content_manage")} className="space-y-4">
          <div className="mkt-grid-2">
            <Field id="p-title" label="اسم المنشور" required><TextInput id="p-title" value={f.title} onChange={set("title")} /></Field>
            <Field id="p-when" label="موعد النشر (بتوقيت الرياض)"><TextInput id="p-when" type="datetime-local" value={f.scheduledAt} onChange={set("scheduledAt")} /></Field>
            <Field id="p-camp" label="الحملة"><Select id="p-camp" value={f.campaignId} onChange={set("campaignId")}><option value="">—</option>{campaigns.data?.rows.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select></Field>
            <Field id="p-prod" label="المنتج"><Select id="p-prod" value={f.productId} onChange={set("productId")}><option value="">—</option>{products.data?.rows.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</Select></Field>
            <Field id="p-obj" label="الهدف"><Select id="p-obj" value={f.objective} onChange={set("objective")}>{Object.entries(OBJ).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select></Field>
            <Field id="p-type" label="نوع المحتوى"><Select id="p-type" value={f.contentType} onChange={set("contentType")}>{Object.entries(TYPES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select></Field>
            <Field id="p-aud" label="الجمهور"><TextInput id="p-aud" value={f.audience} onChange={set("audience")} /></Field>
            <Field id="p-cta" label="الدعوة لاتخاذ إجراء CTA"><TextInput id="p-cta" value={f.cta} onChange={set("cta")} /></Field>
          </div>
          <fieldset><legend className="text-xs font-bold text-oo-text-secondary mb-2">المنصات</legend>
            <div className="mkt-toolbar">{SOCIAL_PLATFORMS.map((pl) => <label key={pl} className="mkt-chip"><input type="checkbox" checked={f.platforms.includes(pl)} onChange={() => tog("platforms", pl)} data-testid={`pl-${pl}`} /> {platformName(pl)}{PLATFORM[pl].organic?.adapter !== "IMPLEMENTED" ? " (يدوي)" : ""}</label>)}</div>
          </fieldset>
          <Field id="p-cap" label="النص"><TextArea id="p-cap" value={f.caption} onChange={set("caption")} rows={5} /></Field>
          <Field id="p-tags" label="الوسوم (بمسافة أو فاصلة، بدون #)"><TextInput id="p-tags" value={f.hashtags} onChange={set("hashtags")} /></Field>
          <Field id="p-link" label="الرابط" hint={campaign ? "يفضّل رابط الحملة المتتبَّع (صفحة الحملة › روابط التتبع)." : "اربط المنشور بحملة ليُتتبع أثره في المبيعات."}><TextInput id="p-link" value={f.link} onChange={set("link")} placeholder="https://" /></Field>
          {f.platforms.length > 1 ? <details><summary className="mkt-muted">نص مخصص لكل منصة (اختياري)</summary>
            {f.platforms.map((pl) => <Field key={pl} id={`ov-${pl}`} label={platformName(pl)}><TextArea id={`ov-${pl}`} value={f.overrides[pl] ?? ""} onChange={(v) => setF((s) => ({ ...s, overrides: { ...s.overrides, [pl]: v } }))} rows={3} /></Field>)}
          </details> : null}
          <fieldset><legend className="text-xs font-bold text-oo-text-secondary mb-2">الوسائط من المكتبة</legend>
            {assets.data?.rows.filter((a) => a.kind !== "COPY").length ? <div className="mkt-toolbar">{assets.data.rows.filter((a) => a.kind !== "COPY").slice(0, 40).map((a) => <label key={a.id} className="mkt-chip"><input type="checkbox" checked={f.assetIds.includes(a.id)} onChange={() => tog("assetIds", a.id)} /> {a.title}</label>)}</div> : <p className="mkt-muted">لا وسائط في المكتبة بعد.</p>}
          </fieldset>
          {p && ["APPROVED", "SCHEDULED", "IN_REVIEW"].includes(p.status) ? <Field id="p-reason" label="سبب التغيير" hint="مطلوب عند تغيير موعد منشور معتمد. تعديل المحتوى يعيد المنشور إلى مسودة ويلغي الاعتماد."><TextInput id="p-reason" value={f.reason} onChange={set("reason")} /></Field> : null}
        </fieldset>
      ) : null}

      {tab === "brief" ? (
        <div className="mkt-grid-2">
          {([["goal", "الهدف"], ["audience", "الجمهور"], ["message", "الرسالة"], ["offer", "العرض"], ["cta", "CTA"], ["size", "المقاس"], ["platform", "المنصة"]] as const).map(([k, l]) => (
            <Field key={k} id={`b-${k}`} label={l}><TextInput id={`b-${k}`} value={f.brief[k] ?? ""} onChange={(v) => setF((s) => ({ ...s, brief: { ...s.brief, [k]: v } }))} /></Field>
          ))}
        </div>
      ) : null}

      {tab === "preview" ? (
        <div className="mkt-grid-2">{(f.platforms.length ? f.platforms : ["INSTAGRAM"]).map((pl) => (
          <div key={pl} className="mkt-sec" data-testid={`preview-${pl}`}>
            <div className="mkt-toolbar"><strong>{platformName(pl)}</strong><span className="sp" />{p?.variants.find((v) => v.platform === pl) ? <StatusChip map={VARIANT_STATUS} value={p.variants.find((v) => v.platform === pl)!.status} /> : null}</div>
            {f.assetIds.length ? <div className="mkt-muted">🖼 {f.assetIds.length} وسائط</div> : null}
            <p className="mkt-pre">{composeCaptionPreview(f.overrides[pl] || f.caption, f.hashtags.split(/[\s,،]+/).filter(Boolean), f.link || null, f.cta || null)}</p>
            <p className="mkt-muted">{[...(f.overrides[pl] || f.caption)].length} / {PLATFORM[pl]?.limits?.captionMax ?? "—"} حرف</p>
          </div>
        ))}</div>
      ) : null}

      {tab === "history" && detail ? (
        <div className="mkt-list" data-testid="post-history">
          {detail.approvals.map((a) => <div key={a.id} className="mkt-item"><span>طلب اعتماد · {a.requestedByName}{a.decidedByName ? ` → ${a.decidedByName}` : ""}{a.decisionNote ? ` · ${a.decisionNote}` : ""}</span><StatusChip map={APPROVAL_STATUS} value={a.status} /></div>)}
          {detail.history.map((h) => <div key={h.id} className="mkt-item"><div><div className="t">{h.field}</div><div className="s">{h.before ?? "—"} ← {h.after ?? "—"}{h.reason ? ` · السبب: ${h.reason}` : ""}</div></div><span className="mkt-muted">{h.actorName ?? "النظام"} · {fmtDate(h.at, true)}</span></div>)}
        </div>
      ) : null}
    </Modal>
  );
}

function Readiness({ r }: { r: Detail["readiness"] }) {
  const per = Object.entries(r.perPlatform);
  if (!r.blocking.length && !r.warnings.length && !per.length) return <p className="mkt-chip" data-tone="good">جاهز للنشر</p>;
  return (
    <div className="mkt-list" data-testid="readiness">
      {r.blocking.map((b) => <div key={b} className="mkt-banner">{b}</div>)}
      {r.warnings.map((w) => <div key={w} className="mkt-banner warn">{w}</div>)}
      {per.map(([pl, ws]) => <div key={pl} className="mkt-banner info"><strong>{platformName(pl)}:</strong> {ws.join(" ")}</div>)}
    </div>
  );
}
