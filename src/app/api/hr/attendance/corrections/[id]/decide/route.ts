import { hrHandler } from "@/lib/hr/http";
import { readJson } from "@/lib/hr/core";
import { decideCorrection } from "@/lib/hr/services/attendance";

export const POST = hrHandler(async ({ actor, request, params }) => decideCorrection(actor, params.id, await readJson(request)));
