import { accountingRoute } from "@/lib/accounting/http";
import { bankMappings } from "@/lib/accounting/stage2-service";

export const GET = accountingRoute(null, () => bankMappings());
