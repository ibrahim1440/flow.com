import { hrHandler } from "@/lib/hr/http";
import { readJson } from "@/lib/hr/core";
import { listRuns, prepareRun } from "@/lib/hr/services/payroll";

export const GET = hrHandler(async ({ actor }) => listRuns(actor));
export const POST = hrHandler(async ({ actor, request }) => prepareRun(actor, await readJson(request)), { status: 201 });
