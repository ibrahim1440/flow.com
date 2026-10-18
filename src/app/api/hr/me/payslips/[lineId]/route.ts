import { hrHandler } from "@/lib/hr/http";
import { HrError } from "@/lib/hr/core";
import { prisma } from "@/lib/db";
import { selfPerson } from "@/lib/hr/services/self";
import { payslip } from "@/lib/hr/services/payroll";
import { assertPayrollLive } from "@/lib/hr/payroll-lock";

export const GET = hrHandler(async ({ actor, params }) => {
  // Owner RC3.1: while payroll is locked no payslip — checked first (after sign-in), before any
  // lookup, so every id gets the same 409 PAYROLL_LOCKED.
  await assertPayrollLive("PAYSLIP");
  const p = await selfPerson(actor);
  if (!(await prisma.hrPayrollLine.count({ where: { id: params.lineId, employeeId: p.id } }))) throw new HrError("Payslip not found", 404);
  return payslip(actor, params.lineId, { self: true });
}, { self: true });
