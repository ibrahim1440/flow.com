import { NextResponse } from "@/lib/api-response";
import { requireModule } from "@/lib/auth-server";
import { requireRegisterWrite } from "@/lib/accounting/register-access";
import { acctError, jsonBody, qp } from "@/lib/accounting/http";
import { auditFromRequest } from "@/lib/accounting/audit";
import { createSchedule, listSchedules, schedulePosts } from "@/lib/accounting/deferrals";

/** The deferral schedules (filters status, kind; paged take / skip). */
export async function GET(request: Request) {
  const { error } = await requireModule("accounting");
  if (error) return error;
  try {
    return NextResponse.json(await listSchedules({ status: qp(request, "status"), kind: qp(request, "kind"), take: Number(qp(request, "take")) || undefined, skip: Number(qp(request, "skip")) || undefined }));
  } catch (err) {
    return acctError(err);
  }
}

/**
 * «إنشاء جدول تأجيل» (accounting › deferrals): template + amount + start date (+ an optional source line). A schedule
 * whose initial RECLASS entry writes the GL (an invoice-line source, or «أعد التصنيف») also needs accounting ›
 * journal_post through the central gate (verified individual + step-up).
 */
export async function POST(request: Request) {
  const body = await jsonBody(request).catch(() => ({} as Record<string, unknown>));
  const { user, error } = await requireRegisterWrite("deferrals", { duties: [schedulePosts(body) && "journal_post"] });
  if (error) return error;
  try {
    return NextResponse.json(await createSchedule(body, auditFromRequest(request, user.id)), { status: 201 });
  } catch (err) {
    return acctError(err);
  }
}
