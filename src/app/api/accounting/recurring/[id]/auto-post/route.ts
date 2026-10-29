import { NextResponse } from "@/lib/api-response";
import { requireAdminAction } from "@/lib/auth-server";
import { requireRegisterWrite } from "@/lib/accounting/register-access";
import { acctError, jsonBody } from "@/lib/accounting/http";
import { auditFromRequest } from "@/lib/accounting/audit";
import { setAutoPost } from "@/lib/accounting/recurring/schedules";

type Params = { params: Promise<{ id: string }> };

/**
 * Auto-post of a recurring JOURNAL. `{ on: true }` authorises it: the duty of posting journals (accounting › journal_post)
 * and the same admin gate as posting one (a verified individual with a recent step-up — PATCH …/journals/:id/post); the
 * authoriser is recorded, and is not the preparer unless the SoD setting allows it (a self-authorisation is recorded
 * as sodBypass and listed in «استثناءات فصل المهام», RECURRING_SELF_AUTHORISED). Both need the register's maintenance
 * duty accounting › recurring; `{ on: true }` ALSO the journal duty through the central gate. `{ on: false }` withdraws it. `expectedUpdatedAt`: the version the authoriser read.
 */
export async function POST(request: Request, { params }: Params) {
  const body = await jsonBody(request).catch(() => ({} as Record<string, unknown>));
  const on = body.on === true;
  const { user, error } = await requireRegisterWrite("recurring", { duties: [on && "journal_post"] });
  if (error) return error;
  if (on) {
    const refused = await requireAdminAction(user, "accounting.recurring_auto_post", { stepUp: true, message: "Insufficient permissions." });
    if (refused) return refused;
  }
  const { id } = await params;
  try {
    return NextResponse.json(await setAutoPost(id, on, auditFromRequest(request, user.id, on ? "recurring auto-post authorised" : "recurring auto-post withdrawn"), body.expectedUpdatedAt));
  } catch (err) {
    return acctError(err);
  }
}
