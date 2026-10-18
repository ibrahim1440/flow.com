import { hrHandler } from "@/lib/hr/http";
import { readJson } from "@/lib/hr/core";
import { confirmAllocations } from "@/lib/hr/services/payroll";

// P-2 rev3 item 2: the bank's per-employee credits of a recorded payment, entered by hand.
export const POST = hrHandler(async ({ actor, request, params }) => confirmAllocations(actor, params.id, await readJson(request)), { status: 201 });
