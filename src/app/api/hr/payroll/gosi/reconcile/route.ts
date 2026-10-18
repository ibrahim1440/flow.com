import { hrHandler } from "@/lib/hr/http";
import { gosiReconciliation } from "@/lib/hr/services/gosi";

// P-2 finding 4: read-only — invoice vs payroll per person, share and period.
export const GET = hrHandler(async ({ actor, query }) => gosiReconciliation(actor, query.get("month") ?? ""));
