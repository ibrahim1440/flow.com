import { hrHandler } from "@/lib/hr/http";
import { readJson } from "@/lib/hr/core";
import { voidGosiInvoice } from "@/lib/hr/services/gosi";

export const POST = hrHandler(async ({ actor, request, params }) => voidGosiInvoice(actor, params.id, await readJson(request)));
