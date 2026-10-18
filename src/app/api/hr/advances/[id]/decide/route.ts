import { hrHandler } from "@/lib/hr/http";
import { readJson } from "@/lib/hr/core";
import { decideAdvance } from "@/lib/hr/services/advances";

export const POST = hrHandler(async ({ actor, request, params }) => decideAdvance(actor, params.id, await readJson(request)));
