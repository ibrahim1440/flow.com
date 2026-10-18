import { hrHandler } from "@/lib/hr/http";
import { balancesFor } from "@/lib/hr/services/leave";

export const GET = hrHandler(async ({ actor, params }) => balancesFor(actor, params.id));
