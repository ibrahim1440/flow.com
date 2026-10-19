"use client";
/**
 * Print settings · Templates & fields (A-5, design §P2-3): saved label presets per template — field
 * visibility and order, language, notes line limit, the Cupping Results options (notes mode,
 * printed attributes; scorer names only with the separate permission and a privacy confirmation —
 * owner decision 2.1; guest feedback is never a label option — 2.2) and an optional paper profile. Product name is
 * always shown. Authorized users only (labels.template_manage or administrator); the API enforces
 * it and audits every change. Anyone who prints may read and apply presets in the print dialog.
 */
import { Select } from "@/components/ui/Select";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Btn, Notice, OpsBanner, OpsEmpty, OpsError, OpsLoading, OpsRoot, PageHeader, useL } from "@/components/ops/ui";
import { Dialog } from "@/components/hr/ui";
import { useI18n } from "@/lib/i18n/context";
import { PrintSettingsTabs } from "@/components/print/SettingsTabs";
import { FIELD_DEFS, TEMPLATES, defaultFields, normalizeFields, type FieldConfig, type TemplateKey } from "@/lib/print/templates";
import type { PrintLang } from "@/lib/print/bidi";
import { profileDisplayName } from "@/lib/print/profiles";

type Preset = { id: string; name: string; templateKey: TemplateKey; language: PrintLang; fields: unknown; notesMaxLines: number | null; showLogo: boolean; profileId: string | null; ownerName: string | null; canEdit: boolean };
type Draft = { id: string | null; name: string; templateKey: TemplateKey; language: PrintLang; fields: FieldConfig; notesMaxLines: number | null; profileId: string };
type Profile = { id: string; name: string; presetKey: string | null; isPreset: boolean };

async function call<T>(url: string, method = "GET", json?: unknown) {
  const r = await fetch(url, { method, headers: json !== undefined ? { "Content-Type": "application/json" } : undefined, body: json !== undefined ? JSON.stringify(json) : undefined, cache: "no-store" });
  return { ok: r.ok, status: r.status, body: (await r.json().catch(() => ({}))) as T & { error?: string } };
}

export default function TemplatesPage() {
  return <OpsRoot><TemplatesInner /></OpsRoot>;
}

function TemplatesInner() {
  const L = useL();
  const { lang } = useI18n();
  const [presets, setPresets] = useState<Preset[] | null>(null);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [canManage, setCanManage] = useState(false);
  const [canName, setCanName] = useState(false);
  const [privacy, setPrivacy] = useState(false);
  const [err, setErr] = useState<{ status: number; message: string } | null>(null);
  const [tpl, setTpl] = useState<TemplateKey>("COFFEE_ORIGIN");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [banner, setBanner] = useState<{ tone: "success" | "danger"; text: string } | null>(null);
  const [del, setDel] = useState<Preset | null>(null);

  const load = useCallback(async () => {
    const [r, p] = await Promise.all([call<{ presets: Preset[]; canManage: boolean; canNameScorers: boolean }>("/api/print/presets"), call<{ profiles: Profile[] }>("/api/print/profiles")]);
    if (!r.ok) { setErr({ status: r.status, message: r.body.error ?? `HTTP ${r.status}` }); return; }
    setErr(null); setPresets(r.body.presets); setCanManage(r.body.canManage); setCanName(!!r.body.canNameScorers);
    if (p.ok) setProfiles(p.body.profiles);
  }, []);
  useEffect(() => { load(); }, [load]); // eslint-disable-line react-hooks/set-state-in-effect -- initial fetch

  const startNew = () => { const d: Draft = { id: null, name: "", templateKey: tpl, language: "BI", fields: defaultFields(tpl), notesMaxLines: null, profileId: "" }; setDraft(d); setSaved(JSON.stringify(d)); };
  const edit = (p: Preset) => { const d: Draft = { id: p.id, name: p.name, templateKey: p.templateKey, language: p.language, fields: normalizeFields(p.templateKey, p.fields), notesMaxLines: p.notesMaxLines, profileId: p.profileId ?? "" }; setDraft(d); setSaved(JSON.stringify(d)); };
  const dirty = useMemo(() => !!draft && JSON.stringify(draft) !== saved, [draft, saved]);

  const save = async (asNew: boolean) => {
    if (!draft) return;
    const body = { name: draft.name, templateKey: draft.templateKey, language: draft.language, fields: draft.fields, notesMaxLines: draft.notesMaxLines, showLogo: true, profileId: draft.profileId || null, privacyConfirmed: privacy };
    const r = draft.id && !asNew ? await call<Preset>(`/api/print/presets/${draft.id}`, "PUT", body) : await call<Preset>("/api/print/presets", "POST", body);
    if (!r.ok) { setBanner({ tone: "danger", text: r.body.error ?? `HTTP ${r.status}` }); return; }
    setBanner({ tone: "success", text: L("حُفظ الإعداد.", "Preset saved.") });
    edit({ ...r.body, canEdit: true });
    load();
  };
  const remove = async (p: Preset) => {
    const r = await call(`/api/print/presets/${p.id}`, "DELETE");
    setDel(null); if (draft?.id === p.id) setDraft(null);
    setBanner(r.ok ? { tone: "success", text: L("حُذف الإعداد.", "Preset deleted.") } : { tone: "danger", text: r.body.error ?? `HTTP ${r.status}` });
    load();
  };

  if (err) {
    return (
      <div className="hr-page">
        <PageHeader title={L("إعدادات الطباعة", "Print settings")} />
        {err.status === 403 || err.status === 401
          ? <Notice tone="warning"><span data-testid="templates-denied">{L("لا تملك صلاحية إعدادات الطباعة.", "You don’t have permission for print settings.")}</span></Notice>
          : <OpsError message={err.message} onRetry={load} />}
      </div>
    );
  }

  const list = (presets ?? []).filter((p) => p.templateKey === tpl);
  const setField = (i: number, patch: Partial<{ show: boolean }>) => setDraft((d) => d && { ...d, fields: d.fields.map((f, j) => (j === i ? { ...f, ...patch } : f)) });
  const move = (i: number, by: number) => setDraft((d) => { if (!d) return d; const c = [...d.fields]; const j = i + by; if (j < 0 || j >= c.length) return d; [c[i], c[j]] = [c[j], c[i]]; return { ...d, fields: c }; });
  const compactRank = (key: string): string => {
    const order = TEMPLATES[tpl].compact;
    const slot = key === "name" ? "name" : key === "score" ? "score" : ["cupNotes", "sharedNotes", "scorerNotes"].includes(key) ? "notes" : ["country", "region"].includes(key) ? "origin" : ["batchNumber", "roastDate"].includes(key) ? "trace" : null;
    const i = slot ? order.indexOf(slot as never) : -1;
    return i >= 0 ? String(i + 1) : "—";
  };

  return (
    <div className="hr-page">
      <PageHeader title={L("إعدادات الطباعة", "Print settings")} actions={canManage ? <Btn variant="primary" onClick={startNew} data-testid="template-new">{L("إعداد جديد", "New preset")}</Btn> : null}>
        <a className="ops-link" href="/dashboard/labels">{L("الملصقات", "Labels")}</a>
      </PageHeader>
      <PrintSettingsTabs current="templates" />
      {banner ? <OpsBanner tone={banner.tone} onClose={() => setBanner(null)}>{banner.text}</OpsBanner> : null}
      {!canManage ? <Notice tone="info">{L("تستطيع استخدام هذه الإعدادات عند الطباعة. تعديلها يحتاج صلاحية «إدارة إعدادات الملصقات».", "You can apply these presets when printing. Changing them needs the “manage label presets” permission.")}</Notice> : null}
      <div className="pd-seg" role="group" aria-label={L("القالب", "Template")} style={{ maxWidth: 420 }}>
        {(Object.keys(TEMPLATES) as TemplateKey[]).map((k) => <button key={k} type="button" aria-pressed={tpl === k} onClick={() => { setTpl(k); setDraft(null); }}>{lang === "ar" ? TEMPLATES[k].ar : TEMPLATES[k].en}</button>)}
      </div>
      {!presets ? <OpsLoading rows={3} /> : list.length === 0 ? <OpsEmpty title={L("لا إعدادات محفوظة لهذا القالب", "No saved presets for this template")} body={L("الإعدادات الافتراضية للقالب تُستخدم عند الطباعة.", "The template defaults are used when printing.")} /> : (
        <ul className="ops-list" data-testid="templates-list">
          {list.map((p) => (
            <li key={p.id}>
              <span><strong style={{ fontWeight: 600 }}>{p.name}</strong> <span className="hr-caption">· {p.language === "BI" ? L("ثنائي اللغة", "Bilingual") : p.language === "AR" ? "عربي" : "English"}{p.ownerName ? ` · ${p.ownerName}` : ""}</span></span>
              <span style={{ display: "flex", gap: 6 }}>
                {p.canEdit ? <><Btn size="sm" onClick={() => edit(p)}>{L("تعديل", "Edit")}</Btn><Btn size="sm" variant="danger" onClick={() => setDel(p)}>{L("حذف", "Delete")}</Btn></> : null}
              </span>
            </li>
          ))}
        </ul>
      )}

      {draft ? (
        <section className="hr-stack" style={{ gap: 12, maxWidth: 760 }} data-testid="template-editor">
          {dirty ? <Notice tone="warning">{L("تغييرات غير محفوظة.", "Unsaved changes.")}</Notice> : null}
          <div className="hr-form" style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 12 }}>
            <label className="hr-field"><span className="hr-label">{L("الاسم", "Name")}</span><input className="hr-input" value={draft.name} maxLength={80} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></label>
            <label className="hr-field"><span className="hr-label">{L("اللغة", "Language")}</span>
              <Select className="hr-select" value={draft.language} onChange={(e) => setDraft({ ...draft, language: e.target.value as PrintLang })}>
                <option value="BI">{L("ثنائي اللغة", "Bilingual")}</option><option value="AR">عربي</option><option value="EN">English</option>
              </Select></label>
            <label className="hr-field"><span className="hr-label">{L("أقصى أسطر للإيحاءات", "Notes: maximum lines")}</span>
              <Select className="hr-select" value={draft.notesMaxLines ?? ""} onChange={(e) => setDraft({ ...draft, notesMaxLines: e.target.value === "" ? null : Number(e.target.value) })} data-testid="template-notes-lines">
                {/* §P2-2: by size = 3 per language on bilingual standard, 2 single-language, 2 on 50 × 30. */}
                <option value="">{L("حسب المقاس (3 لكل لغة ثنائيًا · 2 بلغة واحدة · 2 على 50 × 30)", "By size (3 per language bilingual · 2 single-language · 2 on 50 × 30)")}</option>
                {[1, 2, 3, 4, 5, 6].map((v) => <option key={v} value={v}>{v}</option>)}
              </Select></label>
            <label className="hr-field" style={{ gridColumn: "1 / -1" }}><span className="hr-label">{L("ملف الورق (اختياري)", "Paper profile (optional)")}</span>
              <Select className="hr-select" value={draft.profileId} onChange={(e) => setDraft({ ...draft, profileId: e.target.value })}>
                <option value="">{L("— بلا —", "— None —")}</option>
                {profiles.map((p) => <option key={p.id} value={p.id}>{profileDisplayName(p, lang === "ar" ? "ar" : "en")}</option>)}
              </Select></label>
          </div>
          <div className="hr-tablewrap">
            <table className="hr-table" aria-label={L("الحقول", "Fields")} data-testid="template-fields">
              <thead><tr><th>{L("الترتيب", "Order")}</th><th>{L("الحقل", "Field")}</th><th>{L("ظاهر", "Shown")}</th><th>{L("على", "On")} <bdi dir="ltr">50 × 30</bdi></th></tr></thead>
              <tbody>
                {draft.fields.map((f, i) => {
                  const def = FIELD_DEFS[f.key];
                  // Decision 2.1: the scorer-names switch is locked without the separate permission.
                  const lockedName = f.key === "scorerNames" && !canName;
                  const locked = f.key === "name" || lockedName;
                  return (
                    <tr key={f.key}>
                      <td style={{ whiteSpace: "nowrap" }}>
                        <Btn size="sm" variant="ghost" disabled={i === 0} onClick={() => move(i, -1)} aria-label={`${L("أعلى", "Up")} · ${lang === "ar" ? def.ar : def.en}`}>↑</Btn>
                        <Btn size="sm" variant="ghost" disabled={i === draft.fields.length - 1} onClick={() => move(i, 1)} aria-label={`${L("أسفل", "Down")} · ${lang === "ar" ? def.ar : def.en}`}>↓</Btn>
                      </td>
                      <td style={lockedName ? { opacity: 0.6 } : undefined}>{lang === "ar" ? def.ar : def.en}{f.key === "scorerNames" ? <span className="hr-caption" style={{ display: "block" }} data-testid="names-locked-help">{lockedName ? L("(مقفل) يتطلب تفويضًا منفصلًا ومتطلبات الخصوصية؛ الملصقات تُطبع «مقيّم 1».", "(locked) needs a separate authorization and privacy requirements; labels print «Scorer 1».") : L("مسموح لك: يتطلب تأكيد متطلبات الخصوصية عند الحفظ.", "Allowed for you: saving needs the privacy confirmation.")}</span> : null}</td>
                      <td><label className="pd-switch"><input type="checkbox" role="switch" checked={locked || f.show} disabled={locked} onChange={(e) => setField(i, { show: e.target.checked })} aria-label={lang === "ar" ? def.ar : def.en} /></label></td>
                      <td className="hr-num">{compactRank(f.key)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <span className="hr-caption">{L("على", "On")} <bdi dir="ltr">50 × 30</bdi>{L(": الاسم، ثم النتيجة أو الإيحاءات (سطران «…»)، ثم سطر المنشأ، ثم الدفعة وتاريخ التحميص. الشعار لا يُطبع بهذا المقاس. المقيّمون يُطبعون بلا أسماء («مقيّم 1»).", ": name, then the score or notes (2 lines «…»), the origin line, then batch · roast date. No logo at that size. Scorers print anonymously («Scorer 1»).")}</span>
          {draft.templateKey === "CUPPING_RESULTS" ? <span className="hr-caption">{L("ملاحظات الضيوف متاحة في التطبيق فقط ولا تُطبع على ملصقات نتائج التذوق.", "Guest feedback is available in the app only; it is never printed on cupping-results labels.")}</span> : null}
          {draft.fields.some((f) => f.key === "scorerNames" && f.show) ? (
            <label className="pd-switch" data-testid="privacy-confirm"><input type="checkbox" checked={privacy} onChange={(e) => setPrivacy(e.target.checked)} />
              {L("أؤكد أن طباعة أسماء المقيّمين تستوفي متطلبات الخصوصية (يُسجَّل باسمي في سجل الطباعة).", "I confirm that printing scorer names meets the privacy requirements (recorded under my name in the print audit).")}</label>
          ) : null}
          {canManage ? (
            <div style={{ display: "flex", gap: 8 }}>
              <Btn variant="primary" disabled={!draft.name.trim() || (!!draft.id && !dirty)} onClick={() => save(false)} data-testid="template-save">{draft.id ? L("حفظ التغييرات", "Save changes") : L("حفظ كإعداد جديد", "Save as new preset")}</Btn>
              {draft.id ? <Btn disabled={!draft.name.trim()} onClick={() => save(true)}>{L("حفظ كإعداد جديد", "Save as new preset")}</Btn> : null}
              <Btn onClick={() => setDraft(null)}>{L("إغلاق", "Close")}</Btn>
            </div>
          ) : null}
        </section>
      ) : null}

      <Dialog open={!!del} title={L("حذف الإعداد؟", "Delete the preset?")} onClose={() => setDel(null)} closeLabel={L("إغلاق", "Close")}
        actions={<><Btn variant="danger" onClick={() => del && remove(del)}>{L("حذف", "Delete")}</Btn><Btn onClick={() => setDel(null)}>{L("إلغاء", "Cancel")}</Btn></>}>
        <p style={{ margin: 0 }}>{del?.name}</p>
      </Dialog>
    </div>
  );
}
