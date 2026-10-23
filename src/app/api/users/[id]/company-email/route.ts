import { NextResponse } from "@/lib/api-response";
import { prisma, TX_OPTS } from "@/lib/db";
import { requireAuth, requireAdminAction } from "@/lib/auth-server";
import { handleDomainError } from "@/lib/api-error";
import { auditContext } from "@/lib/users/account-update";
import { recordUsersAudit } from "@/lib/users/server";
import { assertCompanyEmailFree, companyEmailOf, isValidEmail } from "@/lib/notify/recipients";

type Params = { params: Promise<{ id: string }> };

/**
 * PUT /api/users/[id]/company-email — «البريد الإلكتروني للشركة» from the user's page (feat/credit-hold,
 * owner e-mail model). { email: string | null }. ONE source of truth: an account linked to an HR
 * person writes that person's HrEmployee.workEmail («بريد الشركة», also edited in HR); an account
 * with no HR link writes Employee.workEmail. Unique among active people and accounts, case-insensitive
 * (409 EMAIL_TAKEN names who uses it). The administrator, after a recent step-up; audited in
 * «سجل الصلاحيات» (EMPLOYEE_COMPANY_EMAIL_CHANGED) and, for a person, in the HR audit as well.
 */
export async function PUT(request: Request, { params }: Params) {
  const { user, error } = await requireAuth();
  if (error) return error;
  const refused = await requireAdminAction(user, "users.company_email", { stepUp: true });
  if (refused) return refused;
  const { id } = await params;
  const body = (await request.json().catch(() => ({}))) as { email?: unknown };
  const raw = typeof body.email === "string" ? body.email.trim() : body.email === null ? "" : undefined;
  if (raw === undefined) return NextResponse.json({ error: "أرسل البريد في الحقل email.", errorEn: "Send the address in `email`." }, { status: 400 });
  if (raw.length > 120 || (raw && !isValidEmail(raw.toLowerCase()))) {
    return NextResponse.json({ error: "صيغة البريد الإلكتروني غير صحيحة.", errorEn: "That e-mail address is not valid.", code: "EMAIL_INVALID" }, { status: 400 });
  }
  const email = raw || null;
  try {
    const result = await prisma.$transaction(async (tx) => {
      const cur = await companyEmailOf(tx, id);
      if (!cur) throw { _appCode: 404, message: "المستخدم غير موجود.", errorEn: "User not found." };
      await assertCompanyEmailFree(tx, email, cur.hrEmployeeId ? { hrEmployeeId: cur.hrEmployeeId } : { accountId: id });
      const target = await tx.employee.findUniqueOrThrow({ where: { id }, select: { name: true } });
      if (cur.hrEmployeeId) {
        await tx.hrEmployee.update({ where: { id: cur.hrEmployeeId }, data: { workEmail: email, version: { increment: 1 } } });
        await tx.hrAuditLog.create({ data: { action: "PERSON_UPDATE", entityType: "HrEmployee", entityId: cur.hrEmployeeId, employeeId: cur.hrEmployeeId, before: { workEmail: cur.email }, after: { workEmail: email }, actorId: user.id } });
      } else {
        await tx.employee.update({ where: { id }, data: { workEmail: email } });
      }
      await recordUsersAudit(tx, auditContext(request, user.id), "EMPLOYEE_COMPANY_EMAIL_CHANGED", { targetEmployeeId: id, targetName: target.name, source: cur.source, before: cur.email, after: email });
      return { email, source: cur.source };
    }, TX_OPTS);
    return NextResponse.json(result);
  } catch (err) {
    return handleDomainError(err);
  }
}
