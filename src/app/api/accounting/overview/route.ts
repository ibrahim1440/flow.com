import { accountingRoute } from "@/lib/accounting/http";
import { overview } from "@/lib/accounting/reports";

export const GET = accountingRoute(null, () => overview());
