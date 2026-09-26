import { financeHandler } from "@/lib/finance/server/http";
import { prisma } from "@/lib/db";
import { getTransaction } from "@/lib/finance/server/transactions";

export const GET = financeHandler(undefined, ({ scope, params }) => getTransaction(prisma, scope, params.id));
