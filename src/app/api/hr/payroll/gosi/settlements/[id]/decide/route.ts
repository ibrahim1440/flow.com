import { hrHandler } from "@/lib/hr/http";
import { readJson } from "@/lib/hr/core";
import { decideGosiSettlement } from "@/lib/hr/services/gosi";

export const POST = hrHandler(async ({ actor, request, params, today }) => decideGosiSettlement(actor, params.id, await readJson(request), today));
