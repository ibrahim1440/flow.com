"use client";
// HR settings › «تنبيهات انتهاء الوثائق» (feat/hr-expiry-email; hr › policy_manage): the days before an
// expiry at which the daily check notifies, the last run, and «تشغيل الآن». The check itself runs every
// day at 06:00 Riyadh (Vercel Cron) and is idempotent: running it now never notifies anyone twice.
import { useState } from "react";
import { Btn, ErrorState, Field, KV, LoadingTable, Notice, dateTimeIn, hrFetch, useAction, useHr, useHrI18n } from "@/components/hr/ui";

type Settings = { thresholds: number[]; defaults: number[]; lastRun: { state: string; at: string } | null; emailConfigured: boolean; cronSecretConfigured: boolean };
type Report = { day: string; checked: number; due: number; notified: { hr: number; me: number }; failed: number; emails: number };

export function ExpiryAlerts() {
  const q = useHr<Settings>("/api/hr/document-expiry/settings");
  const { L } = useHrI18n();
  const [draft, setDraft] = useState<string | null>(null);
  const [report, setReport] = useState<Report | null>(null);
  const [saved, setSaved] = useState(false);
  const act = useAction();
  if (q.error) return <ErrorState error={q.error} onRetry={q.reload} />;
  if (!q.data) return <LoadingTable rows={3} />;
  const s = q.data;
  const value = draft ?? s.thresholds.join("، ");
  const save = () => act.run("save", async () => {
    await hrFetch("/api/hr/document-expiry/settings", { method: "PUT", json: { thresholds: value } });
    setDraft(null);
    setSaved(true);
    q.reload();
  });
  const run = () => act.run("run", async () => {
    setReport(await hrFetch<Report>("/api/hr/document-expiry/run", { json: {} }));
    q.reload();
  });
  return (
    <section className="hr-stack" data-testid="hr-expiry-settings" style={{ gap: 12 }}>
      <span className="hr-section">{L("تنبيهات انتهاء الوثائق", "Document expiry alerts")}</span>
      <p className="hr-caption" style={{ margin: 0 }}>
        {L(
          "يفحص النظام كل يوم الساعة 6:00 صباحًا بتوقيت الرياض تواريخ انتهاء مستندات الموظفين والهوية أو الإقامة والعقود محددة المدة، ويُنبّه الموظف نفسه (عدا العقد) ومن يملك صلاحية الموارد البشرية المعنية في نطاقه، عند كل يوم من أيام التنبيه، ثم «منتهية» يوم الانتهاء وكل أسبوع بعده. لا يتكرر التنبيه للمستند نفسه في اليوم نفسه.",
          "Every day at 06:00 Riyadh the system checks the expiry dates of employee documents, the ID or iqama and fixed-term contracts, and notifies the employee (except for the contract) and the holders of the relevant HR permission whose scope covers them, on each alert day, then «expired» on the date and weekly after. The same item is never notified twice for the same step.",
        )}
      </p>
      {act.error ? <Notice tone="danger">{act.error}</Notice> : null}
      {saved ? <Notice tone="success">{L("حُفظت أيام التنبيه.", "The alert days were saved.")}</Notice> : null}
      <div className="hr-form">
        <Field label={L("أيام التنبيه قبل الانتهاء", "Alert days before expiry")} help={L(`أرقام مفصولة بفواصل، من 1 إلى 365 (حتى 10 أيام). الافتراضي: ${s.defaults.join("، ")}`, `Numbers separated by commas, 1 to 365 (up to 10). Default: ${s.defaults.join(", ")}`)} wide>
          <input className="hr-input" dir="ltr" inputMode="numeric" value={value} onChange={(e) => { setDraft(e.target.value); setSaved(false); }} data-testid="hr-expiry-days" />
        </Field>
      </div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <Btn variant="primary" busy={act.busy === "save"} disabled={draft === null} onClick={save}>{L("حفظ", "Save")}</Btn>
        <Btn busy={act.busy === "run"} onClick={run} data-testid="hr-expiry-run">{L("تشغيل الآن", "Run now")}</Btn>
      </div>
      {report ? (
        <Notice tone="success">
          {L(
            `اكتمل الفحص (${report.day}): ${report.checked} عنصرًا قريبًا أو منتهيًا، ${report.due} مستحق التنبيه. تنبيهات جديدة: ${report.notified.hr} للموارد البشرية و${report.notified.me} للموظفين${report.failed ? `، وتعذّر ${report.failed}` : ""}.`,
            `Check done (${report.day}): ${report.checked} items near or past expiry, ${report.due} due. New notifications: ${report.notified.hr} to HR and ${report.notified.me} to employees${report.failed ? `, ${report.failed} failed` : ""}.`,
          )}
        </Notice>
      ) : null}
      <KV rows={[
        [L("آخر تشغيل", "Last run"), s.lastRun ? <span key="r" className="hr-num">{dateTimeIn(s.lastRun.at)} · {s.lastRun.state.includes(" cron ") ? L("مجدول", "scheduled") : L("يدوي", "manual")}</span> : L("لم يُشغَّل بعد", "Not run yet"), s.lastRun ? undefined : "muted"],
        [L("البريد الإلكتروني", "E-mail"), s.emailConfigured ? L("مفعّل: يُرسل لمن اختار البريد في تفضيلات التنبيهات", "On: sent to those who chose e-mail in their notification preferences") : L("البريد غير مفعّل بعد — تظهر التنبيهات داخل النظام فقط", "E-mail is not set up yet — notifications appear in the app only"), s.emailConfigured ? undefined : "warning"],
      ]} />
    </section>
  );
}
