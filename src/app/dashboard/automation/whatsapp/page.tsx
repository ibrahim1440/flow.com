"use client";

import { useCallback, useEffect, useState } from "react";
import { Btn, Dot, Field, Notice, OpsBanner, OpsLoading, OpsRoot } from "@/components/ops/ui";
import { Dialog } from "@/components/hr/ui";
import { useD21Phone } from "@/components/shell/page-context";
import { api, useLang } from "../../sales/_components/ui";
import { formatPhone, normalizePhoneForWhatsApp } from "@/lib/automation/phone";
import { AutomationHeader, Phone, SEND_MODE_LABELS, connectionLabel, noteText, useAutomationAbilities } from "../_components/shared";
import { SettingsFrame } from "../../_components/tools-ui";
import { ChannelsCard } from "../_components/channels";

/**
 * Linking the WhatsApp number, and deciding whether anything is sent — Direction 2.1 (UI batch
 * 2; GX E-P04, Figma 1228:107443 at 1440, EN 1230:141723, 1024 1228:109238, phone 1228:124175).
 *
 * The QR expires in about a minute, so while it is on screen it is refreshed every 35 s and
 * the connection state is polled every 5 s; the moment the phone links, the QR disappears.
 * Polling stops after a few minutes so a forgotten tab does not keep asking the server.
 * Visual port only: the same requests, timers, gates and confirmations as before.
 */

type Status = {
  configured: boolean;
  configError: string | null;
  state: "open" | "connecting" | "close" | "unknown" | null;
  stateError: string | null;
  linkedPhone: string | null;
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

  const [testPhone, setTestPhone] = useState("");
  const [testText, setTestText] = useState("");

  useD21Phone({ title: ar ? "إعدادات الإرسال" : "Sending settings", sub: ar ? "رسائل العملاء التلقائية" : "Automated customer messages" });

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
      setTestPhone(formatPhone(r.data.testPhone));
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

  async function sendTest() {
    const d = await post("test", { phone: testPhone, text: testText });
    if (d) setSuccess(ar ? "انرسلت رسالة اختبار الاتصال." : "Connection check sent.");
  }

  const L = (a: string, e: string) => (ar ? a : e);
  const stateBadge = connectionLabel(status?.state);
  const effective = status ? SEND_MODE_LABELS[status.effectiveMode] : null;
  const normalizedTest = testPhone ? normalizePhoneForWhatsApp(testPhone) : null;

  return (
    <OpsRoot className="tl-root">
      <SettingsFrame>
        <AutomationHeader lang={lang} conn={null} actions={<Btn variant="ghost" size="sm" onClick={() => load()}>{L("تحديث", "Refresh")}</Btn>} />

        {error && <OpsBanner tone="danger" onClose={() => setError("")}>{error}</OpsBanner>}
        {success && <OpsBanner tone="success" onClose={() => setSuccess("")}>{success}</OpsBanner>}

        {!status && !error ? <OpsLoading /> : null}

        {/* Batch 25 (council seat 5): no server variable names in front of the owner — plain words, the detail for support in the title. */}
        {status && !status.configured && <Notice tone="danger"><span title={status.configError ?? undefined} data-testid="wa-not-configured">{L("الواتساب غير مربوط على هذا الخادم، فرسائل الواتساب ما تطلع. كلّم الدعم الفني.", "WhatsApp is not connected on this server, so no WhatsApp message goes out. Contact support.")}</span></Notice>}

        <ChannelsCard lang={lang} onChanged={() => void load()} />

        {status ? (
          <div className="tl-cols">
            {/* ── Connection, then the test message ── */}
            <section aria-label={L("حالة الاتصال", "Connection")}>
              {status.configured ? (
                <>
                  <div className="tl-h">
                    <h2>{L("حالة الاتصال", "Connection")}</h2>
                    <span>{L("الجوال الذي تُرسل منه رسائل النظام", "The phone system messages are sent from")}</span>
                  </div>
                  <div className="tl-acts">
                    <span data-testid="wa-state"><Dot tone={stateBadge.tone}>{ar ? stateBadge.ar : stateBadge.en}</Dot></span>
                    {status.state === "open" ? (
                      <span className="hr-caption" data-testid="wa-linked">
                        {status.linkedPhone ? (
                          // GX E-05: «الرقم +966 5X XXX XXXX مربوط بجوال ويستطيع الإرسال.»
                          <>{L("الرقم ", "Number ")}<Phone value={status.linkedPhone} />{L(" مربوط بجوال ويستطيع الإرسال.", " is linked to a phone and can send.")}</>
                        ) : L("الرقم مربوط بجوال ويستطيع الإرسال.", "The number is linked to a phone and can send.")}
                      </span>
                    ) : null}
                  </div>
                  {status.stateError && <p className="hr-caption" style={{ color: "var(--status-danger)", margin: 0 }} dir="auto">{noteText(status.stateError, lang)}</p>}

                  {status.state === "open" ? (
                    canManageConnection ? (
                      <div className="tl-acts">
                        <Btn onClick={() => setConfirmLogout(true)} disabled={!!busy} data-testid="wa-logout">{L("فصل الجوال / تغيير الرقم", "Unlink / change phone")}</Btn>
                        <Btn variant="ghost" onClick={doRestart} disabled={!!busy}>{L("إعادة تشغيل الاتصال", "Restart connection")}</Btn>
                      </div>
                    ) : null
                  ) : canManageConnection ? (
                    <div className="hr-stack" style={{ gap: 14 }}>
                      <div className="hr-stack" style={{ gap: 8 }}>
                        <strong style={{ fontSize: 14.5 }}>{L("الربط برمز QR", "Link with a QR code")}</strong>
                        <ol className="tl-steps">
                          <li>{L("افتح واتساب على الجوال المخصص للمحمصة.", "Open WhatsApp on the roastery's phone.")}</li>
                          <li>{L("الإعدادات ← الأجهزة المرتبطة ← ربط جهاز.", "Settings → Linked devices → Link a device.")}</li>
                          <li>{L("امسح الرمز. يتجدد تلقائيا كل نصف دقيقة تقريبا.", "Scan the code. It refreshes by itself.")}</li>
                        </ol>
                        {qr ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={qr} alt={L("رمز QR لربط واتساب", "WhatsApp QR code")} className="tl-qr" data-testid="wa-qr" />
                        ) : (
                          <Btn variant="primary" onClick={showQr} disabled={!!busy} data-testid="wa-show-qr" style={{ alignSelf: "flex-start" }}>
                            {busy === "qr" ? L("يطلب الرمز...", "Requesting...") : L("عرض رمز QR", "Show QR code")}
                          </Btn>
                        )}
                      </div>
                      <hr className="tl-hr" />
                      <div className="hr-stack" style={{ gap: 8 }}>
                        <strong style={{ fontSize: 14.5 }}>{L("أو بكود الربط (بلا تصوير)", "Or with a pairing code")}</strong>
                        <p className="hr-caption" style={{ margin: 0 }}>
                          {L(
                            "اكتب رقم الجوال الذي ستربطه، ثم أدخل الكود في واتساب: الأجهزة المرتبطة ← ربط جهاز ← الربط برقم الهاتف.",
                            "Enter the phone's number, then type the code in WhatsApp: Linked devices → Link with phone number.",
                          )}
                        </p>
                        <Field label={L("رقم الجوال", "Phone number")}>
                          <input id="pair-number" className="hr-input" value={pairNumber} onChange={(e) => setPairNumber(e.target.value)} inputMode="tel" placeholder="05XXXXXXXX" dir="ltr" />
                        </Field>
                        {pairingCode ? (
                          <p className="tl-code" dir="ltr" data-testid="wa-pairing-code">{pairingCode}</p>
                        ) : (
                          <Btn onClick={pair} disabled={!!busy || !pairNumber.trim()} style={{ alignSelf: "flex-start" }}>{L("اطلب كود الربط", "Get a pairing code")}</Btn>
                        )}
                      </div>
                      {linking && (
                        <p className="hr-caption" role="status" style={{ margin: 0 }}>{L("ننتظر الربط... تتحدث الحالة تلقائيا.", "Waiting for the phone... the state updates by itself.")}</p>
                      )}
                      <Btn variant="ghost" onClick={doRestart} disabled={!!busy} style={{ alignSelf: "flex-start" }}>{L("إعادة تشغيل الاتصال (إذا علق)", "Restart the connection (if stuck)")}</Btn>
                    </div>
                  ) : (
                    <p className="hr-caption" style={{ margin: 0 }}>{L("الرقم غير مربوط. يربطه من يملك صلاحية إدارة الاتصال.", "Not linked.")}</p>
                  )}

                  {canManageConnection ? (
                    <>
                      <hr className="tl-hr" />
                      <div className="tl-h"><h2>{L("اختبار الاتصال", "Connection check")}</h2></div>
                      <p className="hr-caption" style={{ margin: 0 }}>
                        {L("رسالة واتساب وحدة الحين إلى رقم التجربة", "One WhatsApp message now to the test number")}
                        {normalizedTest && normalizedTest.ok && (
                          <>
                            {" "}<Phone value={(normalizedTest as { phone: string }).phone} />
                          </>
                        )}
                        {L("، بغض النظر عن وضع الإرسال.", ", whatever the sending mode.")}
                      </p>
                      <Field label={L("النص (اختياري)", "Text (optional)")}>
                        <input id="test-text" className="hr-input" value={testText} onChange={(e) => setTestText(e.target.value)} placeholder={L("اختبار الاتصال من نظام حقبة", "A connection check")} />
                      </Field>
                      <Btn onClick={sendTest} disabled={!!busy || status.state !== "open" || !testPhone.trim()} data-testid="send-test" style={{ alignSelf: "flex-start" }}>{L("أرسل لي الحين", "Send me one now")}</Btn>
                    </>
                  ) : null}
                </>
              ) : null}
            </section>

            {/* ── The queue (the sending modes are on the channels card above, batch 25) ── */}
            <section aria-label={L("طابور الواتساب", "WhatsApp queue")}>
              <div className="tl-h">
                <h2>{L("طابور الواتساب", "WhatsApp queue")}</h2>
                {effective ? <span data-testid="wa-mode" style={{ marginInlineStart: "auto" }}><Dot tone={effective.tone}>{ar ? effective.ar : effective.en}</Dot></span> : null}
              </div>
              <p className="hr-caption" style={{ margin: 0 }}>
                {ar
                  ? `آخر 24 ساعة: انرسلت ${status.queue.sent24h}، وفشلت ${status.queue.failed24h}. تنتظر الإرسال الحين: ${status.queue.queued}.`
                  : `Last 24 h: ${status.queue.sent24h} sent, ${status.queue.failed24h} failed. Queued now: ${status.queue.queued}.`}
              </p>
            </section>
          </div>
        ) : null}
      </SettingsFrame>

      <Dialog
        open={confirmLogout}
        title={L("فصل الجوال؟", "Unlink the phone?")}
        onClose={() => setConfirmLogout(false)}
        actions={
          <>
            <Btn onClick={() => setConfirmLogout(false)}>{L("إلغاء", "Cancel")}</Btn>
            <Btn variant="danger" onClick={doLogout} data-testid="wa-logout-confirm">{L("فصل", "Unlink")}</Btn>
          </>
        }
      >
        <p style={{ margin: 0, fontSize: 14, lineHeight: "22px", color: "var(--text-secondary)" }}>
          {L(
            "يتوقف الإرسال حتى تربط جوالا من جديد. الرسائل المنتظرة تبقى في الطابور وترسل بعد الربط إن لم يمض عليها يوم.",
            "Sending stops until a phone is linked again. Queued messages wait, and expire after a day.",
          )}
        </p>
      </Dialog>
    </OpsRoot>
  );
}
