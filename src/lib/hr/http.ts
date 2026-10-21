// HTTP-only helpers for HR route handlers (kept apart so the services stay importable from
// the integration tests). Every HR route goes through `hrHandler`: authenticate, require the
// hr module (self-service routes require only a login), run, map errors. The duty check
// itself lives in the service — hiding a button is never the control.
import { NextResponse } from "@/lib/api-response";
import { assertVerifiedActor } from "./identity";
import { isPrivileged } from "@/lib/auth/privileged";
import { hasModuleAccess } from "@/lib/auth-shared";
import { requireAuth } from "@/lib/auth-server";
import { handlePrismaError } from "@/lib/api-error";
import { prisma } from "@/lib/db";
import { HrError, type HrActor } from "./core";
import { localDay } from "./dates";
import { activePolicyFor } from "./services/policy";
import { toArabic } from "./messages-ar";

type RouteCtx = { params: Promise<Record<string, string>> };
export type HrArgs = { actor: HrActor; request: Request; params: Record<string, string>; query: URLSearchParams; now: Date; today: Date };

/** Arabic first (`error`), the service's exact English kept as `errorEn`. */
function refusal(message: string, status: number, code: string | null) {
  return NextResponse.json({ error: toArabic(message) ?? message, errorEn: message, code }, { status });
}

export function hrErrorResponse(err: unknown) {
  if (err instanceof HrError) return refusal(err.message, err.status, err.code ?? null);
  const msg = err instanceof Error ? err.message : String((err as { message?: string })?.message ?? "");
  const m = /HR: ([^\n"]+)/.exec(msg);
  if (m) return refusal(m[1].trim(), 409, "DB_GUARD");
  return handlePrismaError(err);
}

/** "Today" as a calendar day in the HR policy's zone (Asia/Riyadh when none is active). */
export async function hrToday(now: Date): Promise<Date> {
  const p = await activePolicyFor(prisma, now);
  return localDay(now, p?.timezone ?? "Asia/Riyadh");
}

export function hrHandler(fn: (a: HrArgs) => Promise<unknown>, opts: { self?: boolean; status?: number } = {}) {
  return async (request: Request, ctx: RouteCtx) => {
    const { user, error } = await requireAuth();
    if (error) return error;
    // authTime: the session's last strong authentication, for the step-up of sensitive actions.
    const actor: HrActor = { id: user.id, role: user.role, permissions: user.permissions, authTime: user.authTime };
    // Same refusal shape as every other HR error (Arabic `error`, English `errorEn`, code), so a
    // login without the HR module reads the refusal in Arabic too. Status and rule unchanged.
    if (!opts.self && !hasModuleAccess(actor.permissions, "hr")) return hrErrorResponse(new HrError("Insufficient permissions", 403, "FORBIDDEN"));
    // Owner decision (SOD.md §19): every HR permission except the directory is privileged, so a
    // non-self HR change by a privileged actor is the exercise of one — a verified individual only.
    // (Self-service routes are the person's own requests, not the exercise of a permission.)
    if (!opts.self && request.method !== "GET" && request.method !== "HEAD" && isPrivileged(actor.permissions, actor.role)) {
      try {
        await assertVerifiedActor(actor, `hr:${request.method} ${new URL(request.url).pathname.replace(/\/[a-z0-9]{20,}(?=\/|$)/g, "/:id")}`);
      } catch (err) {
        return hrErrorResponse(err);
      }
    }
    try {
      const now = new Date();
      const params = ctx?.params ? await ctx.params : {};
      const result = await fn({ actor, request, params, query: new URL(request.url).searchParams, now, today: await hrToday(now) });
      if (result instanceof Response) return result;
      return NextResponse.json(result ?? { ok: true }, { status: opts.status ?? 200 });
    } catch (err) {
      return hrErrorResponse(err);
    }
  };
}
