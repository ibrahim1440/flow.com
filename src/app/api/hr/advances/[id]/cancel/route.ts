import { hrHandler } from "@/lib/hr/http";
import { readJson } from "@/lib/hr/core";
import { cancelAdvance } from "@/lib/hr/services/advances";

export const POST = hrHandler(async ({ actor, request, params }) => cancelAdvance(actor, params.id, await readJson(request)));
