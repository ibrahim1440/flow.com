"use client";

import { useState } from "react";
import { useLang, PageHeader, Spinner, Button, Banner, Sec, Chip, useLoad, useMkt, usePageTitle, api, fmt, fmtDate, Field, TextInput, Select, TextArea, NotAllowed } from "../_components/ui";
import { MODULE_SUB_PRIVILEGES } from "@/lib/auth-shared";
import { subLabel } from "@/lib/users/catalog";

/**
 * «إعدادات التسويق» — the kill switches, the approval policy, messaging limits, attribution defaults,
 * the brand kit, product economics, the automation engine's runs and the audit trail. Everyone in the
 * module sees the settings; changing them is marketing › automation_manage (a privileged key).
 */

type Settings = { killAll: boolean; killPublishing: boolean; killAds: boolean; killMessaging: boolean; timezone: string; currency: string; approvalPolicy: Record<string, boolean>; maxMessagesPerDay: number; maxMarketingPerCustomerPerWeek: number; quietHoursStart: number; quietHoursEnd: number; attributionModel: string; attributionWindowDays: number; updatedAt: string };
type Brand = { brandNameAr: string; brandNameEn: string; colors: { name: string; hex: string }[]; fonts: { role: string; family: string }[]; toneAr: string | null; doList: string[]; dontList: string[]; examples: string[] } | null;
type All = { settings: Settings; brand: Brand; approvalActions: { key: string; ar: string; en: string }[]; rolePresets: { key: string; ar: string; en: string; access: string; subs: string[] }[] };

export default function MarketingSettings() {
  const lang = useLang();
  const L = (ar: string, en: string) => (lang === "ar" ? ar : en);
  usePageTitle("إعدادات التسويق", "Marketing settings", lang);
  const { can } = useMkt();
  const { data, error, reload } = useLoad<All>("/api/marketing/settings");
  const [tab, setTab] = useState<"control" | "brand" | "economics" | "automation" | "audit" | "roles">("control");
  return (
    <div className="mkt" data-testid="mkt-settings">
      <PageHeader title={L("إعدادات التسويق", "Marketing settings")} subtitle={can("automation_manage") ? L("التعديل مسجل في سجل التدقيق.", "Changes are recorded in the audit log.") : L("للاطلاع فقط؛ التعديل لمن يملك صلاحية إعدادات التسويق.", "View only; changes are for holders of the marketing settings permission.")} />
      <div className="mkt-seg" role="tablist">{([["control", "الإيقاف والموافقات", "Stops & approvals"], ["brand", "هوية العلامة", "Brand identity"], ["economics", "اقتصاديات المنتجات", "Product economics"], ["automation", "محرك الأتمتة", "Automation engine"], ["roles", "الأدوار", "Roles"], ["audit", "سجل التدقيق", "Audit log"]] as const).map(([k, la, le]) => <button key={k} type="button" role="tab" aria-selected={tab === k} onClick={() => setTab(k)}>{L(la, le)}</button>)}</div>
      <Banner>{error}</Banner>
      {!data ? <Spinner /> : tab === "control" ? <Control key={data.settings.updatedAt} all={data} onSaved={reload} /> : tab === "brand" ? <BrandKit brand={data.brand} onSaved={reload} /> : tab === "economics" ? <Economics /> : tab === "automation" ? <Automation /> : tab === "roles" ? <Roles all={data} /> : can("automation_manage") ? <Audit /> : <NotAllowed what={L("الاطلاع على سجل التدقيق (إعدادات التسويق)", "viewing the audit log (marketing settings)")} />}
    </div>
  );
}

function Control({ all, onSaved }: { all: All; onSaved: () => void }) {
  const { can } = useMkt();
  const lang = useLang();
  const L = (ar: string, en: string) => (lang === "ar" ? ar : en);
  const s = all.settings;
  const [f, setF] = useState({ ...s, approvalPolicy: Object.fromEntries(all.approvalActions.map((a) => [a.key, s.approvalPolicy[a.key] !== false])) });
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  async function kill(scope: string, on: boolean) {
    const reason = prompt(on ? L("سبب تفعيل الإيقاف الطارئ:", "Reason for turning on the emergency stop:") : L("سبب رفع الإيقاف:", "Reason for lifting the stop:"));
    if (!reason) return;
    const r = await api("/api/marketing/settings/kill", { method: "POST", body: { scope, on, reason } });
    if (!r.ok) return setErr(r.data.error ?? "");
    onSaved();
  }
  async function save() {
    const r = await api("/api/marketing/settings", { method: "PUT", body: f });
    if (!r.ok) return setErr(r.data.error ?? "");
    setMsg(L("حُفظت الإعدادات.", "Settings saved."));
    onSaved();
  }
  const switches: [string, string, boolean][] = [["all", L("كل الأتمتة والإرسال", "All automation and sending"), s.killAll], ["publishing", L("النشر", "Publishing"), s.killPublishing], ["ads", L("الإعلانات", "Ads"), s.killAds], ["messaging", L("رسائل واتساب", "WhatsApp messages"), s.killMessaging]];
  return (
    <>
      <Banner tone="info" onClose={() => setMsg("")}>{msg}</Banner>
      <Banner onClose={() => setErr("")}>{err}</Banner>
      <Sec title={L("الإيقاف الطارئ", "Emergency stop (kill switch)")} caption={L("يُقرأ قبل كل عملية خارجية؛ يسري فوراً على النشر والرسائل والإعلانات.", "Read before every external operation; applies at once to publishing, messages and ads.")} testId="kill">
        <div className="mkt-list">{switches.map(([k, l, on]) => (
          <div key={k} className="mkt-item"><span>{l}</span><span className="mkt-toolbar"><Chip tone={on ? "bad" : "good"}>{on ? L("موقوف", "Stopped") : L("يعمل", "Running")}</Chip>{can("automation_manage") ? <Button variant={on ? "secondary" : "danger"} onClick={() => kill(k, !on)} testId={`kill-${k}`}>{on ? L("رفع الإيقاف", "Lift the stop") : L("إيقاف فوري", "Stop now")}</Button> : null}</span></div>
        ))}</div>
      </Sec>
      <fieldset disabled={!can("automation_manage")}>
        <Sec title={L("سياسة الموافقات", "Approval policy")} caption={L("ما يحتاج شخصاً ثانياً قبل التنفيذ. كل البنود مفعّلة افتراضياً؛ إيقاف بند يُسجل في سجل التدقيق. لفريق من شخص واحد: الاعتماد يتطلب شخصاً ثانياً، فأوقف ما لا يمكن تطبيقه بوعي.", "What needs a second person before it runs. Every item is on by default; turning one off is recorded in the audit log. For a one-person team: approval needs a second person, so knowingly turn off what cannot apply.")}>
          <div className="mkt-list">{all.approvalActions.map((a) => (
            <label key={a.key} className="mkt-item"><span>{L(a.ar, a.en)}</span><input type="checkbox" checked={f.approvalPolicy[a.key]} onChange={(e) => setF({ ...f, approvalPolicy: { ...f.approvalPolicy, [a.key]: e.target.checked } })} /></label>
          ))}</div>
        </Sec>
        <Sec title={L("حدود الرسائل", "Message limits")}>
          <div className="mkt-grid-2">
            <Field id="mpd" label={L("الحد اليومي لكل الرسائل", "Daily cap on all messages")}><TextInput id="mpd" value={String(f.maxMessagesPerDay)} onChange={(v) => setF({ ...f, maxMessagesPerDay: Number(v) || 0 })} inputMode="numeric" /></Field>
            <Field id="mpw" label={L("أقصى رسائل تسويقية للعميل أسبوعياً", "Max marketing messages per customer per week")}><TextInput id="mpw" value={String(f.maxMarketingPerCustomerPerWeek)} onChange={(v) => setF({ ...f, maxMarketingPerCustomerPerWeek: Number(v) || 0 })} inputMode="numeric" /></Field>
            <Field id="qs" label={L("بداية ساعات الهدوء (0–23، الرياض)", "Quiet hours start (0–23, Riyadh)")}><TextInput id="qs" value={String(f.quietHoursStart)} onChange={(v) => setF({ ...f, quietHoursStart: Number(v) })} inputMode="numeric" /></Field>
            <Field id="qe" label={L("نهاية ساعات الهدوء", "Quiet hours end")}><TextInput id="qe" value={String(f.quietHoursEnd)} onChange={(v) => setF({ ...f, quietHoursEnd: Number(v) })} inputMode="numeric" /></Field>
          </div>
        </Sec>
        <Sec title={L("الإسناد الافتراضي", "Default attribution")}>
          <div className="mkt-grid-2">
            <Field id="am" label={L("النموذج", "Model")}><Select id="am" value={f.attributionModel} onChange={(v) => setF({ ...f, attributionModel: v })}><option value="LAST_TOUCH">{L("آخر نقطة تواصل", "Last touch")}</option><option value="FIRST_TOUCH">{L("أول نقطة تواصل", "First touch")}</option><option value="LINEAR">{L("توزيع متساوٍ", "Even split")}</option></Select></Field>
            <Field id="aw" label={L("نافذة الإسناد (أيام)", "Attribution window (days)")}><TextInput id="aw" value={String(f.attributionWindowDays)} onChange={(v) => setF({ ...f, attributionWindowDays: Number(v) || 7 })} inputMode="numeric" /></Field>
          </div>
        </Sec>
        {can("automation_manage") ? <Button onClick={save} testId="save-settings">{L("حفظ الإعدادات", "Save settings")}</Button> : null}
      </fieldset>
      <p className="mkt-muted">{L("آخر تعديل", "Last changed")} {fmtDate(s.updatedAt, true)} · {L("المنطقة الزمنية", "Time zone")} {s.timezone} · {L("العملة", "Currency")} {s.currency}</p>
    </>
  );
}

function BrandKit({ brand, onSaved }: { brand: Brand; onSaved: () => void }) {
  const { can } = useMkt();
  const lang = useLang();
  const L = (ar: string, en: string) => (lang === "ar" ? ar : en);
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
    setMsg(L("حُفظت هوية العلامة.", "Brand identity saved."));
    onSaved();
  }
  return (
    <Sec title={L("هوية العلامة", "Brand identity (brand kit)")} caption={L("يستخدمها استوديو الذكاء الاصطناعي ومراجعة النصوص. الشعارات والنصوص المعتمدة لا تُعدّل آلياً.", "Used by the AI studio and copy review. Logos and approved copy are never changed automatically.")}>
      <Banner onClose={() => setErr("")}>{err}</Banner>
      <Banner tone="info" onClose={() => setMsg("")}>{msg}</Banner>
      <fieldset disabled={!can("automation_manage") && !can("content_manage")} className="space-y-3">
        <div className="mkt-grid-2">
          <Field id="bn" label={L("الاسم بالعربية", "Name in Arabic")}><TextInput id="bn" value={f.brandNameAr} onChange={(v) => setF({ ...f, brandNameAr: v })} /></Field>
          <Field id="be" label={L("الاسم بالإنجليزية", "Name in English")}><TextInput id="be" value={f.brandNameEn} onChange={(v) => setF({ ...f, brandNameEn: v })} /></Field>
        </div>
        <Field id="bt" label={L("النبرة والأسلوب", "Tone and style")}><TextArea id="bt" value={f.toneAr} onChange={(v) => setF({ ...f, toneAr: v })} rows={3} /></Field>
        <div className="mkt-grid-2">
          <Field id="bc" label={L("الألوان (سطر لكل لون: الاسم:#RRGGBB)", "Colours (one per line: name:#RRGGBB)")}><TextArea id="bc" value={f.colors} onChange={(v) => setF({ ...f, colors: v })} rows={4} /></Field>
          <Field id="bf" label={L("الخطوط (الاستخدام:الخط)", "Fonts (use:font)")}><TextArea id="bf" value={f.fonts} onChange={(v) => setF({ ...f, fonts: v })} rows={4} /></Field>
          <Field id="bd" label={L("المعتمد (سطر لكل عبارة)", "Approved (one phrase per line)")}><TextArea id="bd" value={f.doList} onChange={(v) => setF({ ...f, doList: v })} rows={4} /></Field>
          <Field id="bx" label={L("الممنوع", "Not allowed")}><TextArea id="bx" value={f.dontList} onChange={(v) => setF({ ...f, dontList: v })} rows={4} /></Field>
        </div>
        <Field id="bex" label={L("أمثلة معتمدة (افصل بينها بسطر ---)", "Approved examples (separate them with a --- line)")}><TextArea id="bex" value={f.examples} onChange={(v) => setF({ ...f, examples: v })} rows={5} /></Field>
        <div className="mkt-toolbar">{lines(f.colors).map((l) => { const hex = l.split(":")[1]?.trim(); return /^#[0-9a-f]{6}$/i.test(hex ?? "") ? <span key={l} className="mkt-chip"><span style={{ width: 14, height: 14, borderRadius: 3, background: hex, display: "inline-block", border: "1px solid var(--border-control)" }} />{l}</span> : null; })}</div>
        <Button onClick={save}>{L("حفظ هوية العلامة", "Save brand identity")}</Button>
      </fieldset>
    </Sec>
  );
}

function Economics() {
  const { can } = useMkt();
  const lang = useLang();
  const L = (ar: string, en: string) => (lang === "ar" ? ar : en);
  const { data, reload } = useLoad<{ rows: { id: string; name: string; economics: { avgOrderValue: number | null; grossMarginPct: number | null; variableCostPerOrder: number | null; targetCac: number | null; repurchaseCycleDays: number | null; vatIncluded: boolean } | null }[] }>("/api/marketing/products");
  const [edit, setEdit] = useState<Record<string, Record<string, string>>>({});
  const [err, setErr] = useState("");
  async function save(id: string) {
    const r = await api(`/api/marketing/products/${id}/economics`, { method: "PUT", body: edit[id] });
    if (!r.ok) return setErr(r.data.error ?? "");
    setEdit((e) => { const x = { ...e }; delete x[id]; return x; });
    reload();
  }
  const fields: [string, string][] = [["avgOrderValue", L("متوسط الطلب ر.س", "Average order SAR")], ["grossMarginPct", L("هامش الربح %", "Gross margin %")], ["variableCostPerOrder", L("تكلفة متغيرة/طلب", "Variable cost / order")], ["targetCac", L("هدف تكلفة الاكتساب", "Target acquisition cost")], ["repurchaseCycleDays", L("دورة إعادة الشراء (يوم)", "Repurchase cycle (days)")]];
  return (
    <Sec title={L("اقتصاديات المنتجات", "Product economics")} caption={L("أساس نقطة التعادل وأهداف تكلفة الاكتساب في محرك القرار. لا تُفترض أرقام عامة؛ الحقل الفارغ يعني «غير مدخل».", "The basis of the break-even point and acquisition-cost targets in the decision engine. No generic figures are assumed; an empty field means “not entered”.")}>
      <Banner onClose={() => setErr("")}>{err}</Banner>
      {!data ? <Spinner /> : <div className="mkt-scroll"><table className="mkt-table"><thead><tr><th>{L("المنتج", "Product")}</th>{fields.map(([, l]) => <th key={l} className="n">{l}</th>)}<th /></tr></thead><tbody>{data.rows.map((p) => {
        const e = edit[p.id];
        return (
          <tr key={p.id}><td>{p.name}</td>{fields.map(([k]) => <td key={k} className="n">{e ? <input className="mkt-chip" style={{ width: 90 }} value={e[k] ?? ""} onChange={(ev) => setEdit({ ...edit, [p.id]: { ...e, [k]: ev.target.value } })} inputMode="decimal" aria-label={k} /> : fmt((p.economics as Record<string, number | null> | null)?.[k] ?? null)}</td>)}
            <td>{can("campaigns_manage") || can("revenue_view") ? (e ? <Button onClick={() => save(p.id)}>{L("حفظ", "Save")}</Button> : <button type="button" className="mkt-chip" onClick={() => setEdit({ ...edit, [p.id]: Object.fromEntries(fields.map(([k]) => [k, String((p.economics as Record<string, number | null> | null)?.[k] ?? "")])) })}>{L("تعديل", "Edit")}</button>) : null}</td></tr>
        );
      })}</tbody></table></div>}
    </Sec>
  );
}

function Automation() {
  const { can } = useMkt();
  const lang = useLang();
  const L = (ar: string, en: string) => (lang === "ar" ? ar : en);
  const { data, reload } = useLoad<{ jobs: { key: string; ar: string; en: string; schedule: string; scheduleEn: string; detail: string; detailEn: string }[]; runs: { id: string; job: string; trigger: string; status: string; startedAt: string; finishedAt: string | null; summary: Record<string, unknown>; error: string | null }[]; schedulerConfigured: boolean }>("/api/marketing/jobs");
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
      <Sec title={L("محرك الأتمتة", "Automation engine")} caption={L("كل مهمة: المحفّز، الشروط، الإجراء، الصلاحية، معالجة الخطأ، إعادة المحاولة، السجل، وطريقة الإيقاف (مفاتيح الإيقاف الطارئ).", "Each job: trigger, conditions, action, permission, error handling, retry, log and how to stop it (the emergency stops).")} actions={can("automation_manage") ? <Button onClick={run} disabled={busy} testId="run-jobs">{L("تشغيل الآن", "Run now")}</Button> : null}>
        {!data ? <Spinner /> : <>
          {!data.schedulerConfigured ? <div className="mkt-banner warn">{L("لا يوجد مجدول مضبوط (CRON_SECRET + استدعاء /api/cron/marketing كل دقيقة إلى 15 دقيقة). تعمل المهام فقط عند «تشغيل الآن».", "No scheduler is configured (CRON_SECRET + a call to /api/cron/marketing every 1 to 15 minutes). Jobs run only on “Run now”.")}</div> : null}
          <table className="mkt-table"><thead><tr><th>{L("المهمة", "Job")}</th><th>{L("التوقيت", "Schedule")}</th><th>{L("ما تفعله", "What it does")}</th></tr></thead><tbody>{data.jobs.map((j) => <tr key={j.key}><td>{L(j.ar, j.en)}</td><td className="mkt-muted">{L(j.schedule, j.scheduleEn)}</td><td className="mkt-muted">{L(j.detail, j.detailEn)}</td></tr>)}</tbody></table>
        </>}
      </Sec>
      <Sec title={L("آخر التشغيلات", "Recent runs")}>
        {!data ? <Spinner /> : data.runs.length === 0 ? <p className="mkt-muted">{L("لم تُشغّل بعد.", "Not run yet.")}</p> : <div className="mkt-scroll"><table className="mkt-table" data-testid="runs"><thead><tr><th>{L("المهمة", "Job")}</th><th>{L("المحفّز", "Trigger")}</th><th>{L("الحالة", "Status")}</th><th>{L("البدء", "Started")}</th><th>{L("النتيجة", "Result")}</th></tr></thead><tbody>{data.runs.map((r) => <tr key={r.id}><td>{(() => { const j = data.jobs.find((x) => x.key === r.job); return j ? L(j.ar, j.en) : r.job; })()}</td><td>{r.trigger === "cron" ? L("المجدول", "Scheduler") : L("يدوي", "Manual")}</td><td><Chip tone={r.status === "SUCCEEDED" ? "good" : r.status === "FAILED" ? "bad" : r.status === "SKIPPED" ? "warn" : "info"}>{r.status}</Chip></td><td className="mkt-muted">{fmtDate(r.startedAt, true)}</td><td className="mkt-muted"><bdi dir="ltr">{r.error ?? JSON.stringify(r.summary)}</bdi></td></tr>)}</tbody></table></div>}
      </Sec>
    </>
  );
}

function Roles({ all }: { all: All }) {
  const lang = useLang();
  const L = (ar: string, en: string) => (lang === "ar" ? ar : en);
  const labels = Object.fromEntries((MODULE_SUB_PRIVILEGES.marketing ?? []).map((s) => [s.key, subLabel("marketing", s.key, lang)]));
  return (
    <Sec title={L("أدوار التسويق المقترحة", "Suggested marketing roles")} caption={L("تُطبّق من «المستخدمون والصلاحيات» على وحدة «التسويق الذكي». الصلاحيات المميّزة (الإعلانات، التكاملات، الإعدادات) للمالك فقط.", "Applied from “Users & permissions” on the “Smart marketing” module. The privileged permissions (ads, integrations, settings) are for the owner only.")}>
      <div className="mkt-scroll"><table className="mkt-table"><thead><tr><th>{L("الدور", "Role")}</th><th>{L("الوصول", "Access")}</th><th>{L("الصلاحيات", "Permissions")}</th></tr></thead><tbody>{all.rolePresets.map((r) => <tr key={r.key}><td>{L(r.ar, r.en)}</td><td>{r.access === "edit" ? L("تعديل", "Edit") : L("عرض", "View")}</td><td className="mkt-muted">{r.subs.map((s) => labels[s] ?? s).join(" · ") || L("عرض فقط", "View only")}</td></tr>)}</tbody></table></div>
    </Sec>
  );
}

function Audit() {
  const lang = useLang();
  const L = (ar: string, en: string) => (lang === "ar" ? ar : en);
  const [page, setPage] = useState(1);
  const [action, setAction] = useState("");
  const { data } = useLoad<{ rows: { id: string; actorKind: string; actorName: string | null; action: string; entityType: string; entityId: string | null; note: string | null; at: string; after: unknown }[]; total: number; perPage: number }>(`/api/marketing/audit?page=${page}&action=${encodeURIComponent(action)}`);
  return (
    <Sec title={L("سجل التدقيق", "Audit log")} caption={L("لا يُعدّل ولا يُحذف (مفروض في قاعدة البيانات).", "Never edited or deleted (enforced in the database).")}>
      <TextInput id="aa" value={action} onChange={(v) => { setAction(v); setPage(1); }} placeholder={L("تصفية بالإجراء: post. campaign. kill. consent.", "Filter by action: post. campaign. kill. consent.")} />
      {!data ? <Spinner /> : <div className="mkt-scroll"><table className="mkt-table" data-testid="audit"><thead><tr><th>{L("الوقت", "Time")}</th><th>{L("الفاعل", "Actor")}</th><th>{L("الإجراء", "Action")}</th><th>{L("الكيان", "Entity")}</th><th>{L("التفاصيل", "Details")}</th></tr></thead><tbody>{data.rows.map((r) => <tr key={r.id}><td className="mkt-muted">{fmtDate(r.at, true)}</td><td>{r.actorName ?? (r.actorKind === "SYSTEM" ? L("النظام", "System") : r.actorKind === "RULE" ? L("قاعدة آلية", "Automatic rule") : L("ويبهوك", "Webhook"))}</td><td><bdi>{r.action}</bdi></td><td className="mkt-muted"><bdi>{r.entityType}{r.entityId ? `:${r.entityId.slice(0, 10)}` : ""}</bdi></td><td className="mkt-muted">{r.note ?? ""}</td></tr>)}</tbody></table></div>}
      {data && data.total > data.perPage ? <div className="mkt-toolbar"><Button variant="secondary" disabled={page === 1} onClick={() => setPage(page - 1)}>{L("السابق", "Previous")}</Button><span>{page}</span><Button variant="secondary" disabled={page * data.perPage >= data.total} onClick={() => setPage(page + 1)}>{L("التالي", "Next")}</Button></div> : null}
    </Sec>
  );
}
