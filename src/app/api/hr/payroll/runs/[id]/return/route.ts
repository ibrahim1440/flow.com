import { hrHandler } from "@/lib/hr/http";
import { readJson } from "@/lib/hr/core";
import { returnToDraft } from "@/lib/hr/services/payroll";

export const POST = hrHandler(async ({ actor, request, params }) => returnToDraft(actor, params.id, await readJson(request)));
