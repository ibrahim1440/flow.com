import { accountingRoute } from "@/lib/accounting/http";
import { approveJournalEntry } from "@/lib/accounting/journal-service";

const handler = accountingRoute("journal_approve", ({ user, params }) => approveJournalEntry(params.id, user.id));
// PATCH kept for existing clients; POST is what the accounting screens use.
export const POST = handler;
export const PATCH = handler;
