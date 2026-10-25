"use client";

import { useState } from "react";
import { useLang, PageHeader, Spinner, Button, Banner, Sec, Chip, useLoad, useMkt, usePageTitle, api, fmt, fmtDate, Field, TextInput, Select, TextArea, NotAllowed } from "../_components/ui";
import { MODULE_SUB_PRIVILEGES } from "@/lib/auth-shared";

/**
 * «إعدادات التسويق» — the kill switches, the approval policy, messaging limits, attribution defaults,
 * the brand kit, product economics, the automation engine's runs and the audit trail. Everyone in the
 * module sees the settings; changing them is marketing › automation_manage (a privileged key).
 */

type Settings = { killAll: boolean; killPublishing: boolean; killAds: boolean; killMessaging: boolean; timezone: string; currency: string; approvalPolicy: Record<string, boolean>; maxMessagesPerDay: number; maxMarketingPerCustomerPerWeek: number; quietHoursStart: number; quietHoursEnd: number; attributionModel: string; attributionWindowDays: number; updatedAt: string };
type Brand = { brandNameAr: string; brandNameEn: string; colors: { name: string; hex: string }[]; fonts: { role: string; family: string }[]; toneAr: string | null; doList: string[]; dontList: string[]; examples: string[] } | null;
type All = { settings: Settings; brand: Brand; approvalActions: { key: string; ar: string }[]; rolePresets: { key: string; ar: string; access: string; subs: string[] }[] };

export default function MarketingSettings() {
  const lang = useLang();
  usePageTitle("إعدادات التسويق", "Marketing settings", lang);
  const { can } = useMkt();
  const { data, error, reload } = useLoad<All>("/api/marketing/settings");
  const [tab, setTab] = useState<"control" | "brand" | "economics" | "automation" | "audit" | "roles">("control");
  return (
    <div className="mkt" data-testid="mkt-settings">
      <PageHeader title="إعدادات التسويق" subtitle={can("automation_manage") ? "التعديل مسجل في سجل التدقيق." : "للاطلاع فقط؛ التعديل لمن يملك صلاحية إعدادات التسويق."} />
      <div className="mkt-seg" role="tablist">{([["control", "الإيقاف والموافقات"], ["brand", "هوية العلامة"], ["economics", "اقتصاديات المنتجات"], ["automation", "محرك الأتمتة"], ["roles", "الأدوار"], ["audit", "سجل التدقيق"]] as const).map(([k, l]) => <button key={k} type="button" role="tab" aria-selected={tab === k} onClick={() => setTab(k)}>{l}</button>)}</div>
      <Banner>{error}</Banner>
      {!data ? <Spinner /> : tab === "control" ? <Control key={data.settings.updatedAt} all={data} onSaved={reload} /> : tab === "brand" ? <BrandKit brand={data.brand} onSaved={reload} /> : tab === "economics" ? <Economics /> : tab === "automation" ? <Automation /> : tab === "roles" ? <Roles all={data} /> : can("automation_manage") ? <Audit /> : <NotAllowed what="الاطلاع على سجل التدقيق (إعدادات التسويق)" />}
    </div>
  );
}

function Control({ all, onSaved }: { all: All; onSaved: () => void }) {
  const { can } = useMkt();
  const s = all.settings;
  const [f, setF] = useState({ ...s, approvalPolicy: Object.fromEntries(all.approvalActions.map((a) => [a.key, s.approvalPolicy[a.key] !== false])) });
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  async function kill(scope: string, on: boolean) {
    const reason = prompt(on ? "سبب تفعيل الإيقاف الطارئ:" : "سبب رفع الإيقاف:");
    if (!reason) return;
    const r = await api("/api/marketing/settings/kill", { method: "POST", body: { scope, on, reason } });
    if (!r.ok) return setErr(r.data.error ?? "");
    onSaved();
  }
  async function save() {
    const r = await api("/api/marketing/settings", { method: "PUT", body: f });
    if (!r.ok) return setErr(r.data.error ?? "");
    setMsg("حُفظت الإعدادات.");
    onSaved();
  }
  const switches: [string, string, boolean][] = [["all", "كل الأتمتة والإرسال", s.killAll], ["publishing", "النشر", s.killPublishing], ["ads", "الإعلانات", s.killAds], ["messaging", "رسائل واتساب", s.killMessaging]];
  return (
    <>
      <Banner tone="info" onClose={() => setMsg("")}>{msg}</Banner>
      <Banner onClose={() => setErr("")}>{err}</Banner>
      <Sec title="الإيقاف الطارئ (Kill Switch)" caption="يُقرأ قبل كل عملية خارجية؛ يسري فوراً على النشر والرسائل والإعلانات." testId="kill">
        <div className="mkt-list">{switches.map(([k, l, on]) => (
          <div key={k} className="mkt-item"><span>{l}</span><span className="mkt-toolbar"><Chip tone={on ? "bad" : "good"}>{on ? "موقوف" : "يعمل"}</Chip>{can("automation_manage") ? <Button variant={on ? "secondary" : "danger"} onClick={() => kill(k, !on)} testId={`kill-${k}`}>{on ? "رفع الإيقاف" : "إيقاف فوري"}</Button> : null}</span></div>
        ))}</div>
      </Sec>
      <fieldset disabled={!can("automation_manage")}>
        <Sec title="سياسة الموافقات" caption="ما يحتاج شخصاً ثانياً قبل التنفيذ. كل البنود مفعّلة افتراضياً؛ إيقاف بند يُسجل في سجل التدقيق. لفريق من شخص واحد: الاعتماد يتطلب شخصاً ثانياً، فأوقف ما لا يمكن تطبيقه بوعي.">
          <div className="mkt-list">{all.approvalActions.map((a) => (
            <label key={a.key} className="mkt-item"><span>{a.ar}</span><input type="checkbox" checked={f.approvalPolicy[a.key]} onChange={(e) => setF({ ...f, approvalPolicy: { ...f.approvalPolicy, [a.key]: e.target.checked } })} /></label>
          ))}</div>
        </Sec>
        <Sec title="حدود الرسائل">
          <div className="mkt-grid-2">
            <Field id="mpd" label="الحد اليومي لكل الرسائل"><TextInput id="mpd" value={String(f.maxMessagesPerDay)} onChange={(v) => setF({ ...f, maxMessagesPerDay: Number(v) || 0 })} inputMode="numeric" /></Field>
            <Field id="mpw" label="أقصى رسائل تسويقية للعميل أسبوعياً"><TextInput id="mpw" value={String(f.maxMarketingPerCustomerPerWeek)} onChange={(v) => setF({ ...f, maxMarketingPerCustomerPerWeek: Number(v) || 0 })} inputMode="numeric" /></Field>
            <Field id="qs" label="بداية ساعات الهدوء (0–23، الرياض)"><TextInput id="qs" value={String(f.quietHoursStart)} onChange={(v) => setF({ ...f, quietHoursStart: Number(v) })} inputMode="numeric" /></Field>
            <Field id="qe" label="نهاية ساعات الهدوء"><TextInput id="qe" value={String(f.quietHoursEnd)} onChange={(v) => setF({ ...f, quietHoursEnd: Number(v) })} inputMode="numeric" /></Field>
          </div>
        </Sec>
        <Sec title="الإسناد الافتراضي">
          <div className="mkt-grid-2">
            <Field id="am" label="النموذج"><Select id="am" value={f.attributionModel} onChange={(v) => setF({ ...f, attributionModel: v })}><option value="LAST_TOUCH">آخر نقطة تواصل</option><option value="FIRST_TOUCH">أول نقطة تواصل</option><option value="LINEAR">توزيع متساوٍ</option></Select></Field>
            <Field id="aw" label="نافذة الإسناد (أيام)"><TextInput id="aw" value={String(f.attributionWindowDays)} onChange={(v) => setF({ ...f, attributionWindowDays: Number(v) || 7 })} inputMode="numeric" /></Field>
          </div>
        </Sec>
        {can("automation_manage") ? <Button onClick={save} testId="save-settings">حفظ الإعدادات</Button> : null}
      </fieldset>
      <p className="mkt-muted">آخر تعديل {fmtDate(s.updatedAt, true)} · المنطقة الزمنية {s.timezone} · العملة {s.currency}</p>
    </>
  );
}

function BrandKit({ brand, onSaved }: { brand: Brand; onSaved: () => void }) {
  const { can } = useMkt();
  const [f, setF] = useState({ brandNameAr: brand?.brandNameAr ?? "حقبة", brandNameEn: brand?.brandNameEn ?? "Hiqbah", toneAr: brand?.toneAr ?? "", colors: (brand?.colors ?? []).map((c) => `${c.name}:${c.hex}`).join("\n"), fonts: (brand?.fonts ?? []).map((x) => `${x.role}:${x.family}`).join("\n"), doList: (brand?.doList ?? []).join("\n"), dontList: (brand?.dontList ?? []).join("\n"), examples: (brand?.examples ?? []).join("\n---\n") });
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");
  const lines = (s: string) => s.split("\n").map((x) => x.trim()).filter(Boolean);
  async function save() {
    const r = await api("/api/marketing/settings/brand", { method: "PUT", body: {
      ...f, colors: lines(f.colors).map((l) => ({ name: l.split(":")[0], hex: l.split(":")[1]?.trim() })), fonts: lines(f.fonts).map((l) => ({ role: l.split(":")[0], family: l.split(":").slice(1).join(":").trim() })),
      doList: lines(f.doList), dontList: lines(f.dontList), examples: f.examples.split(/\n---\n/).map((x) => x.trim()).filter(Boolean),
    } });
    if (!r.ok) return setErr(r.data.error ?? "");
    setMsg("حُفظت هوية العلامة.");
    onSaved();
  }
  return (
    <Sec title="هوية العلامة (Brand Kit)" caption="يستخدمها استوديو الذكاء الاصطناعي ومراجعة النصوص. الشعارات والنصوص المعتمدة لا تُعدّل آلياً.">
      <Banner onClose={() => setErr("")}>{err}</Banner>
      <Banner tone="info" onClose={() => setMsg("")}>{msg}</Banner>
      <fieldset disabled={!can("automation_manage") && !can("content_manage")} className="space-y-3">
        <div className="mkt-grid-2">
          <Field id="bn" label="الاسم بالعربية"><TextInput id="bn" value={f.brandNameAr} onChange={(v) => setF({ ...f, brandNameAr: v })} /></Field>
          <Field id="be" label="الاسم بالإنجليزية"><TextInput id="be" value={f.brandNameEn} onChange={(v) => setF({ ...f, brandNameEn: v })} /></Field>
        </div>
        <Field id="bt" label="النبرة والأسلوب"><TextArea id="bt" value={f.toneAr} onChange={(v) => setF({ ...f, toneAr: v })} rows={3} /></Field>
        <div className="mkt-grid-2">
          <Field id="bc" label="الألوان (سطر لكل لون: الاسم:#RRGGBB)"><TextArea id="bc" value={f.colors} onChange={(v) => setF({ ...f, colors: v })} rows={4} /></Field>
          <Field id="bf" label="الخطوط (الاستخدام:الخط)"><TextArea id="bf" value={f.fonts} onChange={(v) => setF({ ...f, fonts: v })} rows={4} /></Field>
          <Field id="bd" label="المعتمد (سطر لكل عبارة)"><TextArea id="bd" value={f.doList} onChange={(v) => setF({ ...f, doList: v })} rows={4} /></Field>
          <Field id="bx" label="الممنوع"><TextArea id="bx" value={f.dontList} onChange={(v) => setF({ ...f, dontList: v })} rows={4} /></Field>
        </div>
        <Field id="bex" label="أمثلة معتمدة (افصل بينها بسطر ---)"><TextArea id="bex" value={f.examples} onChange={(v) => setF({ ...f, examples: v })} rows={5} /></Field>
        <div className="mkt-toolbar">{lines(f.colors).map((l) => { const hex = l.split(":")[1]?.trim(); return /^#[0-9a-f]{6}$/i.test(hex ?? "") ? <span key={l} className="mkt-chip"><span style={{ width: 14, height: 14, borderRadius: 3, background: hex, display: "inline-block", border: "1px solid var(--border-control)" }} />{l}</span> : null; })}</div>
        <Button onClick={save}>حفظ هوية العلامة</Button>
      </fieldset>
    </Sec>
  );
}

function Economics() {
  const { can } = useMkt();
  const { data, reload } = useLoad<{ rows: { id: string; name: string; economics: { avgOrderValue: number | null; grossMarginPct: number | null; variableCostPerOrder: number | null; targetCac: number | null; repurchaseCycleDays: number | null; vatIncluded: boolean } | null }[] }>("/api/marketing/products");
  const [edit, setEdit] = useState<Record<string, Record<string, string>>>({});
  const [err, setErr] = useState("");
  async function save(id: string) {
    const r = await api(`/api/marketing/products/${id}/economics`, { method: "PUT", body: edit[id] });
    if (!r.ok) return setErr(r.data.error ?? "");
    setEdit((e) => { const x = { ...e }; delete x[id]; return x; });
    reload();
  }
  const fields: [string, string][] = [["avgOrderValue", "متوسط الطلب ر.س"], ["grossMarginPct", "هامش الربح %"], ["variableCostPerOrder", "تكلفة متغيرة/طلب"], ["targetCac", "هدف تكلفة الاكتساب"], ["repurchaseCycleDays", "دورة إعادة الشراء (يوم)"]];
  return (
    <Sec title="اقتصاديات المنتجات" caption="أساس نقطة التعادل وأهداف تكلفة الاكتساب في محرك القرار. لا تُفترض أرقام عامة؛ الحقل الفارغ يعني «غير مدخل».">
      <Banner onClose={() => setErr("")}>{err}</Banner>
      {!data ? <Spinner /> : <div className="mkt-scroll"><table className="mkt-table"><thead><tr><th>المنتج</th>{fields.map(([, l]) => <th key={l} className="n">{l}</th>)}<th /></tr></thead><tbody>{data.rows.map((p) => {
        const e = edit[p.id];
        return (
          <tr key={p.id}><td>{p.name}</td>{fields.map(([k]) => <td key={k} className="n">{e ? <input className="mkt-chip" style={{ width: 90 }} value={e[k] ?? ""} onChange={(ev) => setEdit({ ...edit, [p.id]: { ...e, [k]: ev.target.value } })} inputMode="decimal" aria-label={k} /> : fmt((p.economics as Record<string, number | null> | null)?.[k] ?? null)}</td>)}
            <td>{can("campaigns_manage") || can("revenue_view") ? (e ? <Button onClick={() => save(p.id)}>حفظ</Button> : <button type="button" className="mkt-chip" onClick={() => setEdit({ ...edit, [p.id]: Object.fromEntries(fields.map(([k]) => [k, String((p.economics as Record<string, number | null> | null)?.[k] ?? "")])) })}>تعديل</button>) : null}</td></tr>
        );
      })}</tbody></table></div>}
    </Sec>
  );
}

function Automation() {
  const { can } = useMkt();
  const { data, reload } = useLoad<{ jobs: { key: string; ar: string; schedule: string; detail: string }[]; runs: { id: string; job: string; trigger: string; status: string; startedAt: string; finishedAt: string | null; summary: Record<string, unknown>; error: string | null }[]; schedulerConfigured: boolean }>("/api/marketing/jobs");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  async function run() {
    setBusy(true);
    const r = await api("/api/marketing/jobs", { method: "POST" });
    setBusy(false);
    if (!r.ok) setErr(r.data.error ?? "");
    reload();
  }
  return (
    <>
      <Banner onClose={() => setErr("")}>{err}</Banner>
      <Sec title="محرك الأتمتة" caption="كل مهمة: المحفّز، الشروط، الإجراء، الصلاحية، معالجة الخطأ، إعادة المحاولة، السجل، وطريقة الإيقاف (مفاتيح الإيقاف الطارئ)." actions={can("automation_manage") ? <Button onClick={run} disabled={busy} testId="run-jobs">تشغيل الآن</Button> : null}>
        {!data ? <Spinner /> : <>
          {!data.schedulerConfigured ? <div className="mkt-banner warn">لا يوجد مجدول مضبوط (CRON_SECRET + استدعاء /api/cron/marketing كل دقيقة إلى 15 دقيقة). تعمل المهام فقط عند «تشغيل الآن».</div> : null}
          <table className="mkt-table"><thead><tr><th>المهمة</th><th>التوقيت</th><th>ما تفعله</th></tr></thead><tbody>{data.jobs.map((j) => <tr key={j.key}><td>{j.ar}</td><td className="mkt-muted">{j.schedule}</td><td className="mkt-muted">{j.detail}</td></tr>)}</tbody></table>
        </>}
      </Sec>
      <Sec title="آخر التشغيلات">
        {!data ? <Spinner /> : data.runs.length === 0 ? <p className="mkt-muted">لم تُشغّل بعد.</p> : <div className="mkt-scroll"><table className="mkt-table" data-testid="runs"><thead><tr><th>المهمة</th><th>المحفّز</th><th>الحالة</th><th>البدء</th><th>النتيجة</th></tr></thead><tbody>{data.runs.map((r) => <tr key={r.id}><td>{data.jobs.find((j) => j.key === r.job)?.ar ?? r.job}</td><td>{r.trigger === "cron" ? "المجدول" : "يدوي"}</td><td><Chip tone={r.status === "SUCCEEDED" ? "good" : r.status === "FAILED" ? "bad" : r.status === "SKIPPED" ? "warn" : "info"}>{r.status}</Chip></td><td className="mkt-muted">{fmtDate(r.startedAt, true)}</td><td className="mkt-muted"><bdi dir="ltr">{r.error ?? JSON.stringify(r.summary)}</bdi></td></tr>)}</tbody></table></div>}
      </Sec>
    </>
  );
}

function Roles({ all }: { all: All }) {
  const labels = Object.fromEntries((MODULE_SUB_PRIVILEGES.marketing ?? []).map((s) => [s.key, s.label]));
  return (
    <Sec title="أدوار التسويق المقترحة" caption="تُطبّق من «المستخدمون والصلاحيات» على وحدة «التسويق الذكي». الصلاحيات المميّزة (الإعلانات، التكاملات، الإعدادات) للمالك فقط.">
      <div className="mkt-scroll"><table className="mkt-table"><thead><tr><th>الدور</th><th>الوصول</th><th>الصلاحيات</th></tr></thead><tbody>{all.rolePresets.map((r) => <tr key={r.key}><td>{r.ar}</td><td>{r.access === "edit" ? "تعديل" : "عرض"}</td><td className="mkt-muted">{r.subs.map((s) => labels[s] ?? s).join(" · ") || "عرض فقط"}</td></tr>)}</tbody></table></div>
    </Sec>
  );
}

function Audit() {
  const [page, setPage] = useState(1);
  const [action, setAction] = useState("");
  const { data } = useLoad<{ rows: { id: string; actorKind: string; actorName: string | null; action: string; entityType: string; entityId: string | null; note: string | null; at: string; after: unknown }[]; total: number; perPage: number }>(`/api/marketing/audit?page=${page}&action=${encodeURIComponent(action)}`);
  return (
    <Sec title="سجل التدقيق" caption="لا يُعدّل ولا يُحذف (مفروض في قاعدة البيانات).">
      <TextInput id="aa" value={action} onChange={(v) => { setAction(v); setPage(1); }} placeholder="تصفية بالإجراء: post. campaign. kill. consent." />
      {!data ? <Spinner /> : <div className="mkt-scroll"><table className="mkt-table" data-testid="audit"><thead><tr><th>الوقت</th><th>الفاعل</th><th>الإجراء</th><th>الكيان</th><th>التفاصيل</th></tr></thead><tbody>{data.rows.map((r) => <tr key={r.id}><td className="mkt-muted">{fmtDate(r.at, true)}</td><td>{r.actorName ?? (r.actorKind === "SYSTEM" ? "النظام" : r.actorKind === "RULE" ? "قاعدة آلية" : "ويبهوك")}</td><td><bdi>{r.action}</bdi></td><td className="mkt-muted"><bdi>{r.entityType}{r.entityId ? `:${r.entityId.slice(0, 10)}` : ""}</bdi></td><td className="mkt-muted">{r.note ?? ""}</td></tr>)}</tbody></table></div>}
      {data && data.total > data.perPage ? <div className="mkt-toolbar"><Button variant="secondary" disabled={page === 1} onClick={() => setPage(page - 1)}>السابق</Button><span>{page}</span><Button variant="secondary" disabled={page * data.perPage >= data.total} onClick={() => setPage(page + 1)}>التالي</Button></div> : null}
    </Sec>
  );
}
