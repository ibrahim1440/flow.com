import { financeHandler } from "@/lib/finance/server/http";
import { prisma } from "@/lib/db";
import { readJson } from "@/lib/finance/server/context";
import { listObligations, createObligation } from "@/lib/finance/server/obligations";

export const GET = financeHandler(undefined, ({ scope, query }) => listObligations(prisma, scope, { status: query.get("status") === "ALL" ? "ALL" : "LIVE", take: Math.min(Number(query.get("take") ?? 100) || 100, 500), skip: Number(query.get("skip") ?? 0) || 0 }));

export const POST = financeHandler("budget_prepare", async ({ actor, scope, request }) => createObligation(actor, scope, await readJson(request)), 201);
