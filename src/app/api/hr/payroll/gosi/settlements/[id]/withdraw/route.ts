import { hrHandler } from "@/lib/hr/http";
import { readJson } from "@/lib/hr/core";
import { withdrawGosiSettlement } from "@/lib/hr/services/gosi";

export const POST = hrHandler(async ({ actor, request, params }) => withdrawGosiSettlement(actor, params.id, await readJson(request)));
