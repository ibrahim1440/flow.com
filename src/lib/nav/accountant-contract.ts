/**
 * Addresses the accountant workspace (`./accountant`) links to and another builder's page answers (CHROME.md).
 *
 * «فواتير بسيطة» (Qoyod's simple bills): the purchase-invoice form opened in EXPENSE mode — one expense line, the
 * expense-category picker, VAT on/off, the amount. The form (feat/qoyod-pages) reads `?mode=expense`; until it does,
 * the address opens the ordinary new purchase invoice, where an EXPENSE line can already be entered.
 */
export const SIMPLE_BILL_PARAM = "mode";
export const SIMPLE_BILL_HREF = "/dashboard/purchases/invoices/new?mode=expense";
