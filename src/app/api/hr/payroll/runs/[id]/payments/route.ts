import { hrHandler } from "@/lib/hr/http";
import { readJson } from "@/lib/hr/core";
import { recordPayment } from "@/lib/hr/services/payroll";

export const POST = hrHandler(async ({ actor, request, params }) => recordPayment(actor, params.id, await readJson(request)), { status: 201 });
