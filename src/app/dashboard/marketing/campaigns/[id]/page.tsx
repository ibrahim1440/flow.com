"use client";

import Link from "next/link";
import { use, useState } from "react";
import {
  useLang, PageHeader, Spinner, Button, Banner, Sec, Chip, StatusChip, useLoad, useMkt, usePageTitle, fmt, fmtDate, platformName, api,
  CAMPAIGN_STATUS, OBJECTIVES, POST_STATUS, APPROVAL_STATUS, Field, TextInput, Select, TextArea, Modal, Alert, specLabel,
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

const EVIDENCE_LABELS: Record<string, { ar: string; en: string }> = {
  spend: { ar: "الإنفاق", en: "Spend" }, linkClicks: { ar: "نقرات الرابط", en: "Link clicks" }, orders: { ar: "الطلبات المنسوبة", en: "Attributed orders" },
  newCustomers: { ar: "العملاء الجدد", en: "New customers" }, netRevenue: { ar: "الإيراد المنسوب", en: "Attributed revenue" }, cac: { ar: "تكلفة الاكتساب (CAC)", en: "Acquisition cost (CAC)" },
  cpa: { ar: "تكلفة الطلب (CPA)", en: "Cost per order (CPA)" }, roas: { ar: "العائد (ROAS)", en: "ROAS" }, cvrPct: { ar: "معدل التحويل (CVR) %", en: "Conversion rate (CVR) %" },
  targetCac: { ar: "هدف تكلفة الاكتساب (CAC)", en: "Target acquisition cost (CAC)" }, targetRoas: { ar: "هدف العائد (ROAS)", en: "Target ROAS" }, breakEvenRoas: { ar: "نقطة التعادل (Break-even ROAS)", en: "Break-even ROAS" },
  minSpend: { ar: "حد الإنفاق للحكم", en: "Spend threshold for a verdict" }, minConversions: { ar: "حد الطلبات للحكم", en: "Order threshold for a verdict" },
  trackingHealthy: { ar: "صحة التتبع", en: "Tracking health" }, dataAgeHours: { ar: "عمر البيانات (ساعة)", en: "Data age (hours)" }, periodDays: { ar: "أيام الفترة", en: "Period days" },
};

export default function CampaignDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const lang = useLang();
  const L = (ar: string, en: string) => (lang === "ar" ? ar : en);
  usePageTitle("الحملة", "Campaign", lang);
  const { can } = useMkt();
  const { data, error, loading, reload } = useLoad<Detail>(`/api/marketing/campaigns/${id}`);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const [edit, setEdit] = useState(false);
  const [wa, setWa] = useState(false);
  const [busy, setBusy] = useState(false);

  async function status(to: string) {
    const note = to === "ACTIVE" || to === "PAUSED" ? prompt(L("ملاحظة (اختيارية):", "Note (optional):")) ?? "" : "";
    const r = await api<{ status: string; approval: { id: string } | null }>(`/api/marketing/campaigns/${id}/status`, { method: "POST", body: { status: to, note } });
    if (!r.ok) return setErr(r.data.error ?? "");
    setMsg(r.data.approval ? L("أُرسل طلب اعتماد؛ تتغير الحالة بعد اعتماده من شخص آخر.", "An approval request was sent; the status changes once someone else approves it.") : L("تم تحديث الحالة.", "Status updated."));
    reload();
  }

  async function evaluate() {
    setBusy(true);
    const r = await api(`/api/marketing/campaigns/${id}/evaluate`, { method: "POST" });
    setBusy(false);
    if (!r.ok) return setErr(r.data.error ?? "");
    setMsg(L("قُيّمت الحملة لآخر 7 أيام. التوصية أدناه لا تُنفّذ شيئاً بنفسها.", "The campaign was evaluated for the last 7 days. The recommendation below does nothing by itself."));
    reload();
  }

  async function closeDecision(d: Decision, st: "ACCEPTED" | "DISMISSED" | "EXECUTED") {
    const outcomeNote = st === "EXECUTED" ? prompt(L("ما الذي نُفّذ وما النتيجة؟", "What was done and what was the result?")) : st === "DISMISSED" ? prompt(L("سبب التجاهل (اختياري):", "Reason for dismissing (optional):")) : "";
    if (st === "EXECUTED" && !outcomeNote) return;
    const r = await api(`/api/marketing/decisions/${d.id}`, { method: "PATCH", body: { status: st, outcomeNote } });
    if (!r.ok) return setErr(r.data.error ?? "");
    reload();
  }

  if (loading && !data) return <Spinner />;
  if (!data) return <div className="mkt"><Banner>{error || L("الحملة غير موجودة.", "Campaign not found.")}</Banner></div>;
  const c = data.campaign;
  const latest = data.decisions[0];
  const ev = (latest?.evidence ?? {}) as Record<string, unknown>;

  return (
    <div className="mkt" data-testid="mkt-campaign">
      <PageHeader title={c.name} subtitle={<><StatusChip map={CAMPAIGN_STATUS} value={c.status} testId="campaign-status" /> · {specLabel(OBJECTIVES, c.objective, lang)} · <bdi>{c.utmCampaign}</bdi> · {fmtDate(c.startAt)} → {fmtDate(c.endAt)}</>}
        actions={can("campaigns_manage") ? (
          <>
            <Button variant="secondary" onClick={() => setEdit(true)} testId="edit-campaign">{L("تعديل", "Edit")}</Button>
            {["DRAFT", "PLANNED", "PAUSED"].includes(c.status) ? <Button onClick={() => status("ACTIVE")} testId="activate">{L("تفعيل", "Activate")}</Button> : null}
            {c.status === "DRAFT" ? <Button variant="secondary" onClick={() => status("PLANNED")}>{L("تخطيط", "Plan")}</Button> : null}
            {c.status === "ACTIVE" ? <Button variant="secondary" onClick={() => status("PAUSED")} testId="pause">{L("إيقاف مؤقت", "Pause")}</Button> : null}
            {["ACTIVE", "PAUSED"].includes(c.status) ? <Button variant="secondary" onClick={() => status("COMPLETED")}>{L("إنهاء", "Complete")}</Button> : null}
            {can("messaging_manage") ? <Button variant="secondary" onClick={() => setWa(true)} testId="wa-send">{L("رسالة واتساب للحملة", "WhatsApp message for the campaign")}</Button> : null}
          </>
        ) : null} />
      <Banner tone="info" onClose={() => setMsg("")}>{msg}</Banner>
      <Banner onClose={() => setErr("")}>{err}</Banner>

      <div className="mkt-grid-2">
        <Sec title={L("تفاصيل الحملة", "Campaign details")}>
          <dl className="mkt-list">
            <div><dt className="mkt-muted">{L("المنتج", "Product")}</dt><dd>{c.product?.name ?? "—"}</dd></div>
            <div><dt className="mkt-muted">{L("القنوات", "Channels")}</dt><dd>{c.channels.map((x) => platformName(x, lang)).join(L("، ", ", ")) || "—"}</dd></div>
            <div><dt className="mkt-muted">{L("الجمهور", "Audience")}</dt><dd className="mkt-pre">{c.audience ?? "—"}</dd></div>
            <div><dt className="mkt-muted">{L("العرض", "Offer")}</dt><dd className="mkt-pre">{c.offer ?? "—"}</dd></div>
            <div><dt className="mkt-muted">{L("الميزانية المخططة", "Planned budget")}</dt><dd>{fmt(c.plannedBudget, { unit: "SAR", lang })}</dd></div>
            <div><dt className="mkt-muted">{L("الأهداف", "Targets")}</dt><dd>{L("تكلفة الاكتساب (CAC)", "Acquisition cost (CAC)")} ≤ {fmt(c.targetCac, { unit: "SAR", lang })} · {L("العائد (ROAS)", "ROAS")} ≥ {fmt(c.targetRoas, { unit: "x", lang })}</dd></div>
          </dl>
        </Sec>
        <Sec title={L("روابط التتبع (UTM)", "Tracking links (UTM)")} caption={L("انسخ الرابط المناسب لكل قناة؛ الطلبات القادمة منه تُنسب لهذه الحملة.", "Copy the right link for each channel; orders that come through it are credited to this campaign.")}>
          {!c.landingUrl ? <p className="mkt-muted">{L("أضف صفحة الهبوط للحملة لتوليد الروابط.", "Add the campaign's landing page to generate the links.")}</p> : (
            <div className="mkt-list">{(c.channels.length ? c.channels : ["INSTAGRAM"]).map((ch) => {
              const medium = ch === "WHATSAPP_CLOUD" ? UTM_MEDIUM.whatsapp : ch.endsWith("_ADS") || ch === "GOOGLE_ADS" ? UTM_MEDIUM.paid : UTM_MEDIUM.organic;
              const r = buildUtmUrl(c.landingUrl!, { source: ch.toLowerCase().replace(/_ads$|_cloud$/, ""), medium, campaign: c.utmCampaign });
              return r.ok ? <div key={ch} className="mkt-item"><div><div className="t">{platformName(ch, lang)}</div><div className="s"><bdi className="break-all">{r.url}</bdi></div></div><button type="button" className="mkt-chip" onClick={() => navigator.clipboard?.writeText(r.url)}>{L("نسخ", "Copy")}</button></div> : null;
            })}</div>
          )}
        </Sec>
      </div>

      <Sec title={L("محرك القرار", "Decision engine")} caption={L("توصية مبنية على أهداف الحملة واقتصاديات المنتج؛ تقترح ولا تنفّذ. كل تنفيذ يمر بالصلاحيات والموافقات.", "A recommendation built on the campaign's targets and the product's economics; it suggests and never acts. Every action goes through permissions and approvals.")} testId="decision"
        actions={can("campaigns_manage") || can("revenue_view") ? <Button onClick={evaluate} disabled={busy} testId="evaluate">{L("تقييم آخر 7 أيام", "Evaluate the last 7 days")}</Button> : null}>
        {!latest ? <p className="mkt-muted">{L("لم تُقيّم الحملة بعد.", "The campaign has not been evaluated yet.")}</p> : (
          <div className="mkt-list">
            <div className="mkt-toolbar">
              <Chip tone={VERDICT_LABELS[latest.verdict].tone === "neutral" ? undefined : VERDICT_LABELS[latest.verdict].tone as "good"} testId="verdict">{L(VERDICT_LABELS[latest.verdict].ar, VERDICT_LABELS[latest.verdict].en)}</Chip>
              <Chip>{L("الثقة:", "Confidence:")} {latest.confidence === "HIGH" ? L("عالية", "high") : latest.confidence === "MEDIUM" ? L("متوسطة", "medium") : L("منخفضة", "low")}</Chip>
              <Chip>{latest.requiresApproval ? L("التنفيذ يتطلب موافقة", "Acting needs an approval") : L("لا يتطلب موافقة", "No approval needed")}</Chip>
              <span className="mkt-muted">{fmtDate(latest.periodStart)} → {fmtDate(latest.periodEnd)} · {fmtDate(latest.createdAt, true)}</span>
            </div>
            <div><strong>{L("الأسباب:", "Reasons:")}</strong><ul className="list-disc ps-5">{latest.reasoning.split("\n").map((r, i) => <li key={i}>{r}</li>)}</ul></div>
            <div><strong>{L("الإجراء المقترح:", "Suggested action:")}</strong> {String(ev.action ?? "")}</div>
            <div><strong>{L("الأثر المتوقع:", "Expected impact:")}</strong> {String(ev.impact ?? "")} · <strong>{L("المخاطر:", "Risks:")}</strong> {String(ev.risk ?? "")}</div>
            <div className="mkt-scroll"><table className="mkt-table"><tbody>{Object.entries(EVIDENCE_LABELS).filter(([k]) => k in ev).map(([k, l]) => (
              <tr key={k}><td className="mkt-muted">{L(l.ar, l.en)}</td><td className="n">{typeof ev[k] === "number" ? fmt(ev[k] as number, { lang }) : ev[k] === null ? L("غير متاح", "Not available") : String(ev[k])}</td></tr>
            ))}</tbody></table></div>
            {Array.isArray(ev.limitations) ? <div className="mkt-muted"><strong>{L("القيود:", "Limits:")}</strong> {(ev.limitations as string[]).join(" ")}</div> : null}
            <div className="mkt-toolbar">
              <span>{L("الحالة:", "Status:")} {latest.status === "PROPOSED" ? L("مقترح", "proposed") : latest.status === "ACCEPTED" ? L("مقبول", "accepted") : latest.status === "DISMISSED" ? L("متجاهل", "dismissed") : L("نُفّذ", "executed")}</span>
              {latest.outcomeNote ? <span className="mkt-muted">{L("النتيجة:", "Result:")} {latest.outcomeNote}</span> : null}
              {can("campaigns_manage") && latest.status === "PROPOSED" ? <>
                <Button variant="secondary" onClick={() => closeDecision(latest, "ACCEPTED")}>{L("قبول", "Accept")}</Button>
                <Button variant="secondary" onClick={() => closeDecision(latest, "DISMISSED")}>{L("تجاهل", "Dismiss")}</Button>
              </> : null}
              {can("campaigns_manage") && latest.status === "ACCEPTED" ? <Button variant="secondary" onClick={() => closeDecision(latest, "EXECUTED")}>{L("تسجيل التنفيذ والنتيجة", "Record what was done and the result")}</Button> : null}
            </div>
          </div>
        )}
        {data.decisions.length > 1 ? <details className="mt-3"><summary className="mkt-muted">{L("التقييمات السابقة", "Earlier evaluations")} ({data.decisions.length - 1})</summary><div className="mkt-list mt-2">{data.decisions.slice(1).map((d) => <div key={d.id} className="mkt-item"><span>{L(VERDICT_LABELS[d.verdict].ar, VERDICT_LABELS[d.verdict].en)}</span><span className="mkt-muted">{fmtDate(d.createdAt, true)} · {d.status}</span></div>)}</div></details> : null}
      </Sec>

      <div className="mkt-grid-2">
        <Sec title={L("منشورات الحملة", "Campaign posts")}>
          {data.posts.length === 0 ? <p className="mkt-muted">{L("لا منشورات مرتبطة.", "No linked posts.")}</p> : <div className="mkt-list">{data.posts.map((p) => <Link key={p.id} href={`/dashboard/marketing/calendar?post=${p.id}`} className="mkt-item"><span>{p.title}</span><span className="mkt-toolbar"><span className="mkt-muted">{fmtDate(p.scheduledAt, true)}</span><StatusChip map={POST_STATUS} value={p.status} /></span></Link>)}</div>}
        </Sec>
        <Sec title={L("طلبات الاعتماد", "Approval requests")}>
          {data.approvals.length === 0 ? <p className="mkt-muted">{L("لا طلبات.", "No requests.")}</p> : <div className="mkt-list">{data.approvals.map((a) => <div key={a.id} className="mkt-item"><div><div className="t">{a.action === "activate" ? L("تفعيل", "Activate") : a.action === "pause" ? L("إيقاف", "Pause") : a.action === "send" ? L("إرسال رسائل", "Send messages") : a.action}</div><div className="s">{L("طلبه", "Requested by")} {a.requestedByName ?? "—"} · {fmtDate(a.createdAt, true)}{a.decidedByName ? L(` · قرار ${a.decidedByName}`, ` · decided by ${a.decidedByName}`) : ""}{a.decisionNote ? ` · ${a.decisionNote}` : ""}</div></div><StatusChip map={APPROVAL_STATUS} value={a.status} /></div>)}</div>}
        </Sec>
      </div>

      {edit ? <CampaignForm existing={c} onClose={() => setEdit(false)} onSaved={() => { setEdit(false); reload(); }} /> : null}
      {wa ? <WhatsAppCampaign campaignId={id} onClose={() => setWa(false)} onDone={(m) => { setWa(false); setMsg(m); }} /> : null}
    </div>
  );
}

function WhatsAppCampaign({ campaignId, onClose, onDone }: { campaignId: string; onClose: () => void; onDone: (m: string) => void }) {
  const lang = useLang();
  const L = (ar: string, en: string) => (lang === "ar" ? ar : en);
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
    onDone(r.data.approvalId ? L("أُرسلت حملة الرسائل للاعتماد؛ لن يُرسل شيء قبل اعتمادها.", "The message campaign was sent for approval; nothing is sent before it is approved.") : L(`جُدولت ${r.data.queued} رسالة؛ يتحقق المرسل من الموافقة والحدود قبل كل إرسال.`, `${r.data.queued} messages scheduled; the sender checks consent and limits before each send.`));
  }
  return (
    <Modal title={L("رسالة واتساب للحملة", "WhatsApp message for the campaign")} onClose={onClose} wide testId="wa-campaign" footer={<><Button variant="secondary" onClick={onClose}>{L("إلغاء", "Cancel")}</Button><Button variant="secondary" onClick={doPreview} disabled={!f.templateId}>{L("معاينة الجمهور", "Preview audience")}</Button><Button onClick={send} disabled={!preview || preview.eligible === 0}>{L("إرسال للاعتماد / الجدولة", "Send for approval / scheduling")}</Button></>}>
      {err ? <Alert kind="error">{err}</Alert> : null}
      {approved.length === 0 ? <p className="mkt-banner warn">{L("لا توجد قوالب معتمدة من Meta. أضف القوالب وزامنها من «الواتساب والعملاء».", "No Meta-approved templates. Add and sync templates in “WhatsApp & customers”.")}</p> : null}
      <Field id="w-t" label={L("القالب المعتمد", "Approved template")}><Select id="w-t" value={f.templateId} onChange={set("templateId")}><option value="">—</option>{approved.map((t) => <option key={t.id} value={t.id}>{t.name} ({t.language} · {t.category === "MARKETING" ? L("تسويقي", "marketing") : L("خدمي", "utility")})</option>)}</Select></Field>
      {chosen ? <p className="mkt-pre mkt-sec">{chosen.body}</p> : null}
      <Field id="w-s" label={L("الشريحة", "Segment")}><Select id="w-s" value={f.type} onChange={set("type")}>
        <option value="OPTED_IN_ALL">{L("كل الموافقين على الرسائل التسويقية", "Everyone opted in to marketing messages")}</option><option value="BOUGHT_PRODUCT">{L("من اشترى منتجاً (SKU)", "Bought a product (SKU)")}</option>
        <option value="INACTIVE_DAYS">{L("عملاء بلا طلب منذ عدد أيام", "Customers with no order for a number of days")}</option><option value="PHONES">{L("أرقام محددة", "Specific numbers")}</option>
      </Select></Field>
      {f.type === "BOUGHT_PRODUCT" ? <Field id="w-sku" label={L("رمز المنتج (SKU)", "Product SKU")}><TextInput id="w-sku" value={f.sku} onChange={set("sku")} /></Field> : null}
      {f.type === "INACTIVE_DAYS" ? <Field id="w-d" label={L("أيام عدم النشاط (14–730)", "Days inactive (14–730)")}><TextInput id="w-d" value={f.days} onChange={set("days")} inputMode="numeric" /></Field> : null}
      {f.type === "PHONES" ? <Field id="w-p" label={L("الأرقام", "Numbers")}><TextArea id="w-p" value={f.phones} onChange={set("phones")} /></Field> : null}
      <Field id="w-l" label={L("الرابط (يُتتبع النقر عليه)", "Link (clicks are tracked)")}><TextInput id="w-l" value={f.link} onChange={set("link")} placeholder="https://" /></Field>
      <Field id="w-at" label={L("موعد الإرسال (بتوقيت الرياض)", "Send time (Riyadh time)")} hint={L("فارغ = فوراً بعد الاعتماد، مع احترام ساعات الهدوء.", "Empty = right after approval, respecting quiet hours.")}><TextInput id="w-at" type="datetime-local" value={f.scheduledAt} onChange={set("scheduledAt")} /></Field>
      {preview ? <div className="mkt-sec" data-testid="wa-preview">{L("الجمهور:", "Audience:")} {preview.audience} · {L("المؤهلون:", "Eligible:")} <strong>{preview.eligible}</strong>{Object.entries(preview.skipped).map(([k, v]) => <div key={k} className="mkt-muted">{L("مستبعدون", "Excluded")} ({k}): {String(v)}</div>)}</div> : null}
    </Modal>
  );
}
