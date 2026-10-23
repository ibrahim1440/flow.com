"use client";
// «ملفات التحميص» — Production › Quality: roast profiles and their versioned QC spec (owner decision
// 1). A profile is a product (optionally one green coffee) roasted one way. Its version in
// development collects TRIAL readings (whole and ground, device, scale, sensory) that guide the
// target ± tolerance; approving it (with the sensory evaluation) freezes the spec, retires the
// previous version, and makes it the reference for every new batch of the product. Before any
// approval the product's QC is «المواصفة قيد المعايرة». qc › manage_profiles edits; everyone with
// QC or production access reads.
import { useCallback, useEffect, useState } from "react";
import { useI18n } from "@/lib/i18n/context";
import { localizeApiError } from "@/lib/i18n/api-errors";
import { Btn, Dot, Field, Notice, OpsEmpty, OpsError, OpsLoading, SecHead } from "@/components/ops/ui";
import { DEFAULT_DEVICE, DEFAULT_SCALE, SENSORY_RESULTS, SENSORY_WORD, type SensoryResult } from "@/lib/qc/spec";

type Trial = { id: string; colorWhole: number; colorGround: number; device: string; scale: string; sensoryResult: SensoryResult | null; notes: string | null; recordedByName: string; createdAt: string };
type Version = {
  id: string; version: number; status: "DRAFT" | "APPROVED" | "RETIRED"; wholeTarget: number | null; wholeTol: number | null; groundTarget: number | null; groundTol: number | null; device: string | null; scale: string | null;
  sensoryRequirements: string | null; approvalSensoryNotes: string | null; approvedAt: string | null; approvedByName: string | null; retiredAt: string | null; trials: Trial[];
  trialStats: { n: number; whole: { mean: number; min: number; max: number }; ground: { mean: number; min: number; max: number } } | null;
};
type Profile = { id: string; name: string; status: string; product: { id: string; productNameEn: string; productNameAr: string | null }; greenBean: { serialNumber: string; beanType: string; beanTypeAr: string | null } | null; versions: Version[] };
type Data = { profiles: Profile[]; products: { id: string; productNameEn: string; productNameAr: string | null }[]; greens: { id: string; serialNumber: string; beanType: string; beanTypeAr: string | null }[]; canManage: boolean };

const TZ = "Asia/Riyadh";
const at = (iso: string | null, lang: "ar" | "en") => (iso ? new Date(iso).toLocaleDateString(lang === "ar" ? "ar-SA-u-nu-latn-ca-gregory" : "en-GB", { timeZone: TZ, day: "numeric", month: "short", year: "numeric" }) : "—");

async function call(url: string, method: string, body?: unknown) {
  const r = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { ok: r.ok, status: r.status, body: await r.json().catch(() => ({})) };
}

export function ProfilesTab() {
  const { lang } = useI18n();
  const L = useCallback((ar: string, en: string) => (lang === "ar" ? ar : en), [lang]);
  const [data, setData] = useState<Data | null>(null);
  const [failed, setFailed] = useState(false);
  const [msg, setMsg] = useState<{ tone: "success" | "danger"; text: string } | null>(null);
  const [adding, setAdding] = useState(false);
  const load = useCallback(async () => {
    const r = await call("/api/qc/profiles", "GET");
    if (!r.ok) { setFailed(true); return; }
    setData(r.body); setFailed(false);
  }, []);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- read on mount
  useEffect(() => { void load(); }, [load]);
  const done = useCallback(async (r: { ok: boolean; body: unknown }, ok: string) => {
    setMsg(r.ok ? { tone: "success", text: ok } : { tone: "danger", text: localizeApiError(r.body, lang) ?? "—" });
    if (r.ok) await load();
    return r.ok;
  }, [lang, load]);
  if (failed) return <OpsError message={L("تعذّر تحميل ملفات التحميص.", "Could not load the roast profiles.")} onRetry={load} />;
  if (!data) return <OpsLoading />;
  const pname = (p: { productNameEn: string; productNameAr: string | null }) => (lang === "ar" ? p.productNameAr || p.productNameEn : p.productNameEn);
  return (
    <div style={{ display: "grid", gap: 20 }} data-testid="qc-profiles-tab">
      <Notice tone="info">{L("المرجع لكل منتج هو إصدار ملف التحميص المعتمد: هدف الحبوب والمطحون ± السماحية، بالجهاز والمقياس. قبل الاعتماد تُعرض الدفعات «المواصفة قيد المعايرة» ويكون القبول يدويًا موثّقًا. تعديل المرجع = اعتماد إصدار جديد؛ الفحوص السابقة لا تتغير.", "Each product's reference is its APPROVED roast-profile version. Before approval its batches show «spec under calibration». Changing the reference means approving a new version; past inspections never change.")}</Notice>
      {msg ? <Notice tone={msg.tone}>{msg.text}</Notice> : null}
      {data.canManage ? (adding ? <NewProfile data={data} onCancel={() => setAdding(false)} onSave={async (b) => { if (await done(await call("/api/qc/profiles", "POST", b), L("أُنشئ الملف والإصدار 1 قيد التطوير.", "Profile created with version 1 in development."))) setAdding(false); }} />
        : <div><Btn variant="primary" onClick={() => setAdding(true)} data-testid="profile-new">{L("ملف تحميص جديد", "New roast profile")}</Btn></div>) : null}
      {data.profiles.length === 0 ? <OpsEmpty title={L("لا ملفات تحميص بعد.", "No roast profiles yet.")} body={L("كل منتج دون ملف معتمد: «المواصفة قيد المعايرة».", "Every product without an approved profile: «spec under calibration».")} /> : null}
      {data.profiles.map((p) => {
        const approved = p.versions.find((v) => v.status === "APPROVED") ?? null;
        const draft = p.versions.find((v) => v.status === "DRAFT") ?? null;
        return (
          <section key={p.id} data-testid={`profile-${p.id}`} style={{ display: "grid", gap: 12, paddingBottom: 16, borderBottom: "1px solid var(--hr-border, #e8e2d6)" }}>
            <SecHead title={<>{p.name} · {pname(p.product)}</>} caption={<>{p.greenBean ? <>{L("البن", "Green")} <bdi className="hr-id">{p.greenBean.serialNumber}</bdi> · </> : L("كل دفعات البن · ", "Every green lot · ")}{approved ? <Dot tone="success">{L(`معتمد · الإصدار ${approved.version}`, `Approved · v${approved.version}`)}</Dot> : <Dot tone="info">{L("المواصفة قيد المعايرة", "Spec under calibration")}</Dot>}</>}
              action={data.canManage && !draft ? <Btn size="sm" onClick={async () => { await done(await call(`/api/qc/profiles/${p.id}/versions`, "POST"), L("أُنشئ إصدار جديد قيد التطوير.", "A new version is in development.")); }} data-testid={`profile-newversion-${p.id}`}>{L("إصدار جديد", "New version")}</Btn> : null} />
            <div className="hr-tablewrap"><table className="hr-table" aria-label={L("الإصدارات", "Versions")}>
              <thead><tr><th scope="col">{L("الإصدار", "Version")}</th><th scope="col">{L("الحالة", "Status")}</th><th scope="col">{L("حبوب", "Whole")}</th><th scope="col">{L("مطحون", "Ground")}</th><th scope="col">{L("الجهاز · المقياس", "Device · scale")}</th><th scope="col">{L("التجارب", "Trials")}</th><th scope="col">{L("الاعتماد", "Approval")}</th></tr></thead>
              <tbody>{p.versions.map((v) => (
                <tr key={v.id} data-testid={`version-${v.version}`}>
                  <td className="hr-num">{v.version}</td>
                  <td><Dot tone={v.status === "APPROVED" ? "success" : v.status === "DRAFT" ? "info" : "neutral"}>{v.status === "APPROVED" ? L("معتمد", "Approved") : v.status === "DRAFT" ? L("قيد التطوير", "In development") : L("متقاعد", "Retired")}</Dot></td>
                  <td className="hr-num">{v.wholeTarget !== null ? `${v.wholeTarget} ± ${v.wholeTol ?? "—"}` : "—"}</td>
                  <td className="hr-num">{v.groundTarget !== null ? `${v.groundTarget} ± ${v.groundTol ?? "—"}` : "—"}</td>
                  <td>{v.device ?? "—"} · {v.scale ?? "—"}</td>
                  <td className="hr-num">{v.trialStats ? `${v.trialStats.n} · ${L("متوسط", "mean")} ${v.trialStats.whole.mean} / ${v.trialStats.ground.mean}` : "0"}</td>
                  <td>{v.approvedAt ? <>{v.approvedByName} · {at(v.approvedAt, lang)}</> : "—"}</td>
                </tr>
              ))}</tbody>
            </table></div>
            {draft && data.canManage ? <DraftEditor key={draft.id} v={draft} onDone={done} /> : null}
          </section>
        );
      })}
    </div>
  );
}

function NewProfile({ data, onSave, onCancel }: { data: Data; onSave: (b: Record<string, unknown>) => Promise<void>; onCancel: () => void }) {
  const { lang } = useI18n();
  const L = (ar: string, en: string) => (lang === "ar" ? ar : en);
  const [productId, setProductId] = useState("");
  const [greenBeanId, setGreen] = useState("");
  const [name, setName] = useState("");
  return (
    <section style={{ display: "grid", gap: 10, maxWidth: 640 }} data-testid="profile-form">
      <Field label={L("المنتج *", "Product *")}>
        <select className="hr-select" value={productId} onChange={(e) => setProductId(e.target.value)} data-testid="profile-product">
          <option value="">{L("اختر", "Choose")}</option>
          {data.products.map((p) => <option key={p.id} value={p.id}>{lang === "ar" ? p.productNameAr || p.productNameEn : p.productNameEn}</option>)}
        </select>
      </Field>
      <Field label={L("البن الأخضر (اختياري)", "Green coffee (optional)")} help={L("دون اختيار: لكل دفعات البن لهذا المنتج.", "Empty: every green lot of the product.")}>
        <select className="hr-select" value={greenBeanId} onChange={(e) => setGreen(e.target.value)}>
          <option value="">{L("كل دفعات البن", "Every green lot")}</option>
          {data.greens.map((g) => <option key={g.id} value={g.id}>{g.serialNumber} · {lang === "ar" ? g.beanTypeAr || g.beanType : g.beanType}</option>)}
        </select>
      </Field>
      <Field label={L("اسم الملف", "Profile name")}><input className="hr-input" value={name} onChange={(e) => setName(e.target.value)} data-testid="profile-name" /></Field>
      <div style={{ display: "flex", gap: 8 }}>
        <Btn variant="primary" disabled={!productId} onClick={() => void onSave({ productId, greenBeanId: greenBeanId || null, name })} data-testid="profile-save">{L("إنشاء", "Create")}</Btn>
        <Btn onClick={onCancel}>{L("إلغاء", "Cancel")}</Btn>
      </div>
    </section>
  );
}

function DraftEditor({ v, onDone }: { v: Version; onDone: (r: { ok: boolean; body: unknown }, ok: string) => Promise<boolean> }) {
  const { lang } = useI18n();
  const L = (ar: string, en: string) => (lang === "ar" ? ar : en);
  const s = (n: number | null) => (n === null ? "" : String(n));
  const [spec, setSpec] = useState({ wholeTarget: s(v.wholeTarget), wholeTol: s(v.wholeTol), groundTarget: s(v.groundTarget), groundTol: s(v.groundTol), device: v.device ?? DEFAULT_DEVICE, scale: v.scale ?? DEFAULT_SCALE, sensoryRequirements: v.sensoryRequirements ?? "" });
  const [trial, setTrial] = useState({ colorWhole: "", colorGround: "", sensoryResult: "" as SensoryResult | "", notes: "" });
  const [appr, setAppr] = useState({ sensoryResult: "" as SensoryResult | "", sensoryNotes: "" });
  return (
    <div style={{ display: "grid", gap: 16, padding: 16, borderRadius: 12, background: "var(--hr-surface-subtle, #f6f3ec)" }} data-testid="draft-editor">
      <b>{L(`الإصدار ${v.version} · قيد التطوير`, `Version ${v.version} · in development`)}</b>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 10 }}>
        <Field label={L("هدف الحبوب", "Whole target")}><input className="hr-input" inputMode="decimal" value={spec.wholeTarget} onChange={(e) => setSpec({ ...spec, wholeTarget: e.target.value })} data-testid="spec-whole" /></Field>
        <Field label={L("± سماحية الحبوب", "± whole tolerance")}><input className="hr-input" inputMode="decimal" value={spec.wholeTol} onChange={(e) => setSpec({ ...spec, wholeTol: e.target.value })} data-testid="spec-whole-tol" /></Field>
        <Field label={L("هدف المطحون", "Ground target")}><input className="hr-input" inputMode="decimal" value={spec.groundTarget} onChange={(e) => setSpec({ ...spec, groundTarget: e.target.value })} data-testid="spec-ground" /></Field>
        <Field label={L("± سماحية المطحون", "± ground tolerance")}><input className="hr-input" inputMode="decimal" value={spec.groundTol} onChange={(e) => setSpec({ ...spec, groundTol: e.target.value })} data-testid="spec-ground-tol" /></Field>
        <Field label={L("الجهاز", "Device")}><input className="hr-input" value={spec.device} onChange={(e) => setSpec({ ...spec, device: e.target.value })} data-testid="spec-device" /></Field>
        <Field label={L("المقياس", "Scale")}><input className="hr-input" value={spec.scale} onChange={(e) => setSpec({ ...spec, scale: e.target.value })} data-testid="spec-scale" /></Field>
        <Field label={L("متطلبات حسية", "Sensory requirements")} wide><input className="hr-input" value={spec.sensoryRequirements} onChange={(e) => setSpec({ ...spec, sensoryRequirements: e.target.value })} data-testid="spec-sensory-req" /></Field>
      </div>
      <div><Btn onClick={async () => { await onDone(await call(`/api/qc/profile-versions/${v.id}`, "PATCH", spec), L("حُفظت المواصفة قيد التطوير.", "Draft spec saved.")); }} data-testid="spec-save">{L("حفظ المواصفة", "Save the spec")}</Btn></div>

      <SecHead title={L("قراءات التجربة", "Trial readings")} caption={v.trialStats ? L(`${v.trialStats.n} قراءة · حبوب ${v.trialStats.whole.min}–${v.trialStats.whole.max} (متوسط ${v.trialStats.whole.mean}) · مطحون ${v.trialStats.ground.min}–${v.trialStats.ground.max} (متوسط ${v.trialStats.ground.mean})`, `${v.trialStats.n} reading(s) · whole ${v.trialStats.whole.min}–${v.trialStats.whole.max} (mean ${v.trialStats.whole.mean}) · ground ${v.trialStats.ground.min}–${v.trialStats.ground.max} (mean ${v.trialStats.ground.mean})`) : L("للاسترشاد عند ضبط الهدف والسماحية؛ لا تحكم على أي دفعة.", "A guide for the target and tolerance; they judge no batch.")} />
      {v.trials.length ? (
        <div className="hr-tablewrap"><table className="hr-table" aria-label={L("قراءات التجربة", "Trial readings")}>
          <thead><tr><th scope="col">{L("حبوب", "Whole")}</th><th scope="col">{L("مطحون", "Ground")}</th><th scope="col">{L("الجهاز · المقياس", "Device · scale")}</th><th scope="col">{L("حسي", "Sensory")}</th><th scope="col">{L("سجّلها", "By")}</th></tr></thead>
          <tbody>{v.trials.map((t) => <tr key={t.id}><td className="hr-num">{t.colorWhole}</td><td className="hr-num">{t.colorGround}</td><td>{t.device} · {t.scale}</td><td>{t.sensoryResult ? SENSORY_WORD[t.sensoryResult][lang] : "—"}{t.notes ? ` · ${t.notes}` : ""}</td><td>{t.recordedByName} · {at(t.createdAt, lang)}</td></tr>)}</tbody>
        </table></div>
      ) : null}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 10, alignItems: "end" }}>
        <Field label={L("حبوب", "Whole")}><input className="hr-input" inputMode="decimal" value={trial.colorWhole} onChange={(e) => setTrial({ ...trial, colorWhole: e.target.value })} data-testid="trial-whole" /></Field>
        <Field label={L("مطحون", "Ground")}><input className="hr-input" inputMode="decimal" value={trial.colorGround} onChange={(e) => setTrial({ ...trial, colorGround: e.target.value })} data-testid="trial-ground" /></Field>
        <Field label={L("حسي", "Sensory")}>
          <select className="hr-select" value={trial.sensoryResult} onChange={(e) => setTrial({ ...trial, sensoryResult: e.target.value as SensoryResult | "" })} data-testid="trial-sensory">
            <option value="">—</option>{SENSORY_RESULTS.map((r) => <option key={r} value={r}>{SENSORY_WORD[r][lang]}</option>)}
          </select>
        </Field>
        <Btn onClick={async () => { if (await onDone(await call(`/api/qc/profile-versions/${v.id}/trials`, "POST", { ...trial, device: spec.device, scale: spec.scale, sensoryResult: trial.sensoryResult || null }), L("سُجّلت قراءة التجربة.", "Trial reading recorded."))) setTrial({ colorWhole: "", colorGround: "", sensoryResult: "", notes: "" }); }} data-testid="trial-add">{L("تسجيل قراءة تجربة", "Record a trial")}</Btn>
      </div>

      <SecHead title={L("اعتماد الإصدار", "Approve the version")} caption={L("يتطلب التقييم الحسي «مطابق» وقراءة تجربة واحدة على الأقل. بعد الاعتماد تُجمَّد المواصفة ويتقاعد الإصدار السابق.", "Needs a «conforming» sensory evaluation and at least one trial. On approval the spec freezes and the previous version retires.")} />
      <div style={{ display: "grid", gridTemplateColumns: "200px minmax(0, 1fr) auto", gap: 10, alignItems: "end" }}>
        <Field label={L("التقييم الحسي *", "Sensory evaluation *")}>
          <select className="hr-select" value={appr.sensoryResult} onChange={(e) => setAppr({ ...appr, sensoryResult: e.target.value as SensoryResult | "" })} data-testid="approve-sensory">
            <option value="">—</option>{SENSORY_RESULTS.map((r) => <option key={r} value={r}>{SENSORY_WORD[r][lang]}</option>)}
          </select>
        </Field>
        <Field label={L("ملاحظات التقييم الحسي *", "Sensory notes *")}><input className="hr-input" value={appr.sensoryNotes} onChange={(e) => setAppr({ ...appr, sensoryNotes: e.target.value })} data-testid="approve-notes" /></Field>
        <Btn variant="primary" disabled={!appr.sensoryResult || appr.sensoryNotes.trim().length < 3} onClick={async () => { await onDone(await call(`/api/qc/profile-versions/${v.id}/approve`, "POST", appr), L("اعتُمد الإصدار وأصبح المرجع للدفعات الجديدة.", "Version approved: the reference for new batches.")); }} data-testid="approve-version">{L("اعتماد الإصدار", "Approve the version")}</Btn>
      </div>
    </div>
  );
}
