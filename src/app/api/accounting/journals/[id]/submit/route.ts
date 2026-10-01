import { accountingRoute } from "@/lib/accounting/http";
import { submitJournalEntry } from "@/lib/accounting/journal-service";

const handler = accountingRoute("journal_submit", ({ user, params }) => submitJournalEntry(params.id, user.id));
// PATCH kept for existing clients; POST is what the accounting screens use.
export const POST = handler;
export const PATCH = handler;
