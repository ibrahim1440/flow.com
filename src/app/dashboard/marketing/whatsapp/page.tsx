"use client";

import { useState } from "react";
import { useLang, PageHeader, Spinner, Button, Banner, Sec, Chip, StatusChip, useLoad, useMkt, usePageTitle, api, fmt, fmtDate, RangePicker, useRange, MESSAGE_STATUS, Modal, Field, TextInput, Select, TextArea, Alert, SearchField } from "../_components/ui";
import { CART_LIMITS } from "@/lib/marketing/messaging-rules";

/**
 * «الواتساب والعملاء» — marketing messages over the official WhatsApp Cloud API, the central consent
 * ledger, the abandoned-cart journey and the measurement board. Separate from «الأتمتة والواتساب»
 * (staff notifications through the existing Evolution server), deliberately: customers are messaged
 * only through the official API, with approved templates and recorded opt-in.
 */

type Tab = "board" | "journeys" | "templates" | "consent" | "log";

export default function WhatsAppPage() {
  const lang = useLang();
  usePageTitle("الواتساب والعملاء", "WhatsApp & customers", lang);
  const { can } = useMkt();
  const [tab, setTab] = useState<Tab>("board");
  const tabs: [Tab, string, boolean][] = [["board", "لوحة القياس", true], ["journeys", "الرحلات الآلية", can("messaging_manage") || can("customers_data")], ["templates", "القوالب", true], ["consent", "الموافقات وإلغاء الاشتراك", can("customers_data")], ["log", "سجل الرسائل", can("customers_data")]];
  return (
    <div className="mkt" data-testid="mkt-whatsapp">
      <PageHeader title="الواتساب والعملاء" subtitle="رسائل تسويقية عبر WhatsApp Business Cloud API الرسمي فقط، بقوالب معتمدة وموافقة مسجلة." />
      <div className="mkt-seg" role="tablist">{tabs.filter((t) => t[2]).map(([k, l]) => <button key={k} type="button" role="tab" aria-selected={tab === k} onClick={() => setTab(k)} data-testid={`tab-${k}`}>{l}</button>)}</div>
      {tab === "board" ? <Board /> : tab === "journeys" ? <Journeys /> : tab === "templates" ? <Templates /> : tab === "consent" ? <Consent /> : <Log />}
    </div>
  );
}

type Summary = {
  mode: string; window: { days: number };
  messages: { scheduled: number; sent: number; delivered: number | null; read: number | null; failed: number; skipped: number; deliveryRate: number | null; readRate: number | null; clicks: number; clickRate: number | null; statusUnreported?: number };
  carts: { abandoned: number; targeted: number; recovered: number; recoveryRate: number | null };
  money?: { recoveredValue: number | null; messagingCost: number | null; costPerRecovery: number | null };
  optOuts: number; unsubscribeRate: number | null; perTemplate: ({ templateId: string; name: string } & Record<string, number | string>)[]; automatedVsManual: { automated: number; manual: number };
};

function Board() {
  const r = useRange(30);
  const { data, error, loading } = useLoad<Summary>(`/api/marketing/whatsapp/summary?${r.qs}`);
  const tile = (l: string, v: string, hint?: string) => <div className="mkt-kpi" title={hint}><span className={`v ${v === "غير متاح" ? "na" : ""}`}><bdi>{v}</bdi></span><span className="l">{l}</span>{hint ? <span className="m">{hint}</span> : null}</div>;
  return (
    <>
      <RangePicker r={r} />
      <Banner>{error}</Banner>
      {loading && !data ? <Spinner /> : data ? <>
        {data.mode !== "LIVE" ? <div className="mkt-banner warn" data-testid="wa-mode">{data.mode === "TEST" ? "وضع الاختبار: كل الرسائل تذهب لرقم الاختبار بدل العملاء." : "الإرسال الفعلي غير مفعّل على الخادم: الرسائل تُسجل «لم تُرسل» مع السبب."}</div> : null}
        {data.messages.statusUnreported ? <p className="mkt-muted" data-testid="wa-unreported">{data.messages.statusUnreported} رسالة أُرسلت عبر كرزون: كرزون لا يُبلغ عن التسليم والقراءة لكل رسالة، فهي خارج معدلَي التسليم والقراءة (تظهر في كرزون نفسه).</p> : null}
        <div className="mkt-grid">
          {tile("مجدولة", fmt(data.messages.scheduled, { unit: "count" }))}{tile("مرسلة", fmt(data.messages.sent, { unit: "count" }))}
          {tile("معدل التسليم", fmt(data.messages.deliveryRate, { unit: "pct" }), "المسلّمة ÷ المرسلة")}{tile("معدل القراءة", fmt(data.messages.readRate, { unit: "pct" }), "المقروءة ÷ المسلّمة")}
          {tile("النقرات", fmt(data.messages.clicks, { unit: "count" }), "نقرات الروابط المتتبعة")}{tile("معدل النقر", fmt(data.messages.clickRate, { unit: "pct" }), "النقرات ÷ المسلّمة")}
          {tile("فشلت", fmt(data.messages.failed, { unit: "count" }))}{tile("لم تُرسل", fmt(data.messages.skipped, { unit: "count" }), "بسبب الموافقة أو القالب أو الإعداد")}
          {tile("السلال المتروكة", fmt(data.carts.abandoned, { unit: "count" }))}{tile("السلال المستهدفة", fmt(data.carts.targeted, { unit: "count" }), "أُرسلت لها رسالة واحدة على الأقل")}
          {tile("السلال المستعادة", fmt(data.carts.recovered, { unit: "count" }), `اكتمل طلبها خلال ${data.window.days} أيام`)}{tile("معدل الاستعادة", fmt(data.carts.recoveryRate, { unit: "pct" }), "المستعادة ÷ المستهدفة × 100")}
          {data.money ? <>{tile("قيمة الطلبات المستعادة", fmt(data.money.recoveredValue, { unit: "SAR" }), "بعد استبعاد الملغى وخصم المسترد")}{tile("تكلفة الرسائل", fmt(data.money.messagingCost, { unit: "SAR" }), "كما تُسجل من فاتورة Meta")}{tile("تكلفة استعادة الطلب", fmt(data.money.costPerRecovery, { unit: "SAR" }), "تكلفة رسائل الاستعادة ÷ الطلبات المستعادة")}</> : null}
          {tile("إلغاء الاشتراك", fmt(data.optOuts, { unit: "count" }))}{tile("معدل إلغاء الاشتراك", fmt(data.unsubscribeRate, { unit: "pct" }), "إلغاءات ÷ المرسلة")}
        </div>
        <p className="mkt-muted">لا يُعد كل شراء بعد رسالة نتيجة لها: تُحسب الاستعادة فقط لسلة استُهدفت ثم اكتمل طلبها داخل نافذة الإسناد. الآلي: {data.automatedVsManual.automated} · الحملات اليدوية: {data.automatedVsManual.manual}.</p>
        <Sec title="أداء القوالب">
          {data.perTemplate.length === 0 ? <p className="mkt-muted">لا رسائل في الفترة.</p> : <table className="mkt-table"><thead><tr><th>القالب</th><th className="n">أُرسلت</th><th className="n">سُلّمت</th><th className="n">قُرئت</th><th className="n">فشلت</th><th className="n">لم تُرسل</th></tr></thead><tbody>{data.perTemplate.map((t) => <tr key={t.templateId}><td><bdi>{t.name}</bdi></td><td className="n">{Number(t.SENT ?? 0)}</td><td className="n">{Number(t.DELIVERED ?? 0)}</td><td className="n">{Number(t.READ ?? 0)}</td><td className="n">{Number(t.FAILED ?? 0)}</td><td className="n">{Number(t.SKIPPED ?? 0)}</td></tr>)}</tbody></table>}
        </Sec>
      </> : null}
    </>
  );
}

type Template = { id: string; name: string; language: string; category: string; status: string; body: string; variables: string[]; purpose: string | null };

function Journeys() {
  const { can } = useMkt();
  const { data, error, reload } = useLoad<{ rows: { id: string; kind: string; name: string; active: boolean; config: { steps?: { waitMinutes: number; templateId: string | null; label?: string }[]; minCartValue?: number | null; expireAfterHours?: number }; label: { ar: string; implemented: boolean; noteAr: string }; enrollments: Record<string, number>; pendingApprovalId: string | null }[] }>("/api/marketing/whatsapp/journeys");
  const tpl = useLoad<{ rows: Template[] }>("/api/marketing/whatsapp/templates");
  const [edit, setEdit] = useState<string | null>(null);
  return (
    <>
      <Banner>{error}</Banner>
      {!data ? <Spinner /> : <div className="mkt-list">{data.rows.map((j) => (
        <div key={j.id} className="mkt-item" data-testid={`journey-${j.kind}`}>
          <div><div className="t">{j.label.ar}</div><div className="s">{j.label.noteAr}</div>
            {j.kind === "ABANDONED_CART" ? <div className="s">{(j.config.steps ?? []).map((s, i) => `رسالة ${i + 1} بعد ${Math.round(s.waitMinutes / 60 * 10) / 10} ساعة`).join(" · ")} · صلاحية السلة {j.config.expireAfterHours ?? 72} ساعة</div> : null}
            <div className="s">نشطة: {j.enrollments.ACTIVE ?? 0} · مكتملة: {j.enrollments.COMPLETED ?? 0} · متوقفة: {j.enrollments.STOPPED ?? 0}</div>
          </div>
          <div className="mkt-toolbar">
            <Chip tone={j.active ? "good" : undefined}>{j.active ? "مفعّلة" : "متوقفة"}</Chip>
            {j.pendingApprovalId ? <Chip tone="warn">التفعيل بانتظار الاعتماد</Chip> : null}
            {!j.label.implemented ? <Chip>غير مطبّقة بعد</Chip> : can("messaging_manage") ? <Button variant="secondary" onClick={() => setEdit(j.kind)} testId={`edit-${j.kind}`}>إعداد</Button> : null}
          </div>
        </div>
      ))}</div>}
      {edit && data ? <CartJourney j={data.rows.find((x) => x.kind === edit)!} templates={tpl.data?.rows ?? []} onClose={() => setEdit(null)} onDone={() => { setEdit(null); reload(); }} /> : null}
    </>
  );
}

function CartJourney({ j, templates, onClose, onDone }: { j: { kind: string; active: boolean; config: { steps?: { waitMinutes: number; templateId: string | null; label?: string }[]; minCartValue?: number | null; expireAfterHours?: number } }; templates: Template[]; onClose: () => void; onDone: () => void }) {
  const [steps, setSteps] = useState((j.config.steps ?? []).map((s) => ({ hours: String(s.waitMinutes / 60), templateId: s.templateId ?? "", label: s.label ?? "" })));
  const [minValue, setMinValue] = useState(j.config.minCartValue?.toString() ?? "");
  const [expire, setExpire] = useState(String(j.config.expireAfterHours ?? 72));
  const [err, setErr] = useState("");
  const [info, setInfo] = useState("");
  const approved = templates.filter((t) => t.status === "APPROVED");
  async function save(active: boolean) {
    const r = await api<{ approvalId: string | null }>(`/api/marketing/whatsapp/journeys/${j.kind}`, { method: "PUT", body: { active, config: { steps: steps.map((s) => ({ waitMinutes: Math.round(Number(s.hours) * 60), templateId: s.templateId || null, label: s.label || undefined })), minCartValue: minValue ? Number(minValue) : null, expireAfterHours: Number(expire) } } });
    if (!r.ok) return setErr(r.data.error ?? "");
    if (r.data.approvalId) { setInfo("أُرسل التفعيل للاعتماد من شخص آخر."); return; }
    onDone();
  }
  return (
    <Modal title="رحلة استعادة السلة المتروكة" onClose={onClose} wide testId="cart-journey" footer={<><Button variant="secondary" onClick={onClose}>إغلاق</Button><Button variant="secondary" onClick={() => save(false)}>حفظ وإيقاف</Button><Button onClick={() => save(true)} testId="activate-journey">حفظ وتفعيل</Button></>}>
      {err ? <Alert kind="error">{err}</Alert> : null}
      {info ? <Alert kind="info">{info}</Alert> : null}
      <ol className="list-decimal ps-5 mkt-muted text-sm">
        <li>تُكتشف السلة من بيانات المتجر، ويُتحقق أن الطلب لم يكتمل.</li>
        <li>لا رسالة دون موافقة تسويقية مسجلة على الرقم، ولا لمن ألغى الاشتراك.</li>
        <li>تُفحص حالة السلة قبل كل رسالة؛ يتوقف التسلسل فور الطلب أو الإلغاء أو انتهاء الصلاحية.</li>
        <li>ساعات الهدوء والحد اليومي وحد العميل الأسبوعي من إعدادات التسويق. لا يُنشأ كود خصم تلقائياً.</li>
      </ol>
      <p className="mkt-muted">الحدود: حتى {CART_LIMITS.maxSteps} رسائل، الأولى بعد {CART_LIMITS.minFirstWaitMinutes} دقيقة على الأقل، وبين الرسائل {CART_LIMITS.minGapMinutes / 60} ساعات على الأقل.</p>
      {approved.length === 0 ? <div className="mkt-banner warn">لا توجد قوالب معتمدة من Meta بعد. أنشئها في WhatsApp Manager ثم «مزامنة من Meta».</div> : null}
      {steps.map((s, i) => (
        <div key={i} className="mkt-grid-2">
          <Field id={`st-h-${i}`} label={`الرسالة ${i + 1}: بعد (ساعات) ${i === 0 ? "من ترك السلة" : "من الرسالة السابقة"}`}><TextInput id={`st-h-${i}`} value={s.hours} onChange={(v) => setSteps((x) => x.map((y, k) => (k === i ? { ...y, hours: v } : y)))} inputMode="decimal" /></Field>
          <Field id={`st-t-${i}`} label="القالب"><Select id={`st-t-${i}`} value={s.templateId} onChange={(v) => setSteps((x) => x.map((y, k) => (k === i ? { ...y, templateId: v } : y)))}><option value="">—</option>{approved.map((t) => <option key={t.id} value={t.id}>{t.name} ({t.language})</option>)}</Select></Field>
        </div>
      ))}
      <div className="mkt-toolbar">
        {steps.length < CART_LIMITS.maxSteps ? <Button variant="secondary" onClick={() => setSteps((x) => [...x, { hours: "24", templateId: "", label: "" }])}>إضافة رسالة</Button> : null}
        {steps.length > 1 ? <Button variant="secondary" onClick={() => setSteps((x) => x.slice(0, -1))}>حذف الأخيرة</Button> : null}
      </div>
      <div className="mkt-grid-2">
        <Field id="minv" label="أقل قيمة سلة تُستهدف (ر.س)"><TextInput id="minv" value={minValue} onChange={setMinValue} inputMode="decimal" /></Field>
        <Field id="exp" label="صلاحية السلة (ساعات، حتى 168)"><TextInput id="exp" value={expire} onChange={setExpire} inputMode="numeric" /></Field>
      </div>
    </Modal>
  );
}

function Templates() {
  const { can } = useMkt();
  const { data, error, reload } = useLoad<{ rows: Template[] }>("/api/marketing/whatsapp/templates");
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const [adding, setAdding] = useState(false);
  async function sync() {
    const r = await api<{ synced: number }>("/api/marketing/whatsapp/templates/sync", { method: "POST" });
    if (!r.ok) return setErr(r.data.error ?? "");
    setMsg(`زُومنت ${r.data.synced} قالباً من Meta.`);
    reload();
  }
  return (
    <>
      <div className="mkt-toolbar">{can("messaging_manage") ? <><Button onClick={sync} testId="sync-templates">مزامنة من Meta</Button><Button variant="secondary" onClick={() => setAdding(true)}>مسودة قالب محلية</Button></> : null}</div>
      <p className="mkt-muted">القالب يُعتمد في WhatsApp Manager لدى Meta؛ النظام يقرأ حالته ولا يرسل إلا المعتمد. المسودة المحلية للتخطيط فقط.</p>
      <Banner tone="info" onClose={() => setMsg("")}>{msg}</Banner>
      <Banner onClose={() => setErr("")}>{err || error}</Banner>
      {!data ? <Spinner /> : data.rows.length === 0 ? <p className="mkt-muted">لا قوالب.</p> : <div className="mkt-list">{data.rows.map((t) => (
        <div key={t.id} className="mkt-item"><div style={{ minWidth: 0 }}><div className="t"><bdi>{t.name}</bdi> · {t.language} · {t.category === "MARKETING" ? "تسويقي" : t.category === "UTILITY" ? "خدمي" : "مصادقة"}</div><p className="mkt-pre">{t.body}</p><div className="s">المتغيرات: {t.variables.join("، ") || "—"}{t.purpose ? ` · الغرض: ${t.purpose}` : ""}</div></div><Chip tone={t.status === "APPROVED" ? "good" : t.status === "REJECTED" ? "bad" : "warn"}>{{ APPROVED: "معتمد", PENDING: "قيد مراجعة Meta", REJECTED: "مرفوض", PAUSED: "موقوف", DISABLED: "معطل", LOCAL_DRAFT: "مسودة محلية" }[t.status] ?? t.status}</Chip></div>
      ))}</div>}
      {adding ? <TemplateForm onClose={() => setAdding(false)} onDone={() => { setAdding(false); reload(); }} /> : null}
    </>
  );
}

function TemplateForm({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState({ name: "", language: "ar", category: "MARKETING", body: "", variables: "", purpose: "" });
  const [err, setErr] = useState("");
  const set = (k: keyof typeof f) => (v: string) => setF((s) => ({ ...s, [k]: v }));
  async function save() {
    const r = await api("/api/marketing/whatsapp/templates", { method: "POST", body: { ...f, variables: f.variables.split(/[,،\s]+/).filter(Boolean) } });
    if (!r.ok) return setErr(r.data.error ?? "");
    onDone();
  }
  return (
    <Modal title="مسودة قالب" onClose={onClose} footer={<><Button variant="secondary" onClick={onClose}>إلغاء</Button><Button onClick={save}>حفظ</Button></>}>
      {err ? <Alert kind="error">{err}</Alert> : null}
      <Field id="t-n" label="الاسم (كما في Meta)"><TextInput id="t-n" value={f.name} onChange={set("name")} placeholder="cart_reminder_1" /></Field>
      <Field id="t-c" label="الفئة"><Select id="t-c" value={f.category} onChange={set("category")}><option value="MARKETING">تسويقي</option><option value="UTILITY">خدمي</option></Select></Field>
      <Field id="t-b" label="النص" hint="المتغيرات {{1}} {{2}} …"><TextArea id="t-b" value={f.body} onChange={set("body")} rows={4} /></Field>
      <Field id="t-v" label="أسماء المتغيرات بالترتيب" hint="مثل: name, value, link (link يصبح رابطاً متتبَّعاً)."><TextInput id="t-v" value={f.variables} onChange={set("variables")} /></Field>
      <Field id="t-p" label="الغرض"><TextInput id="t-p" value={f.purpose} onChange={set("purpose")} placeholder="ABANDONED_CART" /></Field>
    </Modal>
  );
}

function Consent() {
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("");
  const { data, error, reload } = useLoad<{ rows: { phone: string; status: string; source: string; evidence: string | null; updatedAt: string }[]; counts: Record<string, number> }>(`/api/marketing/whatsapp/consent?q=${encodeURIComponent(q)}&status=${status}`);
  const [f, setF] = useState({ phone: "", status: "OPTED_IN", source: "IN_STORE", evidence: "" });
  const [err, setErr] = useState("");
  async function save() {
    const r = await api("/api/marketing/whatsapp/consent", { method: "POST", body: f });
    if (!r.ok) return setErr(r.data.error ?? "");
    setF({ ...f, phone: "", evidence: "" });
    reload();
  }
  return (
    <>
      <Sec title="تسجيل موافقة أو إلغاء اشتراك" caption="إلغاء الاشتراك يوقف فوراً كل رسالة تسويقية مجدولة لهذا الرقم وكل رحلة نشطة.">
        <Banner onClose={() => setErr("")}>{err}</Banner>
        <div className="mkt-grid-2">
          <Field id="c-p" label="الجوال"><TextInput id="c-p" value={f.phone} onChange={(v) => setF({ ...f, phone: v })} placeholder="05XXXXXXXX" /></Field>
          <Field id="c-s" label="الحالة"><Select id="c-s" value={f.status} onChange={(v) => setF({ ...f, status: v })}><option value="OPTED_IN">موافق على الرسائل التسويقية</option><option value="OPTED_OUT">ألغى الاشتراك</option></Select></Field>
          <Field id="c-src" label="المصدر"><Select id="c-src" value={f.source} onChange={(v) => setF({ ...f, source: v })}><option value="IN_STORE">في المتجر</option><option value="FORM">نموذج</option><option value="CHECKOUT">عند الشراء</option><option value="ADMIN">إداري</option></Select></Field>
          <Field id="c-e" label="الدليل (أين ومتى)" hint="مطلوب للموافقة."><TextInput id="c-e" value={f.evidence} onChange={(v) => setF({ ...f, evidence: v })} /></Field>
        </div>
        <Button onClick={save} testId="save-consent">حفظ</Button>
      </Sec>
      <div className="mkt-toolbar"><SearchField value={q} onChange={setQ} placeholder="ابحث برقم" label="بحث" /><div className="mkt-seg">{["", "OPTED_IN", "OPTED_OUT"].map((s) => <button key={s} type="button" aria-pressed={status === s} onClick={() => setStatus(s)}>{s === "" ? "الكل" : s === "OPTED_IN" ? `موافقون (${data?.counts.OPTED_IN ?? 0})` : `ألغوا (${data?.counts.OPTED_OUT ?? 0})`}</button>)}</div></div>
      <Banner>{error}</Banner>
      {!data ? <Spinner /> : <table className="mkt-table" data-testid="consent-table"><thead><tr><th>الجوال</th><th>الحالة</th><th>المصدر</th><th>الدليل</th><th>آخر تحديث</th></tr></thead><tbody>{data.rows.map((r) => <tr key={r.phone}><td><bdi>+{r.phone}</bdi></td><td><Chip tone={r.status === "OPTED_IN" ? "good" : "bad"}>{r.status === "OPTED_IN" ? "موافق" : "ألغى"}</Chip></td><td>{r.source}</td><td className="mkt-muted">{r.evidence}</td><td className="mkt-muted">{fmtDate(r.updatedAt, true)}</td></tr>)}</tbody></table>}
    </>
  );
}

function Log() {
  const { can } = useMkt();
  const [status, setStatus] = useState("");
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const { data, error, reload } = useLoad<{ rows: { id: string; phone: string; status: string; statusNote: string | null; preview: string; category: string; scheduledAt: string; sentAt: string | null; campaign: { name: string } | null; enrollmentId: string | null }[]; total: number; perPage: number; counts: Record<string, number> }>(`/api/marketing/whatsapp/messages?status=${status}&q=${encodeURIComponent(q)}&page=${page}`);
  async function cancel(id: string) {
    await api(`/api/marketing/whatsapp/messages/${id}`, { method: "DELETE" });
    reload();
  }
  return (
    <>
      <div className="mkt-toolbar"><SearchField value={q} onChange={(v) => { setQ(v); setPage(1); }} placeholder="رقم الجوال" label="بحث" /><div className="mkt-seg">{["", ...Object.keys(MESSAGE_STATUS)].map((s) => <button key={s} type="button" aria-pressed={status === s} onClick={() => { setStatus(s); setPage(1); }}>{s ? `${MESSAGE_STATUS[s].ar} (${data?.counts[s] ?? 0})` : "الكل"}</button>)}</div></div>
      <Banner>{error}</Banner>
      {!data ? <Spinner /> : data.rows.length === 0 ? <p className="mkt-muted">لا رسائل.</p> : <div className="mkt-list">{data.rows.map((m) => (
        <div key={m.id} className="mkt-item"><div style={{ minWidth: 0 }}><div className="t"><bdi>+{m.phone}</bdi> · {m.enrollmentId ? "رحلة آلية" : m.campaign?.name ?? "—"} · {m.category === "MARKETING" ? "تسويقية" : "خدمية"}</div><p className="mkt-pre">{m.preview}</p><div className="s">مجدولة {fmtDate(m.scheduledAt, true)}{m.sentAt ? ` · أُرسلت ${fmtDate(m.sentAt, true)}` : ""}{m.statusNote ? ` · ${m.statusNote}` : ""}</div></div><div className="mkt-toolbar"><StatusChip map={MESSAGE_STATUS} value={m.status} />{m.status === "QUEUED" && can("messaging_manage") ? <Button variant="secondary" onClick={() => cancel(m.id)}>إلغاء</Button> : null}</div></div>
      ))}</div>}
      {data && data.total > data.perPage ? <div className="mkt-toolbar"><Button variant="secondary" disabled={page === 1} onClick={() => setPage(page - 1)}>السابق</Button><span>{page} / {Math.ceil(data.total / data.perPage)}</span><Button variant="secondary" disabled={page * data.perPage >= data.total} onClick={() => setPage(page + 1)}>التالي</Button></div> : null}
    </>
  );
}
