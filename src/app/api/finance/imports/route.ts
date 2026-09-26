import { financeHandler } from "@/lib/finance/server/http";
import { prisma } from "@/lib/db";
import { readJson } from "@/lib/finance/server/context";
import { commitImport } from "@/lib/finance/server/transactions";
import { scopeWhere } from "@/lib/finance/server/context";

export const GET = financeHandler(undefined, ({ scope }) => prisma.bankImportBatch.findMany({ where: { cashAccount: scopeWhere(scope) }, orderBy: { createdAt: "desc" }, take: 50, include: { cashAccount: { select: { code: true } } } }));

export const POST = financeHandler("txn_enter", async ({ actor, scope, request }) => commitImport(actor, scope, await readJson(request)), 201);
