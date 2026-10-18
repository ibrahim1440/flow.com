import { hrHandler } from "@/lib/hr/http";
import { deferralReport } from "@/lib/hr/services/advance-recovery";

// P-2 finding 2: read-only — disbursed advances with deferred, overdue, held or escalated installments.
export const GET = hrHandler(async ({ actor, today }) => deferralReport(actor, today));
