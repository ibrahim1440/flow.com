/**
 * `NextResponse` for the API routes, with the Arabic of every refusal added on the server.
 *
 * The shared refusal helpers (`forbidden`, `unauthorized`, `handleDomainError`, `handlePrismaError`)
 * already add `errorAr` (DEF-08/09), but most routes also answer refusals inline (a literal English
 * error string in NextResponse.json with a 4xx status), and those carried the English only. Every
 * route handler and every server helper that builds a response imports `NextResponse` from here
 * instead of "next/server", so each refusal passes through the one shared helper, withArabicError:
 *
 *   - only an error response (status 400 and above) whose body is a plain object with an English
 *     `error` string is touched;
 *   - `errorAr` is added when the English is known (src/lib/i18n/api-errors-ar.ts); the English
 *     `error`, every other field and the status stay exactly as the route wrote them;
 *   - a body that already carries Arabic (`errorAr`, or the Arabic `error` of the HR-style routes)
 *     is left alone.
 *
 * tests/ops/unit/api-errors-ar.test.ts enforces both halves: every route file imports this module
 * (allow-listed machine-facing routes excepted, each with its reason) and every English refusal
 * written in src/app/api and src/lib has its Arabic.
 */
import { NextResponse as NextBase } from "next/server";
import { withArabicError } from "@/lib/i18n/api-errors";

function statusOf(init: ResponseInit | undefined): number {
  return typeof init?.status === "number" ? init.status : 200;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
}

/** The body as sent, with `errorAr` added to an error response when its English is known. */
export function localizeErrorBody<T>(body: T, init?: ResponseInit): T {
  if (statusOf(init) < 400 || !isPlainObject(body)) return body;
  return withArabicError(body) as T;
}

export class NextResponse<Body = unknown> extends NextBase<Body> {
  static json<JsonBody>(body: JsonBody, init?: ResponseInit): NextBase<JsonBody> {
    return NextBase.json(localizeErrorBody(body, init), init);
  }
}
