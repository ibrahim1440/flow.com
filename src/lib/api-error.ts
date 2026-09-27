import { NextResponse } from "next/server";

/**
 * A refusal the domain raised deliberately, mapped to the status it asked for.
 *
 * Services throw `{ _appCode, message }` for business refusals — "a deal cannot be won
 * without a customer", "this quote is already accepted" — because a service must not
 * import NextResponse to say no. Without this branch every one of those surfaced as a
 * 500 with "An unexpected error occurred", which tells the operator nothing and reads in
 * the logs as a crash rather than as the guard doing its job. That exact confusion cost a
 * debugging session on the packaging routes, so it is one shared helper now rather than
 * the same six lines copied into each route.
 */
export function handleDomainError(err: unknown): NextResponse {
  if (err && typeof err === "object" && "_appCode" in err) {
    const e = err as { _appCode: number; message?: string };
    const status = Number.isInteger(e._appCode) && e._appCode >= 400 && e._appCode < 600 ? e._appCode : 400;
    return NextResponse.json({ error: e.message ?? "Refused." }, { status });
  }
  return handlePrismaError(err);
}

export function handlePrismaError(err: unknown): NextResponse {
  if (err && typeof err === "object" && "code" in err) {
    const code = (err as { code: string }).code;
    if (code === "P2002") {
      return NextResponse.json({ error: "A record with these details already exists." }, { status: 409 });
    }
    if (code === "P2003" || code === "P2014") {
      return NextResponse.json({ error: "Cannot complete: a related record is missing or still referenced." }, { status: 409 });
    }
    if (code === "P2025") {
      return NextResponse.json({ error: "Record not found." }, { status: 404 });
    }
  }
  console.error("[API Error]", err);
  return NextResponse.json({ error: "An unexpected error occurred. Please try again." }, { status: 500 });
}
