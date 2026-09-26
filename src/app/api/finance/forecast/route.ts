import { financeHandler } from "@/lib/finance/server/http";
import { prisma } from "@/lib/db";
import { cashForecast } from "@/lib/finance/server/dashboard";

export const GET = financeHandler(undefined, ({ scope }) => cashForecast(prisma, scope));
