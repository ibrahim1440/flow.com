import { financeHandler } from "@/lib/finance/server/http";
import { prisma } from "@/lib/db";
import { overview } from "@/lib/finance/server/dashboard";

export const GET = financeHandler(undefined, ({ scope }) => overview(prisma, scope));
