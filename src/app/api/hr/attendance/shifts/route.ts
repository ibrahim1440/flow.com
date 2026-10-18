import { hrHandler } from "@/lib/hr/http";
import { readJson } from "@/lib/hr/core";
import { createShift, listShifts } from "@/lib/hr/services/attendance";

export const GET = hrHandler(async ({  }) => listShifts());
export const POST = hrHandler(async ({ actor, request }) => createShift(actor, await readJson(request)), { status: 201 });
