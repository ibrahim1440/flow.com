import { hrHandler } from "@/lib/hr/http";
import { payslip } from "@/lib/hr/services/payroll";

export const GET = hrHandler(async ({ actor, params }) => payslip(actor, params.lineId));
