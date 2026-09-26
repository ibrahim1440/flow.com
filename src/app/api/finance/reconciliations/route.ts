import { financeHandler } from "@/lib/finance/server/http";
import { prisma } from "@/lib/db";
import { readJson } from "@/lib/finance/server/context";
import { listReconciliations, saveReconciliation } from "@/lib/finance/server/reconciliation";

export const GET = financeHandler(undefined, ({ scope, query }) => listReconciliations(prisma, scope, query.get("accountId") ?? undefined));

export const POST = financeHandler("reconcile", async ({ actor, scope, request }) => saveReconciliation(actor, scope, await readJson(request)), 201);
