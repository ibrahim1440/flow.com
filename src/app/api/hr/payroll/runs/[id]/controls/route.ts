import { hrHandler } from "@/lib/hr/http";
import { getRunControls } from "@/lib/hr/services/payroll-controls";

// P-2 / E-4: one run's figures (items, lines, totals, payslips, export, journals, payments), read only.
export const GET = hrHandler(async ({ actor, params }) => getRunControls(actor, params.id));
