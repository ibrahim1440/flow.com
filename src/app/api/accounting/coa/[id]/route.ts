import { prisma } from "@/lib/db";
import { accountingRoute, body } from "@/lib/accounting/http";
import { AccountingError } from "@/lib/accounting/errors";
import { updateAccount } from "@/lib/accounting/account-service";

export const GET = accountingRoute(null, async ({ params }) => {
  const a = await prisma.account.findUnique({ where: { id: params.id } });
  if (!a) throw new AccountingError("Account not found.", 404);
  return a;
});

export const PATCH = accountingRoute("coa_manage", async ({ user, request, params }) => updateAccount(params.id, await body(request), user.id));
