import { accountingRoute } from "@/lib/accounting/http";
import { invoiceDraftFromOrder } from "@/lib/accounting/receivables-service";

export const GET = accountingRoute(null, ({ params }) => invoiceDraftFromOrder(params.orderId));
