import { hrHandler } from "@/lib/hr/http";
import { readJson } from "@/lib/hr/core";
import { updateDraftPolicy } from "@/lib/hr/services/policy";

// Edits a DRAFT version only, by its drafter; ACTIVE and RETIRED versions are refused (409).
export const PUT = hrHandler(async ({ actor, request, params }) => updateDraftPolicy(actor, params.id, await readJson(request)));
