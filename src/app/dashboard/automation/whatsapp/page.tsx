"use client";

import { useCallback, useEffect, useState } from "react";
import { LogOut, QrCode, RefreshCw, RotateCcw, Send, Smartphone } from "lucide-react";
import {
  Alert, Button, Card, Field, Modal, PageHeader, SectionTitle, Spinner, TextInput, api, useLang,
} from "../../sales/_components/ui";
import { normalizePhoneForWhatsApp } from "@/lib/automation/phone";
import { Badge, Phone, SEND_MODE_LABELS, noteText, useAutomationAbilities } from "../_components/shared";

/**
 * Linking the WhatsApp number, and deciding whether anything is sent.
 *
 * The QR expires in about a minute, so while it is on screen it is refreshed every 35 s and
 * the connection state is polled every 5 s; the moment the phone links, the QR disappears.
 * Polling stops after a few minutes so a forgotten tab does not keep asking the server.
 */

type Status = {
  configured: boolean;
  configError: string | null;
  state: "open" | "connecting" | "close" | "unknown" | null;
  stateError: string | null;
  sendMode: "OFF" | "TEST" | "LIVE";
  testPhone: string | null;
  liveAllowed: boolean;
  effectiveMode: string;
  effectiveNote: string | null;
  queue: { queued: number; failed24h: number; sent24h: number };
};

const QR_REFRESH_MS = 35_000;
const STATE_POLL_MS = 5_000;
const LINKING_WINDOW_MS = 4 * 60_000;

export default function WhatsAppConnectionPage() {
  const lang = useLang();
  const ar = lang === "ar";
  const { canManageConnection } = useAutomationAbilities();

  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [qr, setQr] = useState<string | null>(null);
  const [pairingCode, setPairingCode] = useState<string | null>(null);
  const [pairNumber, setPairNumber] = useState("");
  const [linkingSince, setLinkingSince] = useState<number | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmLogout, setConfirmLogout] = useState(false);

  const [mode, setMode] = useState<"OFF" | "TEST" | "LIVE">("OFF");
  const [testPhone, setTestPhone] = useState("");
  const [testText, setTestText] = useState("");
  /** Re-read the status. The form fields (mode, test number) are only set on first load. */
  const load = useCallback(async () => {
    const r = await api<Status>("/api/automation/whatsapp");
    if (!r.ok) {
      setError(r.data.error ?? (ar ? "تعذر قراءة حالة الواتساب." : "Could not read WhatsApp status."));
      return null;
    }
    setStatus(r.data);
    return r.data;
  }, [ar]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const r = await api<Status>("/api/automation/whatsapp");
      if (cancelled) return;
      if (!r.ok) {
        setError(r.data.error ?? (ar ? "تعذر قراءة حالة الواتساب." : "Could not read WhatsApp status."));
        return;
      }
      setStatus(r.data);
      setMode(r.data.sendMode);
      setTestPhone(r.data.testPhone ?? "");
    })();
    return () => {
      cancelled = true;
    };
  }, [ar]);

  const linking = linkingSince !== null;

  // While linking: poll the state, refresh the QR, and stop once linked or after the window.
  useEffect(() => {
    if (!linking) return;
    const poll = setInterval(async () => {
      const s = await load();
      if (s?.state === "open") {
        setLinkingSince(null);
        setQr(null);
        setPairingCode(null);
        setSuccess(ar ? "تم ربط الجوال بنجاح." : "The phone is linked.");
      } else if (Date.now() - (linkingSince ?? 0) > LINKING_WINDOW_MS) {
        setLinkingSince(null);
        setQr(null);
        setPairingCode(null);
      }
    }, STATE_POLL_MS);
    const refresh = qr
      ? setInterval(async () => {
          const r = await api<{ connected: boolean; qr?: string | null }>("/api/automation/whatsapp", { method: "POST", body: { action: "qr" } });
          if (r.ok && r.data.qr) setQr(r.data.qr);
        }, QR_REFRESH_MS)
      : null;
    return () => {
      clearInterval(poll);
      if (refresh) clearInterval(refresh);
    };
  }, [linking, linkingSince, qr, load, ar]);

  async function post(action: string, body: Record<string, unknown> = {}) {
    setBusy(action);
    setError("");
    setSuccess("");
    const r = await api<{ connected?: boolean; qr?: string | null; pairingCode?: string | null; phone?: string }>("/api/automation/whatsapp", {
      method: "POST",
      body: { action, ...body },
    });
    setBusy(null);
    if (!r.ok) {
      setError(r.data.error ?? (ar ? "تعذر تنفيذ الطلب." : "The request failed."));
      return null;
    }
    return r.data;
  }

  async function showQr() {
    const d = await post("qr");
    if (!d) return;
    if (d.connected) return load();
    setPairingCode(null);
    setQr(d.qr ?? null);
    setLinkingSince(Date.now());
    if (!d.qr) setError(ar ? "لم يرجع الخادم رمز QR. جرب إعادة التشغيل ثم أعد المحاولة." : "No QR came back. Try a restart.");
  }

  async function pair() {
    const p = normalizePhoneForWhatsApp(pairNumber);
    if (!p.ok) return setError(p.reason);
    const d = await post("pair", { number: p.phone });
    if (!d) return;
    if (d.connected) return load();
    setQr(null);
    setPairingCode(d.pairingCode ?? null);
    setLinkingSince(Date.now());
  }

  async function doLogout() {
    setConfirmLogout(false);
    const d = await post("logout");
    if (d) {
      setSuccess(ar ? "فصل الجوال. اربط الجوال الجديد بالرمز." : "Unlinked. Link the new phone.");
      load();
    }
  }

  async function doRestart() {
    const d = await post("restart");
    if (d) {
      setSuccess(ar ? "أعيد تشغيل الاتصال." : "Connection restarted.");
      setTimeout(load, 3000);
    }
  }

  async function saveMode() {
    setBusy("mode");
    setError("");
    setSuccess("");
    const r = await api<{ sendMode: string; testPhone: string | null }>("/api/automation/settings", {
      method: "PUT",
      body: { sendMode: mode, testPhone },
    });
    setBusy(null);
    if (!r.ok) return setError(r.data.error ?? "");
    setTestPhone(r.data.testPhone ?? "");
    setSuccess(ar ? "حفظ وضع الإرسال." : "Sending mode saved.");
    load();
  }

  async function sendTest() {
    const d = await post("test", { phone: testPhone, text: testText });
    if (d) setSuccess(ar ? "أرسلت الرسالة التجريبية." : "Test message sent.");
  }

  if (!status && !error) return <Spinner />;

  const stateBadge =
    status?.state === "open"
      ? { tone: "success" as const, ar: "متصل", en: "Connected" }
      : status?.state === "connecting"
        ? { tone: "waiting" as const, ar: "جار الاتصال", en: "Connecting" }
        : { tone: "blocked" as const, ar: "غير متصل", en: "Not connected" };
  const effective = status ? SEND_MODE_LABELS[status.effectiveMode] : null;

  return (
    <div className="space-y-[18px]">
      <PageHeader
        title={ar ? "ربط الواتساب" : "WhatsApp connection"}
        subtitle={ar ? "الرقم الذي ترسل منه رسائل النظام، ووضع الإرسال." : "The number messages are sent from, and whether they are sent."}
        actions={
          <Button variant="secondary" onClick={() => load()}>
            <RefreshCw size={15} aria-hidden /> {ar ? "تحديث" : "Refresh"}
          </Button>
        }
      />

      {error && <Alert kind="error" onDismiss={() => setError("")}>{error}</Alert>}
      {success && <Alert kind="success" onDismiss={() => setSuccess("")}>{success}</Alert>}

      {status && !status.configured && (
        <Alert kind="error">{status.configError}</Alert>
      )}

      {status && status.configured && (
        <Card>
          <SectionTitle right={<Badge tone={stateBadge.tone} testId="wa-state">{ar ? stateBadge.ar : stateBadge.en}</Badge>}>
            {ar ? "حالة الاتصال" : "Connection"}
          </SectionTitle>
          {status.stateError && <p className="mb-3 text-[13px] text-oo-status-blocked" dir="auto">{noteText(status.stateError, lang)}</p>}

          {status.state === "open" ? (
            <div className="space-y-3">
              <p className="text-[14px] text-oo-text-secondary">
                {ar ? "الرقم مربوط بجوال ويستطيع الإرسال." : "The number is linked to a phone and can send."}
              </p>
              {canManageConnection && (
                <div className="flex flex-wrap gap-2">
                  <Button variant="secondary" onClick={() => setConfirmLogout(true)} disabled={!!busy} testId="wa-logout">
                    <LogOut size={15} aria-hidden /> {ar ? "فصل الجوال / تغيير الرقم" : "Unlink / change phone"}
                  </Button>
                  <Button variant="ghost" onClick={doRestart} disabled={!!busy}>
                    <RotateCcw size={15} aria-hidden /> {ar ? "إعادة تشغيل الاتصال" : "Restart connection"}
                  </Button>
                </div>
              )}
            </div>
          ) : canManageConnection ? (
            <div className="grid gap-6 lg:grid-cols-2">
              <div className="space-y-3">
                <h3 className="text-[15px] font-semibold text-oo-text-primary">{ar ? "الربط برمز QR" : "Link with a QR code"}</h3>
                <ol className="list-decimal ps-5 text-[13px] leading-[22px] text-oo-text-secondary">
                  <li>{ar ? "افتح واتساب على الجوال المخصص للمحمصة." : "Open WhatsApp on the roastery's phone."}</li>
                  <li>{ar ? "الإعدادات ← الأجهزة المرتبطة ← ربط جهاز." : "Settings → Linked devices → Link a device."}</li>
                  <li>{ar ? "امسح الرمز. يتجدد تلقائيا كل نصف دقيقة تقريبا." : "Scan the code. It refreshes by itself."}</li>
                </ol>
                {qr ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={qr} alt={ar ? "رمز QR لربط واتساب" : "WhatsApp QR code"} className="h-64 w-64 rounded-xl border border-oo-border-default bg-white p-2" data-testid="wa-qr" />
                ) : (
                  <Button onClick={showQr} disabled={!!busy} testId="wa-show-qr">
                    <QrCode size={15} aria-hidden /> {busy === "qr" ? (ar ? "يطلب الرمز..." : "Requesting...") : ar ? "عرض رمز QR" : "Show QR code"}
                  </Button>
                )}
              </div>
              <div className="space-y-3">
                <h3 className="text-[15px] font-semibold text-oo-text-primary">{ar ? "أو بكود الربط (بلا تصوير)" : "Or with a pairing code"}</h3>
                <p className="text-[13px] leading-[22px] text-oo-text-secondary">
                  {ar
                    ? "اكتب رقم الجوال الذي ستربطه، ثم أدخل الكود في واتساب: الأجهزة المرتبطة ← ربط جهاز ← الربط برقم الهاتف."
                    : "Enter the phone's number, then type the code in WhatsApp: Linked devices → Link with phone number."}
                </p>
                <Field id="pair-number" label={ar ? "رقم الجوال" : "Phone number"}>
                  <TextInput id="pair-number" value={pairNumber} onChange={setPairNumber} inputMode="tel" placeholder="05XXXXXXXX" />
                </Field>
                {pairingCode ? (
                  <p className="text-center text-[28px] font-bold tracking-[0.3em] text-oo-text-primary" dir="ltr" data-testid="wa-pairing-code">
                    {pairingCode}
                  </p>
                ) : (
                  <Button variant="secondary" onClick={pair} disabled={!!busy || !pairNumber.trim()}>
                    <Smartphone size={15} aria-hidden /> {ar ? "اطلب كود الربط" : "Get a pairing code"}
                  </Button>
                )}
              </div>
              {linking && (
                <p className="lg:col-span-2 text-[13px] text-oo-text-muted" role="status">
                  {ar ? "ننتظر الربط... تتحدث الحالة تلقائيا." : "Waiting for the phone... the state updates by itself."}
                </p>
              )}
              <div className="lg:col-span-2">
                <Button variant="ghost" onClick={doRestart} disabled={!!busy}>
                  <RotateCcw size={15} aria-hidden /> {ar ? "إعادة تشغيل الاتصال (إذا علق)" : "Restart the connection (if stuck)"}
                </Button>
              </div>
            </div>
          ) : (
            <p className="text-[14px] text-oo-text-secondary">{ar ? "الرقم غير مربوط. يربطه من يملك صلاحية إدارة الاتصال." : "Not linked."}</p>
          )}
        </Card>
      )}

      {status && (
        <Card>
          <SectionTitle right={effective ? <Badge tone={effective.tone} testId="wa-mode">{ar ? effective.ar : effective.en}</Badge> : undefined}>
            {ar ? "وضع الإرسال" : "Sending mode"}
          </SectionTitle>
          {status.effectiveNote && status.sendMode !== "OFF" && <Alert kind="info">{noteText(status.effectiveNote, lang)}</Alert>}
          <div className="mt-3 space-y-2" role="radiogroup" aria-label={ar ? "وضع الإرسال" : "Sending mode"}>
            {(
              [
                ["OFF", ar ? "متوقف" : "Off", ar ? "القواعد تعمل وتسجل في السجل ما كانت سترسله، ولا يرسل شيء. مناسب لتجربة القواعد بأمان." : "Rules run and the log shows what they would have sent. Nothing is sent."],
                ["TEST", ar ? "تجربة" : "Test", ar ? "كل رسالة تذهب لرقم التجربة فقط، مهما كان مستلمها الأصلي." : "Every message goes to the test number only."],
                ["LIVE", ar ? "إرسال فعلي" : "Live", status.liveAllowed ? (ar ? "الرسائل تذهب للعملاء والموظفين فعلا." : "Messages go to the real recipients.") : ar ? "غير متاح: يجب تفعيل WHATSAPP_LIVE_ENABLED على الخادم أولا." : "Unavailable: set WHATSAPP_LIVE_ENABLED on the server first."],
              ] as const
            ).map(([value, title, desc]) => {
              const disabled = !canManageConnection || (value === "LIVE" && !status.liveAllowed);
              return (
                <label key={value} className={`flex items-start gap-3 rounded-xl border p-3 ${mode === value ? "border-oo-action-primary" : "border-oo-border-default"} ${disabled ? "opacity-60" : "cursor-pointer"}`}>
                  <input type="radio" name="send-mode" value={value} checked={mode === value} disabled={disabled} onChange={() => setMode(value)} className="mt-1 accent-oo-action-primary" data-testid={`mode-${value}`} />
                  <span>
                    <span className="block text-[14px] font-semibold text-oo-text-primary">{title}</span>
                    <span className="block text-[13px] text-oo-text-secondary">{desc}</span>
                  </span>
                </label>
              );
            })}
          </div>
          <div className="mt-4 grid gap-3 sm:grid-cols-[1fr_auto] items-end">
            <Field id="test-phone" label={ar ? "رقم التجربة" : "Test number"} hint={ar ? "تذهب له الرسائل في وضع التجربة، وتذهب له الرسالة التجريبية." : "Where test-mode messages go."}>
              <TextInput id="test-phone" value={testPhone} onChange={setTestPhone} inputMode="tel" placeholder="05XXXXXXXX" disabled={!canManageConnection} />
            </Field>
            {canManageConnection && (
              <Button onClick={saveMode} disabled={busy === "mode"} testId="save-mode">
                {ar ? "حفظ الوضع" : "Save mode"}
              </Button>
            )}
          </div>
          <p className="mt-3 text-[12px] text-oo-text-muted">
            {ar
              ? `آخر 24 ساعة: أرسلت ${status.queue.sent24h}، وفشلت ${status.queue.failed24h}. بانتظار الإرسال الآن: ${status.queue.queued}.`
              : `Last 24 h: ${status.queue.sent24h} sent, ${status.queue.failed24h} failed. Queued now: ${status.queue.queued}.`}
          </p>
        </Card>
      )}

      {status?.configured && canManageConnection && (
        <Card>
          <SectionTitle>{ar ? "رسالة تجريبية" : "Send a test message"}</SectionTitle>
          <p className="mb-3 text-[13px] text-oo-text-secondary">
            {ar ? "ترسل الآن إلى رقم التجربة أعلاه" : "Sent now to the test number above"}
            {testPhone && normalizePhoneForWhatsApp(testPhone).ok && (
              <>
                {" "}(<Phone value={(normalizePhoneForWhatsApp(testPhone) as { phone: string }).phone} />)
              </>
            )}
            {ar ? "، بغض النظر عن وضع الإرسال." : ", whatever the sending mode."}
          </p>
          <div className="grid gap-3 sm:grid-cols-[1fr_auto] items-end">
            <Field id="test-text" label={ar ? "النص (اختياري)" : "Text (optional)"}>
              <TextInput id="test-text" value={testText} onChange={setTestText} placeholder={ar ? "رسالة تجريبية من نظام حقبة" : "A test message"} />
            </Field>
            <Button onClick={sendTest} disabled={!!busy || status.state !== "open" || !testPhone.trim()} testId="send-test">
              <Send size={15} aria-hidden /> {ar ? "أرسل" : "Send"}
            </Button>
          </div>
        </Card>
      )}

      {confirmLogout && (
        <Modal
          title={ar ? "فصل الجوال؟" : "Unlink the phone?"}
          onClose={() => setConfirmLogout(false)}
          footer={
            <>
              <Button variant="secondary" onClick={() => setConfirmLogout(false)}>
                {ar ? "إلغاء" : "Cancel"}
              </Button>
              <Button variant="danger" onClick={doLogout} testId="wa-logout-confirm">
                {ar ? "فصل" : "Unlink"}
              </Button>
            </>
          }
        >
          <p className="text-[14px] leading-[22px] text-oo-text-secondary">
            {ar
              ? "يتوقف الإرسال حتى تربط جوالا من جديد. الرسائل المنتظرة تبقى في الطابور وترسل بعد الربط إن لم يمض عليها يوم."
              : "Sending stops until a phone is linked again. Queued messages wait, and expire after a day."}
          </p>
        </Modal>
      )}
    </div>
  );
}
