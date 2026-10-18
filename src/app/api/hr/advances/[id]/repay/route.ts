import { hrHandler } from "@/lib/hr/http";
import { readJson } from "@/lib/hr/core";
import { repayAdvance } from "@/lib/hr/services/advances";

export const POST = hrHandler(async ({ actor, request, params }) => repayAdvance(actor, params.id, await readJson(request)));
