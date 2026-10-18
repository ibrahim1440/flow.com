import { hrHandler } from "@/lib/hr/http";
import { overview } from "@/lib/hr/services/self";

// Self-service: any login. The subject is always the caller's own linked HR record.
export const GET = hrHandler(async ({ actor, now }) => overview(actor, now), { self: true });
