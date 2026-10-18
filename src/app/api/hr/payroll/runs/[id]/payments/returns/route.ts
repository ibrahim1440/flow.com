import { hrHandler } from "@/lib/hr/http";
import { readJson } from "@/lib/hr/core";
import { recordPaymentReturn } from "@/lib/hr/services/payroll";

// P-2 rev3 item 2: a credit the bank returned, or a part of a bulk payment it rejected.
export const POST = hrHandler(async ({ actor, request, params }) => recordPaymentReturn(actor, params.id, await readJson(request)), { status: 201 });
