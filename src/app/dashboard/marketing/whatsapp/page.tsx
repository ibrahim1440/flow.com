"use client";

import { useState } from "react";
import { useLang, PageHeader, Spinner, Button, Banner, Sec, Chip, StatusChip, useLoad, useMkt, usePageTitle, api, fmt, fmtDate, RangePicker, useRange, MESSAGE_STATUS, Modal, Field, TextInput, Select, TextArea, Alert, SearchField, specLabel } from "../_components/ui";
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
  const L = (ar: string, en: string) => (lang === "ar" ? ar : en);
  usePageTitle("الواتساب والعملاء", "WhatsApp & customers", lang);
  const { can } = useMkt();
  const [tab, setTab] = useState<Tab>("board");
  const tabs: [Tab, string, boolean][] = [["board", L("لوحة القياس", "Measurement board"), true], ["journeys", L("الرحلات الآلية", "Automated journeys"), can("messaging_manage") || can("customers_data")], ["templates", L("القوالب", "Templates"), true], ["consent", L("الموافقات وإلغاء الاشتراك", "Consent & opt-outs"), can("customers_data")], ["log", L("سجل الرسائل", "Message log"), can("customers_data")]];
  return (
    <div className="mkt" data-testid="mkt-whatsapp">
      <PageHeader title={L("الواتساب والعملاء", "WhatsApp & customers")} subtitle={L("رسائل تسويقية عبر WhatsApp Business Cloud API الرسمي فقط، بقوالب معتمدة وموافقة مسجلة.", "Marketing messages through the official WhatsApp Business Cloud API only, with approved templates and recorded consent.")} />
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
  const lang = useLang();
  const L = (ar: string, en: string) => (lang === "ar" ? ar : en);
  const r = useRange(30);
  const { data, error, loading } = useLoad<Summary>(`/api/marketing/whatsapp/summary?${r.qs}`);
  const tile = (l: string, v: string, hint?: string) => <div className="mkt-kpi" title={hint}><span className={`v ${v === "غير متاح" || v === "Not available" ? "na" : ""}`}><bdi>{v}</bdi></span><span className="l">{l}</span>{hint ? <span className="m">{hint}</span> : null}</div>;
  return (
    <>
      <RangePicker r={r} />
      <Banner>{error}</Banner>
      {loading && !data ? <Spinner /> : data ? <>
        {data.mode !== "LIVE" ? <div className="mkt-banner warn" data-testid="wa-mode">{data.mode === "TEST" ? L("وضع الاختبار: كل الرسائل تذهب لرقم الاختبار بدل العملاء.", "Test mode: every message goes to the test number instead of customers.") : L("الإرسال الفعلي غير مفعّل على الخادم: الرسائل تُسجل «لم تُرسل» مع السبب.", "Live sending is off on the server: messages are recorded as “Not sent” with the reason.")}</div> : null}
        {data.messages.statusUnreported ? <p className="mkt-muted" data-testid="wa-unreported">{L(`${data.messages.statusUnreported} رسالة أُرسلت عبر كرزون: كرزون لا يُبلغ عن التسليم والقراءة لكل رسالة، فهي خارج معدلَي التسليم والقراءة (تظهر في كرزون نفسه).`, `${data.messages.statusUnreported} messages were sent through Karzoun: Karzoun does not report delivery and read per message, so they are outside the delivery and read rates (they show in Karzoun itself).`)}</p> : null}
        <div className="mkt-grid">
          {tile(L("مجدولة", "Scheduled"), fmt(data.messages.scheduled, { unit: "count", lang }))}{tile(L("مرسلة", "Sent"), fmt(data.messages.sent, { unit: "count", lang }))}
          {tile(L("معدل التسليم", "Delivery rate"), fmt(data.messages.deliveryRate, { unit: "pct", lang }), L("المسلّمة ÷ المرسلة", "Delivered ÷ sent"))}{tile(L("معدل القراءة", "Read rate"), fmt(data.messages.readRate, { unit: "pct", lang }), L("المقروءة ÷ المسلّمة", "Read ÷ delivered"))}
          {tile(L("النقرات", "Clicks"), fmt(data.messages.clicks, { unit: "count", lang }), L("نقرات الروابط المتتبعة", "Clicks on tracked links"))}{tile(L("معدل النقر", "Click rate"), fmt(data.messages.clickRate, { unit: "pct", lang }), L("النقرات ÷ المسلّمة", "Clicks ÷ delivered"))}
          {tile(L("فشلت", "Failed"), fmt(data.messages.failed, { unit: "count", lang }))}{tile(L("لم تُرسل", "Not sent"), fmt(data.messages.skipped, { unit: "count", lang }), L("بسبب الموافقة أو القالب أو الإعداد", "Because of consent, the template or the setup"))}
          {tile(L("السلال المتروكة", "Abandoned carts"), fmt(data.carts.abandoned, { unit: "count", lang }))}{tile(L("السلال المستهدفة", "Targeted carts"), fmt(data.carts.targeted, { unit: "count", lang }), L("أُرسلت لها رسالة واحدة على الأقل", "Sent at least one message"))}
          {tile(L("السلال المستعادة", "Recovered carts"), fmt(data.carts.recovered, { unit: "count", lang }), L(`اكتمل طلبها خلال ${data.window.days} أيام`, `Order completed within ${data.window.days} days`))}{tile(L("معدل الاستعادة", "Recovery rate"), fmt(data.carts.recoveryRate, { unit: "pct", lang }), L("المستعادة ÷ المستهدفة × 100", "Recovered ÷ targeted × 100"))}
          {data.money ? <>{tile(L("قيمة الطلبات المستعادة", "Recovered order value"), fmt(data.money.recoveredValue, { unit: "SAR", lang }), L("بعد استبعاد الملغى وخصم المسترد", "After excluding cancelled orders and deducting refunds"))}{tile(L("تكلفة الرسائل", "Messaging cost"), fmt(data.money.messagingCost, { unit: "SAR", lang }), L("كما تُسجل من فاتورة Meta", "As recorded from the Meta invoice"))}{tile(L("تكلفة استعادة الطلب", "Cost per recovered order"), fmt(data.money.costPerRecovery, { unit: "SAR", lang }), L("تكلفة رسائل الاستعادة ÷ الطلبات المستعادة", "Recovery message cost ÷ recovered orders"))}</> : null}
          {tile(L("إلغاء الاشتراك", "Opt-outs"), fmt(data.optOuts, { unit: "count", lang }))}{tile(L("معدل إلغاء الاشتراك", "Opt-out rate"), fmt(data.unsubscribeRate, { unit: "pct", lang }), L("إلغاءات ÷ المرسلة", "Opt-outs ÷ sent"))}
        </div>
        <p className="mkt-muted">{L(`لا يُعد كل شراء بعد رسالة نتيجة لها: تُحسب الاستعادة فقط لسلة استُهدفت ثم اكتمل طلبها داخل نافذة الإسناد. الآلي: ${data.automatedVsManual.automated} · الحملات اليدوية: ${data.automatedVsManual.manual}.`, `Not every purchase after a message counts as its result: a recovery is counted only for a targeted cart whose order completed inside the attribution window. Automated: ${data.automatedVsManual.automated} · manual campaigns: ${data.automatedVsManual.manual}.`)}</p>
        <Sec title={L("أداء القوالب", "Template performance")}>
          {data.perTemplate.length === 0 ? <p className="mkt-muted">{L("لا رسائل في الفترة.", "No messages in this period.")}</p> : <table className="mkt-table"><thead><tr><th>{L("القالب", "Template")}</th><th className="n">{L("أُرسلت", "Sent")}</th><th className="n">{L("سُلّمت", "Delivered")}</th><th className="n">{L("قُرئت", "Read")}</th><th className="n">{L("فشلت", "Failed")}</th><th className="n">{L("لم تُرسل", "Not sent")}</th></tr></thead><tbody>{data.perTemplate.map((t) => <tr key={t.templateId}><td><bdi>{t.name}</bdi></td><td className="n">{Number(t.SENT ?? 0)}</td><td className="n">{Number(t.DELIVERED ?? 0)}</td><td className="n">{Number(t.READ ?? 0)}</td><td className="n">{Number(t.FAILED ?? 0)}</td><td className="n">{Number(t.SKIPPED ?? 0)}</td></tr>)}</tbody></table>}
        </Sec>
      </> : null}
    </>
  );
}

type Template = { id: string; name: string; language: string; category: string; status: string; body: string; variables: string[]; purpose: string | null };

function Journeys() {
  const { can } = useMkt();
  const lang = useLang();
  const L = (ar: string, en: string) => (lang === "ar" ? ar : en);
  const { data, error, reload } = useLoad<{ rows: { id: string; kind: string; name: string; active: boolean; config: { steps?: { waitMinutes: number; templateId: string | null; label?: string }[]; minCartValue?: number | null; expireAfterHours?: number }; label: { ar: string; en: string; implemented: boolean; noteAr: string; noteEn: string }; enrollments: Record<string, number>; pendingApprovalId: string | null }[] }>("/api/marketing/whatsapp/journeys");
  const tpl = useLoad<{ rows: Template[] }>("/api/marketing/whatsapp/templates");
  const [edit, setEdit] = useState<string | null>(null);
  return (
    <>
      <Banner>{error}</Banner>
      {!data ? <Spinner /> : <div className="mkt-list">{data.rows.map((j) => (
        <div key={j.id} className="mkt-item" data-testid={`journey-${j.kind}`}>
          <div><div className="t">{L(j.label.ar, j.label.en)}</div><div className="s">{L(j.label.noteAr, j.label.noteEn)}</div>
            {j.kind === "ABANDONED_CART" ? <div className="s">{(j.config.steps ?? []).map((s, i) => L(`رسالة ${i + 1} بعد ${Math.round(s.waitMinutes / 60 * 10) / 10} ساعة`, `Message ${i + 1} after ${Math.round(s.waitMinutes / 60 * 10) / 10} h`)).join(" · ")} · {L(`صلاحية السلة ${j.config.expireAfterHours ?? 72} ساعة`, `cart valid for ${j.config.expireAfterHours ?? 72} h`)}</div> : null}
            <div className="s">{L("نشطة:", "Active:")} {j.enrollments.ACTIVE ?? 0} · {L("مكتملة:", "Completed:")} {j.enrollments.COMPLETED ?? 0} · {L("متوقفة:", "Stopped:")} {j.enrollments.STOPPED ?? 0}</div>
          </div>
          <div className="mkt-toolbar">
            <Chip tone={j.active ? "good" : undefined}>{j.active ? L("مفعّلة", "On") : L("متوقفة", "Off")}</Chip>
            {j.pendingApprovalId ? <Chip tone="warn">{L("التفعيل بانتظار الاعتماد", "Activation awaiting approval")}</Chip> : null}
            {!j.label.implemented ? <Chip>{L("غير مطبّقة بعد", "Not implemented yet")}</Chip> : can("messaging_manage") ? <Button variant="secondary" onClick={() => setEdit(j.kind)} testId={`edit-${j.kind}`}>{L("إعداد", "Set up")}</Button> : null}
          </div>
        </div>
      ))}</div>}
      {edit && data ? <CartJourney j={data.rows.find((x) => x.kind === edit)!} templates={tpl.data?.rows ?? []} onClose={() => setEdit(null)} onDone={() => { setEdit(null); reload(); }} /> : null}
    </>
  );
}

function CartJourney({ j, templates, onClose, onDone }: { j: { kind: string; active: boolean; config: { steps?: { waitMinutes: number; templateId: string | null; label?: string }[]; minCartValue?: number | null; expireAfterHours?: number } }; templates: Template[]; onClose: () => void; onDone: () => void }) {
  const lang = useLang();
  const L = (ar: string, en: string) => (lang === "ar" ? ar : en);
  const [steps, setSteps] = useState((j.config.steps ?? []).map((s) => ({ hours: String(s.waitMinutes / 60), templateId: s.templateId ?? "", label: s.label ?? "" })));
  const [minValue, setMinValue] = useState(j.config.minCartValue?.toString() ?? "");
  const [expire, setExpire] = useState(String(j.config.expireAfterHours ?? 72));
  const [err, setErr] = useState("");
  const [info, setInfo] = useState("");
  const approved = templates.filter((t) => t.status === "APPROVED");
  async function save(active: boolean) {
    const r = await api<{ approvalId: string | null }>(`/api/marketing/whatsapp/journeys/${j.kind}`, { method: "PUT", body: { active, config: { steps: steps.map((s) => ({ waitMinutes: Math.round(Number(s.hours) * 60), templateId: s.templateId || null, label: s.label || undefined })), minCartValue: minValue ? Number(minValue) : null, expireAfterHours: Number(expire) } } });
    if (!r.ok) return setErr(r.data.error ?? "");
    if (r.data.approvalId) { setInfo(L("أُرسل التفعيل للاعتماد من شخص آخر.", "The activation was sent for someone else's approval.")); return; }
    onDone();
  }
  return (
    <Modal title={L("رحلة استعادة السلة المتروكة", "Abandoned cart recovery journey")} onClose={onClose} wide testId="cart-journey" footer={<><Button variant="secondary" onClick={onClose}>{L("إغلاق", "Close")}</Button><Button variant="secondary" onClick={() => save(false)}>{L("حفظ وإيقاف", "Save and turn off")}</Button><Button onClick={() => save(true)} testId="activate-journey">{L("حفظ وتفعيل", "Save and turn on")}</Button></>}>
      {err ? <Alert kind="error">{err}</Alert> : null}
      {info ? <Alert kind="info">{info}</Alert> : null}
      <ol className="list-decimal ps-5 mkt-muted text-sm">
        <li>{L("تُكتشف السلة من بيانات المتجر، ويُتحقق أن الطلب لم يكتمل.", "The cart is detected from the store's data, and the order is checked as not completed.")}</li>
        <li>{L("لا رسالة دون موافقة تسويقية مسجلة على الرقم، ولا لمن ألغى الاشتراك.", "No message without recorded marketing consent for the number, and none to anyone who opted out.")}</li>
        <li>{L("تُفحص حالة السلة قبل كل رسالة؛ يتوقف التسلسل فور الطلب أو الإلغاء أو انتهاء الصلاحية.", "The cart is re-checked before every message; the sequence stops at once on an order, a cancellation or expiry.")}</li>
        <li>{L("ساعات الهدوء والحد اليومي وحد العميل الأسبوعي من إعدادات التسويق. لا يُنشأ كود خصم تلقائياً.", "Quiet hours, the daily cap and the weekly per-customer cap come from marketing settings. No discount code is created automatically.")}</li>
      </ol>
      <p className="mkt-muted">{L(`الحدود: حتى ${CART_LIMITS.maxSteps} رسائل، الأولى بعد ${CART_LIMITS.minFirstWaitMinutes} دقيقة على الأقل، وبين الرسائل ${CART_LIMITS.minGapMinutes / 60} ساعات على الأقل.`, `Limits: up to ${CART_LIMITS.maxSteps} messages, the first after at least ${CART_LIMITS.minFirstWaitMinutes} minutes, and at least ${CART_LIMITS.minGapMinutes / 60} hours between messages.`)}</p>
      {approved.length === 0 ? <div className="mkt-banner warn">{L("لا توجد قوالب معتمدة من Meta بعد. أنشئها في WhatsApp Manager ثم «مزامنة من Meta».", "No Meta-approved templates yet. Create them in WhatsApp Manager, then “Sync from Meta”.")}</div> : null}
      {steps.map((s, i) => (
        <div key={i} className="mkt-grid-2">
          <Field id={`st-h-${i}`} label={L(`الرسالة ${i + 1}: بعد (ساعات) ${i === 0 ? "من ترك السلة" : "من الرسالة السابقة"}`, `Message ${i + 1}: after (hours) ${i === 0 ? "from cart abandonment" : "from the previous message"}`)}><TextInput id={`st-h-${i}`} value={s.hours} onChange={(v) => setSteps((x) => x.map((y, k) => (k === i ? { ...y, hours: v } : y)))} inputMode="decimal" /></Field>
          <Field id={`st-t-${i}`} label={L("القالب", "Template")}><Select id={`st-t-${i}`} value={s.templateId} onChange={(v) => setSteps((x) => x.map((y, k) => (k === i ? { ...y, templateId: v } : y)))}><option value="">—</option>{approved.map((t) => <option key={t.id} value={t.id}>{t.name} ({t.language})</option>)}</Select></Field>
        </div>
      ))}
      <div className="mkt-toolbar">
        {steps.length < CART_LIMITS.maxSteps ? <Button variant="secondary" onClick={() => setSteps((x) => [...x, { hours: "24", templateId: "", label: "" }])}>{L("إضافة رسالة", "Add message")}</Button> : null}
        {steps.length > 1 ? <Button variant="secondary" onClick={() => setSteps((x) => x.slice(0, -1))}>{L("حذف الأخيرة", "Remove the last")}</Button> : null}
      </div>
      <div className="mkt-grid-2">
        <Field id="minv" label={L("أقل قيمة سلة تُستهدف (ر.س)", "Minimum cart value targeted (SAR)")}><TextInput id="minv" value={minValue} onChange={setMinValue} inputMode="decimal" /></Field>
        <Field id="exp" label={L("صلاحية السلة (ساعات، حتى 168)", "Cart validity (hours, up to 168)")}><TextInput id="exp" value={expire} onChange={setExpire} inputMode="numeric" /></Field>
      </div>
    </Modal>
  );
}

function Templates() {
  const { can } = useMkt();
  const lang = useLang();
  const L = (ar: string, en: string) => (lang === "ar" ? ar : en);
  const { data, error, reload } = useLoad<{ rows: Template[] }>("/api/marketing/whatsapp/templates");
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const [adding, setAdding] = useState(false);
  async function sync() {
    const r = await api<{ synced: number }>("/api/marketing/whatsapp/templates/sync", { method: "POST" });
    if (!r.ok) return setErr(r.data.error ?? "");
    setMsg(L(`زُومنت ${r.data.synced} قالباً من Meta.`, `${r.data.synced} templates synced from Meta.`));
    reload();
  }
  return (
    <>
      <div className="mkt-toolbar">{can("messaging_manage") ? <><Button onClick={sync} testId="sync-templates">{L("مزامنة من Meta", "Sync from Meta")}</Button><Button variant="secondary" onClick={() => setAdding(true)}>{L("مسودة قالب محلية", "Local template draft")}</Button></> : null}</div>
      <p className="mkt-muted">{L("القالب يُعتمد في WhatsApp Manager لدى Meta؛ النظام يقرأ حالته ولا يرسل إلا المعتمد. المسودة المحلية للتخطيط فقط.", "A template is approved in Meta's WhatsApp Manager; the system reads its status and sends only approved ones. A local draft is for planning only.")}</p>
      <Banner tone="info" onClose={() => setMsg("")}>{msg}</Banner>
      <Banner onClose={() => setErr("")}>{err || error}</Banner>
      {!data ? <Spinner /> : data.rows.length === 0 ? <p className="mkt-muted">{L("لا قوالب.", "No templates.")}</p> : <div className="mkt-list">{data.rows.map((t) => (
        <div key={t.id} className="mkt-item"><div style={{ minWidth: 0 }}><div className="t"><bdi>{t.name}</bdi> · {t.language} · {t.category === "MARKETING" ? L("تسويقي", "Marketing") : t.category === "UTILITY" ? L("خدمي", "Utility") : L("مصادقة", "Authentication")}</div><p className="mkt-pre">{t.body}</p><div className="s">{L("المتغيرات:", "Variables:")} {t.variables.join(L("، ", ", ")) || "—"}{t.purpose ? L(` · الغرض: ${t.purpose}`, ` · purpose: ${t.purpose}`) : ""}</div></div><Chip tone={t.status === "APPROVED" ? "good" : t.status === "REJECTED" ? "bad" : "warn"}>{(lang === "ar" ? { APPROVED: "معتمد", PENDING: "قيد مراجعة Meta", REJECTED: "مرفوض", PAUSED: "موقوف", DISABLED: "معطل", LOCAL_DRAFT: "مسودة محلية" } as Record<string, string> : { APPROVED: "Approved", PENDING: "In Meta review", REJECTED: "Rejected", PAUSED: "Paused", DISABLED: "Disabled", LOCAL_DRAFT: "Local draft" } as Record<string, string>)[t.status] ?? t.status}</Chip></div>
      ))}</div>}
      {adding ? <TemplateForm onClose={() => setAdding(false)} onDone={() => { setAdding(false); reload(); }} /> : null}
    </>
  );
}

function TemplateForm({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const lang = useLang();
  const L = (ar: string, en: string) => (lang === "ar" ? ar : en);
  const [f, setF] = useState({ name: "", language: "ar", category: "MARKETING", body: "", variables: "", purpose: "" });
  const [err, setErr] = useState("");
  const set = (k: keyof typeof f) => (v: string) => setF((s) => ({ ...s, [k]: v }));
  async function save() {
    const r = await api("/api/marketing/whatsapp/templates", { method: "POST", body: { ...f, variables: f.variables.split(/[,،\s]+/).filter(Boolean) } });
    if (!r.ok) return setErr(r.data.error ?? "");
    onDone();
  }
  return (
    <Modal title={L("مسودة قالب", "Template draft")} onClose={onClose} footer={<><Button variant="secondary" onClick={onClose}>{L("إلغاء", "Cancel")}</Button><Button onClick={save}>{L("حفظ", "Save")}</Button></>}>
      {err ? <Alert kind="error">{err}</Alert> : null}
      <Field id="t-n" label={L("الاسم (كما في Meta)", "Name (as in Meta)")}><TextInput id="t-n" value={f.name} onChange={set("name")} placeholder="cart_reminder_1" /></Field>
      <Field id="t-c" label={L("الفئة", "Category")}><Select id="t-c" value={f.category} onChange={set("category")}><option value="MARKETING">{L("تسويقي", "Marketing")}</option><option value="UTILITY">{L("خدمي", "Utility")}</option></Select></Field>
      <Field id="t-b" label={L("النص", "Body")} hint={L("المتغيرات {{1}} {{2}} …", "Variables {{1}} {{2}} …")}><TextArea id="t-b" value={f.body} onChange={set("body")} rows={4} /></Field>
      <Field id="t-v" label={L("أسماء المتغيرات بالترتيب", "Variable names in order")} hint={L("مثل: name, value, link (link يصبح رابطاً متتبَّعاً).", "For example: name, value, link (link becomes a tracked link).")}><TextInput id="t-v" value={f.variables} onChange={set("variables")} /></Field>
      <Field id="t-p" label={L("الغرض", "Purpose")}><TextInput id="t-p" value={f.purpose} onChange={set("purpose")} placeholder="ABANDONED_CART" /></Field>
    </Modal>
  );
}

function Consent() {
  const lang = useLang();
  const L = (ar: string, en: string) => (lang === "ar" ? ar : en);
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
      <Sec title={L("تسجيل موافقة أو إلغاء اشتراك", "Record consent or an opt-out")} caption={L("إلغاء الاشتراك يوقف فوراً كل رسالة تسويقية مجدولة لهذا الرقم وكل رحلة نشطة.", "An opt-out stops at once every scheduled marketing message to this number and every active journey.")}>
        <Banner onClose={() => setErr("")}>{err}</Banner>
        <div className="mkt-grid-2">
          <Field id="c-p" label={L("الجوال", "Mobile")}><TextInput id="c-p" value={f.phone} onChange={(v) => setF({ ...f, phone: v })} placeholder="05XXXXXXXX" /></Field>
          <Field id="c-s" label={L("الحالة", "Status")}><Select id="c-s" value={f.status} onChange={(v) => setF({ ...f, status: v })}><option value="OPTED_IN">{L("موافق على الرسائل التسويقية", "Agreed to marketing messages")}</option><option value="OPTED_OUT">{L("ألغى الاشتراك", "Opted out")}</option></Select></Field>
          <Field id="c-src" label={L("المصدر", "Source")}><Select id="c-src" value={f.source} onChange={(v) => setF({ ...f, source: v })}><option value="IN_STORE">{L("في المتجر", "In store")}</option><option value="FORM">{L("نموذج", "Form")}</option><option value="CHECKOUT">{L("عند الشراء", "At checkout")}</option><option value="ADMIN">{L("إداري", "Administrative")}</option></Select></Field>
          <Field id="c-e" label={L("الدليل (أين ومتى)", "Evidence (where and when)")} hint={L("مطلوب للموافقة.", "Required for consent.")}><TextInput id="c-e" value={f.evidence} onChange={(v) => setF({ ...f, evidence: v })} /></Field>
        </div>
        <Button onClick={save} testId="save-consent">{L("حفظ", "Save")}</Button>
      </Sec>
      <div className="mkt-toolbar"><SearchField value={q} onChange={setQ} placeholder={L("ابحث برقم", "Search by number")} label={L("بحث", "Search")} /><div className="mkt-seg">{["", "OPTED_IN", "OPTED_OUT"].map((s) => <button key={s} type="button" aria-pressed={status === s} onClick={() => setStatus(s)}>{s === "" ? L("الكل", "All") : s === "OPTED_IN" ? L(`موافقون (${data?.counts.OPTED_IN ?? 0})`, `Opted in (${data?.counts.OPTED_IN ?? 0})`) : L(`ألغوا (${data?.counts.OPTED_OUT ?? 0})`, `Opted out (${data?.counts.OPTED_OUT ?? 0})`)}</button>)}</div></div>
      <Banner>{error}</Banner>
      {!data ? <Spinner /> : <table className="mkt-table" data-testid="consent-table"><thead><tr><th>{L("الجوال", "Mobile")}</th><th>{L("الحالة", "Status")}</th><th>{L("المصدر", "Source")}</th><th>{L("الدليل", "Evidence")}</th><th>{L("آخر تحديث", "Last updated")}</th></tr></thead><tbody>{data.rows.map((r) => <tr key={r.phone}><td><bdi>+{r.phone}</bdi></td><td><Chip tone={r.status === "OPTED_IN" ? "good" : "bad"}>{r.status === "OPTED_IN" ? L("موافق", "Opted in") : L("ألغى", "Opted out")}</Chip></td><td>{r.source}</td><td className="mkt-muted">{r.evidence}</td><td className="mkt-muted">{fmtDate(r.updatedAt, true)}</td></tr>)}</tbody></table>}
    </>
  );
}

function Log() {
  const { can } = useMkt();
  const lang = useLang();
  const L = (ar: string, en: string) => (lang === "ar" ? ar : en);
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
      <div className="mkt-toolbar"><SearchField value={q} onChange={(v) => { setQ(v); setPage(1); }} placeholder={L("رقم الجوال", "Mobile number")} label={L("بحث", "Search")} /><div className="mkt-seg">{["", ...Object.keys(MESSAGE_STATUS)].map((s) => <button key={s} type="button" aria-pressed={status === s} onClick={() => { setStatus(s); setPage(1); }}>{s ? `${specLabel(MESSAGE_STATUS, s, lang)} (${data?.counts[s] ?? 0})` : L("الكل", "All")}</button>)}</div></div>
      <Banner>{error}</Banner>
      {!data ? <Spinner /> : data.rows.length === 0 ? <p className="mkt-muted">{L("لا رسائل.", "No messages.")}</p> : <div className="mkt-list">{data.rows.map((m) => (
        <div key={m.id} className="mkt-item"><div style={{ minWidth: 0 }}><div className="t"><bdi>+{m.phone}</bdi> · {m.enrollmentId ? L("رحلة آلية", "Automated journey") : m.campaign?.name ?? "—"} · {m.category === "MARKETING" ? L("تسويقية", "Marketing") : L("خدمية", "Utility")}</div><p className="mkt-pre">{m.preview}</p><div className="s">{L("مجدولة", "Scheduled")} {fmtDate(m.scheduledAt, true)}{m.sentAt ? L(` · أُرسلت ${fmtDate(m.sentAt, true)}`, ` · sent ${fmtDate(m.sentAt, true)}`) : ""}{m.statusNote ? ` · ${m.statusNote}` : ""}</div></div><div className="mkt-toolbar"><StatusChip map={MESSAGE_STATUS} value={m.status} />{m.status === "QUEUED" && can("messaging_manage") ? <Button variant="secondary" onClick={() => cancel(m.id)}>{L("إلغاء", "Cancel")}</Button> : null}</div></div>
      ))}</div>}
      {data && data.total > data.perPage ? <div className="mkt-toolbar"><Button variant="secondary" disabled={page === 1} onClick={() => setPage(page - 1)}>{L("السابق", "Previous")}</Button><span>{page} / {Math.ceil(data.total / data.perPage)}</span><Button variant="secondary" disabled={page * data.perPage >= data.total} onClick={() => setPage(page + 1)}>{L("التالي", "Next")}</Button></div> : null}
    </>
  );
}
