import { financeHandler } from "@/lib/finance/server/http";
import { prisma } from "@/lib/db";
import { readJson } from "@/lib/finance/server/context";
import { accountBalances } from "@/lib/finance/server/ledger";
import { createAccount } from "@/lib/finance/server/transactions";

export const GET = financeHandler(undefined, ({ scope }) => accountBalances(prisma, scope));

export const POST = financeHandler("settings_manage", async ({ actor, scope, request }) => createAccount(actor, scope, await readJson(request)), 201);
