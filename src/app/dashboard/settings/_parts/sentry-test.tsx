"use client";
// R1-d: «إرسال خطأ تجريبي إلى المراقبة» — the owner sends one synthetic error from the server (POST /api/ops/sentry-test)
// and one from this browser (the Sentry SDK loaded by instrumentation-client.ts, only when NEXT_PUBLIC_SENTRY_DSN is set),
// then checks in Sentry that both arrived with no e-mail, IBAN, phone, long number or token in them.
import { useState } from "react";
import { Btn, Notice, useL } from "@/components/ops/ui";
import { sentryTestError } from "@/lib/observability/sentry-test";

type Outcome = { server: string; browser: string; tone: "success" | "warning" | "danger" };

export function SentryTestPanel() {
  const L = useL();
  const [busy, setBusy] = useState(false);
  const [out, setOut] = useState<Outcome | null>(null);

  async function send() {
    setBusy(true);
    let server: string;
    let serverOn = false;
    let failed = false;
    try {
      const res = await fetch("/api/ops/sentry-test", { method: "POST" });
      const b = await res.json().catch(() => ({}));
      if (res.status === 429) server = L("الخادم: أُرسل قبل دقيقة — جرّب بعد شوي", "Server: sent a minute ago — try again shortly");
      else if (!res.ok) { failed = true; server = L("الخادم: ما انرسل", "Server: not sent"); }
      else if (b.sentry === "off") server = L("الخادم: المراقبة غير مفعّلة", "Server: monitoring is not enabled");
      else { serverOn = true; server = L(`الخادم: أُرسل (${b.eventId ?? "—"})`, `Server: sent (${b.eventId ?? "—"})`); }
    } catch {
      failed = true;
      server = L("الخادم: تعذّر الاتصال", "Server: could not connect");
    }
    let browser: string;
    let browserOn = false;
    if (process.env.NEXT_PUBLIC_SENTRY_DSN) {
      try {
        const Sentry = await import("@sentry/nextjs");
        const id = Sentry.captureException(sentryTestError("browser"));
        await Sentry.flush(3000).catch(() => false);
        browserOn = true;
        browser = L(`المتصفح: أُرسل (${id})`, `Browser: sent (${id})`);
      } catch {
        failed = true;
        browser = L("المتصفح: ما انرسل", "Browser: not sent");
      }
    } else {
      browser = L("المتصفح: المراقبة غير مفعّلة", "Browser: monitoring is not enabled");
    }
    // «غير مفعّلة» is a state, not a failure: amber; red only when a send failed.
    setOut({ server, browser, tone: failed ? "danger" : serverOn && browserOn ? "success" : "warning" });
    setBusy(false);
  }

  return (
    <div className="hr-stack" style={{ gap: 8 }} data-testid="sentry-test">
      <p className="hr-caption" style={{ margin: 0 }}>
        {L("يرسل خطأ وهمي من الخادم ومن هذا المتصفح، فيه بريد ورقم آيبان وجوال ورقم طويل وهمية — تأكد في Sentry إنه وصل وإن هالبيانات كلها مشطوبة.", "Sends a fake error from the server and from this browser, carrying a fake e-mail, IBAN, phone and long number — check in Sentry that it arrived with all of them removed.")}
      </p>
      <div><Btn onClick={send} disabled={busy} data-testid="sentry-test-send">{L("إرسال خطأ تجريبي إلى المراقبة", "Send a test error to monitoring")}</Btn></div>
      {out ? <div data-testid="sentry-test-result"><Notice tone={out.tone}>{out.server} · {out.browser}</Notice></div> : null}
    </div>
  );
}
