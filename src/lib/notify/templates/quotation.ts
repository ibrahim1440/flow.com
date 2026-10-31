// «عرض سعر» to the customer (feature/email-demo): a greeting to the contact, the offer in brief
// (number, validity, totals, the lines) and the quotation itself as a PDF attachment (./pdf/documents).
import { formatMoney } from "@/lib/format/money";
import { formatQuantity, longDate, unitLabel } from "@/lib/print/quote-document";
import { quotationPdf } from "./pdf/documents";
import { esc, kvTable, linesTable, ltr, mailShell, para, subjectOf, textOf } from "./shell";
import type { QuoteEmailInput, RenderedEmail } from "./types";

export const QUOTATION_TEMPLATE = "customer-quotation/v1";

export const greeting = (contact: string | null, name: string) => `السادة ${name}${contact ? `، عناية ${contact}` : ""} المحترمين،`;

export function renderQuotationEmail(q: QuoteEmailInput): RenderedEmail {
  const title = `عرض سعر ${q.quoteNumber}`;
  const money = (v: string) => `${ltr(formatMoney(v))} ر.س`;
  const rows = q.priced.lines.map((l) => [esc(l.description), `${ltr(formatQuantity(l.quantity))} ${esc(unitLabel(l.unit, "ar"))}`, ltr(formatMoney(l.unitPrice)), ltr(formatMoney(l.lineTotal))]);
  const body = [
    para(esc(greeting(q.customer.contact, q.customer.name))),
    para("السلام عليكم ورحمة الله وبركاته،"),
    para(`يسعدنا تزويدكم بعرض السعر رقم ${ltr(q.quoteNumber, true)} للأصناف التي طلبتموها، ونرفق لكم نسخته الكاملة بصيغة PDF. العرض صالح لمدة ${ltr(String(q.validityDays))} يومًا حتى ${esc(longDate(q.validUntil, "ar"))}.`),
    kvTable([
      ["رقم العرض", ltr(q.quoteNumber, true)],
      ["تاريخ العرض", esc(longDate(q.issueDate, "ar"))],
      ["صالح حتى", esc(longDate(q.validUntil, "ar"))],
      ["الإجمالي قبل الضريبة", money(q.priced.taxable)],
      ["ضريبة القيمة المضافة", money(q.priced.taxTotal)],
      ["الإجمالي شامل الضريبة", `<span style="color:#5c5c38;font-size:16px">${money(q.priced.grandTotal)}</span>`],
    ]),
    linesTable(
      [{ label: "الصنف" }, { label: "الكمية", numeric: true }, { label: "سعر الوحدة", numeric: true }, { label: "الإجمالي", numeric: true }],
      rows,
      [
        { label: "الإجمالي قبل الضريبة", value: ltr(formatMoney(q.priced.taxable)) },
        { label: "ضريبة القيمة المضافة 15%", value: ltr(formatMoney(q.priced.taxTotal)) },
        { label: "الإجمالي شامل الضريبة · ر.س", value: ltr(formatMoney(q.priced.grandTotal)), grand: true },
      ],
    ),
    q.replyable === false
      ? para(`لاعتماد العرض أو لأي استفسار تواصلوا معنا${q.company.phone ? ` على ${ltr(q.company.phone)}` : ` عن طريق مندوبكم${q.repName ? ` ${esc(q.repName)}` : ""}`}، وسنؤكد لكم موعد التحميص والتسليم.`)
      : para("لاعتماد العرض يكفي الرد على هذه الرسالة، وسنؤكد لكم موعد التحميص والتسليم. ولأي استفسار عن الأصناف أو الكميات يسعدنا التواصل معكم."),
    ...(q.repName ? [para(`مندوبكم: ${esc(q.repName)}`)] : []),
  ].join("\n");
  const pdf = quotationPdf(q);
  return {
    version: QUOTATION_TEMPLATE,
    subject: subjectOf(`عرض سعر ${q.quoteNumber} — ${q.company.nameAr}`, q.demo),
    html: mailShell({ title, eyebrow: esc(q.customer.name), company: q.company, demo: q.demo, body }),
    text: textOf([
      greeting(q.customer.contact, q.customer.name), "",
      `يسعدنا تزويدكم بعرض السعر رقم ${q.quoteNumber}، ونرفق نسخته بصيغة PDF.`,
      `صالح حتى: ${longDate(q.validUntil, "ar")} (${q.validityDays} يومًا)`,
      ...q.priced.lines.map((l) => `- ${l.description}: ${formatQuantity(l.quantity)} ${unitLabel(l.unit, "ar")} × ${formatMoney(l.unitPrice)} = ${formatMoney(l.lineTotal)} شامل الضريبة`),
      `الإجمالي قبل الضريبة: ${formatMoney(q.priced.taxable)} ر.س`,
      `ضريبة القيمة المضافة: ${formatMoney(q.priced.taxTotal)} ر.س`,
      `الإجمالي شامل الضريبة: ${formatMoney(q.priced.grandTotal)} ر.س`,
      "", q.replyable === false ? `لاعتماد العرض أو لأي استفسار تواصلوا معنا${q.company.phone ? ` على ${q.company.phone}` : ` عن طريق مندوبكم${q.repName ? ` ${q.repName}` : ""}`}.` : "لاعتماد العرض يكفي الرد على هذه الرسالة.",
      ...(q.repName ? [`مندوبكم: ${q.repName}`] : []),
    ], q.company, q.demo),
    attachments: [{ filename: `${q.quoteNumber}.pdf`, contentBase64: pdf.toString("base64"), contentType: "application/pdf" }],
  };
}
