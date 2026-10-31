"use client";
// Settings › «البريد الإلكتروني» (feature/email-demo). The admin role (the audience of every settings
// page; registry «settings.email»). Shows whether an e-mail provider is configured and the sender's
// DOMAIN only (never the address, never the key), and sends the four demo e-mails to one address the
// admin types: POST /api/settings/email/test (step-up, 3 runs an hour, one audit row, nothing else
// written). GET /api/settings/email.
import { useEffect, useState } from "react";
import Link from "next/link";
import { Btn, Dot, Field, OpsLoading, OpsRoot, PageHeader, useL } from "@/components/ops/ui";
import { useD21Phone } from "@/components/shell/page-context";
import { Sec, SettingsFrame } from "../../_components/tools-ui";
import "../_parts/sections.css";

type Status = {
  provider: string | null; configured: boolean; senderDomain: string | null; environment: string; defaultRecipient: string | null;
  limit: { runs: number; windowMinutes: number; remaining: number; retryAt: string | null };
};
type Result = { kind: string; subject: string; status: "SENT" | "FAILED" | "NOT_CONFIGURED"; attachments: number };

const EMAIL_RE = /^[^\s@,;<>]+@[^\s@,;<>]+\.[a-z]{2,}$/i;
const KIND: Record<string, [string, string]> = {
  connection_test: ["اختبار الربط", "Connection test"],
  quotation: ["عرض سعر + PDF", "Quotation + PDF"],
  invoice: ["فاتورة نموذجية + PDF", "Demo invoice + PDF"],
  payment_reminder: ["تذكير بالسداد + كشف حساب", "Payment reminder + statement"],
};
const STATUS: Record<Result["status"], [string, string, "success" | "danger" | "warning"]> = {
  SENT: ["أُرسلت", "Sent", "success"],
  FAILED: ["تعذّر الإرسال", "Failed", "danger"],
  NOT_CONFIGURED: ["البريد غير مُعدّ", "Not configured", "warning"],
};

export default function EmailSettingsPage() {
  const L = useL();
  const [s, setS] = useState<Status | null>(null);
  const [failed, setFailed] = useState(false);
  const [to, setTo] = useState("");
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [results, setResults] = useState<Result[] | null>(null);
  useD21Phone({ title: L("البريد الإلكتروني", "E-mail"), sub: L("الإعدادات", "Settings"), back: "/dashboard/settings" });

  const load = () => fetch("/api/settings/email", { cache: "no-store" }).then((r) => (r.ok ? r.json() : Promise.reject())).then((j: Status) => {
    setS(j);
    setTo((cur) => cur || j.defaultRecipient || "");
  });
  useEffect(() => { load().catch(() => setFailed(true)); }, []);

  const valid = EMAIL_RE.test(to.trim());
  const fieldError = touched && to.trim() !== "" && !valid ? L("عنوان بريد واحد صحيح، مثل name@example.com", "One valid address, e.g. name@example.com") : null;

  async function send(e: React.FormEvent) {
    e.preventDefault();
    setTouched(true);
    if (!valid || busy) return;
    setBusy(true);
    setErr(null);
    setResults(null);
    try {
      // A 401 REAUTH_REQUIRED opens the step-up dialog (StepUpProvider) and the request is retried once.
      const r = await fetch("/api/settings/email/test", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ to: to.trim() }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setErr(L(j.error ?? "تعذّر الإرسال.", j.errorEn ?? "Could not send.")); return; }
      setResults(j.results as Result[]);
    } catch {
      setErr(L("تعذّر الاتصال بالخادم.", "Could not reach the server."));
    } finally {
      setBusy(false);
      load().catch(() => undefined);
    }
  }

  const provider = s?.provider === "resend" ? "Resend" : s?.provider === "outbox" ? L("صندوق محلي (للاختبار)", "Local outbox (testing)") : s?.provider ?? null;

  return (
    <OpsRoot className="tl-root">
      <SettingsFrame>
        <PageHeader title={L("البريد الإلكتروني", "E-mail")} />
        <p className="tl-sub">{L("إعدادات النظام", "System settings")}<span className="tl-sep">·</span>{L("للمدير فقط", "admins only")}</p>
        {failed ? <div className="hr-notice tone-danger" role="alert">{L("تعذّر التحميل.", "Could not load.")}</div> : !s ? <OpsLoading rows={4} /> : (
          <div data-testid="email-settings">
            <Sec title={L("مزوّد البريد", "Provider")} caption={L("يُضبط في متغيرات البيئة على الخادم؛ لا يظهر المفتاح ولا عنوان المرسِل هنا", "Set in the server's environment; the key and the sender address are never shown here")} testId="email-provider">
              <dl className="ss-kv is-wide">
                <dt>{L("الحالة", "Status")}</dt>
                <dd data-testid="email-provider-state">{s.configured ? <Dot tone="success">{L("مُعدّ", "Configured")} · {provider}</Dot> : <Dot tone="warning">{L("غير مُعدّ", "Not configured")}</Dot>}</dd>
                <dt>{L("نطاق المرسِل", "Sender domain")}</dt>
                <dd data-testid="email-sender-domain">{s.senderDomain ? <bdi dir="ltr" className="hr-num">{s.senderDomain}</bdi> : <span className="ss-muted">—</span>}</dd>
              </dl>
              {s.configured && s.provider === "resend" ? (
                <p className="tl-foot">{L("يجب أن يكون هذا النطاق موثّقًا في Resend حتى تصل الرسائل.", "This domain must be verified in Resend for mail to be delivered.")}</p>
              ) : null}
              {!s.configured ? (
                <div className="hr-notice tone-warning" role="status">{L("لا يوجد مزوّد بريد مُعدّ: التنبيهات تظهر داخل النظام فقط، ولا يُرسَل بريد.", "No e-mail provider is configured: alerts appear in the app only; no mail is sent.")}</div>
              ) : null}
              <p className="tl-foot" data-testid="email-to-automation">
                {L("تبي ترسل إيميلات للعملاء (عروض الأسعار)؟ ", "Want to e-mail customers (quotations)? ")}
                <Link href="/dashboard/automation/whatsapp">{L("رسائل العملاء التلقائية ← إعدادات الإرسال", "Automated customer messages → Sending settings")}</Link>
              </p>
            </Sec>

            <Sec title={L("إرسال رسائل نموذجية", "Send demo e-mails")} caption={L("أربع رسائل ببيانات وهمية إلى عنوان واحد: اختبار الربط، وعرض سعر، وفاتورة نموذجية، وتذكير بالسداد — مع ملفات PDF", "Four e-mails with mock data to one address: a connection test, a quotation, a demo invoice and a payment reminder — with PDFs")} testId="email-demo">
              <form className="ss-setrow" noValidate onSubmit={send}>
                <Field label={L("المستلم", "Recipient")} error={fieldError} help={L("عنوان واحد فقط · لا تُنشأ فواتير ولا عروض ولا قيود", "One address only · no invoice, quotation or entry is created")}>
                  <input className="hr-input" type="email" dir="ltr" inputMode="email" autoComplete="email" value={to} placeholder="name@example.com"
                    onChange={(e) => setTo(e.target.value)} onBlur={() => setTouched(true)} aria-invalid={!!fieldError} data-testid="email-test-to" />
                </Field>
                <div className="tl-acts" style={{ paddingBottom: 22 }}>
                  <Btn type="submit" variant="primary" busy={busy} disabled={!valid || s.limit.remaining === 0} data-testid="email-test-send">{L("إرسال الرسائل النموذجية", "Send the demo e-mails")}</Btn>
                </div>
              </form>
              <p className="tl-foot" data-testid="email-test-limit">
                {L(`يطلب تأكيد الهوية · ${s.limit.runs} مرات في الساعة كحد أقصى · المتبقي ${s.limit.remaining}`, `Asks you to confirm your identity · at most ${s.limit.runs} runs an hour · ${s.limit.remaining} left`)}
              </p>
              {err ? <div className="hr-notice tone-danger" role="alert" data-testid="email-test-error">{err}</div> : null}
              {results ? (
                <div role="status" data-testid="email-test-results">
                  <table className="hr-table">
                    <thead><tr><th>{L("الرسالة", "E-mail")}</th><th>{L("الحالة", "Status")}</th></tr></thead>
                    <tbody>
                      {results.map((r) => (
                        <tr key={r.kind} data-testid={`email-result-${r.kind}`}>
                          <td><span className="strong">{L(KIND[r.kind]?.[0] ?? r.kind, KIND[r.kind]?.[1] ?? r.kind)}</span><span className="ss-sub">{r.subject}</span></td>
                          <td><Dot tone={STATUS[r.status][2]}>{L(STATUS[r.status][0], STATUS[r.status][1])}</Dot></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : null}
            </Sec>
          </div>
        )}
      </SettingsFrame>
    </OpsRoot>
  );
}
