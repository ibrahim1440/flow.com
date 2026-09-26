// HTTP-only helpers for finance route handlers (kept apart so services stay importable
// outside Next.js, e.g. by the integration tests).
import { NextResponse } from "next/server";
import { hasModuleAccess } from "@/lib/auth-shared";
import { requireAuth } from "@/lib/auth-server";
import { handlePrismaError } from "@/lib/api-error";
import { can, FinanceError, narrowScope, resolveScope, type FinanceActor, type FinanceScope, type FinanceSub } from "./context";

/** Route wrapper: authenticate, require the finance module (and optionally a duty). */
export async function financeRoute(sub?: FinanceSub) {
  const { user, error } = await requireAuth();
  if (error) return { actor: null as never, error };
  const actor: FinanceActor = { id: user.id, role: user.role, permissions: user.permissions };
  if (!hasModuleAccess(actor.permissions, "finance")) {
    return { actor: null as never, error: NextResponse.json({ error: "Insufficient permissions" }, { status: 403 }) };
  }
  if (sub && !can(actor, sub)) {
    return { actor: null as never, error: NextResponse.json({ error: "Insufficient permissions" }, { status: 403 }) };
  }
  return { actor, error: null };
}

export function financeErrorResponse(err: unknown) {
  if (err instanceof FinanceError) {
    return NextResponse.json({ error: err.message, details: err.details }, { status: err.status });
  }
  if (err && typeof err === "object" && "name" in err && (err as Error).name === "AllocationRefused") {
    return NextResponse.json({ error: (err as Error).message }, { status: 409 });
  }
  // Database trigger refusals (append-only ledgers, approved budget lines).
  const msg = err instanceof Error ? err.message : "";
  if (/append-only financial record|cannot be changed|cannot be deleted/.test(msg)) {
    return NextResponse.json({ error: "This financial record is protected and cannot be changed." }, { status: 409 });
  }
  return handlePrismaError(err);
}


type RouteCtx = { params: Promise<Record<string, string>> };
export type HandlerArgs = {
  actor: FinanceActor;
  scope: FinanceScope;
  request: Request;
  params: Record<string, string>;
  query: URLSearchParams;
};

/**
 * Every finance route goes through this: authenticate, require the finance module and the
 * duty (checked again inside the service), resolve the caller's branch scope on the server
 * (optionally narrowed by ?branch=), run, and map errors. Hiding a button is never the
 * control — this is.
 */
export function financeHandler(sub: FinanceSub | undefined, fn: (a: HandlerArgs) => Promise<unknown>, okStatus = 200) {
  return async (request: Request, ctx: RouteCtx) => {
    const { actor, error } = await financeRoute(sub);
    if (error) return error;
    try {
      const query = new URL(request.url).searchParams;
      const scope = narrowScope(await resolveScope(actor), query.get("branch"));
      const params = ctx?.params ? await ctx.params : {};
      const result = await fn({ actor, scope, request, params, query });
      if (result instanceof Response) return result;
      return NextResponse.json(result ?? { ok: true }, { status: okStatus });
    } catch (err) {
      return financeErrorResponse(err);
    }
  };
}
