import { hrHandler } from "@/lib/hr/http";
import { readJson } from "@/lib/hr/core";
import { addContributionRule } from "@/lib/hr/services/policy";

export const POST = hrHandler(async ({ actor, request, params }) => addContributionRule(actor, params.id, await readJson(request)), { status: 201 });
