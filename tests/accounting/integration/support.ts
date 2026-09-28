// Accounting integration-test support. Same disposable database and the same fail-closed
// guard as the finance suite (reset() truncates tables).
import "../../finance/integration/guard";
import { buildDefaultPermissions, MODULE_SUB_PRIVILEGES, type Permissions } from "../../../src/lib/auth-shared";
import { prisma } from "../../../src/lib/db";
import { assertDisposableFinanceDb } from "../../../scripts/finance/local-db-guard.mjs";
export { prisma };

const TABLES = [
  "InvMove", "InvLayer", "InvDocLine", "InvDocument", "InvLossBand", "InvUnit", "InvItem", "InvLocation",
  "RoastingBatch", "CoffeeProduct", "GreenBean",
  "AdvanceApplication", "ArAllocation", "CustomerReceipt", "SalesInvoiceLine", "SalesInvoice",
  "SalesCollection", "Opportunity", "PipelineStage", "Order", "Customer",
  "BankCorrection", "SupplierBillLine", "SupplierBill", "BankTransactionMatch", "BankTransactionSplit", "BankTransaction", "CashAccount",
  "PaymentReservation", "FinObligation", "FinCategory", "PurchaseRecord", "Supplier",
  "AccountingEvent", "QoyodExportRecord", "JournalEntryLine", "JournalEntry", "FiscalPeriod", "AccountMapping", "AccountingPolicy",
  "Account", "TaxCategory", "AccountingSettings", "FinAuditLog", "FinCostCenter", "FinBranchAccess", "FinBranch",
  "CommissionLedgerCorrection", "CommissionLedgerEntry", "CommissionAccrual", "CommissionAssignment", "CommissionTier",
  "CommissionPlanVersion", "CommissionPlan", "CollectionEvent", "Employee",
];

let verified = false;
export async function reset() {
  if (!verified) {
    await assertDisposableFinanceDb({ url: process.env.DATABASE_URL, expectedDb: "erp_finance_integration", query: (q: string) => prisma.$queryRawUnsafe(q) });
    verified = true;
  }
  await prisma.$executeRawUnsafe(`TRUNCATE ${TABLES.map((t) => `"${t}"`).join(", ")} RESTART IDENTITY CASCADE`);
  delete process.env.ACCOUNTING_PROVISIONAL_POSTING;
}

export function accountingPerms(subs: string[] | "ALL"): Permissions {
  const base = buildDefaultPermissions("custom");
  const keys = MODULE_SUB_PRIVILEGES.accounting.map((s) => s.key);
  base.accounting = { access: "edit", sub: Object.fromEntries(keys.map((k) => [k, subs === "ALL" || subs.includes(k)])) };
  return base;
}

export async function makeUser(name: string, subs: string[] | "ALL" = "ALL") {
  const e = await prisma.employee.create({ data: { name, pin: "x", role: "custom", permissions: JSON.stringify(accountingPerms(subs)) } });
  return e.id;
}

/** Expect a promise to reject with a message matching `re`. */
export async function rejects(p: Promise<unknown>, re: RegExp) {
  try {
    await p;
  } catch (e) {
    const m = String((e as Error)?.message ?? e);
    if (!re.test(m)) throw new Error(`Rejected with an unexpected message: ${m}`);
    return e;
  }
  throw new Error(`Expected a rejection matching ${re}`);
}
