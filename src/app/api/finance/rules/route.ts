import { financeHandler } from "@/lib/finance/server/http";
import { prisma } from "@/lib/db";
import { readJson } from "@/lib/finance/server/context";
import { listRuleVersions, saveRuleDraft } from "@/lib/finance/server/allocation";

export const GET = financeHandler(undefined, ({ scope }) => listRuleVersions(prisma, scope));

export const POST = financeHandler("budget_prepare", async ({ actor, scope, request }) => saveRuleDraft(actor, scope, await readJson(request)), 201);
