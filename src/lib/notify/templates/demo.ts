// The four demo e-mails of Settings › «البريد الإلكتروني» › «إرسال رسائل تجريبية» (feature/email-demo).
//
// Mock data only: a fictitious customer («مقهى الواحة للقهوة المختصة», الخبر), mock lines priced by the
// app's own helper (./pricing.ts → priceQuote, 15% VAT), mock numbers outside every series
// (Q-DEMO-0001, DEMO-INV-0001, DEMO-INV-0000). Nothing here reads or writes a quotation, an invoice, a
// counter, ZATCA state or a journal: the only real facts are the sender's own details (the Settings
// seller fields, passed in) and the clock. Every subject starts with «[تجريبي]».
import { renderConnectionTest } from "./connection-test";
import { renderInvoiceEmail } from "./invoice";
import { renderPaymentReminder } from "./payment-reminder";
import { priceDocument, type DocLineInput } from "./pricing";
import { renderQuotationEmail } from "./quotation";
import type { CompanyInfo, CustomerInfo, ConnectionTestInput, RenderedEmail } from "./types";

export const DEMO_CUSTOMER: CustomerInfo = {
  name: "مقهى الواحة للقهوة المختصة",
  contact: "أ. سلمان الدوسري",
  address: "الخبر 34423 · حي العقربية · شارع الأمير فيصل بن فهد · مبنى 4127",
  vatNumber: null,
};

export const DEMO_QUOTE_LINES: DocLineInput[] = [
  { description: "إثيوبيا يرقاشيفي 1كغ", skuCode: "DEMO-ETH-YRG-1KG", quantity: "5", unit: "UNIT", unitPrice: "145.00", taxRatePercent: "15" },
  { description: "كولومبيا هويلا 1كغ", skuCode: "DEMO-COL-HUI-1KG", quantity: "3", unit: "UNIT", unitPrice: "128.00", taxRatePercent: "15" },
  { description: "خلطة الإسبريسو 1كغ", skuCode: "DEMO-ESP-BLD-1KG", quantity: "10", unit: "UNIT", unitPrice: "96.50", taxRatePercent: "15" },
];

const OVERDUE_LINES: DocLineInput[] = [
  { description: "خلطة الإسبريسو 1كغ", quantity: "12", unit: "UNIT", unitPrice: "96.50", taxRatePercent: "15" },
  { description: "إثيوبيا يرقاشيفي 1كغ", quantity: "4", unit: "UNIT", unitPrice: "145.00", taxRatePercent: "15" },
];

export const DEMO_NUMBERS = { quote: "Q-DEMO-0001", invoice: "DEMO-INV-0001", overdueInvoice: "DEMO-INV-0000" } as const;
export const DEMO_KINDS = ["connection_test", "quotation", "invoice", "payment_reminder"] as const;
export type DemoKind = (typeof DEMO_KINDS)[number];

const DAY = 86_400_000;
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * DAY);
const money = (n: number) => n.toFixed(2);

export type DemoContext = {
  company: CompanyInfo;
  now: Date;
  environment: ConnectionTestInput["environment"];
  senderDomain: string | null;
};

/** The four demo e-mails, in sending order. Pure: the same context renders the same mails. */
export function buildDemoEmails(ctx: DemoContext): { kind: DemoKind; email: RenderedEmail }[] {
  const { company, now } = ctx;
  const quotePriced = priceDocument(DEMO_QUOTE_LINES);
  const overdue = priceDocument(OVERDUE_LINES);
  const invoiceDate = addDays(now, -42);
  const dueDate = addDays(now, -12);
  const firstPayment = 1000;
  const secondPayment = 400;
  const total = Number(overdue.grandTotal);
  const balance = total - firstPayment - secondPayment;
  return [
    { kind: "connection_test", email: renderConnectionTest({ demo: true, company, sentAt: now, environment: ctx.environment, senderDomain: ctx.senderDomain }) },
    {
      kind: "quotation",
      email: renderQuotationEmail({
        demo: true, company, customer: DEMO_CUSTOMER, quoteNumber: DEMO_NUMBERS.quote, revision: 1,
        issueDate: now, validUntil: addDays(now, 15), validityDays: 15, priced: quotePriced,
        notes: "الأسعار تشمل التحميص حسب الطلب والتعبئة في أكياس بصمام. التسليم خلال 3 أيام عمل من اعتماد العرض داخل الخبر والدمام.",
      }),
    },
    {
      kind: "invoice",
      email: renderInvoiceEmail({
        demo: true, company, customer: DEMO_CUSTOMER, invoiceNumber: DEMO_NUMBERS.invoice,
        issueDate: now, supplyDate: now, dueDate: addDays(now, 30), paymentTermsDays: 30, priced: quotePriced,
      }),
    },
    {
      kind: "payment_reminder",
      email: renderPaymentReminder({
        demo: true, company, customer: DEMO_CUSTOMER, invoiceNumber: DEMO_NUMBERS.overdueInvoice,
        invoiceDate, dueDate, daysOverdue: 12, invoiceTotal: overdue.grandTotal, paid: money(firstPayment + secondPayment), balance: money(balance), asOf: now,
        statement: [
          { date: invoiceDate, reference: DEMO_NUMBERS.overdueInvoice, description: "فاتورة توريد — خلطة الإسبريسو وإثيوبيا يرقاشيفي", debit: overdue.grandTotal, credit: "0", balance: money(total) },
          { date: addDays(now, -20), reference: "DEMO-RCV-0101", description: "سداد جزئي — تحويل بنكي", debit: "0", credit: money(firstPayment), balance: money(total - firstPayment) },
          { date: addDays(now, -5), reference: "DEMO-RCV-0117", description: "سداد جزئي — تحويل بنكي", debit: "0", credit: money(secondPayment), balance: money(balance) },
        ],
      }),
    },
  ];
}

/** The sender as the e-mails name it, from the seller particulars (SellerSnapshot of invoicing/settings). */
export function companyInfoFrom(s: {
  name: string | null; nameEn: string | null; vatNumber: string | null; crNumber: string | null; phone: string | null; address: string | null;
  city?: string | null; postalCode?: string | null; district?: string | null; street?: string | null; buildingNo?: string | null;
  bank: { name: string | null; accountName: string | null; iban: string | null };
}): CompanyInfo {
  const ar = s.name?.trim() || "";
  const en = s.nameEn?.trim() || "";
  const structured = [[s.city, s.postalCode].filter(Boolean).join(" "), s.district ? `حي ${s.district}` : null, s.street || null, s.buildingNo ? `مبنى ${s.buildingNo}` : null]
    .filter((x): x is string => !!x && x.trim() !== "");
  const t = (v: string | null | undefined) => v?.trim() || null;
  return {
    nameAr: ar || en || "حقبة",
    nameEn: en || ar || "Hiqbah",
    legal: !!(ar || en),
    phone: t(s.phone),
    vatNumber: t(s.vatNumber),
    crNumber: t(s.crNumber),
    address: structured.length ? structured.join(" · ") : t(s.address),
    bank: { name: t(s.bank.name), accountName: t(s.bank.accountName), iban: t(s.bank.iban) },
  };
}
