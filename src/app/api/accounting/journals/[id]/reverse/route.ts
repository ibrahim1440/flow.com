import { accountingRoute, body, str } from "@/lib/accounting/http";
import { requestJournalReversal } from "@/lib/accounting/journal-service";
import { accountingDate } from "@/lib/accounting/dates";

// Requests a reversal: the mirror entry is created SUBMITTED and needs a second approval.
const handler = accountingRoute("journal_reverse", async ({ user, request, params }) => {
  const b = await body(request);
  const date = b.date ? accountingDate(b.date) : undefined;
  return requestJournalReversal(params.id, user.id, str(b.reason, "reason")!, date);
}, 201);
export const POST = handler;
export const PATCH = handler;
