"use client";

import { useState } from "react";
import Link from "next/link";
import { useLang, PageHeader, Button, Banner, Sec, Chip, useLoad, useMkt, usePageTitle, api, platformName, Field, TextInput, Select, TextArea, NotAllowed, Spinner } from "../_components/ui";
import { SOCIAL_PLATFORMS, PLATFORM } from "@/lib/marketing/platforms";

/**
 * «استوديو الذكاء الاصطناعي» and «مدير التسويق الذكي». Generates DRAFTS only: copy variants, a
 * marketing plan grounded in the system's real figures, and a language / brand review. Every saved
 * output is flagged as AI-generated and its publication follows the AI-content approval policy (on by default).
 */

type Variant = { platform: string; angle: string; headline: string; caption: string; hashtags: string[]; cta: string };

export default function StudioPage() {
  const lang = useLang();
  usePageTitle("استوديو الذكاء الاصطناعي", "AI studio", lang);
  const { can } = useMkt();
  const [tab, setTab] = useState<"copy" | "plan" | "review">("copy");
  const status = useLoad<{ server: { ai: boolean } }>("/api/marketing/integrations");
  if (!can("ai_use")) return <div className="mkt"><NotAllowed what="استخدام استوديو الذكاء الاصطناعي" /></div>;
  return (
    <div className="mkt" data-testid="mkt-studio">
      <PageHeader title="استوديو الذكاء الاصطناعي ومدير التسويق" subtitle="ينشئ مسودات فقط؛ نشرها يخضع لسياسة اعتماد محتوى الذكاء الاصطناعي (مفعّلة افتراضياً). لا يختلق أسعاراً أو خصومات أو بيانات سوق." />
      {status.data && !status.data.server.ai ? <Banner tone="warn">الاستوديو غير مفعّل: يحتاج مفتاح ANTHROPIC_API_KEY على الخادم.</Banner> : null}
      <div className="mkt-seg" role="tablist">{([["copy", "نصوص إعلانية"], ["plan", "خطة تسويقية"], ["review", "مراجعة نص"]] as const).map(([k, l]) => <button key={k} type="button" role="tab" aria-selected={tab === k} onClick={() => setTab(k)}>{l}</button>)}</div>
      {tab === "copy" ? <CopyTab /> : tab === "plan" ? <PlanTab /> : <ReviewTab />}
    </div>
  );
}

function CopyTab() {
  const products = useLoad<{ rows: { id: string; name: string }[] }>("/api/marketing/products");
  const campaigns = useLoad<{ rows: { id: string; name: string }[] }>("/api/marketing/campaigns");
  const [f, setF] = useState({ objective: "", audience: "", message: "", offer: "", cta: "", productId: "", campaignId: "", language: "ar", count: "3", platforms: ["INSTAGRAM"] as string[] });
  const [out, setOut] = useState<{ variants: Variant[]; assumptions: string[]; notes: string; model: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [saved, setSaved] = useState<string[]>([]);
  const set = (k: keyof typeof f) => (v: string) => setF((s) => ({ ...s, [k]: v }));
  async function gen() {
    setBusy(true); setErr(""); setOut(null);
    const r = await api<{ variants: Variant[]; assumptions: string[]; notes: string; model: string }>("/api/marketing/ai/copy", { method: "POST", body: { ...f, count: Number(f.count), productId: f.productId || null } });
    setBusy(false);
    if (!r.ok) return setErr(r.data.error ?? "");
    setOut(r.data);
  }
  async function keep(v: Variant, as: "post" | "asset", i: number) {
    const r = await api("/api/marketing/ai/save", { method: "POST", body: as === "post"
      ? { as, title: v.headline || v.angle, caption: v.caption, hashtags: v.hashtags, cta: v.cta, platforms: [v.platform], productId: f.productId || null, campaignId: f.campaignId || null, objective: "AWARENESS", brief: { goal: f.objective, audience: f.audience, message: f.message, offer: f.offer, cta: f.cta, platform: v.platform } }
      : { as, title: v.headline || v.angle, text: `${v.caption}\n\n${v.hashtags.map((h) => `#${h}`).join(" ")}`, productId: f.productId || null, campaignId: f.campaignId || null, tags: [v.platform.toLowerCase()] } });
    if (!r.ok) return setErr(r.data.error ?? "");
    setSaved((s) => [...s, `${i}-${as}`]);
  }
  return (
    <>
      <Sec title="الموجز">
        <div className="mkt-grid-2">
          <Field id="o" label="الهدف" required><TextInput id="o" value={f.objective} onChange={set("objective")} placeholder="إطلاق محصول إثيوبيا الجديد" /></Field>
          <Field id="m" label="الرسالة الأساسية" required><TextInput id="m" value={f.message} onChange={set("message")} /></Field>
          <Field id="a" label="الجمهور"><TextInput id="a" value={f.audience} onChange={set("audience")} /></Field>
          <Field id="of" label="العرض (إن وجد ومعتمد)"><TextInput id="of" value={f.offer} onChange={set("offer")} /></Field>
          <Field id="c" label="CTA"><TextInput id="c" value={f.cta} onChange={set("cta")} /></Field>
          <Field id="p" label="المنتج (تُستخدم بياناته من النظام)"><Select id="p" value={f.productId} onChange={set("productId")}><option value="">—</option>{products.data?.rows.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select></Field>
          <Field id="cp" label="الحملة (عند الحفظ)"><Select id="cp" value={f.campaignId} onChange={set("campaignId")}><option value="">—</option>{campaigns.data?.rows.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select></Field>
          <Field id="l" label="اللغة"><Select id="l" value={f.language} onChange={set("language")}><option value="ar">العربية</option><option value="en">الإنجليزية</option></Select></Field>
          <Field id="n" label="عدد النسخ لكل منصة"><Select id="n" value={f.count} onChange={set("count")}>{[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n}</option>)}</Select></Field>
        </div>
        <div className="mkt-toolbar">{SOCIAL_PLATFORMS.map((pl) => <label key={pl} className="mkt-chip"><input type="checkbox" checked={f.platforms.includes(pl)} onChange={() => setF((s) => ({ ...s, platforms: s.platforms.includes(pl) ? s.platforms.filter((x) => x !== pl) : [...s.platforms, pl] }))} /> {platformName(pl)}</label>)}</div>
        <Button onClick={gen} disabled={busy || !f.objective || !f.message} testId="generate">{busy ? "جارٍ التوليد…" : "توليد النسخ"}</Button>
      </Sec>
      <Banner onClose={() => setErr("")}>{err}</Banner>
      {busy ? <Spinner /> : null}
      {out ? <Sec title="النسخ المقترحة (مسودات)" caption={`النموذج: ${out.model}. راجع كل نسخة قبل حفظها؛ الحفظ كمنشور يضعه مسودة تتطلب الاعتماد.`}>
        {out.assumptions.length ? <div className="mkt-banner warn">افتراضات النموذج (تحقق منها): {out.assumptions.join(" · ")}</div> : null}
        <div className="mkt-grid-2">{out.variants.map((v, i) => (
          <div key={i} className="mkt-sec">
            <div className="mkt-toolbar"><Chip>{platformName(v.platform)}</Chip><Chip tone="info">{v.angle}</Chip><span className="mkt-muted">{[...v.caption].length}/{PLATFORM[v.platform]?.limits?.captionMax ?? "—"}</span></div>
            <strong>{v.headline}</strong><p className="mkt-pre">{v.caption}</p><p className="mkt-muted">{v.hashtags.map((h) => `#${h}`).join(" ")} · {v.cta}</p>
            <div className="mkt-toolbar">
              <Button variant="secondary" onClick={() => keep(v, "post", i)} disabled={saved.includes(`${i}-post`)}>{saved.includes(`${i}-post`) ? "حُفظ كمسودة" : "حفظ كمسودة منشور"}</Button>
              <Button variant="secondary" onClick={() => keep(v, "asset", i)} disabled={saved.includes(`${i}-asset`)}>{saved.includes(`${i}-asset`) ? "حُفظ في المكتبة" : "حفظ في المكتبة"}</Button>
            </div>
          </div>
        ))}</div>
        {out.notes ? <p className="mkt-muted">{out.notes}</p> : null}
        {saved.length ? <Link href="/dashboard/marketing/calendar" className="mkt-chip">فتح التقويم</Link> : null}
      </Sec> : null}
    </>
  );
}

type Plan = { summary: string; situation: string; swot: Record<string, string[]>; objectives: { objective: string; kpi: string; target: string; deadline: string; basis: string }[]; segments: { name: string; needs: string; objections: string; message: string }[]; channels: { platform: string; role: string; budgetSharePct: number; why: string }[]; calendar: { week: number; platform: string; contentType: string; idea: string; objective: string }[]; experiments: { hypothesis: string; test: string; successMetric: string }[]; risks: string[]; dataUsed: string[]; assumptions: string[] };

function PlanTab() {
  const [f, setF] = useState({ horizon: "MONTH", goal: "", budget: "", constraints: "" });
  const [out, setOut] = useState<{ plan: Plan; model: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const history = useLoad<{ rows: { id: string; title: string; createdAt: string; brief: { plan?: Plan } | null }[] }>("/api/marketing/assets?tag=strategy");
  async function gen() {
    setBusy(true); setErr("");
    const r = await api<{ plan: Plan; model: string }>("/api/marketing/ai/plan", { method: "POST", body: { ...f, budget: f.budget || null } });
    setBusy(false);
    if (!r.ok) return setErr(r.data.error ?? "");
    setOut(r.data);
    history.reload();
  }
  const SW: Record<string, string> = { strengths: "نقاط القوة", weaknesses: "نقاط الضعف", opportunities: "الفرص", threats: "التهديدات" };
  return (
    <>
      <Sec title="مدير التسويق الذكي" caption="يبني الخطة من أرقام النظام الفعلية لآخر 30 يوماً ومنتجاتكم وهويتكم؛ يفصل الحقائق عن الافتراضات. لا تحليل منافسين دون مصادر تزوّدونه بها.">
        <div className="mkt-grid-2">
          <Field id="h" label="المدى"><Select id="h" value={f.horizon} onChange={(v) => setF({ ...f, horizon: v })}><option value="MONTH">شهري</option><option value="QUARTER">ربع سنوي</option><option value="YEAR">سنوي</option></Select></Field>
          <Field id="b" label="الميزانية (ر.س)"><TextInput id="b" value={f.budget} onChange={(v) => setF({ ...f, budget: v })} inputMode="decimal" /></Field>
        </div>
        <Field id="g" label="الهدف التجاري" required><TextArea id="g" value={f.goal} onChange={(v) => setF({ ...f, goal: v })} rows={2} /></Field>
        <Field id="cs" label="مواسم وقيود (رمضان، مخزون محدود، إطلاق…)"><TextArea id="cs" value={f.constraints} onChange={(v) => setF({ ...f, constraints: v })} rows={2} /></Field>
        <Button onClick={gen} disabled={busy || !f.goal} testId="gen-plan">{busy ? "جارٍ إعداد الخطة…" : "إعداد الخطة"}</Button>
      </Sec>
      <Banner onClose={() => setErr("")}>{err}</Banner>
      {busy ? <Spinner /> : null}
      {out ? <Sec title="الخطة المقترحة" caption={`النموذج ${out.model} · حُفظت في المكتبة كمسودة.`}>
        <p className="mkt-pre">{out.plan.summary}</p>
        <p className="mkt-pre mkt-muted">{out.plan.situation}</p>
        <div className="mkt-grid-2">{Object.entries(out.plan.swot).map(([k, v]) => <div key={k} className="mkt-sec"><strong>{SW[k]}</strong><ul className="list-disc ps-5">{v.map((x) => <li key={x}>{x}</li>)}</ul></div>)}</div>
        <h3 className="font-bold mt-3">الأهداف (SMART)</h3>
        <table className="mkt-table"><thead><tr><th>الهدف</th><th>المؤشر</th><th>المستهدف</th><th>الموعد</th><th>الأساس</th></tr></thead><tbody>{out.plan.objectives.map((o, i) => <tr key={i}><td>{o.objective}</td><td>{o.kpi}</td><td>{o.target}</td><td>{o.deadline}</td><td className="mkt-muted">{o.basis}</td></tr>)}</tbody></table>
        <h3 className="font-bold mt-3">الشرائح</h3>
        {out.plan.segments.map((s, i) => <div key={i} className="mkt-item"><div><div className="t">{s.name}</div><div className="s">الاحتياج: {s.needs} · الاعتراضات: {s.objections} · الرسالة: {s.message}</div></div></div>)}
        <h3 className="font-bold mt-3">القنوات وتوزيع الميزانية</h3>
        <table className="mkt-table"><tbody>{out.plan.channels.map((c, i) => <tr key={i}><td>{c.platform}</td><td>{c.role}</td><td className="n">{c.budgetSharePct}%</td><td className="mkt-muted">{c.why}</td></tr>)}</tbody></table>
        <h3 className="font-bold mt-3">التقويم المقترح</h3>
        <table className="mkt-table"><tbody>{out.plan.calendar.map((c, i) => <tr key={i}><td>أسبوع {c.week}</td><td>{c.platform}</td><td>{c.contentType}</td><td>{c.idea}</td><td className="mkt-muted">{c.objective}</td></tr>)}</tbody></table>
        <h3 className="font-bold mt-3">اختبارات A/B</h3>
        {out.plan.experiments.map((e, i) => <div key={i} className="mkt-muted">• {e.hypothesis} — {e.test} — النجاح: {e.successMetric}</div>)}
        <div className="mkt-banner warn" style={{ marginTop: 10 }}>افتراضات: {out.plan.assumptions.join(" · ") || "—"}</div>
        <p className="mkt-muted">البيانات المستخدمة: {out.plan.dataUsed.join(" · ")} · المخاطر: {out.plan.risks.join(" · ")}</p>
      </Sec> : null}
      <Sec title="الخطط السابقة">{history.data?.rows.length ? history.data.rows.map((h) => <div key={h.id} className="mkt-item"><span>{h.title}</span><span className="mkt-muted">{h.createdAt.slice(0, 10)}</span></div>) : <p className="mkt-muted">لا خطط محفوظة.</p>}</Sec>
    </>
  );
}

function ReviewTab() {
  const [text, setText] = useState("");
  const [platform, setPlatform] = useState("");
  const [out, setOut] = useState<{ issues: { kind: string; excerpt: string; suggestion: string }[]; corrected: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  async function run() {
    setBusy(true); setErr("");
    const r = await api<{ issues: { kind: string; excerpt: string; suggestion: string }[]; corrected: string }>("/api/marketing/ai/review", { method: "POST", body: { text, platform: platform || null } });
    setBusy(false);
    if (!r.ok) return setErr(r.data.error ?? "");
    setOut(r.data);
  }
  const KIND: Record<string, string> = { spelling: "إملاء", grammar: "نحو", brand: "هوية العلامة", claim: "ادعاء يحتاج دليلاً", length: "الطول", clarity: "الوضوح" };
  return (
    <Sec title="مراجعة الإملاء واللغة والهوية">
      <Field id="t" label="النص"><TextArea id="t" value={text} onChange={setText} rows={6} /></Field>
      <Field id="pl" label="المنصة (اختياري)"><Select id="pl" value={platform} onChange={setPlatform}><option value="">—</option>{SOCIAL_PLATFORMS.map((p) => <option key={p} value={p}>{platformName(p)}</option>)}</Select></Field>
      <Button onClick={run} disabled={busy || !text}>{busy ? "جارٍ المراجعة…" : "مراجعة"}</Button>
      <Banner onClose={() => setErr("")}>{err}</Banner>
      {out ? <>
        {out.issues.length === 0 ? <p className="mkt-chip" data-tone="good">لا ملاحظات</p> : out.issues.map((i, k) => <div key={k} className="mkt-item"><div><div className="t">{KIND[i.kind] ?? i.kind}: «{i.excerpt}»</div><div className="s">{i.suggestion}</div></div></div>)}
        <h3 className="font-bold mt-3">النسخة المصححة</h3><p className="mkt-pre mkt-sec">{out.corrected}</p>
      </> : null}
    </Sec>
  );
}
