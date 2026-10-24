import type { Prisma as PrismaNS } from "@/generated/prisma/client";
import { hasSubPrivilege, type Permissions } from "@/lib/auth-shared";
import { Decimal } from "./engine";

type Db = PrismaNS.TransactionClient;

/**
 * Who may see an employee's fixed pay next to their commission: holders of the HR duties that
 * already show pay — contracts and pay, payroll preparation or approval. Nobody else, the earner
 * included (the commission screens never become a way round HR's own pay permissions).
 */
export function maySeePay(permissions: Permissions | Record<string, unknown>): boolean {
  const p = permissions as Permissions;
  return hasSubPrivilege(p, "hr", "contracts_manage") || hasSubPrivilege(p, "hr", "payroll_prepare") || hasSubPrivilege(p, "hr", "payroll_approve");
}

/**
 * The login's fixed monthly pay from native HR (basic + housing + transport of the compensation in
 * force at `at`), or null when the login has no HR person or no compensation. DISPLAY ONLY: no
 * commission figure is computed from it. Call it only after `maySeePay`.
 */
export async function fixedPayFor(db: Db, accountEmployeeId: string, at: Date): Promise<{ basic: string; housing: string; transport: string; total: string } | null> {
  const person = await db.hrEmployee.findUnique({ where: { accountId: accountEmployeeId }, select: { id: true } });
  if (!person) return null;
  const comp = await db.hrCompensation.findFirst({
    where: { employeeId: person.id, effectiveFrom: { lte: at }, OR: [{ effectiveTo: null }, { effectiveTo: { gte: at } }] },
    orderBy: { effectiveFrom: "desc" },
    select: { basic: true, housing: true, transport: true },
  });
  if (!comp) return null;
  const b = new Decimal(comp.basic.toString()), h = new Decimal(comp.housing.toString()), t = new Decimal(comp.transport.toString());
  return { basic: b.toFixed(2), housing: h.toFixed(2), transport: t.toFixed(2), total: b.plus(h).plus(t).toFixed(2) };
}
