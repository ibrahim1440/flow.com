import { hrHandler } from "@/lib/hr/http";
import { readJson } from "@/lib/hr/core";
import { importBankResults } from "@/lib/hr/services/payroll";

// P-2 rev3 item 2: the bank's RESULT file for a recorded payment (never the exported bank file).
export const POST = hrHandler(async ({ actor, request, params }) => importBankResults(actor, params.id, await readJson(request)), { status: 201 });
