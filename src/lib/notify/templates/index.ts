// Customer and system e-mail templates (feature/email-demo). Typed inputs (./types), the house layout
// (./shell), PDFs drawn on the server (./pdf). Only the Settings demo route sends them today; nothing
// sends a quotation, invoice or reminder to a real customer automatically.
export * from "./types";
export { priceDocument, type DocLineInput } from "./pricing";
export { renderConnectionTest, CONNECTION_TEST_TEMPLATE } from "./connection-test";
export { renderQuotationEmail, QUOTATION_TEMPLATE } from "./quotation";
export { renderInvoiceEmail, INVOICE_TEMPLATE } from "./invoice";
export { renderPaymentReminder, PAYMENT_REMINDER_TEMPLATE } from "./payment-reminder";
export { DEMO_SUBJECT_PREFIX, DEMO_FOOTER_AR } from "./shell";
export { quotationPdf, invoicePdf, statementPdf, DEMO_INVOICE_MARK, DEMO_WATERMARK } from "./pdf/documents";
