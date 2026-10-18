import { hrHandler } from "@/lib/hr/http";
import { createSettlement, settlementsForSeparation } from "@/lib/hr/services/final-settlement";

// P-2 finding 8: the financial settlement of a separation (separate from ending the employment).
export const GET = hrHandler(async ({ actor, params }) => settlementsForSeparation(actor, params.id));
export const POST = hrHandler(async ({ actor, params }) => createSettlement(actor, params.id), { status: 201 });
