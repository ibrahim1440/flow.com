import { hrHandler } from "@/lib/hr/http";
import { readJson } from "@/lib/hr/core";
import { interviewOutcome } from "@/lib/hr/services/recruitment";

export const POST = hrHandler(async ({ actor, request, params }) => interviewOutcome(actor, params.id, await readJson(request)));
