import { hrHandler } from "@/lib/hr/http";
import { readJson } from "@/lib/hr/core";
import { assignShift } from "@/lib/hr/services/attendance";

export const POST = hrHandler(async ({ actor, request, params }) => assignShift(actor, params.id, await readJson(request)), { status: 201 });
