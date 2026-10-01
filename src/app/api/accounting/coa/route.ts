import { prisma } from "@/lib/db";
import { accountingRoute, body } from "@/lib/accounting/http";
import { createAccount } from "@/lib/accounting/account-service";

export const GET = accountingRoute(null, async () => {
  const [accounts, used, mapped] = await Promise.all([
    prisma.account.findMany({ orderBy: { code: "asc" }, take: 2000 }),
    prisma.journalEntryLine.groupBy({ by: ["accountId"], _count: { _all: true } }),
    prisma.accountMapping.findMany({ select: { role: true, accountId: true } }),
  ]);
  const usage = new Map(used.map((u) => [u.accountId, u._count._all]));
  return accounts.map((a) => ({ ...a, lineCount: usage.get(a.id) ?? 0, roles: mapped.filter((m) => m.accountId === a.id).map((m) => m.role) }));
});

export const POST = accountingRoute("coa_manage", async ({ user, request }) => createAccount(await body(request), user.id), 201);
