// «تذكير ودّي بسداد فاتورة مستحقة» (feature/email-demo): a polite reminder of an overdue invoice — how
// late, what is left, how to pay, whom to call — with a short statement of account as a PDF.
import { formatMoney } from "@/lib/format/money";
import { formatIban, longDate } from "@/lib/print/quote-document";
import { statementPdf } from "./pdf/documents";
import { callout, esc, kvTable, ltr, mailShell, para, subjectOf, textOf } from "./shell";
import { greeting } from "./quotation";
import type { PaymentReminderInput, RenderedEmail } from "./types";

export const PAYMENT_REMINDER_TEMPLATE = "customer-payment-reminder/v1";

export function renderPaymentReminder(r: PaymentReminderInput): RenderedEmail {
  const title = "تذكير ودّي بسداد فاتورة مستحقة";
  const money = (v: string) => `${ltr(formatMoney(v))} ر.س`;
  const b = r.company.bank;
  const contact = r.company.phone ? `على الرقم ${ltr(r.company.phone)} أو بالرد على هذه الرسالة` : "بالرد على هذه الرسالة";
  const body = [
    para(esc(greeting(r.customer.contact, r.customer.name))),
    para("تحية طيبة وبعد،"),
    para(`نودّ تذكيركم بلطف بأن الفاتورة رقم ${ltr(r.invoiceNumber, true)} الصادرة بتاريخ ${esc(longDate(r.invoiceDate, "ar"))} قد تجاوزت موعد استحقاقها بـ ${ltr(String(r.daysOverdue))} يومًا، وما زال المتبقي منها ${money(r.balance)}.`),
    kvTable([
      ["رقم الفاتورة", ltr(r.invoiceNumber, true)],
      ["تاريخ الاستحقاق", esc(longDate(r.dueDate, "ar"))],
      ["أيام التأخير", `${ltr(String(r.daysOverdue))} يومًا`],
      ["إجمالي الفاتورة", money(r.invoiceTotal)],
      ["المسدَّد", money(r.paid)],
      ["الرصيد المتبقي", `<span style="color:#b42318;font-size:16px">${money(r.balance)}</span>`],
    ]),
    b.iban || b.name ? callout(`للسداد بالتحويل البنكي${b.name ? `: ${esc(b.name)}` : ""}${b.accountName ? ` — ${esc(b.accountName)}` : ""}${b.iban ? `<br>رقم الآيبان ${ltr(formatIban(b.iban), true)}` : ""}<br>يُرجى ذكر رقم الفاتورة في بيان التحويل.`) : "",
    para(`أرفقنا لكم كشف حساب مختصرًا بالحركات. إن كنتم قد سددتم المبلغ مؤخرًا فنشكركم ونرجو تجاهل هذا التذكير، أو إرسال إشعار التحويل لنُحدّث السجل. ولأي ملاحظة على الفاتورة يسعدنا تواصلكم ${contact}.`),
    para("نقدّر تعاونكم الدائم، ونتطلع إلى استمرار شراكتنا."),
  ].filter(Boolean).join("\n");
  const pdf = statementPdf(r);
  return {
    version: PAYMENT_REMINDER_TEMPLATE,
    subject: subjectOf(`${title} — ${r.invoiceNumber}`, r.demo),
    html: mailShell({ title, eyebrow: esc(r.customer.name), company: r.company, demo: r.demo, body }),
    text: textOf([
      greeting(r.customer.contact, r.customer.name), "",
      `نودّ تذكيركم بلطف بأن الفاتورة رقم ${r.invoiceNumber} تجاوزت موعد استحقاقها (${longDate(r.dueDate, "ar")}) بـ ${r.daysOverdue} يومًا.`,
      `الرصيد المتبقي: ${formatMoney(r.balance)} ر.س (الإجمالي ${formatMoney(r.invoiceTotal)} · المسدَّد ${formatMoney(r.paid)})`,
      b.iban ? `رقم الآيبان: ${formatIban(b.iban)}` : null,
      "إن كنتم قد سددتم مؤخرًا فنرجو تجاهل هذا التذكير.",
      r.company.phone ? `للتواصل: ${r.company.phone}` : null,
    ], r.company, r.demo),
    attachments: [{ filename: `statement-${r.invoiceNumber}.pdf`, contentBase64: pdf.toString("base64"), contentType: "application/pdf" }],
  };
}
