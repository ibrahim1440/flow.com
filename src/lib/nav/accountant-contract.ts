/**
 * Addresses the accountant workspace (`./accountant`) links to and another builder's page answers (CHROME.md).
 *
 * «فواتير بسيطة» (Qoyod's simple bills): `?mode=expense` opens the simple-invoice form (BATCH22 WP-H: up to 5 expense
 * lines entered gross, the vendor of «مورد نقدي متنوع», the receipt attached, «مدفوعة من»); the sidebar item is the list.
 */
export const SIMPLE_BILL_PARAM = "mode";
export const SIMPLE_BILL_HREF = "/dashboard/purchases/invoices/new?mode=expense";
/** «فواتير بسيطة» (BATCH22 WP-H): the list — the purchase invoices of kind SIMPLE (GET /api/purchases/invoices?kind=SIMPLE). */
export const SIMPLE_BILL_LIST_HREF = "/dashboard/purchases?tab=invoices&kind=SIMPLE";
