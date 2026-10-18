import { hrHandler } from "@/lib/hr/http";
import { auditTrail } from "@/lib/hr/services/people";

export const GET = hrHandler(async ({ actor, params }) => auditTrail(actor, params.id));
