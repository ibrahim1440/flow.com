import { hrHandler } from "@/lib/hr/http";
import { readJson } from "@/lib/hr/core";
import { approveLines } from "@/lib/hr/services/payroll";

export const POST = hrHandler(async ({ actor, request, params }) => approveLines(actor, params.id, await readJson(request)));
