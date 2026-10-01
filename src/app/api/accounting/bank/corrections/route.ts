import { accountingRoute, query } from "@/lib/accounting/http";
import { listBankCorrections } from "@/lib/accounting/bank-correction-service";

export const GET = accountingRoute(null, ({ request }) => listBankCorrections({ status: query(request).get("status") ?? undefined }));
