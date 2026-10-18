import { hrHandler } from "@/lib/hr/http";
import { readJson } from "@/lib/hr/core";
import { manualDay } from "@/lib/hr/services/attendance";

export const POST = hrHandler(async ({ actor, request }) => manualDay(actor, await readJson(request)), { status: 201 });
