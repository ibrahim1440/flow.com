import { NextResponse } from "next/server";

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
