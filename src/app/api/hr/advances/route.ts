import { hrHandler } from "@/lib/hr/http";
import { readJson } from "@/lib/hr/core";
import { listAdvances, requestAdvance } from "@/lib/hr/services/advances";

export const GET = hrHandler(async ({ actor, query }) => listAdvances(actor, { view: query.get("view") }));
export const POST = hrHandler(async ({ actor, request, today }) => requestAdvance(actor, await readJson(request), { today }), { status: 201 });
