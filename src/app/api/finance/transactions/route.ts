import { financeHandler } from "@/lib/finance/server/http";
import { prisma } from "@/lib/db";
import { readJson } from "@/lib/finance/server/context";
import { listTransactions, createManualTransaction } from "@/lib/finance/server/transactions";

export const GET = financeHandler(undefined, ({ scope, query }) => listTransactions(prisma, scope, query));

export const POST = financeHandler("txn_enter", async ({ actor, scope, request }) => createManualTransaction(actor, scope, await readJson(request)), 201);
