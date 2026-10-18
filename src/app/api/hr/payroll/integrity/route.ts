import { hrHandler } from "@/lib/hr/http";
import { payrollIntegrity } from "@/lib/hr/services/integrity";

// F2: read-only integrity report (runs, payments and advances without journals; reconciliation; deferred installments).
export const GET = hrHandler(async ({ actor, today }) => payrollIntegrity(actor, today));
