"use client";

import { useCallback, useEffect, useState } from "react";
import { Lock } from "lucide-react";
import { Btn, Notice } from "@/components/ops/ui";
import { Dialog } from "@/components/hr/ui";
import { api } from "../../sales/_components/ui";
import { formatPhone } from "@/lib/automation/phone";
import { ChannelIcon, Phone, SEND_MODE_LABELS, when } from "./shared";

/**
 * «إعدادات الإرسال» (batch 25; concept screen 1): ONE card, two channel rows — واتساب and إيميل — each with its own
 * sending mode, its own test target and «آخر رسالة تجربة وصلت». «فعلي» carries a lock: choosing it asks to type
 * «تشغيل», then the server asks the administrator to confirm who they are (step-up) and records who switched it.
 * The words: «تجربة» is the sending mode only; the button that sends one message now is «أرسل لي الحين».
 */

type Mode = "OFF" | "TEST" | "LIVE";
type ChannelState = {
  whatsapp: { sendMode: Mode; testPhone: string | null; liveAllowed: boolean; effectiveMode: Mode; effectiveNote: string | null; lastTestSentAt: string | null };
  email: { sendMode: Mode; testEmail: string | null; testEmailVerifiedAt: string | null; verifiedFresh: boolean; liveAllowed: boolean; effectiveMode: Mode; effectiveNote: string | null; providerConfigured: boolean; lastTestSentAt: string | null;
    webhookConfigured: boolean; baseUrlConfigured: boolean; replyToEmail: string | null; linkSecretConfigured?: boolean; baseUrlProduction?: boolean };
  can: { manage: boolean; live: boolean };
};

const MODE_HELP: Record<Mode, { ar: string; en: string }> = {
  OFF: { ar: "ما يطلع شي. القواعد تسجّل وش كانت بترسل.", en: "Nothing goes out. Rules record what they would send." },
  TEST: { ar: "كل الرسائل تجيك أنت بس، ولا شي يوصل للعملاء.", en: "Every message reaches you only, never a customer." },
  LIVE: { ar: "الرسائل توصل للعملاء الحقيقيين.", en: "Messages reach the real customers." },
};

export function ChannelsCard({ lang, onChanged }: { lang: "ar" | "en"; onChanged?: () => void }) {
  const ar = lang === "ar";
  const L = (a: string, e: string) => (ar ? a : e);
  const [s, setS] = useState<ChannelState | null>(null);
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [replyTo, setReplyTo] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [confirm, setConfirm] = useState<{ channel: "whatsapp" | "email" } | null>(null);
  const [typed, setTyped] = useState("");

  const apply = useCallback((d: ChannelState) => {
    setS(d);
    setPhone(formatPhone(d.whatsapp.testPhone));
    setEmail(d.email.testEmail ?? "");
    setReplyTo(d.email.replyToEmail ?? "");
  }, []);
  const load = useCallback(async () => {
    const r = await api<ChannelState>("/api/automation/settings");
    if (r.ok) apply(r.data);
  }, [apply]);
  useEffect(() => {
    let cancelled = false;
    api<ChannelState>("/api/automation/settings").then((r) => { if (!cancelled && r.ok) apply(r.data); });
    return () => { cancelled = true; };
  }, [apply]);
  if (!s) return null;

  async function save(channel: "whatsapp" | "email", sendMode: Mode) {
    setBusy(channel);
    setMsg(null);
    const body = channel === "whatsapp" ? { channel, sendMode, testPhone: phone } : { channel, sendMode, testEmail: email };
    const r = await api<{ sendMode: Mode }>("/api/automation/settings", { method: "PUT", body });
    setBusy(null);
    if (!r.ok) return setMsg({ ok: false, text: r.data.error ?? L("تعذّر الحفظ.", "Could not save.") });
    setMsg({ ok: true, text: sendMode === "LIVE" ? L("صار «فعلي». انسجل اسمك ووقت التشغيل.", "Now Live. Your name and the time were recorded.") : L("انحفظ.", "Saved.") });
    await load();
    onChanged?.();
  }

  function choose(channel: "whatsapp" | "email", m: Mode) {
    if (!s || busy) return;
    if (m === "LIVE") { setTyped(""); setConfirm({ channel }); return; }
    void save(channel, m);
  }

  async function saveReplyTo() {
    setBusy("reply");
    setMsg(null);
    const r = await api<{ replyToEmail: string | null }>("/api/automation/settings", { method: "PUT", body: { channel: "email", replyToEmail: replyTo } });
    setBusy(null);
    if (!r.ok) return setMsg({ ok: false, text: r.data.error ?? L("تعذّر الحفظ.", "Could not save.") });
    setMsg({ ok: true, text: L("انحفظ بريد الردود.", "Reply address saved.") });
    await load();
  }

  async function sendTestEmail() {
    setBusy("email-test");
    setMsg(null);
    const r = await api<{ ok: boolean }>("/api/automation/settings/test-email", { method: "POST" });
    setBusy(null);
    if (!r.ok) return setMsg({ ok: false, text: r.data.error ?? L("ما انرسلت.", "Not sent.") });
    setMsg({ ok: true, text: L("انرسلت رسالة التجربة لإيميل التجربة. افتحها واضغط «وصلتني».", "The test e-mail went to the test address. Open it and press «It arrived».") });
    await load();
  }

  const row = (channel: "whatsapp" | "email") => {
    const c = channel === "whatsapp" ? s.whatsapp : s.email;
    const saved = c.sendMode;
    const eff = SEND_MODE_LABELS[c.effectiveMode];
    const liveLocked = !c.liveAllowed || (channel === "email" && (!s.email.verifiedFresh || !s.email.webhookConfigured || !s.email.baseUrlConfigured || !s.email.providerConfigured || !s.email.linkSecretConfigured || !s.email.baseUrlProduction));
    const name = channel === "whatsapp" ? L("واتساب", "WhatsApp") : L("إيميل", "E-mail");
    return (
      <div className="tl-chrow" data-testid={`channel-${channel}`}>
        <div>
          <span className="tl-chname"><ChannelIcon channel={channel} lang={lang} />{name}</span>
          <span className="tl-chsub">
            {L("الحين: ", "Now: ")}<span data-testid={`channel-${channel}-effective`}>{eff ? (ar ? eff.ar : eff.en) : c.effectiveMode}</span>
            {saved === "LIVE" && c.effectiveMode === "OFF" ? L(" (المحفوظ «فعلي» لكنه مقفل على الخادم)", " (saved «Live», locked on the server)") : null}
          </span>
          {channel === "email" ? <EmailSetupChecks s={s.email} L={L} /> : null}
        </div>
        <div>
          <span className="ops-seg" role="group" aria-label={`${L("وضع الإرسال", "Sending mode")} — ${name}`} data-testid={`channel-${channel}-mode`}>
            {(["OFF", "TEST", "LIVE"] as Mode[]).map((m) => (
              <button key={m} type="button" aria-pressed={saved === m}
                disabled={!s.can.manage || !!busy || (m === "LIVE" && (!s.can.live || liveLocked))}
                onClick={() => choose(channel, m)} data-testid={`channel-${channel}-${m}`}
                title={m === "LIVE" && liveLocked ? (channel === "email" && c.liveAllowed ? L("لازم توصلك رسالة تجربة أول", "A test e-mail must arrive first") : L("مقفل على الخادم", "Locked on the server")) : undefined}>
                {ar ? SEND_MODE_LABELS[m].ar : SEND_MODE_LABELS[m].en}
                {m === "LIVE" ? <Lock size={13} strokeWidth={1.8} className="tl-lock" aria-label={L("يحتاج تأكيد الهوية", "Needs identity confirmation")} /> : null}
              </button>
            ))}
          </span>
          <span className="tl-chsub">{ar ? MODE_HELP[saved].ar : MODE_HELP[saved].en}</span>
          {channel === "email" && !c.liveAllowed ? <span className="tl-chsub">{L("«فعلي» للإيميل مقفل على الخادم. لفتحه: اطلب من الدعم الفني يفتحه على خادم الإنتاج، بعدها ترجع هنا وتختار «فعلي».", "Live e-mail is locked on the server. To open it, ask technical support to enable it on the production server, then come back here and choose Live.")}</span> : null}
          {channel === "whatsapp" && !c.liveAllowed ? <span className="tl-chsub">{L("«فعلي» للواتساب مقفل على هذا الخادم.", "Live WhatsApp is locked on this server.")}</span> : null}
        </div>
        <div>
          <label className="tl-chsub" htmlFor={`test-${channel}`} style={{ marginTop: 0, marginBottom: 4 }}>{channel === "whatsapp" ? L("رقم التجربة (رقمك أنت)", "Test number (yours)") : L("إيميل التجربة (إيميلك أنت)", "Test e-mail (yours)")}</label>
          <div className="tl-target">
            {channel === "whatsapp" ? (
              <input id="test-whatsapp" className="hr-input" dir="ltr" inputMode="tel" placeholder="05XXXXXXXX" value={phone} onChange={(e) => setPhone(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && s.can.manage && !busy && saved !== "LIVE") { e.preventDefault(); void save(channel, saved); } }} disabled={!s.can.manage} data-testid="test-phone" />
            ) : (
              <input id="test-email" className="hr-input" dir="ltr" type="text" inputMode="email" autoComplete="email" placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && s.can.manage && !busy && saved !== "LIVE") { e.preventDefault(); void save(channel, saved); } }} disabled={!s.can.manage} data-testid="test-email" />
            )}
            {s.can.manage ? <Btn size="sm" onClick={() => void save(channel, saved === "LIVE" ? "LIVE" : saved)} disabled={!!busy || saved === "LIVE"} data-testid={`save-target-${channel}`}>{L("حفظ", "Save")}</Btn> : null}
          </div>
          {channel === "whatsapp" ? (
            <p className="tl-last" data-testid="whatsapp-last-test">
              {L("آخر رسالة تجربة وصلت: ", "Last test message: ")}
              {s.whatsapp.lastTestSentAt ? <bdi dir="ltr">{when(s.whatsapp.lastTestSentAt, lang)}</bdi> : L("لسا ما انرسلت", "none yet")}
              {s.whatsapp.testPhone ? <> · <Phone value={s.whatsapp.testPhone} /></> : null}
            </p>
          ) : (
            <>
              <p className={`tl-last${s.email.verifiedFresh ? " is-ok" : ""}`} data-testid="email-last-test">
                {L("آخر رسالة تجربة وصلت: ", "Last test e-mail that arrived: ")}
                {s.email.testEmailVerifiedAt ? <bdi dir="ltr">{when(s.email.testEmailVerifiedAt, lang)}</bdi> : L("لسا ما وصلت", "none yet")}
                {s.email.testEmailVerifiedAt && !s.email.verifiedFresh ? L(" (أقدم من 30 يوم: أرسل وحدة جديدة)", " (over 30 days: send a new one)") : null}
              </p>
              {s.email.testEmail && !s.email.testEmailVerifiedAt && s.email.sendMode === "TEST" ? (
                <p className="tl-chsub" data-testid="email-unverified" style={{ color: "var(--warning-text, #8a5a00)" }}>{L("إيميل التجربة هذا ما تأكد بعد: أرسل لنفسك إيميل تجربة واضغط «وصلتني».", "This test address is not confirmed yet: send yourself a test e-mail and press «It arrived».")}</p>
              ) : null}
              {s.can.manage ? (
                <Btn size="sm" onClick={sendTestEmail} disabled={!!busy || !s.email.testEmail} busy={busy === "email-test"} data-testid="send-test-email">{L("أرسل لي إيميل الحين", "E-mail me now")}</Btn>
              ) : null}
            </>
          )}
        </div>
      </div>
    );
  };

  return (
    <section className="tl-channels" aria-label={L("وضع الإرسال لكل قناة", "Sending mode per channel")} data-testid="channels-card">
      <header>
        <h2>{L("وضع الإرسال", "Sending mode")}</h2>
        <p>{L("لكل قناة وضعها. «تجربة» يعني كل الرسائل تروح لك أنت بس. «فعلي» يطلب تأكيد هويتك، وينسجل مين شغّله ومتى.", "Each channel has its own mode. «Test» sends everything to you only. «Live» asks you to confirm who you are, and records who switched it and when.")}</p>
      </header>
      {row("whatsapp")}
      {row("email")}
      <div className="tl-chrow" data-testid="reply-to-row">
        <div>
          <span className="tl-chname">{L("بريد الردود", "Reply address")}</span>
          <span className="tl-chsub" data-testid="reply-to-help">{L("لما العميل يرد على الإيميل، يروح الرد لإيميل العمل حق المندوب اللي يتابعه: في عرض السعر صاحب الصفقة، وفي غيره مسؤول حساب العميل. هذا البريد احتياط فقط لما المندوب ما له إيميل عمل.", "Customer replies go to the work e-mail of the rep who handles them: the deal owner for a quotation, otherwise the customer's account owner. This address is only the fallback when that rep has no work e-mail.")}</span>
        </div>
        <div>
          {!s.email.replyToEmail ? (
            <span className="tl-chsub" style={{ color: "var(--status-warning, #946200)" }} data-testid="reply-to-warning">
              {L("ما فيه بريد ردود احتياطي: إذا المندوب ما له إيميل عمل، الإيميل ما بيقول «رد على هذه الرسالة» وبيعطي رقم التواصل بدلها.", "No fallback reply address: when the rep has no work e-mail, e-mails will not say «reply to this e-mail» and give the phone number instead.")}
            </span>
          ) : <span className="tl-chsub">{L("الحين: ", "Now: ")}<bdi dir="ltr">{s.email.replyToEmail}</bdi></span>}
        </div>
        <div className="tl-target">
          <input className="hr-input" dir="ltr" type="text" inputMode="email" placeholder="sales@your-company.com" value={replyTo} onChange={(e) => setReplyTo(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && s.can.live && !busy) { e.preventDefault(); void saveReplyTo(); } }} disabled={!s.can.live} data-testid="reply-to-input" aria-label={L("بريد الردود", "Reply address")} />
          {s.can.live ? <Btn size="sm" onClick={saveReplyTo} disabled={!!busy} data-testid="reply-to-save">{L("حفظ", "Save")}</Btn> : null}
        </div>
      </div>
      {msg ? <div className="tl-chlock"><Notice tone={msg.ok ? "success" : "danger"}><span data-testid="channels-msg">{msg.text}</span></Notice></div> : null}
      <Dialog
        open={!!confirm}
        title={L("تشغيل فعلي؟", "Switch to Live?")}
        onClose={() => setConfirm(null)}
        actions={<>
          <Btn onClick={() => setConfirm(null)}>{L("إلغاء", "Cancel")}</Btn>
          <Btn variant="primary" disabled={typed.trim() !== L("تشغيل", "LIVE")} onClick={() => { const c = confirm!; setConfirm(null); void save(c.channel, "LIVE"); }} data-testid="live-confirm">{L("شغّل فعلي", "Switch to Live")}</Btn>
        </>}
      >
        <p style={{ margin: "0 0 10px", fontSize: 14, lineHeight: "22px" }}>
          {confirm?.channel === "email"
            ? L("من الحين الإيميلات بتوصل للعملاء الحقيقيين، والإيميل ما يرجع بعد ما ينرسل.", "From now on e-mails reach real customers, and an e-mail cannot be taken back.")
            : L("من الحين رسائل الواتساب بتوصل للعملاء الحقيقيين.", "From now on WhatsApp messages reach real customers.")}
        </p>
        <label className="tl-chsub" htmlFor="live-typed">{L("اكتب «تشغيل» للتأكيد", "Type «LIVE» to confirm")}</label>
        <input id="live-typed" className="hr-input" value={typed} onChange={(e) => setTyped(e.target.value)} data-testid="live-typed" autoComplete="off" />
      </Dialog>
    </section>
  );
}

/** What is missing on this server for e-mail, in plain words (fix round 1) — never a secret, only whether it is set. */
function EmailSetupChecks({ s, L }: { s: ChannelState["email"]; L: (a: string, e: string) => string }) {
  const rows: { ok: boolean; text: string; testId: string }[] = [
    { ok: s.providerConfigured, testId: "check-provider", text: s.providerConfigured ? L("الإيميل مربوط", "E-mail is connected") : L("الإيميل غير مربوط على هذا الخادم (مفتاح Resend ناقص)، فالإيميلات تنتظر وما تطلع. كلّم الدعم الفني.", "E-mail is not connected (no Resend key): e-mails wait, none goes out.") },
    { ok: s.webhookConfigured, testId: "check-webhook", text: s.webhookConfigured ? L("نعرف إذا الإيميل وصل أو ارتدّ", "Delivery reports are on") : L("ما نعرف إذا الإيميل وصل أو ارتدّ، لأن ربط تقارير التسليم ناقص. «فعلي» مقفل لين يُضبط.", "No delivery reports (webhook secret missing). Live stays locked until it is set.") },
    { ok: s.baseUrlConfigured, testId: "check-base-url", text: s.baseUrlConfigured ? L("رابط الإيقاف يشتغل", "The unsubscribe link works") : L("عنوان النظام ناقص، فرابط الإيقاف ما يشتغل والإيميلات للعملاء ما تطلع. كلّم الدعم الفني.", "The system address is missing: no unsubscribe link, so customer e-mails are not sent.") },
    // Batch 25b: LIVE needs the link key (so links survive a key rotation) and this server to be the production domain.
    { ok: !!s.linkSecretConfigured, testId: "check-link-secret", text: s.linkSecretConfigured ? L("مفتاح روابط الإيميل مضبوط", "The e-mail link key is set") : L("مفتاح روابط الإيميل (EMAIL_LINK_SECRET) ناقص. «فعلي» مقفل لين يُضبط. كلّم الدعم الفني.", "The e-mail link key (EMAIL_LINK_SECRET) is missing. Live stays locked until it is set.") },
    { ok: !!s.baseUrlProduction, testId: "check-production-url", text: s.baseUrlProduction ? L("هذا خادم الإنتاج (https)", "This is the production server (https)") : L("عنوان هذا الخادم مو عنوان الإنتاج، فـ«فعلي» مقفل هنا (يشتغل على خادم الإنتاج فقط).", "This server's address is not the production domain: Live is locked here (production only).") },
  ];
  const stale = s.sendMode === "LIVE" && !s.verifiedFresh;
  return (
    <ul style={{ listStyle: "none", padding: 0, margin: "6px 0 0", display: "grid", gap: 2 }} data-testid="email-checks">
      {rows.map((r) => (
        <li key={r.testId} className="tl-chsub" style={{ color: r.ok ? "var(--text-muted)" : "var(--status-danger)", marginTop: 0 }} data-testid={r.testId} data-ok={r.ok ? "1" : "0"}>
          {r.ok ? "✓ " : "⚠ "}{r.text}
        </li>
      ))}
      {stale ? <li className="tl-chsub" style={{ color: "var(--status-warning, #946200)", marginTop: 0 }} data-testid="check-stale-test">{L("⚠ آخر رسالة تجربة وصلت أقدم من 30 يوم. الإرسال مستمر، بس يُفضّل ترسل تجربة جديدة وتضغط «وصلتني».", "⚠ The last confirmed test is over 30 days old. Sending continues; send a new test when you can.")}</li> : null}
    </ul>
  );
}
