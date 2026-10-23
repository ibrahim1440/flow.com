import { hrHandler } from "@/lib/hr/http";
import { expiringForActor } from "@/lib/hr/services/document-expiry";

// «وثائق قريبة الانتهاء» (HR dashboard card): what the caller's duties and scope let them see.
export const GET = hrHandler(async ({ actor, now }) => expiringForActor(actor, now));
