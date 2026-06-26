import { NextResponse } from "next/server";
import { requireSub } from "@/lib/auth-server";
import { handlePrismaError } from "@/lib/api-error";
import { postJournalEntry } from "@/lib/accounting/journal-service";
import { AccountingError } from "@/lib/accounting/errors";

type Params = { params: Promise<{ id: string }> };

export async function PATCH(_request: Request, { params }: Params) {
  const { user, error } = await requireSub("accounting", "journal_post");
  if (error) return error;
  // Defense in depth: there is no role hierarchy above "admin" yet (see saas-readiness.md).
  if (user.role !== "admin") {
    return NextResponse.json({ error: "Insufficient permissions." }, { status: 403 });
  }

  const { id } = await params;

  try {
    const entry = await postJournalEntry(id, user.id);
    return NextResponse.json(entry);
  } catch (err) {
    if (err instanceof AccountingError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    return handlePrismaError(err);
  }
}
