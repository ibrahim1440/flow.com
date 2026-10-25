// «مساحة عملي» — the route wrapper: authenticate (any ERP login; a station session is refused like every
// ERP route), build the actor from the SESSION, run, map refusals. Every rule is in the services.
import { after } from "next/server";
import { NextResponse } from "@/lib/api-response";
import { requireAuth } from "@/lib/auth-server";
import { handleDomainError } from "@/lib/api-error";
import { prisma } from "@/lib/db";
import type { WsActor } from "./context";

type RouteCtx = { params: Promise<Record<string, string>> };
export type WsArgs = { actor: WsActor; request: Request; params: Record<string, string>; query: URLSearchParams; body: Record<string, unknown> };

/** The workspace actor of a session (identity and permissions; the role travels for the permission defaults). */
export function actorFrom(user: { id: string; name: string; role: string; permissions: WsActor["permissions"]; authTime?: Date | string }, name?: string | null): WsActor {
  return { id: user.id, name: name ?? user.name, role: user.role, permissions: user.permissions, authTime: user.authTime };
}

export function wsRoute(fn: (a: WsArgs) => Promise<unknown>, opts: { status?: number } = {}) {
  return async (request: Request, ctx: RouteCtx) => {
    const { user, error } = await requireAuth();
    if (error) return error;
    try {
      const me = await prisma.employee.findUnique({ where: { id: user.id }, select: { name: true } });
      const actor = actorFrom(user, me?.name);
      let body: Record<string, unknown> = {};
      if (request.method !== "GET" && request.method !== "HEAD") {
        try {
          const j = await request.json();
          body = j && typeof j === "object" && !Array.isArray(j) ? (j as Record<string, unknown>) : {};
        } catch {
          return NextResponse.json({ error: "تعذّرت قراءة الطلب.", errorEn: "Invalid JSON body.", code: "BAD_JSON" }, { status: 400 });
        }
      }
      const params = ctx?.params ? await ctx.params : {};
      const result = await fn({ actor, request, params, query: new URL(request.url).searchParams, body });
      if (request.method === "GET") kickReminders();
      return NextResponse.json(result ?? { ok: true }, { status: opts.status ?? 200 });
    } catch (err) {
      return handleDomainError(err);
    }
  };
}

/** After the response: the reminders that are due (at most once a minute per instance). */
export function kickReminders() {
  try {
    after(async () => {
      const { maybeRunReminders } = await import("./reminders");
      await maybeRunReminders();
    });
  } catch {
    // outside a request
  }
}
