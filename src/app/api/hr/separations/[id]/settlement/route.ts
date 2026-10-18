import { hrHandler } from "@/lib/hr/http";
import { readJson } from "@/lib/hr/core";
import { recordSettlement } from "@/lib/hr/services/workforce";

export const POST = hrHandler(async ({ actor, request, params }) => recordSettlement(actor, params.id, await readJson(request)));
