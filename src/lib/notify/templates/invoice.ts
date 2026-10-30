// «فاتورة» to the customer (feature/email-demo): thanks, the amount due, the due date, the bank details
// (the IBAN line only when one is set) and the invoice as a PDF attachment. Only the unissued modes of
// the invoice PDF exist here (./pdf/documents invoicePdf: "demo" | "draft") — no QR, no number series,
// no ICV / PIH. Sending a real, issued invoice is a later batch that attaches the issued document.
import { formatMoney } from "@/lib/format/money";
import { formatIban, longDate } from "@/lib/print/quote-document";
import { DEMO_INVOICE_MARK, invoicePdf } from "./pdf/documents";
import { callout, esc, kvTable, ltr, mailShell, para, subjectOf, textOf } from "./shell";
import { greeting } from "./quotation";
import type { InvoiceEmailInput, RenderedEmail } from "./types";

export const INVOICE_TEMPLATE = "customer-invoice/v1";

export function renderInvoiceEmail(inv: InvoiceEmailInput): RenderedEmail {
  const title = inv.demo ? `فاتورة تجريبية ${inv.invoiceNumber}` : `فاتورة ${inv.invoiceNumber}`;
  const money = (v: string) => `${ltr(formatMoney(v))} ر.س`;
  const b = inv.company.bank;
  const bankRows: [string, string][] = [
    ...(b.name ? [["البنك", esc(b.name)] as [string, string]] : []),
    ...(b.accountName ? [["اسم الحساب", esc(b.accountName)] as [string, string]] : []),
    ...(b.iban ? [["رقم الآيبان", ltr(formatIban(b.iban), true)] as [string, string]] : []),
  ];
  const body = [
    para(esc(greeting(inv.customer.contact, inv.customer.name))),
    para(`نشكركم على ثقتكم وتعاملكم معنا. نرفق لكم الفاتورة رقم ${ltr(inv.invoiceNumber, true)} عن توريد الأصناف المتفق عليها بتاريخ ${esc(longDate(inv.supplyDate, "ar"))}.`),
    inv.demo ? callout(`<b>${esc(DEMO_INVOICE_MARK)}</b><br>هذا نموذج لاختبار البريد: بلا رمز QR، ولا رقم من سلسلة الفواتير، ولم يُرسَل إلى الهيئة.`, "warning") : "",
    kvTable([
      ["رقم الفاتورة", ltr(inv.invoiceNumber, true)],
      ["تاريخ الإصدار", esc(longDate(inv.issueDate, "ar"))],
      ["المبلغ المستحق", `<span style="color:#5c5c38;font-size:16px">${money(inv.priced.grandTotal)}</span>`],
      ["تاريخ الاستحقاق", `${esc(longDate(inv.dueDate, "ar"))} · صافي ${ltr(String(inv.paymentTermsDays))} يومًا`],
    ]),
    bankRows.length ? `<h2 style="margin:6px 0 6px;font-size:15px;font-weight:600;color:#28241a">بيانات التحويل البنكي</h2>${kvTable(bankRows)}` : "",
    para(`نرجو التكرم بالسداد في موعد الاستحقاق، وذكر رقم الفاتورة ${ltr(inv.invoiceNumber, true)} في بيان التحويل لتسهيل المطابقة.`),
  ].filter(Boolean).join("\n");
  const pdf = invoicePdf(inv, inv.demo ? "demo" : "draft");
  return {
    version: INVOICE_TEMPLATE,
    subject: subjectOf(`فاتورة ${inv.invoiceNumber} — ${inv.company.nameAr}`, inv.demo),
    html: mailShell({ title, eyebrow: esc(inv.customer.name), company: inv.company, demo: inv.demo, body }),
    text: textOf([
      greeting(inv.customer.contact, inv.customer.name), "",
      `نشكركم على تعاملكم معنا. نرفق الفاتورة رقم ${inv.invoiceNumber}.`,
      inv.demo ? DEMO_INVOICE_MARK : null,
      `المبلغ المستحق: ${formatMoney(inv.priced.grandTotal)} ر.س`,
      `تاريخ الاستحقاق: ${longDate(inv.dueDate, "ar")}`,
      b.name ? `البنك: ${b.name}` : null,
      b.accountName ? `اسم الحساب: ${b.accountName}` : null,
      b.iban ? `رقم الآيبان: ${formatIban(b.iban)}` : null,
    ], inv.company, inv.demo),
    attachments: [{ filename: `${inv.invoiceNumber}.pdf`, contentBase64: pdf.toString("base64"), contentType: "application/pdf" }],
  };
}
