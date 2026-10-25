"use client";

import Link from "next/link";
import { use, useState } from "react";
import {
  useLang, PageHeader, Spinner, Button, Banner, Sec, Chip, StatusChip, useLoad, useMkt, usePageTitle, fmt, fmtDate, platformName, api,
  CAMPAIGN_STATUS, OBJECTIVES, POST_STATUS, APPROVAL_STATUS, Field, TextInput, Select, TextArea, Modal, Alert,
} from "../../_components/ui";
import { CampaignForm, type CampaignRow } from "../form";
import { buildUtmUrl, UTM_MEDIUM } from "@/lib/marketing/utm";
import { VERDICT_LABELS, type Verdict } from "@/lib/marketing/decision";

type Decision = { id: string; verdict: Verdict; confidence: string; reasoning: string; requiresApproval: boolean; status: string; outcomeNote: string | null; createdAt: string; periodStart: string; periodEnd: string; evidence: Record<string, unknown> };
type Detail = {
  campaign: CampaignRow;
  decisions: Decision[];
  posts: { id: string; title: string; status: string; scheduledAt: string | null }[];
  approvals: { id: string; action: string; status: string; requestedByName: string | null; decidedByName: string | null; decisionNote: string | null; createdAt: string }[];
};

const EVIDENCE_LABELS: Record<string, string> = {
  spend: "الإنفاق", linkClicks: "نقرات الرابط", orders: "الطلبات المنسوبة", newCustomers: "العملاء الجدد", netRevenue: "الإيراد المنسوب", cac: "تكلفة الاكتساب",
  cpa: "تكلفة الطلب", roas: "العائد", cvrPct: "معدل التحويل %", targetCac: "هدف تكلفة الاكتساب", targetRoas: "هدف العائد", breakEvenRoas: "نقطة التعادل",
  minSpend: "حد الإنفاق للحكم", minConversions: "حد الطلبات للحكم", trackingHealthy: "صحة التتبع", dataAgeHours: "عمر البيانات (ساعة)", periodDays: "أيام الفترة",
};

export default function CampaignDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const lang = useLang();
  usePageTitle("الحملة", "Campaign", lang);
  const { can } = useMkt();
  const { data, error, loading, reload } = useLoad<Detail>(`/api/marketing/campaigns/${id}`);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const [edit, setEdit] = useState(false);
  const [wa, setWa] = useState(false);
  const [busy, setBusy] = useState(false);

  async function status(to: string) {
    const note = to === "ACTIVE" || to === "PAUSED" ? prompt("ملاحظة (اختيارية):") ?? "" : "";
    const r = await api<{ status: string; approval: { id: string } | null }>(`/api/marketing/campaigns/${id}/status`, { method: "POST", body: { status: to, note } });
    if (!r.ok) return setErr(r.data.error ?? "");
    setMsg(r.data.approval ? "أُرسل طلب اعتماد؛ تتغير الحالة بعد اعتماده من شخص آخر." : "تم تحديث الحالة.");
    reload();
  }

  async function evaluate() {
    setBusy(true);
    const r = await api(`/api/marketing/campaigns/${id}/evaluate`, { method: "POST" });
    setBusy(false);
    if (!r.ok) return setErr(r.data.error ?? "");
    setMsg("قُيّمت الحملة لآخر 7 أيام. التوصية أدناه لا تُنفّذ شيئاً بنفسها.");
    reload();
  }

  async function closeDecision(d: Decision, st: "ACCEPTED" | "DISMISSED" | "EXECUTED") {
    const outcomeNote = st === "EXECUTED" ? prompt("ما الذي نُفّذ وما النتيجة؟") : st === "DISMISSED" ? prompt("سبب التجاهل (اختياري):") : "";
    if (st === "EXECUTED" && !outcomeNote) return;
    const r = await api(`/api/marketing/decisions/${d.id}`, { method: "PATCH", body: { status: st, outcomeNote } });
    if (!r.ok) return setErr(r.data.error ?? "");
    reload();
  }

  if (loading && !data) return <Spinner />;
  if (!data) return <div className="mkt"><Banner>{error || "الحملة غير موجودة."}</Banner></div>;
  const c = data.campaign;
  const latest = data.decisions[0];
  const ev = (latest?.evidence ?? {}) as Record<string, unknown>;

  return (
    <div className="mkt" data-testid="mkt-campaign">
      <PageHeader title={c.name} subtitle={<><StatusChip map={CAMPAIGN_STATUS} value={c.status} testId="campaign-status" /> · {OBJECTIVES[c.objective]} · <bdi>{c.utmCampaign}</bdi> · {fmtDate(c.startAt)} → {fmtDate(c.endAt)}</>}
        actions={can("campaigns_manage") ? (
          <>
            <Button variant="secondary" onClick={() => setEdit(true)} testId="edit-campaign">تعديل</Button>
            {["DRAFT", "PLANNED", "PAUSED"].includes(c.status) ? <Button onClick={() => status("ACTIVE")} testId="activate">تفعيل</Button> : null}
            {c.status === "DRAFT" ? <Button variant="secondary" onClick={() => status("PLANNED")}>تخطيط</Button> : null}
            {c.status === "ACTIVE" ? <Button variant="secondary" onClick={() => status("PAUSED")} testId="pause">إيقاف مؤقت</Button> : null}
            {["ACTIVE", "PAUSED"].includes(c.status) ? <Button variant="secondary" onClick={() => status("COMPLETED")}>إنهاء</Button> : null}
            {can("messaging_manage") ? <Button variant="secondary" onClick={() => setWa(true)} testId="wa-send">رسالة واتساب للحملة</Button> : null}
          </>
        ) : null} />
      <Banner tone="info" onClose={() => setMsg("")}>{msg}</Banner>
      <Banner onClose={() => setErr("")}>{err}</Banner>

      <div className="mkt-grid-2">
        <Sec title="تفاصيل الحملة">
          <dl className="mkt-list">
            <div><dt className="mkt-muted">المنتج</dt><dd>{c.product?.name ?? "—"}</dd></div>
            <div><dt className="mkt-muted">القنوات</dt><dd>{c.channels.map((x) => platformName(x)).join("، ") || "—"}</dd></div>
            <div><dt className="mkt-muted">الجمهور</dt><dd className="mkt-pre">{c.audience ?? "—"}</dd></div>
            <div><dt className="mkt-muted">العرض</dt><dd className="mkt-pre">{c.offer ?? "—"}</dd></div>
            <div><dt className="mkt-muted">الميزانية المخططة</dt><dd>{fmt(c.plannedBudget, { unit: "SAR" })}</dd></div>
            <div><dt className="mkt-muted">الأهداف</dt><dd>تكلفة اكتساب ≤ {fmt(c.targetCac, { unit: "SAR" })} · عائد ≥ {fmt(c.targetRoas, { unit: "x" })}</dd></div>
          </dl>
        </Sec>
        <Sec title="روابط التتبع (UTM)" caption="انسخ الرابط المناسب لكل قناة؛ الطلبات القادمة منه تُنسب لهذه الحملة.">
          {!c.landingUrl ? <p className="mkt-muted">أضف صفحة الهبوط للحملة لتوليد الروابط.</p> : (
            <div className="mkt-list">{(c.channels.length ? c.channels : ["INSTAGRAM"]).map((ch) => {
              const medium = ch === "WHATSAPP_CLOUD" ? UTM_MEDIUM.whatsapp : ch.endsWith("_ADS") || ch === "GOOGLE_ADS" ? UTM_MEDIUM.paid : UTM_MEDIUM.organic;
              const r = buildUtmUrl(c.landingUrl!, { source: ch.toLowerCase().replace(/_ads$|_cloud$/, ""), medium, campaign: c.utmCampaign });
              return r.ok ? <div key={ch} className="mkt-item"><div><div className="t">{platformName(ch)}</div><div className="s"><bdi className="break-all">{r.url}</bdi></div></div><button type="button" className="mkt-chip" onClick={() => navigator.clipboard?.writeText(r.url)}>نسخ</button></div> : null;
            })}</div>
          )}
        </Sec>
      </div>

      <Sec title="محرك القرار" caption="توصية مبنية على أهداف الحملة واقتصاديات المنتج؛ تقترح ولا تنفّذ. كل تنفيذ يمر بالصلاحيات والموافقات." testId="decision"
        actions={can("campaigns_manage") || can("revenue_view") ? <Button onClick={evaluate} disabled={busy} testId="evaluate">تقييم آخر 7 أيام</Button> : null}>
        {!latest ? <p className="mkt-muted">لم تُقيّم الحملة بعد.</p> : (
          <div className="mkt-list">
            <div className="mkt-toolbar">
              <Chip tone={VERDICT_LABELS[latest.verdict].tone === "neutral" ? undefined : VERDICT_LABELS[latest.verdict].tone as "good"} testId="verdict">{VERDICT_LABELS[latest.verdict].ar}</Chip>
              <Chip>الثقة: {latest.confidence === "HIGH" ? "عالية" : latest.confidence === "MEDIUM" ? "متوسطة" : "منخفضة"}</Chip>
              <Chip>{latest.requiresApproval ? "التنفيذ يتطلب موافقة" : "لا يتطلب موافقة"}</Chip>
              <span className="mkt-muted">{fmtDate(latest.periodStart)} → {fmtDate(latest.periodEnd)} · {fmtDate(latest.createdAt, true)}</span>
            </div>
            <div><strong>الأسباب:</strong><ul className="list-disc ps-5">{latest.reasoning.split("\n").map((r, i) => <li key={i}>{r}</li>)}</ul></div>
            <div><strong>الإجراء المقترح:</strong> {String(ev.action ?? "")}</div>
            <div><strong>الأثر المتوقع:</strong> {String(ev.impact ?? "")} · <strong>المخاطر:</strong> {String(ev.risk ?? "")}</div>
            <div className="mkt-scroll"><table className="mkt-table"><tbody>{Object.entries(EVIDENCE_LABELS).filter(([k]) => k in ev).map(([k, l]) => (
              <tr key={k}><td className="mkt-muted">{l}</td><td className="n">{typeof ev[k] === "number" ? fmt(ev[k] as number) : ev[k] === null ? "غير متاح" : String(ev[k])}</td></tr>
            ))}</tbody></table></div>
            {Array.isArray(ev.limitations) ? <div className="mkt-muted"><strong>القيود:</strong> {(ev.limitations as string[]).join(" ")}</div> : null}
            <div className="mkt-toolbar">
              <span>الحالة: {latest.status === "PROPOSED" ? "مقترح" : latest.status === "ACCEPTED" ? "مقبول" : latest.status === "DISMISSED" ? "متجاهل" : "نُفّذ"}</span>
              {latest.outcomeNote ? <span className="mkt-muted">النتيجة: {latest.outcomeNote}</span> : null}
              {can("campaigns_manage") && latest.status === "PROPOSED" ? <>
                <Button variant="secondary" onClick={() => closeDecision(latest, "ACCEPTED")}>قبول</Button>
                <Button variant="secondary" onClick={() => closeDecision(latest, "DISMISSED")}>تجاهل</Button>
              </> : null}
              {can("campaigns_manage") && latest.status === "ACCEPTED" ? <Button variant="secondary" onClick={() => closeDecision(latest, "EXECUTED")}>تسجيل التنفيذ والنتيجة</Button> : null}
            </div>
          </div>
        )}
        {data.decisions.length > 1 ? <details className="mt-3"><summary className="mkt-muted">التقييمات السابقة ({data.decisions.length - 1})</summary><div className="mkt-list mt-2">{data.decisions.slice(1).map((d) => <div key={d.id} className="mkt-item"><span>{VERDICT_LABELS[d.verdict].ar}</span><span className="mkt-muted">{fmtDate(d.createdAt, true)} · {d.status}</span></div>)}</div></details> : null}
      </Sec>

      <div className="mkt-grid-2">
        <Sec title="منشورات الحملة">
          {data.posts.length === 0 ? <p className="mkt-muted">لا منشورات مرتبطة.</p> : <div className="mkt-list">{data.posts.map((p) => <Link key={p.id} href={`/dashboard/marketing/calendar?post=${p.id}`} className="mkt-item"><span>{p.title}</span><span className="mkt-toolbar"><span className="mkt-muted">{fmtDate(p.scheduledAt, true)}</span><StatusChip map={POST_STATUS} value={p.status} /></span></Link>)}</div>}
        </Sec>
        <Sec title="طلبات الاعتماد">
          {data.approvals.length === 0 ? <p className="mkt-muted">لا طلبات.</p> : <div className="mkt-list">{data.approvals.map((a) => <div key={a.id} className="mkt-item"><div><div className="t">{a.action === "activate" ? "تفعيل" : a.action === "pause" ? "إيقاف" : a.action === "send" ? "إرسال رسائل" : a.action}</div><div className="s">طلبه {a.requestedByName ?? "—"} · {fmtDate(a.createdAt, true)}{a.decidedByName ? ` · قرار ${a.decidedByName}` : ""}{a.decisionNote ? ` · ${a.decisionNote}` : ""}</div></div><StatusChip map={APPROVAL_STATUS} value={a.status} /></div>)}</div>}
        </Sec>
      </div>

      {edit ? <CampaignForm existing={c} onClose={() => setEdit(false)} onSaved={() => { setEdit(false); reload(); }} /> : null}
      {wa ? <WhatsAppCampaign campaignId={id} onClose={() => setWa(false)} onDone={(m) => { setWa(false); setMsg(m); }} /> : null}
    </div>
  );
}

function WhatsAppCampaign({ campaignId, onClose, onDone }: { campaignId: string; onClose: () => void; onDone: (m: string) => void }) {
  const tpl = useLoad<{ rows: { id: string; name: string; status: string; category: string; body: string; language: string }[] }>("/api/marketing/whatsapp/templates");
  const [f, setF] = useState({ templateId: "", type: "OPTED_IN_ALL", sku: "", days: "60", phones: "", scheduledAt: "", link: "" });
  const [preview, setPreview] = useState<{ audience: number; eligible: number; skipped: Record<string, string> } | null>(null);
  const [err, setErr] = useState("");
  const set = (k: keyof typeof f) => (v: string) => { setF((s) => ({ ...s, [k]: v })); setPreview(null); };
  const body = () => ({ templateId: f.templateId, segment: { type: f.type, sku: f.sku || null, days: Number(f.days) || null, phones: f.phones ? f.phones.split(/[\s,،]+/).filter(Boolean) : undefined }, scheduledAt: f.scheduledAt ? `${f.scheduledAt}:00+03:00` : null, link: f.link || null });
  const approved = tpl.data?.rows.filter((t) => t.status === "APPROVED") ?? [];
  const chosen = approved.find((t) => t.id === f.templateId);

  async function doPreview() {
    const r = await api<{ audience: number; eligible: number; skipped: Record<string, string> }>(`/api/marketing/campaigns/${campaignId}/messages`, { method: "POST", body: { preview: true, ...body() } });
    if (!r.ok) return setErr(r.data.error ?? "");
    setPreview(r.data);
  }
  async function send() {
    const r = await api<{ approvalId: string | null; queued: number }>(`/api/marketing/campaigns/${campaignId}/messages`, { method: "POST", body: body() });
    if (!r.ok) return setErr(r.data.error ?? "");
    onDone(r.data.approvalId ? "أُرسلت حملة الرسائل للاعتماد؛ لن يُرسل شيء قبل اعتمادها." : `جُدولت ${r.data.queued} رسالة؛ يتحقق المرسل من الموافقة والحدود قبل كل إرسال.`);
  }
  return (
    <Modal title="رسالة واتساب للحملة" onClose={onClose} wide testId="wa-campaign" footer={<><Button variant="secondary" onClick={onClose}>إلغاء</Button><Button variant="secondary" onClick={doPreview} disabled={!f.templateId}>معاينة الجمهور</Button><Button onClick={send} disabled={!preview || preview.eligible === 0}>إرسال للاعتماد / الجدولة</Button></>}>
      {err ? <Alert kind="error">{err}</Alert> : null}
      {approved.length === 0 ? <p className="mkt-banner warn">لا توجد قوالب معتمدة من Meta. أضف القوالب وزامنها من «الواتساب والعملاء».</p> : null}
      <Field id="w-t" label="القالب المعتمد"><Select id="w-t" value={f.templateId} onChange={set("templateId")}><option value="">—</option>{approved.map((t) => <option key={t.id} value={t.id}>{t.name} ({t.language} · {t.category === "MARKETING" ? "تسويقي" : "خدمي"})</option>)}</Select></Field>
      {chosen ? <p className="mkt-pre mkt-sec">{chosen.body}</p> : null}
      <Field id="w-s" label="الشريحة"><Select id="w-s" value={f.type} onChange={set("type")}>
        <option value="OPTED_IN_ALL">كل الموافقين على الرسائل التسويقية</option><option value="BOUGHT_PRODUCT">من اشترى منتجاً (SKU)</option>
        <option value="INACTIVE_DAYS">عملاء بلا طلب منذ عدد أيام</option><option value="PHONES">أرقام محددة</option>
      </Select></Field>
      {f.type === "BOUGHT_PRODUCT" ? <Field id="w-sku" label="رمز المنتج SKU"><TextInput id="w-sku" value={f.sku} onChange={set("sku")} /></Field> : null}
      {f.type === "INACTIVE_DAYS" ? <Field id="w-d" label="أيام عدم النشاط (14–730)"><TextInput id="w-d" value={f.days} onChange={set("days")} inputMode="numeric" /></Field> : null}
      {f.type === "PHONES" ? <Field id="w-p" label="الأرقام"><TextArea id="w-p" value={f.phones} onChange={set("phones")} /></Field> : null}
      <Field id="w-l" label="الرابط (يُتتبع النقر عليه)"><TextInput id="w-l" value={f.link} onChange={set("link")} placeholder="https://" /></Field>
      <Field id="w-at" label="موعد الإرسال (بتوقيت الرياض)" hint="فارغ = فوراً بعد الاعتماد، مع احترام ساعات الهدوء."><TextInput id="w-at" type="datetime-local" value={f.scheduledAt} onChange={set("scheduledAt")} /></Field>
      {preview ? <div className="mkt-sec" data-testid="wa-preview">الجمهور: {preview.audience} · المؤهلون: <strong>{preview.eligible}</strong>{Object.entries(preview.skipped).map(([k, v]) => <div key={k} className="mkt-muted">مستبعدون ({k}): {String(v)}</div>)}</div> : null}
    </Modal>
  );
}
