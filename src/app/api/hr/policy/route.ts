import { hrHandler } from "@/lib/hr/http";
import { readJson } from "@/lib/hr/core";
import { accountMap, createPolicy, listPolicies, settings } from "@/lib/hr/services/policy";
import { assertCan } from "@/lib/hr/core";
async function policyOverview(actor: Parameters<typeof assertCan>[0]) {
  assertCan(actor, "policy_manage");
  const [policies, map, s] = await Promise.all([listPolicies(), accountMap(), settings()]);
  return { policies, accountMap: map, settings: { accountingEnabled: s.accountingEnabled, updatedAt: s.updatedAt } };
}

export const GET = hrHandler(async ({ actor }) => policyOverview(actor));
export const POST = hrHandler(async ({ actor, request }) => createPolicy(actor, await readJson(request)), { status: 201 });
