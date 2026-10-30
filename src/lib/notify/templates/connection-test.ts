// «تم ربط البريد بنجاح» — the connection test (feature/email-demo): proves the provider delivers, and
// says which notifications will use e-mail. No attachment.
import { esc, kvTable, mailShell, para, subjectOf, textOf, callout, ltr } from "./shell";
import type { ConnectionTestInput, RenderedEmail } from "./types";

export const CONNECTION_TEST_TEMPLATE = "email-connection-test/v1";

export const ENVIRONMENT_AR: Record<ConnectionTestInput["environment"], string> = { production: "الإنتاج", preview: "المعاينة", development: "التطوير المحلي" };

/** «الخميس 30 أكتوبر 2026، 2:05 م (بتوقيت الرياض)». */
export function riyadhTime(d: Date): string {
  return `${new Intl.DateTimeFormat("ar-SA-u-ca-gregory-nu-latn", { timeZone: "Asia/Riyadh", weekday: "long", day: "numeric", month: "long", year: "numeric", hour: "numeric", minute: "2-digit", hour12: true }).format(d)} (بتوقيت الرياض)`;
}

/** What e-mail is used for: today, and what a later batch adds. */
export const EMAIL_USES: { ar: string; later?: boolean }[] = [
  { ar: "تنبيهات انتهاء الوثائق والمستندات" },
  { ar: "رسائل الموارد البشرية (دعوات المقابلات وإشعارات إنهاء الخدمة)" },
  { ar: "تنبيهات مساحة التخزين" },
  { ar: "إرسال عروض الأسعار والفواتير إلى العملاء", later: true },
];

export function renderConnectionTest(i: ConnectionTestInput): RenderedEmail {
  const title = "تم ربط البريد بنجاح";
  const env = ENVIRONMENT_AR[i.environment];
  const uses = `<ul style="margin:0 0 16px;padding:0 20px 0 0;font-size:14.5px;line-height:2;color:#28241a">${EMAIL_USES.map((u) => `<li>${esc(u.ar)}${u.later ? ` <span style="color:#6e6a61;font-size:12.5px">(لاحقًا)</span>` : ""}</li>`).join("")}</ul>`;
  const body = [
    para("وصلتك هذه الرسالة لأن مزوّد البريد في نظام حقبة يعمل: أُرسلت من الخادم مباشرة، دون أي إعداد إضافي."),
    kvTable([
      ["وقت الإرسال", esc(riyadhTime(i.sentAt))],
      ["البيئة", esc(env)],
      ["نطاق المرسِل", i.senderDomain ? ltr(i.senderDomain) : "—"],
    ]),
    `<h2 style="margin:6px 0 6px;font-size:15px;font-weight:600;color:#28241a">ما الذي سيُرسَل بالبريد</h2>`,
    uses,
    callout("الرسائل الثلاث التالية في هذه الدفعة نماذج لما سيصل إلى العملاء: عرض سعر، وفاتورة، وتذكير بسداد مستحق — ببيانات وهمية."),
  ].join("\n");
  return {
    version: CONNECTION_TEST_TEMPLATE,
    subject: subjectOf(title, i.demo),
    html: mailShell({ title, eyebrow: "اختبار البريد الإلكتروني", company: i.company, demo: i.demo, body, signature: false }),
    text: textOf([
      title, "",
      "وصلتك هذه الرسالة لأن مزوّد البريد في نظام حقبة يعمل.",
      `وقت الإرسال: ${riyadhTime(i.sentAt)}`,
      `البيئة: ${env}`,
      i.senderDomain ? `نطاق المرسِل: ${i.senderDomain}` : null,
      "", "ما الذي سيُرسَل بالبريد:",
      ...EMAIL_USES.map((u) => `- ${u.ar}${u.later ? " (لاحقًا)" : ""}`),
    ], i.company, i.demo),
  };
}
