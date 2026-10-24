import { NextResponse } from "@/lib/api-response";
import { requireModule, requireSub } from "@/lib/auth-server";
import { acctError, jsonBody } from "@/lib/accounting/http";
import { chartWithUsage, createAccount } from "@/lib/accounting/chart";
import { auditFromRequest } from "@/lib/accounting/audit";

/** «دليل الحسابات»: every account with its usage (lines, posted balance), roles and number of sub-accounts. */
export async function GET() {
  const { error } = await requireModule("accounting");
  if (error) return error;
  try {
    return NextResponse.json(await chartWithUsage());
  } catch (err) {
    return acctError(err);
  }
}

/** A new account (code, names, type, parent header, postable / header, normal balance, control kind, manual flag). */
export async function POST(request: Request) {
  const { user, error } = await requireSub("accounting", "coa_manage");
  if (error) return error;
  try {
    const body = await jsonBody(request);
    return NextResponse.json(await createAccount(body, auditFromRequest(request, user.id)), { status: 201 });
  } catch (err) {
    return acctError(err);
  }
}
