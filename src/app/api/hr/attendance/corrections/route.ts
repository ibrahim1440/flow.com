import { hrHandler } from "@/lib/hr/http";
import { readJson } from "@/lib/hr/core";
import { requestCorrection } from "@/lib/hr/services/attendance";

export const POST = hrHandler(async ({ actor, request }) => requestCorrection(actor, await readJson(request), {}), { status: 201 });
