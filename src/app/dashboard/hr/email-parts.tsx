"use client";
// HR e-mails (feat/hr-expiry-email): the shared parts of the «دعوة مقابلة» and «إشعار إنهاء الخدمة»
// dialogs — the rendered e-mail in a sandboxed frame (no script, no network: the e-mail has none), the
// «البريد غير مفعّل بعد» notice, the outcome and the sent log.
import { Notice, StatusDot, dateTimeIn, useHrI18n, type StatusEntry } from "@/components/hr/ui";

export type EmailLogRow = { id: string; at: string; by: string | null; status: string | null; to: string | null; version: string | null; channel: string | null };

export const EMAIL_STATUS: Record<string, StatusEntry> = {
  SENT: ["أُرسل", "success", "Sent"],
  FAILED: ["تعذّر الإرسال", "danger", "Failed"],
  NOT_CONFIGURED: ["البريد غير مفعّل بعد", "warning", "E-mail not set up yet"],
  NO_ADDRESS: ["لا يوجد بريد مسجّل", "warning", "No e-mail on record"],
};

export function EmailPreviewFrame({ html, title }: { html: string; title: string }) {
  return <iframe className="hr-email-preview" title={title} sandbox="" srcDoc={html} data-testid="hr-email-preview" />;
}

export function NotConfigured({ configured }: { configured: boolean }) {
  const { L } = useHrI18n();
  if (configured) return null;
  return (
    <Notice tone="warning">
      <span data-testid="hr-email-not-configured">{L("البريد غير مفعّل بعد", "E-mail is not set up yet")}</span>
      {L(" — المعاينة تعمل، وأي إرسال يُسجَّل في السجل دون أن يُرسل. يُفعَّل البريد بعد ضبط مزوّد الإرسال.", " — the preview works, and a send is recorded in the log without being sent. E-mail is turned on once the sending provider is configured.")}
    </Notice>
  );
}

export function EmailOutcome({ status }: { status: string }) {
  const { L } = useHrI18n();
  const tone = status === "SENT" ? "success" : status === "FAILED" ? "danger" : "warning";
  const text = status === "SENT" ? L("أُرسلت الرسالة.", "The e-mail was sent.")
    : status === "FAILED" ? L("تعذّر الإرسال. سُجّلت المحاولة؛ حاول لاحقًا.", "Sending failed. The attempt was recorded; try again later.")
    : status === "NOT_CONFIGURED" ? L("البريد غير مفعّل بعد: سُجّلت المحاولة ولم تُرسل الرسالة.", "E-mail is not set up yet: the attempt was recorded and nothing was sent.")
    : L("لا يوجد بريد مسجّل: سُجّلت المحاولة ولم تُرسل الرسالة.", "No e-mail on record: the attempt was recorded and nothing was sent.");
  return <Notice tone={tone}><span data-testid="hr-email-outcome" data-status={status}>{text}</span></Notice>;
}

export function EmailLog({ rows }: { rows: EmailLogRow[] }) {
  const { L, lang } = useHrI18n();
  if (!rows.length) return <span className="hr-caption">{L("لم يُرسل شيء بعد.", "Nothing sent yet.")}</span>;
  return (
    <ul className="hr-email-log" data-testid="hr-email-log">
      {rows.map((r) => (
        <li key={r.id}>
          <span className="hr-num">{dateTimeIn(r.at)}</span>
          {r.status ? <StatusDot map={EMAIL_STATUS} value={r.status} /> : null}
          {r.to ? <span className="hr-num" dir="ltr">{r.to}</span> : null}
          {r.channel === "company" ? <span className="hr-caption">{lang === "en" ? "company e-mail" : "بريد الشركة"}</span> : null}
          {r.by ? <span className="hr-caption">· {r.by}</span> : null}
        </li>
      ))}
    </ul>
  );
}
