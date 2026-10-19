import { NextResponse } from "next/server";
import { DutyConflictError, conflictMessageEn } from "@/lib/hr/sod";
import { HrError } from "@/lib/hr/core";
import { toArabic } from "@/lib/hr/messages-ar";
import { handlePrismaError } from "@/lib/api-error";
import { UsersError } from "./errors";

/** The refusal of a users-area route, in both languages with a stable code (nothing was written). */
export function usersErrorResponse(err: unknown) {
  if (err instanceof UsersError) return err.response();
  if (err instanceof DutyConflictError) return NextResponse.json({ error: err.message, errorEn: conflictMessageEn(err.conflicts), code: err.code, conflicts: err.conflicts }, { status: err.status });
  if (err instanceof HrError) return NextResponse.json({ error: toArabic(err.message) ?? err.message, errorEn: err.message, code: err.code }, { status: err.status });
  if (err && typeof err === "object" && "_appCode" in err) {
    const e = err as { _appCode: number; message: string; code?: string };
    return NextResponse.json({ error: e.message, code: e.code }, { status: e._appCode });
  }
  return handlePrismaError(err);
}

/** The JSON body, or an empty object for a body that is missing or not JSON. */
export async function body(request: Request): Promise<Record<string, unknown>> {
  const b = await request.json().catch(() => ({}));
  return b && typeof b === "object" ? (b as Record<string, unknown>) : {};
}

export const noStore = { headers: { "Cache-Control": "no-store" } };
export const ADMIN_READ_ONLY = () => NextResponse.json({ error: "هذه البيانات لمدير المنشأة فقط.", errorEn: "Only the administrator can see this.", code: "FORBIDDEN" }, { status: 403 });
