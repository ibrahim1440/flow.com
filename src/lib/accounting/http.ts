// Route plumbing for the accounting API: server-side permission check first, then the
// handler; domain refusals and database-guard refusals become JSON errors with their status.
import { NextResponse } from "next/server";
import { requireModule, requireSub } from "@/lib/auth-server";
import { handlePrismaError } from "@/lib/api-error";
import { AccountingError, databaseGuardMessage } from "./errors";

type User = { id: string };
type Ctx = { user: User; request: Request; params: Record<string, string> };

export function accountingRoute(sub: string | null, handler: (ctx: Ctx) => Promise<unknown>, okStatus = 200) {
  return async (request: Request, context?: { params?: Promise<Record<string, string>> }) => {
    const auth = sub ? await requireSub("accounting", sub) : await requireModule("accounting");
    if (auth.error) return auth.error;
    try {
      const params = (await context?.params) ?? {};
      const out = await handler({ user: auth.user as User, request, params });
      if (out instanceof Response) return out;
      return NextResponse.json(out ?? { ok: true }, { status: okStatus });
    } catch (err) {
      if (err instanceof AccountingError) return NextResponse.json({ error: err.message, details: err.details }, { status: err.status });
      const guard = databaseGuardMessage(err);
      if (guard) return NextResponse.json({ error: guard }, { status: 409 });
      return handlePrismaError(err);
    }
  };
}

export async function body(request: Request): Promise<Record<string, unknown>> {
  try {
    const b = await request.json();
    if (!b || typeof b !== "object" || Array.isArray(b)) throw new Error();
    return b as Record<string, unknown>;
  } catch {
    throw new AccountingError("Invalid JSON body.", 400);
  }
}

export function str(v: unknown, field: string, opts: { optional?: boolean; min?: number } = {}): string | undefined {
  if (v === undefined || v === null || v === "") {
    if (opts.optional) return undefined;
    throw new AccountingError(`${field} is required.`, 400);
  }
  if (typeof v !== "string") throw new AccountingError(`${field} must be text.`, 400);
  if (opts.min && v.trim().length < opts.min) throw new AccountingError(`${field} must be at least ${opts.min} characters.`, 400);
  return v;
}

export function query(request: Request) {
  return new URL(request.url).searchParams;
}
