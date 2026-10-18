import { hrHandler } from "@/lib/hr/http";
import { readJson } from "@/lib/hr/core";
import { addAdjustment } from "@/lib/hr/services/payroll";

export const POST = hrHandler(async ({ actor, request, params }) => addAdjustment(actor, params.id, await readJson(request)), { status: 201 });
