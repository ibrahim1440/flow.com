import { hrHandler } from "@/lib/hr/http";
import { readJson } from "@/lib/hr/core";
import { cancelRun } from "@/lib/hr/services/payroll";

export const POST = hrHandler(async ({ actor, request, params, today }) => cancelRun(actor, params.id, await readJson(request), today));
