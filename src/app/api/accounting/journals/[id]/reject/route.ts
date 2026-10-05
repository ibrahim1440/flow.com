import { accountingRoute, body, str } from "@/lib/accounting/http";
import { rejectJournalEntry } from "@/lib/accounting/journal-service";

export const POST = accountingRoute("journal_approve", async ({ user, request, params }) => {
  const b = await body(request);
  return rejectJournalEntry(params.id, user.id, str(b.reason, "reason")!);
});
