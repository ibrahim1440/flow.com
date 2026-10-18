import { hrHandler } from "@/lib/hr/http";
import { bookGosiSettlement } from "@/lib/hr/services/gosi";

// P-2 rev3 item 3: book an approved decision once its D-4h treatment is enabled (never twice).
export const POST = hrHandler(async ({ actor, params, today }) => bookGosiSettlement(actor, params.id, today));
