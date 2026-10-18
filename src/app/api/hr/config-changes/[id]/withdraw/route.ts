import { hrHandler } from "@/lib/hr/http";
import { readJson } from "@/lib/hr/core";
import { withdrawConfigChange } from "@/lib/hr/services/config-change";

export const POST = hrHandler(async ({ actor, request, params }) => withdrawConfigChange(actor, params.id, await readJson(request)));
