// Accounting A3 — payroll in the ledger: option (a) of POSTING-CONTRACT.md §4. The HR bridge keeps posting payroll
// exactly as today (its own controls: the payroll lock, HrJournalLink, two-person rules, the Phase-1 switch columns
// that flowcom_app never writes); A3 requires each of its account keys to sit on the account of the matching posting
// role, so the payroll journals land where the rest of the ledger expects them. This is a READ-ONLY readiness check:
// a mismatch is changed through HR's own account map (second-person approved), never from here.
import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";

/** HR posting key → the posting role whose account it must use (null: no A3 role — the accountant's choice). */
export const HR_KEY_ROLE: Record<string, { role: string | null; why: string }> = {
  SALARY_EXPENSE: { role: "SALARIES_EXPENSE", why: "الرواتب الأساسية" },
  ALLOWANCE_EXPENSE: { role: "SALARIES_EXPENSE", why: "البدلات ضمن الرواتب والأجور" },
  OVERTIME_EXPENSE: { role: "SALARIES_EXPENSE", why: "العمل الإضافي ضمن الرواتب والأجور" },
  // The commission was already expensed when its month was approved (commissions-gl.ts): payroll pays the payable.
  COMMISSION_EXPENSE: { role: "COMMISSION_PAYABLE", why: "العمولة مُستحقة مسبقًا عند اعتمادها؛ الرواتب تسدد العمولات المستحقة" },
  EMPLOYER_CONTRIB_EXPENSE: { role: "GOSI_EXPENSE", why: "حصة الشركة في التأمينات" },
  SALARIES_PAYABLE: { role: "SALARIES_PAYABLE", why: "الرواتب المستحقة" },
  CONTRIB_PAYABLE: { role: "GOSI_PAYABLE", why: "التأمينات المستحقة" },
  ADVANCES_RECEIVABLE: { role: "EMPLOYEE_ADVANCES", why: "سلف الموظفين" },
  PAYROLL_CASH: { role: "BANK", why: "صرف الرواتب من البنك" },
  EOS_PROVISION: { role: "EOSB_PROVISION", why: "مخصص نهاية الخدمة" },
  EOS_EXPENSE: { role: "EOSB_EXPENSE", why: "مصروف نهاية الخدمة" },
  OTHER_DEDUCTIONS_PAYABLE: { role: null, why: "استقطاعات أخرى — يحدد المحاسب حسابها" },
  LEAVE_PROVISION: { role: null, why: "مخصص الإجازات — يحدد المحاسب حسابه" },
  LEAVE_ENCASHMENT_EXPENSE: { role: null, why: "بدل الإجازات — يحدد المحاسب حسابه" },
  FINAL_SETTLEMENT_PAYABLE: { role: null, why: "مستحقات نهاية الخدمة — يحدد المحاسب حسابها" },
};

export type AlignmentRow = { key: string; role: string | null; why: string; hrAccount: { id: string; code: string; name: string } | null; roleAccount: { id: string; code: string; name: string } | null; status: "ALIGNED" | "MISALIGNED" | "HR_UNMAPPED" | "ROLE_UNMAPPED" | "NO_ROLE" };

/** `db`: a transaction to read the map inside (the activation re-checks it under lock, setup.ts). Reads run in turn,
 *  so the same transaction client can serve them. */
export async function payrollAlignment(db: Prisma.TransactionClient | typeof prisma = prisma): Promise<{ rows: AlignmentRow[]; aligned: boolean; hrAccountingEnabled: boolean }> {
  const maps = await db.hrAccountMap.findMany({ include: { account: { select: { id: true, code: true, nameAr: true, nameEn: true } } } });
  const roles = await db.accountRole.findMany({ where: { tenantId: "hiqbah" }, include: { account: { select: { id: true, code: true, nameAr: true, nameEn: true } } } });
  const hr = await db.hrSettings.findUnique({ where: { id: "singleton" }, select: { accountingEnabled: true } });
  const acc = (a: { id: string; code: string; nameAr: string | null; nameEn: string }) => ({ id: a.id, code: a.code, name: a.nameAr ?? a.nameEn });
  const hrOf = new Map(maps.map((m) => [m.key, acc(m.account)]));
  const roleOf = new Map(roles.map((r) => [r.role, acc(r.account)]));
  const rows: AlignmentRow[] = Object.entries(HR_KEY_ROLE).map(([key, { role, why }]) => {
    const hrAccount = hrOf.get(key) ?? null;
    const roleAccount = role ? roleOf.get(role) ?? null : null;
    const status: AlignmentRow["status"] = !role ? "NO_ROLE" : !roleAccount ? "ROLE_UNMAPPED" : !hrAccount ? "HR_UNMAPPED" : hrAccount.id === roleAccount.id ? "ALIGNED" : "MISALIGNED";
    return { key, role, why, hrAccount, roleAccount, status };
  });
  return { rows, aligned: rows.every((r) => r.status === "ALIGNED" || r.status === "NO_ROLE" || (r.status === "HR_UNMAPPED" && !hr?.accountingEnabled)), hrAccountingEnabled: !!hr?.accountingEnabled };
}
