import { hrHandler } from "@/lib/hr/http";
import { readJson } from "@/lib/hr/core";
import { requestOvertime } from "@/lib/hr/services/attendance";

export const POST = hrHandler(async ({ actor, request }) => requestOvertime(actor, await readJson(request)), { status: 201 });
