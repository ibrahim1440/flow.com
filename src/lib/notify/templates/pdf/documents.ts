// The three documents an e-mail can attach (feature/email-demo), as the A4 sheet of ./sheet.ts:
//
//   * quotationPdf  — the quotation, laid out as the printed one (app/dashboard/sales/quotes/[id]/print:
//                     «عرض سعر», revision, number, validity, customer, the eight columns of
//                     quoteLineColumns / quoteLineCells, subtotal → discount → taxable → VAT → total,
//                     notes, bank details, footer «المبالغ بالريال السعودي…»);
//   * invoicePdf    — the tax-invoice layout (app/dashboard/sales/invoices/[id]/print, invoiceColumns /
//                     invoiceCells) in its UNISSUED modes only — "draft" (the print page's draft banner
//                     and watermark) or "demo" («فاتورة تجريبية — ليست فاتورة ضريبية»). It never draws a
//                     QR code and never reads or writes an invoice number series, ICV or PIH: an issued
//                     invoice prints from its frozen snapshot with its stored QR, which is the print
//                     page's job, not this module's;
//   * statementPdf  — a short statement of account («كشف حساب»): dated movements with a running balance.
//
// Every figure arrives priced (./types.ts, ./pricing.ts); these functions only lay it out.
import { formatMoney } from "@/lib/format/money";
import { formatIban, formatPercent, longDate, quoteLineCells, quoteLineColumns, uniformTaxRate, type QuoteDocLine } from "@/lib/print/quote-document";
import { amount, invoiceCells, invoiceColumns, legalLine, type InvoicePrintLine } from "@/lib/print/invoice-document";
import { renderSheetPdf, type SheetColumn, type SheetInput, type SheetRow } from "./sheet";
import type { CompanyInfo, CustomerInfo, InvoiceEmailInput, PaymentReminderInput, QuoteEmailInput } from "../types";

export const DEMO_WATERMARK = "نموذج تجريبي";
export const DEMO_INVOICE_MARK = "فاتورة تجريبية — ليست فاتورة ضريبية";

/** Column widths (pt) of the eight-column lines table; the description takes the rest. */
const LINE_WIDTHS: Record<string, number> = { index: 16, quantity: 50, unitPrice: 56, discount: 46, beforeTax: 60, net: 60, tax: 52, vat: 52, total: 64 };
const cols = (c: { key: string; label: string; numeric: boolean; muted?: boolean }[]): SheetColumn[] => c.map((x) => ({ ...x, width: LINE_WIDTHS[x.key] }));

function sellerBlock(c: CompanyInfo): SheetInput["seller"] {
  const lines = [c.address, c.vatNumber ? `الرقم الضريبي ${c.vatNumber}` : null, c.crNumber ? `السجل التجاري ${c.crNumber}` : null].filter((x): x is string => !!x);
  return { name: c.nameAr, lines };
}

function bankRows(c: CompanyInfo): SheetRow[] {
  const rows: (SheetRow | null)[] = [
    c.bank.name ? { label: "البنك", value: c.bank.name } : null,
    c.bank.accountName ? { label: "اسم الحساب", value: c.bank.accountName } : null,
    // The IBAN line only when one is set (owner: «if the IBAN is empty, omit that line»).
    c.bank.iban ? { label: "رقم الآيبان", value: formatIban(c.bank.iban), mono: true } : null,
  ];
  return rows.filter((x): x is SheetRow => !!x);
}

function customerRows(cu: CustomerInfo, label = "العميل"): SheetRow[] {
  const rows: (SheetRow | null)[] = [
    { label, value: cu.name },
    cu.contact ? { label: "عناية", value: cu.contact } : null,
    cu.address ? { label: "العنوان", value: cu.address } : null,
    cu.vatNumber ? { label: "الرقم الضريبي", value: cu.vatNumber, mono: true, muted: true } : null,
  ];
  return rows.filter((x): x is SheetRow => !!x);
}

const plainCells = (cells: { main: string; sub?: string | null }[]) => cells.map((c) => ({ main: c.main, sub: c.sub ?? null }));

export function quotationPdf(q: QuoteEmailInput): Buffer {
  const lines: QuoteDocLine[] = q.priced.lines.map((l, i) => ({
    position: i + 1, skuCode: l.skuCode, name: l.description, nameAr: l.description, description: l.description,
    quantity: l.quantity, unit: l.unit, unitPrice: l.unitPrice, discountPercent: l.discountPercent, taxRatePercent: l.taxRatePercent,
    gross: l.gross, discountAmount: l.discountAmount, lineSubtotal: l.lineSubtotal, lineTax: l.lineTax, lineTotal: l.lineTotal,
  }));
  const vat = uniformTaxRate(lines);
  const totals = [
    { label: "المجموع قبل الخصم", value: formatMoney(q.priced.subtotal) },
    ...(Number(q.priced.discountTotal) > 0 ? [{ label: `الخصم ${formatPercent(q.priced.effectiveDiscountPercent)}`, value: `−${formatMoney(q.priced.discountTotal)}` }] : []),
    { label: "الوعاء الخاضع للضريبة", value: formatMoney(q.priced.taxable) },
    { label: `ضريبة القيمة المضافة${vat ? ` ${vat}` : ""}`, value: formatMoney(q.priced.taxTotal) },
    { label: "الإجمالي شامل الضريبة · ر.س", value: formatMoney(q.priced.grandTotal), grand: true },
  ];
  const bank = bankRows(q.company);
  return renderSheetPdf({
    info: { title: `عرض سعر ${q.quoteNumber}`, subject: q.demo ? DEMO_WATERMARK : "Quotation" },
    seller: sellerBlock(q.company),
    title: { main: "عرض سعر", lines: [`المراجعة ${q.revision}`, "Quotation"] },
    banner: q.demo ? { tone: "warning", title: "نموذج تجريبي", text: "نسخة تجريبية لاختبار البريد الإلكتروني، وليست عرض سعر صادرًا. الأسعار والبيانات للعرض فقط." } : null,
    watermark: q.demo ? DEMO_WATERMARK : null,
    metaStart: [
      { label: "رقم العرض", value: `${q.quoteNumber} · ${q.demo ? "تجريبي" : "صادر"}` },
      { label: "تاريخ الإصدار", value: longDate(q.issueDate, "ar") },
      { label: "صالح حتى", value: `${longDate(q.validUntil, "ar")} (${q.validityDays} يومًا)` },
    ],
    metaEnd: customerRows(q.customer),
    columns: cols(quoteLineColumns("ar")),
    rows: lines.map((l, i) => plainCells(quoteLineCells(l, i + 1, "ar"))),
    totals,
    notes: q.notes ? { label: "ملاحظات", text: q.notes } : null,
    bank: bank.length ? { label: "بيانات التحويل البنكي", rows: bank } : null,
    footer: {
      legal: vat ? `المبالغ بالريال السعودي. ضريبة القيمة المضافة ${vat} على كل سطر بعد الخصم.` : "المبالغ بالريال السعودي. ضريبة القيمة المضافة على كل سطر بعد الخصم.",
      status: q.demo ? "نموذج تجريبي" : "صادر",
      docNumber: q.quoteNumber,
    },
  });
}

export type InvoicePdfMode = "draft" | "demo";

export function invoicePdf(inv: InvoiceEmailInput, mode: InvoicePdfMode): Buffer {
  const lines: InvoicePrintLine[] = inv.priced.lines.map((l) => ({
    description: l.description, descriptionEn: null, skuCode: l.skuCode, quantity: l.quantity, unit: l.unit, unitPrice: l.unitPrice,
    discountAmount: l.discountAmount, discountPercent: l.discountPercent, taxCategory: "S", taxRatePercent: l.taxRatePercent,
    lineNet: l.lineSubtotal, lineTax: l.lineTax, lineTotal: l.lineTotal,
  }));
  const rate = uniformTaxRate(inv.priced.lines.map((l) => ({ taxRatePercent: l.taxRatePercent })));
  const bank = bankRows(inv.company);
  const demo = mode === "demo";
  return renderSheetPdf({
    info: { title: `${demo ? "فاتورة تجريبية" : "مسودة فاتورة"} ${inv.invoiceNumber}`, subject: demo ? DEMO_INVOICE_MARK : "Draft — not a tax invoice" },
    seller: sellerBlock(inv.company),
    // Not «فاتورة ضريبية»: an unissued document must not title itself a tax invoice.
    title: { main: demo ? "فاتورة تجريبية" : "مسودة فاتورة", lines: [demo ? "Demo invoice — not a tax invoice" : "Draft — not a tax invoice"] },
    banner: demo
      ? { tone: "danger", title: DEMO_INVOICE_MARK, text: "نموذج لاختبار البريد الإلكتروني فقط: لا رمز QR، ولا رقم من سلسلة الفواتير، ولم تُرسَل إلى هيئة الزكاة والضريبة والجمارك، ولا أثر لها في الحسابات." }
      : { tone: "warning", title: "مسودة — ليست فاتورة ضريبية", text: "مسودة غير صادرة: لا رقم ولا رمز QR، ولا تُسلَّم للعميل. يُعطى الرقم عند الإصدار." },
    watermark: demo ? DEMO_INVOICE_MARK : "مسودة — ليست فاتورة ضريبية",
    metaStart: [
      { label: "رقم المستند", value: inv.invoiceNumber },
      { label: "تاريخ الإصدار", value: longDate(inv.issueDate, "ar") },
      { label: "تاريخ التوريد", value: longDate(inv.supplyDate, "ar") },
      { label: "تاريخ الاستحقاق", value: `${longDate(inv.dueDate, "ar")} · صافي ${inv.paymentTermsDays} يومًا` },
    ],
    metaEnd: customerRows(inv.customer, "المشتري"),
    columns: cols(invoiceColumns("ar")),
    rows: lines.map((l, i) => plainCells(invoiceCells(l, i + 1, "ar"))),
    totals: [
      { label: "الإجمالي قبل الضريبة", value: amount(inv.priced.taxable) },
      { label: `ضريبة القيمة المضافة ${rate ?? ""}`.trim(), value: amount(inv.priced.taxTotal) },
      { label: "الإجمالي شامل الضريبة · ر.س", value: amount(inv.priced.grandTotal), grand: true },
    ],
    bank: bank.length ? { label: "بيانات التحويل البنكي", rows: bank } : null,
    footer: { legal: legalLine("ar", true), status: demo ? "نموذج تجريبي — ليست فاتورة ضريبية" : "مسودة", docNumber: inv.invoiceNumber },
  });
}

export function statementPdf(r: PaymentReminderInput): Buffer {
  const columns: SheetColumn[] = [
    { key: "date", label: "التاريخ", numeric: false, width: 92 },
    { key: "reference", label: "المرجع", numeric: false, width: 92 },
    { key: "description", label: "البيان", numeric: false },
    { key: "debit", label: "مدين", numeric: true, width: 66 },
    { key: "credit", label: "دائن", numeric: true, width: 66 },
    { key: "balance", label: "الرصيد", numeric: true, width: 72 },
  ];
  const dash = (v: string) => (Number(v) > 0 ? formatMoney(v) : "—");
  const bank = bankRows(r.company);
  const number = `${r.demo ? "DEMO-SOA" : "SOA"}-${r.asOf.toISOString().slice(0, 10)}`;
  return renderSheetPdf({
    info: { title: `كشف حساب ${r.customer.name}`, subject: r.demo ? DEMO_WATERMARK : "Statement of account" },
    seller: sellerBlock(r.company),
    title: { main: "كشف حساب", lines: [`حتى ${longDate(r.asOf, "ar")}`, "Statement of account"] },
    banner: { tone: "danger", title: `فاتورة متأخرة ${r.daysOverdue} يومًا`, text: `الفاتورة ${r.invoiceNumber} استحقت في ${longDate(r.dueDate, "ar")}، والمتبقي منها ${formatMoney(r.balance)} ر.س.` },
    watermark: r.demo ? DEMO_WATERMARK : null,
    metaStart: [
      { label: "رقم الكشف", value: number },
      { label: "تاريخ الكشف", value: longDate(r.asOf, "ar") },
    ],
    metaEnd: customerRows(r.customer),
    columns,
    rows: r.statement.map((l) => [
      { main: longDate(l.date, "ar").replace(/^\S+\s/, "") },
      { main: l.reference },
      { main: l.description },
      { main: dash(l.debit) },
      { main: dash(l.credit) },
      { main: formatMoney(l.balance) },
    ]),
    totals: [
      { label: "إجمالي الفاتورة", value: formatMoney(r.invoiceTotal) },
      { label: "المسدَّد", value: `−${formatMoney(r.paid)}` },
      { label: "الرصيد المستحق · ر.س", value: formatMoney(r.balance), grand: true },
    ],
    bank: bank.length ? { label: "بيانات التحويل البنكي", rows: bank } : null,
    footer: { legal: "المبالغ بالريال السعودي. الرصيد بعد آخر حركة مسجّلة حتى تاريخ الكشف.", status: r.demo ? "نموذج تجريبي" : null, docNumber: number },
  });
}
