import { hrHandler } from "@/lib/hr/http";
import { payrollControlsReport } from "@/lib/hr/services/payroll-controls";

// P-2 / E-3, E-4: read-only journal integrity + reconciliation of every approved / paid / cancelled run.
export const GET = hrHandler(async ({ actor }) => payrollControlsReport(actor));
