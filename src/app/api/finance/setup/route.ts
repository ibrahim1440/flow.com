import { financeHandler } from "@/lib/finance/server/http";
import { prisma } from "@/lib/db";
import { setupData } from "@/lib/finance/server/setup";

export const GET = financeHandler(undefined, ({ scope }) => setupData(prisma, scope));
