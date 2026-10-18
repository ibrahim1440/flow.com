import { hrHandler } from "@/lib/hr/http";
import { readJson } from "@/lib/hr/core";
import { proposeGosiSettlement } from "@/lib/hr/services/gosi";

// P-2 finding 4: propose how a difference is settled; another person decides.
export const POST = hrHandler(async ({ actor, request, params }) => proposeGosiSettlement(actor, params.id, await readJson(request)), { status: 202 });
