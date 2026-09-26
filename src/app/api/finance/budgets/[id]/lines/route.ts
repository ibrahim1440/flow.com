import { financeHandler } from "@/lib/finance/server/http";
import { prisma } from "@/lib/db";
import { readJson } from "@/lib/finance/server/context";
import { draftLines, saveDraftLines } from "@/lib/finance/server/budgets";

export const GET = financeHandler(undefined, ({ scope, params }) => draftLines(prisma, scope, params.id));

export const PUT = financeHandler("budget_prepare", async ({ actor, scope, request, params }) => saveDraftLines(actor, scope, params.id, await readJson(request)));
