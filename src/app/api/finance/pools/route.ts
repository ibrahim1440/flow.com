import { financeHandler } from "@/lib/finance/server/http";
import { prisma } from "@/lib/db";
import { poolSummaries } from "@/lib/finance/server/ledger";

export const GET = financeHandler(undefined, ({ scope }) => poolSummaries(prisma, scope));
