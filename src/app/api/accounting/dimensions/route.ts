import { NextResponse } from "@/lib/api-response";
import { prisma } from "@/lib/db";
import { requireModule } from "@/lib/auth-server";
import { acctError } from "@/lib/accounting/http";

/**
 * The pick lists of the journal editor and the opening grid: postable accounts, branches, cost centres,
 * customers and suppliers (names only — the AR / AP party of a line). Employees are not listed here (HR data
 * stays in HR); an employee party is set by the posting engine from HR / payroll events.
 */
export async function GET() {
  const { error } = await requireModule("accounting");
  if (error) return error;
  try {
    const [accounts, branches, costCenters, customers, suppliers] = await Promise.all([
      prisma.account.findMany({ where: { isActive: true, allowPosting: true, children: { none: {} } }, orderBy: { code: "asc" }, select: { id: true, code: true, nameAr: true, nameEn: true, type: true, controlType: true, allowManualJournal: true } }),
      prisma.finBranch.findMany({ where: { active: true }, orderBy: { code: "asc" }, select: { id: true, code: true, nameAr: true, nameEn: true } }),
      prisma.finCostCenter.findMany({ where: { active: true }, orderBy: { code: "asc" }, select: { id: true, code: true, nameAr: true, nameEn: true } }),
      prisma.customer.findMany({ orderBy: { name: "asc" }, take: 2000, select: { id: true, name: true } }),
      prisma.supplier.findMany({ orderBy: { name: "asc" }, take: 2000, select: { id: true, name: true } }),
    ]);
    return NextResponse.json({ accounts: accounts.map((a) => ({ ...a, type: String(a.type) })), branches, costCenters, customers, suppliers });
  } catch (err) {
    return acctError(err);
  }
}
