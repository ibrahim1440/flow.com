"use client";

import { useState } from "react";
import { useLang, PageHeader, Spinner, Button, Banner, Sec, Chip, StatusChip, useLoad, useMkt, usePageTitle, api, fmtDate, CONNECTION_STATUS, Modal, Field, TextInput, Alert } from "../_components/ui";
import type { PlatformDef } from "@/lib/marketing/platforms";

/**
 * «التكاملات» — one row per external service: what the official interface allows, what this build
 * implements, what the company must obtain, which server settings are missing (names only), and the
 * stored state. «متصل» is shown only after a live check answered.
 */

type Row = { platform: string; def: PlatformDef; missingEnv: string[]; status: string; accountId: string | null; accountName: string | null; scopes: string[]; tokenStored: boolean; tokenExpiresAt: string | null; expiringSoon: boolean; config: Record<string, string>; lastCheckedAt: string | null; lastError: string | null };
type Server = { tokenKey: boolean; publicUrl: boolean; cronSecret: boolean; ai: boolean; whatsappMode: string; whatsappProvider?: "KARZOUN" | "CLOUD"; whatsappNote: string | null; storeWebhook: boolean };

/** Platforms whose stored connection this build actually uses (publisher + live check). Others get theirs with their phase. */
const CONNECTABLE = ["FACEBOOK", "INSTAGRAM"];

const KIND: Record<string, string> = { social: "النشر العضوي", ads: "الإعلانات المدفوعة", analytics: "التحليلات والتتبع (SEO)", messaging: "الرسائل", store: "المتجر والمبيعات", ai: "الذكاء الاصطناعي" };
const ADAPTER: Record<string, string> = { IMPLEMENTED: "مطبّق (يتطلب الربط والتحقق)", MANUAL: "يدوي في هذا الإصدار", PLANNED: "مخطط" };

export default function IntegrationsPage() {
  const lang = useLang();
  usePageTitle("التكاملات", "Integrations", lang);
  const { can } = useMkt();
  const { data, error, loading, reload } = useLoad<{ rows: Row[]; server: Server }>("/api/marketing/integrations");
  const [edit, setEdit] = useState<Row | null>(null);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");

  async function check(r: Row) {
    const res = await api<{ status: string; lastError: string | null }>(`/api/marketing/integrations/${r.platform}`, { method: "POST" });
    if (!res.ok) return setErr(res.data.error ?? "");
    setMsg(`${r.def.ar}: ${CONNECTION_STATUS[res.data.status]?.ar ?? res.data.status}${res.data.lastError ? ` — ${res.data.lastError}` : ""}`);
    reload();
  }
  async function disconnect(r: Row) {
    if (!confirm(`فصل ${r.def.ar} وحذف التوكن المحفوظ؟`)) return;
    const res = await api(`/api/marketing/integrations/${r.platform}`, { method: "DELETE" });
    if (!res.ok) return setErr(res.data.error ?? "");
    reload();
  }

  return (
    <div className="mkt" data-testid="mkt-integrations">
      <PageHeader title="التكاملات" subtitle="واجهات رسمية فقط. لا يُعرض «متصل» إلا بعد فحص حي ناجح." />
      <Banner tone="info" onClose={() => setMsg("")}>{msg}</Banner>
      <Banner onClose={() => setErr("")}>{err || error}</Banner>
      {loading && !data ? <Spinner /> : data ? <>
        <Sec title="إعدادات الخادم" caption="أسماء المتغيرات فقط؛ القيم لا تظهر أبداً." testId="server">
          <div className="mkt-toolbar">
            <Chip tone={data.server.tokenKey ? "good" : "bad"}>تشفير التوكنات MARKETING_TOKEN_KEY: {data.server.tokenKey ? "مضبوط" : "غير مضبوط"}</Chip>
            <Chip tone={data.server.publicUrl ? "good" : "warn"}>الرابط العام APP_PUBLIC_URL: {data.server.publicUrl ? "مضبوط" : "غير مضبوط (روابط التتبع والوسائط)"}</Chip>
            <Chip tone={data.server.cronSecret ? "good" : "warn"}>المجدول CRON_SECRET: {data.server.cronSecret ? "مضبوط" : "غير مضبوط (الأتمتة تعمل يدوياً فقط)"}</Chip>
            <Chip tone={data.server.ai ? "good" : undefined}>الذكاء الاصطناعي: {data.server.ai ? "مفعّل" : "غير مفعّل"}</Chip>
            <Chip tone={data.server.whatsappMode === "LIVE" ? "good" : "warn"}>واتساب: {data.server.whatsappMode === "LIVE" ? "إرسال فعلي" : data.server.whatsappMode === "TEST" ? "وضع اختبار" : "متوقف"}{data.server.whatsappMode !== "OFF" ? ` (${data.server.whatsappProvider === "KARZOUN" ? "عبر كرزون" : "Cloud API"})` : ""}</Chip>
            <Chip tone={data.server.storeWebhook ? "good" : "warn"}>ويبهوك المتجر: {data.server.storeWebhook ? "مفعّل" : "غير مفعّل"}</Chip>
          </div>
          {data.server.whatsappNote ? <p className="mkt-muted">{data.server.whatsappNote}</p> : null}
        </Sec>
        {Object.entries(KIND).map(([kind, title]) => (
          <Sec key={kind} title={title}>
            <div className="mkt-list">{data.rows.filter((r) => r.def.kind === kind).map((r) => (
              <div key={r.platform} className="mkt-item" data-testid={`int-${r.platform}`}>
                <div style={{ minWidth: 0 }}>
                  <div className="t">{r.def.ar} <span className="mkt-muted">· المرحلة {r.def.phase}</span></div>
                  {r.def.organic ? <div className="s">النشر: {ADAPTER[r.def.organic.adapter]} — {r.def.organic.noteAr}</div> : null}
                  {r.def.ads ? <div className="s">الإعلانات: {ADAPTER[r.def.ads.adapter]} — {r.def.ads.noteAr}</div> : null}
                  <details><summary className="mkt-muted">المتطلبات</summary><ul className="list-disc ps-5 text-sm">{r.def.requirementsAr.map((q) => <li key={q}>{q}</li>)}</ul>{r.def.docs ? <a href={r.def.docs} target="_blank" rel="noreferrer" className="mkt-muted underline">التوثيق الرسمي</a> : null}</details>
                  {r.missingEnv.length ? <div className="s">متغيرات خادم ناقصة: <bdi dir="ltr">{r.missingEnv.join(", ")}</bdi></div> : null}
                  {r.accountName || r.lastCheckedAt ? <div className="s">{r.accountName ?? ""}{r.lastCheckedAt ? ` · آخر فحص ${fmtDate(r.lastCheckedAt, true)}` : ""}{r.lastError ? ` · ${r.lastError}` : ""}</div> : null}
                </div>
                <div className="mkt-toolbar">
                  <StatusChip map={CONNECTION_STATUS} value={r.status} />
                  {r.expiringSoon ? <Chip tone="warn">التوكن ينتهي قريباً</Chip> : null}
                  {can("integrations_manage") && CONNECTABLE.includes(r.platform) ? <Button variant="secondary" onClick={() => setEdit(r)} testId={`connect-${r.platform}`}>إعداد الربط</Button> : ["social", "ads", "analytics"].includes(kind) ? <Chip>الربط في المرحلة {r.def.phase}</Chip> : null}
                  {can("integrations_manage") && r.tokenStored ? <><Button variant="secondary" onClick={() => check(r)} testId={`check-${r.platform}`}>فحص الاتصال</Button><Button variant="danger" onClick={() => disconnect(r)}>فصل</Button></> : null}
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
    <Modal title={`ربط ${row.def.ar}`} onClose={onClose} testId="connect-form" footer={<><Button variant="secondary" onClick={onClose}>إلغاء</Button><Button onClick={save}>حفظ (ثم افحص الاتصال)</Button></>}>
      {err ? <Alert kind="error">{err}</Alert> : null}
      <p className="mkt-muted">يُحفظ التوكن مشفراً على الخادم ولا يعود للمتصفح. استخدم توكن صفحة/نظام طويل الأمد صادر من Business Manager بالصلاحيات الرسمية فقط. بعد الحفظ تكون الحالة «بانتظار التحقق» حتى ينجح فحص الاتصال.</p>
      <Field id="tok" label={row.tokenStored ? "توكن جديد (اتركه فارغاً للإبقاء على المحفوظ)" : "التوكن"}><TextInput id="tok" type="password" value={token} onChange={setToken} /></Field>
      {needs.map((k) => <Field key={k} id={`cfg-${k}`} label={k === "pageId" ? "معرف الصفحة (Page ID)" : "معرف حساب إنستقرام الاحترافي"}><TextInput id={`cfg-${k}`} value={cfg[k]} onChange={(v) => setCfg({ ...cfg, [k]: v })} /></Field>)}
      <Field id="exp" label="تاريخ انتهاء التوكن (إن وجد)"><TextInput id="exp" type="date" value={expires} onChange={setExpires} /></Field>
    </Modal>
  );
}
