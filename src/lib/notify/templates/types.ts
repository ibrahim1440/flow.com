// Typed inputs of the customer e-mail templates (feature/email-demo). Pure: no database, no clock —
// the caller (today only the demo route, POST /api/settings/email/test) gathers the facts and hands
// them in; a later batch can hand in a real quotation, invoice or reminder the same way.
//
// Every amount is a plain decimal string («1234.50»), already priced by the app's own helper
// (priceQuote, lib/services/sales/quotes.ts — see ./pricing.ts). The templates print, they never
// compute a figure.

/** The sender, from Settings (SystemConfig seller fields); the product name when they are empty. */
export type CompanyInfo = {
  nameAr: string;
  nameEn: string;
  /** False when the seller fields are empty and the product name «حِقبة» stands in. */
  legal: boolean;
  phone: string | null;
  vatNumber: string | null;
  crNumber: string | null;
  address: string | null;
  bank: { name: string | null; accountName: string | null; iban: string | null };
};

/** The customer a document is addressed to. */
export type CustomerInfo = {
  name: string;
  /** The person the greeting names («أ. سلمان الدوسري»). */
  contact: string | null;
  address: string | null;
  vatNumber: string | null;
};

/** One priced document line (the shape of a quotation / invoice line). */
export type PricedDocLine = {
  description: string;
  skuCode: string | null;
  quantity: string;
  unit: "KG" | "UNIT";
  unitPrice: string;
  discountPercent: string;
  taxRatePercent: string;
  gross: string;
  discountAmount: string;
  lineSubtotal: string;
  lineTax: string;
  lineTotal: string;
};

export type PricedDocument = {
  lines: PricedDocLine[];
  subtotal: string;
  discountTotal: string;
  /** subtotal − discount: the base the VAT is charged on. */
  taxable: string;
  taxTotal: string;
  grandTotal: string;
  effectiveDiscountPercent: string;
};

export type EmailFile = { filename: string; contentBase64: string; contentType: string };
export type RenderedEmail = { subject: string; html: string; text: string; attachments?: EmailFile[]; version: string };

/** «[تجريبي]» on the subject, the demo watermark and the demo footer. */
export type DemoFlag = { demo: boolean };

export type ConnectionTestInput = DemoFlag & {
  company: CompanyInfo;
  sentAt: Date;
  environment: "production" | "preview" | "development";
  /** The sender domain only (never the address or the key). */
  senderDomain: string | null;
};

export type QuoteEmailInput = DemoFlag & {
  company: CompanyInfo;
  customer: CustomerInfo;
  quoteNumber: string;
  revision: number;
  issueDate: Date;
  validUntil: Date;
  validityDays: number;
  priced: PricedDocument;
  notes: string | null;
  /**
   * Fix round 1 (batch 25): false when a reply would reach nobody (no rep work e-mail, no «بريد الردود») — the e-mail
   * then never says «يكفي الرد على هذه الرسالة» and gives the contact line instead. Absent = true (the demo).
   */
  replyable?: boolean;
  /** Fix round 2: the rep who owns the deal, named in the e-mail (signature, and «تواصلوا مع مندوبكم …»). */
  repName?: string | null;
};

export type InvoiceEmailInput = DemoFlag & {
  company: CompanyInfo;
  customer: CustomerInfo;
  invoiceNumber: string;
  issueDate: Date;
  supplyDate: Date;
  dueDate: Date;
  paymentTermsDays: number;
  priced: PricedDocument;
};

export type StatementLine = {
  date: Date;
  reference: string;
  description: string;
  debit: string;
  credit: string;
  balance: string;
};

export type PaymentReminderInput = DemoFlag & {
  company: CompanyInfo;
  customer: CustomerInfo;
  invoiceNumber: string;
  invoiceDate: Date;
  dueDate: Date;
  daysOverdue: number;
  invoiceTotal: string;
  paid: string;
  balance: string;
  asOf: Date;
  statement: StatementLine[];
};
