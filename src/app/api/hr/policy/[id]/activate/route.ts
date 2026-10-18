import { hrHandler } from "@/lib/hr/http";
import { readJson } from "@/lib/hr/core";
import { activatePolicy } from "@/lib/hr/services/policy";

// `expected` = the fingerprint of the draft the approver reviewed; required over HTTP.
export const POST = hrHandler(async ({ actor, params, request }) => {
  const b = await readJson(request);
  return activatePolicy(actor, params.id, typeof b.expected === "string" ? b.expected : null);
});
