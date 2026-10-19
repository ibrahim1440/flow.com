// Request helpers shared by the settings-section routes (/api/settings/production, inventory, invoicing).
import { NextResponse } from "next/server";
import { fieldErrorBody, type FieldError } from "./roasters";

/** The JSON object of a request body, or the 400 to return. */
export async function readObject(request: Request): Promise<{ body: Record<string, unknown>; error: null } | { body: null; error: NextResponse }> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return { body: null, error: NextResponse.json({ error: "Invalid JSON body.", code: "INVALID_BODY" }, { status: 400 }) };
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { body: null, error: NextResponse.json({ error: "Invalid JSON body.", code: "INVALID_BODY" }, { status: 400 }) };
  }
  return { body: body as Record<string, unknown>, error: null };
}

/** 400 with the field errors (the page draws the frame's summary and the inline messages). */
export function fieldErrors(errors: FieldError[], status = 400): NextResponse {
  return NextResponse.json(fieldErrorBody(errors), { status });
}

export function notFound(what: "roaster" | "maintenance"): NextResponse {
  return what === "roaster"
    ? NextResponse.json({ error: "المحمصة غير موجودة.", errorEn: "Roaster not found.", code: "NOT_FOUND" }, { status: 404 })
    : NextResponse.json({ error: "موعد الصيانة غير موجود.", errorEn: "Maintenance window not found.", code: "NOT_FOUND" }, { status: 404 });
}

/** A thrown refusal inside a transaction (handled by handleDomainError, keeping its code). */
export function refusal(status: number, ar: string, en: string, code: string, extra: Record<string, unknown> = {}) {
  return { _appCode: status, message: ar, errorEn: en, code, ...extra };
}

/** A complete response thrown from inside a transaction (rolls it back) and returned as is by the route. */
export class RouteError extends Error {
  constructor(public response: NextResponse) {
    super("route refusal");
  }
}

/** The response for an error caught around a transaction: a RouteError's own, else null (let the caller map it). */
export function routeErrorResponse(err: unknown): NextResponse | null {
  return err instanceof RouteError ? err.response : null;
}

/** A Postgres unique violation on one of these constraint / index names. */
export function isUniqueViolation(err: unknown, names: string[]): boolean {
  const e = err as { code?: string; meta?: { target?: unknown; constraint?: unknown }; message?: string };
  if (e?.code !== "P2002" && !/unique constraint|duplicate key/i.test(e?.message ?? "")) return false;
  const text = JSON.stringify(e?.meta ?? {}) + (e?.message ?? "");
  return names.some((n) => text.includes(n));
}
