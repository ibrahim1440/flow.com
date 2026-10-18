import { hrHandler } from "@/lib/hr/http";
import { scanDeferrals } from "@/lib/hr/services/advance-recovery";

// P-2 finding 2: raise a review item for every advance deferred N times (N = policy).
export const POST = hrHandler(async ({ actor, today }) => scanDeferrals(actor, today));
