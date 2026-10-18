import { hrHandler } from "@/lib/hr/http";
import { readJson } from "@/lib/hr/core";
import { cancelSeparation } from "@/lib/hr/services/workforce";

export const POST = hrHandler(async ({ actor, request, params }) => cancelSeparation(actor, params.id, await readJson(request)));
