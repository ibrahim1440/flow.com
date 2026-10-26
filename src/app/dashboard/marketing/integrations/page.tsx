"use client";

import { useState } from "react";
import { useLang, PageHeader, Spinner, Button, Banner, Sec, Chip, StatusChip, useLoad, useMkt, usePageTitle, api, fmtDate, CONNECTION_STATUS, Modal, Field, TextInput, Alert, specLabel } from "../_components/ui";
import { platformText, type PlatformDef } from "@/lib/marketing/platforms";

/**
 * «التكاملات» — one row per external service: what the official interface allows, what this build
 * implements, what the company must obtain, which server settings are missing (names only), and the
 * stored state. «متصل» is shown only after a live check answered.
 */

type Row = { platform: string; def: PlatformDef; missingEnv: string[]; status: string; accountId: string | null; accountName: string | null; scopes: string[]; tokenStored: boolean; tokenExpiresAt: string | null; expiringSoon: boolean; config: Record<string, string>; lastCheckedAt: string | null; lastError: string | null };
type Server = { tokenKey: boolean; publicUrl: boolean; cronSecret: boolean; ai: boolean; whatsappMode: string; whatsappProvider?: "KARZOUN" | "CLOUD"; whatsappNote: string | null; whatsappNoteEn?: string | null; storeWebhook: boolean };

/** Platforms whose stored connection this build actually uses (publisher + live check). Others get theirs with their phase. */
const CONNECTABLE = ["FACEBOOK", "INSTAGRAM"];

const KIND: Record<string, { ar: string; en: string }> = {
  social: { ar: "النشر العضوي", en: "Organic publishing" }, ads: { ar: "الإعلانات المدفوعة", en: "Paid ads" }, analytics: { ar: "التحليلات والتتبع (SEO)", en: "Analytics & tracking (SEO)" },
  messaging: { ar: "الرسائل", en: "Messaging" }, store: { ar: "المتجر والمبيعات", en: "Store & sales" }, ai: { ar: "الذكاء الاصطناعي", en: "AI" },
};
const ADAPTER: Record<string, { ar: string; en: string }> = { IMPLEMENTED: { ar: "مطبّق (يتطلب الربط والتحقق)", en: "Implemented (needs connecting and verifying)" }, MANUAL: { ar: "يدوي في هذا الإصدار", en: "Manual in this release" }, PLANNED: { ar: "مخطط", en: "Planned" } };

export default function IntegrationsPage() {
  const lang = useLang();
  const L = (ar: string, en: string) => (lang === "ar" ? ar : en);
  usePageTitle("التكاملات", "Integrations", lang);
  const { can } = useMkt();
  const { data, error, loading, reload } = useLoad<{ rows: Row[]; server: Server }>("/api/marketing/integrations");
  const [edit, setEdit] = useState<Row | null>(null);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");

  async function check(r: Row) {
    const res = await api<{ status: string; lastError: string | null }>(`/api/marketing/integrations/${r.platform}`, { method: "POST" });
    if (!res.ok) return setErr(res.data.error ?? "");
    setMsg(`${L(r.def.ar, r.def.en)}: ${specLabel(CONNECTION_STATUS, res.data.status, lang)}${res.data.lastError ? ` — ${res.data.lastError}` : ""}`);
    reload();
  }
  async function disconnect(r: Row) {
    if (!confirm(L(`فصل ${r.def.ar} وحذف التوكن المحفوظ؟`, `Disconnect ${r.def.en} and delete the stored token?`))) return;
    const res = await api(`/api/marketing/integrations/${r.platform}`, { method: "DELETE" });
    if (!res.ok) return setErr(res.data.error ?? "");
    reload();
  }

  return (
    <div className="mkt" data-testid="mkt-integrations">
      <PageHeader title={L("التكاملات", "Integrations")} subtitle={L("واجهات رسمية فقط. لا يُعرض «متصل» إلا بعد فحص حي ناجح.", "Official interfaces only. “Connected” is shown only after a successful live check.")} />
      <Banner tone="info" onClose={() => setMsg("")}>{msg}</Banner>
      <Banner onClose={() => setErr("")}>{err || error}</Banner>
      {loading && !data ? <Spinner /> : data ? <>
        <Sec title={L("إعدادات الخادم", "Server settings")} caption={L("أسماء المتغيرات فقط؛ القيم لا تظهر أبداً.", "Variable names only; values are never shown.")} testId="server">
          <div className="mkt-toolbar">
            <Chip tone={data.server.tokenKey ? "good" : "bad"}>{L("تشفير التوكنات", "Token encryption")} MARKETING_TOKEN_KEY: {data.server.tokenKey ? L("مضبوط", "set") : L("غير مضبوط", "not set")}</Chip>
            <Chip tone={data.server.publicUrl ? "good" : "warn"}>{L("الرابط العام", "Public URL")} APP_PUBLIC_URL: {data.server.publicUrl ? L("مضبوط", "set") : L("غير مضبوط (روابط التتبع والوسائط)", "not set (tracking and media links)")}</Chip>
            <Chip tone={data.server.cronSecret ? "good" : "warn"}>{L("المجدول", "Scheduler")} CRON_SECRET: {data.server.cronSecret ? L("مضبوط", "set") : L("غير مضبوط (الأتمتة تعمل يدوياً فقط)", "not set (automation runs manually only)")}</Chip>
            <Chip tone={data.server.ai ? "good" : undefined}>{L("الذكاء الاصطناعي:", "AI:")} {data.server.ai ? L("مفعّل", "on") : L("غير مفعّل", "off")}</Chip>
            <Chip tone={data.server.whatsappMode === "LIVE" ? "good" : "warn"}>{L("واتساب:", "WhatsApp:")} {data.server.whatsappMode === "LIVE" ? L("إرسال فعلي", "live sending") : data.server.whatsappMode === "TEST" ? L("وضع اختبار", "test mode") : L("متوقف", "off")}{data.server.whatsappMode !== "OFF" ? ` (${data.server.whatsappProvider === "KARZOUN" ? L("عبر كرزون", "via Karzoun") : "Cloud API"})` : ""}</Chip>
            <Chip tone={data.server.storeWebhook ? "good" : "warn"}>{L("ويبهوك المتجر:", "Store webhook:")} {data.server.storeWebhook ? L("مفعّل", "on") : L("غير مفعّل", "off")}</Chip>
          </div>
          {data.server.whatsappNote ? <p className="mkt-muted">{lang === "ar" ? data.server.whatsappNote : data.server.whatsappNoteEn ?? data.server.whatsappNote}</p> : null}
        </Sec>
        {Object.entries(KIND).map(([kind, title]) => (
          <Sec key={kind} title={L(title.ar, title.en)}>
            <div className="mkt-list">{data.rows.filter((r) => r.def.kind === kind).map((r) => (
              <div key={r.platform} className="mkt-item" data-testid={`int-${r.platform}`}>
                <div style={{ minWidth: 0 }}>
                  <div className="t">{L(r.def.ar, r.def.en)} <span className="mkt-muted">· {L("المرحلة", "Phase")} {r.def.phase}</span></div>
                  {r.def.organic ? <div className="s">{L("النشر:", "Publishing:")} {specLabel(ADAPTER, r.def.organic.adapter, lang)} — {platformText(r.def.organic.noteAr, lang)}</div> : null}
                  {r.def.ads ? <div className="s">{L("الإعلانات:", "Ads:")} {specLabel(ADAPTER, r.def.ads.adapter, lang)} — {platformText(r.def.ads.noteAr, lang)}</div> : null}
                  <details><summary className="mkt-muted">{L("المتطلبات", "Requirements")}</summary><ul className="list-disc ps-5 text-sm">{r.def.requirementsAr.map((q) => <li key={q}>{platformText(q, lang)}</li>)}</ul>{r.def.docs ? <a href={r.def.docs} target="_blank" rel="noreferrer" className="mkt-muted underline">{L("التوثيق الرسمي", "Official documentation")}</a> : null}</details>
                  {r.missingEnv.length ? <div className="s">{L("متغيرات خادم ناقصة:", "Missing server variables:")} <bdi dir="ltr">{r.missingEnv.join(", ")}</bdi></div> : null}
                  {r.accountName || r.lastCheckedAt ? <div className="s">{r.accountName ?? ""}{r.lastCheckedAt ? L(` · آخر فحص ${fmtDate(r.lastCheckedAt, true)}`, ` · last checked ${fmtDate(r.lastCheckedAt, true)}`) : ""}{r.lastError ? ` · ${r.lastError}` : ""}</div> : null}
                </div>
                <div className="mkt-toolbar">
                  <StatusChip map={CONNECTION_STATUS} value={r.status} />
                  {r.expiringSoon ? <Chip tone="warn">{L("التوكن ينتهي قريباً", "Token expires soon")}</Chip> : null}
                  {can("integrations_manage") && CONNECTABLE.includes(r.platform) ? <Button variant="secondary" onClick={() => setEdit(r)} testId={`connect-${r.platform}`}>{L("إعداد الربط", "Set up connection")}</Button> : ["social", "ads", "analytics"].includes(kind) ? <Chip>{L(`الربط في المرحلة ${r.def.phase}`, `Connection in phase ${r.def.phase}`)}</Chip> : null}
                  {can("integrations_manage") && r.tokenStored ? <><Button variant="secondary" onClick={() => check(r)} testId={`check-${r.platform}`}>{L("فحص الاتصال", "Check connection")}</Button><Button variant="danger" onClick={() => disconnect(r)}>{L("فصل", "Disconnect")}</Button></> : null}
                </div>
              </div>
            ))}</div>
          </Sec>
        ))}
      </> : null}
      {edit ? <ConnectForm row={edit} onClose={() => setEdit(null)} onDone={() => { setEdit(null); reload(); }} /> : null}
    </div>
  );
}

function ConnectForm({ row, onClose, onDone }: { row: Row; onClose: () => void; onDone: () => void }) {
  const lang = useLang();
  const L = (ar: string, en: string) => (lang === "ar" ? ar : en);
  const needs = row.platform === "FACEBOOK" ? ["pageId"] : ["igUserId"];
  const [token, setToken] = useState("");
  const [cfg, setCfg] = useState<Record<string, string>>(Object.fromEntries(needs.map((k) => [k, row.config[k] ?? ""])));
  const [expires, setExpires] = useState(row.tokenExpiresAt?.slice(0, 10) ?? "");
  const [err, setErr] = useState("");
  async function save() {
    const r = await api(`/api/marketing/integrations/${row.platform}`, { method: "PUT", body: { token: token || undefined, config: cfg, tokenExpiresAt: expires || null, accountName: row.accountName } });
    if (!r.ok) return setErr(r.data.error ?? "");
    onDone();
  }
  return (
    <Modal title={L(`ربط ${row.def.ar}`, `Connect ${row.def.en}`)} onClose={onClose} testId="connect-form" footer={<><Button variant="secondary" onClick={onClose}>{L("إلغاء", "Cancel")}</Button><Button onClick={save}>{L("حفظ (ثم افحص الاتصال)", "Save (then check the connection)")}</Button></>}>
      {err ? <Alert kind="error">{err}</Alert> : null}
      <p className="mkt-muted">{L("يُحفظ التوكن مشفراً على الخادم ولا يعود للمتصفح. استخدم توكن صفحة/نظام طويل الأمد صادر من Business Manager بالصلاحيات الرسمية فقط. بعد الحفظ تكون الحالة «بانتظار التحقق» حتى ينجح فحص الاتصال.", "The token is stored encrypted on the server and never returns to the browser. Use a long-lived page/system token issued from Business Manager with the official permissions only. After saving, the status is “Awaiting verification” until a connection check succeeds.")}</p>
      <Field id="tok" label={row.tokenStored ? L("توكن جديد (اتركه فارغاً للإبقاء على المحفوظ)", "New token (leave empty to keep the stored one)") : L("التوكن", "Token")}><TextInput id="tok" type="password" value={token} onChange={setToken} /></Field>
      {needs.map((k) => <Field key={k} id={`cfg-${k}`} label={k === "pageId" ? L("معرف الصفحة (Page ID)", "Page ID") : L("معرف حساب إنستقرام الاحترافي", "Instagram professional account ID")}><TextInput id={`cfg-${k}`} value={cfg[k]} onChange={(v) => setCfg({ ...cfg, [k]: v })} /></Field>)}
      <Field id="exp" label={L("تاريخ انتهاء التوكن (إن وجد)", "Token expiry date (if any)")}><TextInput id="exp" type="date" value={expires} onChange={setExpires} /></Field>
    </Modal>
  );
}
