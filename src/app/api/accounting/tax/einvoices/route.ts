import { accountingRoute } from "@/lib/accounting/http";
import { eInvoiceList } from "@/lib/accounting/einvoice/service";

// Posted sales documents with their e-invoice (LOCAL validation only), generation job and last submission.
export const GET = accountingRoute(null, async () => eInvoiceList());
