import { NextResponse } from "@/lib/api-response";
import { requireModule } from "@/lib/auth-server";
import { requireRegisterWrite } from "@/lib/accounting/register-access";
import { acctError, jsonBody, qp } from "@/lib/accounting/http";
import { auditFromRequest } from "@/lib/accounting/audit";
import { createTemplate, listTemplates } from "@/lib/accounting/deferrals";
import { prisma } from "@/lib/db";

/** The deferral templates, the role accounts they fall back to, and the postable accounts a template may name. */
export async function GET(request: Request) {
  const { error } = await requireModule("accounting");
  if (error) return error;
  try {
    const [list, accounts] = await Promise.all([
      listTemplates({ active: qp(request, "active") === "1" }),
      prisma.account.findMany({ where: { isActive: true, allowPosting: true, children: { none: {} }, type: { in: ["ASSET", "LIABILITY", "REVENUE", "EXPENSE"] } }, orderBy: { code: "asc" }, select: { id: true, code: true, nameAr: true, nameEn: true, type: true } }),
    ]);
    return NextResponse.json({ ...list, accounts: accounts.map((a) => ({ ...a, type: String(a.type) })) });
  } catch (err) {
    return acctError(err);
  }
}

/** «قالب جديد» (accounting › deferrals). */
export async function POST(request: Request) {
  const { user, error } = await requireRegisterWrite("deferrals");
  if (error) return error;
  try {
    return NextResponse.json(await createTemplate(await jsonBody(request), auditFromRequest(request, user.id)), { status: 201 });
  } catch (err) {
    return acctError(err);
  }
}
