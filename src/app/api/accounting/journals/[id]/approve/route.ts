import { NextResponse } from "next/server";
import { requireSub } from "@/lib/auth-server";
import { handlePrismaError } from "@/lib/api-error";
import { approveJournalEntry } from "@/lib/accounting/journal-service";
import { AccountingError } from "@/lib/accounting/errors";

type Params = { params: Promise<{ id: string }> };

export async function PATCH(_request: Request, { params }: Params) {
  const { user, error } = await requireSub("accounting", "journal_approve");
  if (error) return error;

  const { id } = await params;

  try {
    const entry = await approveJournalEntry(id, user.id);
    return NextResponse.json(entry);
  } catch (err) {
    if (err instanceof AccountingError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    return handlePrismaError(err);
  }
}
