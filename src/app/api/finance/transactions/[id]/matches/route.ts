import { financeHandler } from "@/lib/finance/server/http";
import { prisma } from "@/lib/db";
import { readJson } from "@/lib/finance/server/context";
import { addMatch, matchCandidates } from "@/lib/finance/server/transactions";

export const GET = financeHandler(undefined, ({ scope, params, query }) => matchCandidates(prisma, scope, params.id, query.get("q") ?? ""));

export const POST = financeHandler("txn_enter", async ({ actor, scope, request, params }) => addMatch(actor, scope, params.id, await readJson(request)), 201);
