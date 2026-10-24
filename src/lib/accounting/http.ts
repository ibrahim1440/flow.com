// Accounting core A1 — the routes' shared answers: a coded refusal (Arabic `error`, English `errorEn`, `code`),
// a database guard's refusal (mapped in ./refusals), or the shared domain / Prisma handling.
import { NextResponse } from "@/lib/api-response";
import { handleDomainError } from "@/lib/api-error";
import { AccountingError, accountingErrorJson } from "./errors";
import { refuse } from "./refusals";

export function acctError(err: unknown): NextResponse {
  if (err instanceof AccountingError) return NextResponse.json(accountingErrorJson(err), { status: err.status });
  return handleDomainError(err);
}

/** The JSON body as an object, or a coded 400. */
export async function jsonBody(request: Request): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw refuse("BAD_INPUT", "The body is not JSON.");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw refuse("BAD_INPUT", "The body is a JSON object.");
  return body as Record<string, unknown>;
}

export const qp = (request: Request, name: string): string | null => new URL(request.url).searchParams.get(name);
