import { accountingRoute } from "@/lib/accounting/http";
import { closeBlockers } from "@/lib/accounting/fiscal-period-service";

export const GET = accountingRoute(null, ({ params }) => closeBlockers(params.id));
