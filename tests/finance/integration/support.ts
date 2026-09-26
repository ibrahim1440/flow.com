// Integration-test support. Refuses to run against anything but the local disposable test
// database, because reset() truncates tables.
import "./guard";
import { buildDefaultPermissions, MODULE_SUB_PRIVILEGES, type Permissions } from "../../../src/lib/auth-shared";

import { prisma } from "../../../src/lib/db";
import { assertDisposableFinanceDb } from "../../../scripts/finance/local-db-guard.mjs";
export { prisma };

const FIN_TABLES = [
  "FinAuditLog", "FinApprovalRequest", "FinForecastSnapshot", "FinVarianceNote", "BudgetLine", "BudgetRevision", "FinBudget",
  "FinForecastItem", "FinObligation", "PaymentReservation", "AllocationEntry", "AllocationRun", "AllocationRuleStep",
  "AllocationRuleVersion", "AllocationCategory", "FinAttachment", "BankTransactionMatch", "BankTransactionSplit",
  "BankTransaction", "BankReconciliation", "BankImportBatch", "CashAccount", "FinCategory", "FinCostCenter",
  "FinBranchAccess", "FinBranch", "FinSettings",
];

let verified = false;
export async function reset() {
  if (!verified) {
    await assertDisposableFinanceDb({ url: process.env.DATABASE_URL, expectedDb: "erp_finance_test", query: (q: string) => prisma.$queryRawUnsafe(q) });
    verified = true;
  }
  const list = [...FIN_TABLES, "Delivery", "OrderItem", "OrderActivity", "Order", "Customer", "PurchaseRecord", "Supplier", "Employee"].map((t) => `"${t}"`).join(", ");
  await prisma.$executeRawUnsafe(`TRUNCATE ${list} RESTART IDENTITY CASCADE`);
}

export function financePerms(subs: string[] | "ALL"): Permissions {
  const base = buildDefaultPermissions("custom");
  const keys = MODULE_SUB_PRIVILEGES.finance.map((s) => s.key);
  base.finance = { access: "edit", sub: Object.fromEntries(keys.map((k) => [k, subs === "ALL" || subs.includes(k)])) };
  return base;
}

export async function makeUser(name: string, subs: string[] | "ALL") {
  const permissions = financePerms(subs);
  const e = await prisma.employee.create({ data: { name, pin: "x", role: "custom", permissions: JSON.stringify(permissions) } });
  return { id: e.id, role: "custom", permissions };
}

export const ALL_SCOPE_SUBS = ["txn_enter", "reconcile", "budget_prepare", "allocate", "all_branches", "settings_manage"];
export const APPROVER_SUBS = ["budget_approve", "transfer_approve", "spend_override_approve", "period_close", "all_branches"];
