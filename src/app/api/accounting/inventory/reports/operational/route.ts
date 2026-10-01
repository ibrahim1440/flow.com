import { accountingRoute } from "@/lib/accounting/http";
import { operationalAgreement } from "@/lib/accounting/inventory-reports";

export const GET = accountingRoute(null, () => operationalAgreement());
