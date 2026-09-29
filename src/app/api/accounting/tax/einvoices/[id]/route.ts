import { accountingRoute } from "@/lib/accounting/http";
import { eInvoiceDetail } from "@/lib/accounting/einvoice/service";

export const GET = accountingRoute(null, async ({ params }) => eInvoiceDetail(params.id));
