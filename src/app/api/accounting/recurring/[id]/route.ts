import { NextResponse } from "@/lib/api-response";
import { requireRegisterWrite } from "@/lib/accounting/register-access";
import { prisma } from "@/lib/db";
import { requireModule } from "@/lib/auth-server";
import { acctError, jsonBody } from "@/lib/accounting/http";
import { auditFromRequest } from "@/lib/accounting/audit";
import { getSchedule, saveSchedule } from "@/lib/accounting/recurring/schedules";
import { refuse } from "@/lib/accounting/refusals";
import { salesDutyRefusal } from "../_shared";

type Params = { params: Promise<{ id: string }> };

/** One recurring transaction: its rule, next dates, runs (with document links and failure reasons), the audit trail and
 *  the people named. PATCH edits it (`expectedUpdatedAt`; withdraws auto-post) — accounting › recurring. */
export async function GET(_request: Request, { params }: Params) {
  const { error } = await requireModule("accounting");
  if (error) return error;
  const { id } = await params;
  try {
    const s = await getSchedule(id);
    const ids = [s.createdBy, s.updatedBy, s.autoPostApprovedBy, s.pausedBy, ...s.runs.map((r) => r.actorId), ...s.runs.map((r) => r.autoPostBy), ...s.audit.map((a) => a.actorId)].filter((x): x is string => !!x);
    const people = await prisma.employee.findMany({ where: { id: { in: [...new Set(ids)] } }, select: { id: true, name: true } });
    return NextResponse.json({ ...s, people: Object.fromEntries(people.map((p) => [p.id, p.name])) });
  } catch (err) {
    return acctError(err);
  }
}

export async function PATCH(request: Request, { params }: Params) {
  const { user, error } = await requireRegisterWrite("recurring", { duties: ["journal_create"] });
  if (error) return error;
  const { id } = await params;
  try {
    const body = await jsonBody(request);
    const cur = await prisma.recurringSchedule.findUnique({ where: { id }, select: { kind: true } });
    if (!cur) throw refuse("NOT_FOUND");
    const refused = salesDutyRefusal(user, body.kind ?? cur.kind) ?? salesDutyRefusal(user, cur.kind);
    if (refused) return refused;
    return NextResponse.json(await saveSchedule(body, id, auditFromRequest(request, user.id)));
  } catch (err) {
    return acctError(err);
  }
}
