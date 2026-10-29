import { NextResponse } from "@/lib/api-response";
import { requireModule } from "@/lib/auth-server";
import { hasSubPrivilege } from "@/lib/auth-shared";
import { acctError, jsonBody } from "@/lib/accounting/http";
import { auditFromRequest } from "@/lib/accounting/audit";
import { requireRegisterWrite } from "@/lib/accounting/register-access";
import { REGISTER_SUB, grantRegister, isRegisterWide, listRegisterWide } from "@/lib/accounting/standing-auth";

/**
 * «التفويض الدائم» of the register-wide scheduler runs (batch 22 WP-A, 20261124090000_standing_authorisation).
 *   GET  — the accounting module: the live authorisation of DEFERRAL_RECOGNITION and DEPRECIATION, the history, and
 *          what the viewer may do (grant: the register's sub + journal_post; revoke: the register's sub). `?register=`
 *          narrows to one register.
 *   POST { register } — grant: the register's sub (deferrals | fixed_assets) AND journal_post through the central gate
 *          (privilegedGate + requireFreshAuth: a 401 REAUTH_REQUIRED first); the SoD setting is applied by the service
 *          (a self-authorisation is refused when self-approval is off, else recorded as sodBypass). Recurring journals are
 *          authorised per schedule: POST /api/accounting/recurring/[id]/auto-post.
 */
export async function GET(request: Request) {
  const { user, error } = await requireModule("accounting");
  if (error) return error;
  try {
    const g = new URL(request.url).searchParams.get("register");
    const has = (s: string) => hasSubPrivilege(user.permissions, "accounting", s);
    const can = (r: "DEFERRAL_RECOGNITION" | "DEPRECIATION") => ({ grant: has(REGISTER_SUB[r]) && has("journal_post"), revoke: has(REGISTER_SUB[r]), needsPost: has(REGISTER_SUB[r]) && !has("journal_post") });
    return NextResponse.json({ ...(await listRegisterWide(isRegisterWide(g) ? g : undefined)), can: { DEFERRAL_RECOGNITION: can("DEFERRAL_RECOGNITION"), DEPRECIATION: can("DEPRECIATION") } });
  } catch (err) {
    return acctError(err);
  }
}

export async function POST(request: Request) {
  const body = await jsonBody(request).catch(() => ({} as Record<string, unknown>));
  if (!isRegisterWide(body.register)) return NextResponse.json({ error: "السجل غير معروف", errorEn: "register is DEFERRAL_RECOGNITION or DEPRECIATION", code: "BAD_INPUT" }, { status: 400 });
  const { user, error } = await requireRegisterWrite(REGISTER_SUB[body.register], { duties: ["journal_post"] });
  if (error) return error;
  try {
    return NextResponse.json(await grantRegister(body.register, auditFromRequest(request, user.id, `standing authorisation granted: ${body.register}`)));
  } catch (err) {
    return acctError(err);
  }
}
