import { accountingRoute } from "@/lib/accounting/http";
import { postJournalEntry } from "@/lib/accounting/journal-service";

const handler = accountingRoute("journal_post", ({ user, params }) => postJournalEntry(params.id, user.id));
// PATCH kept for existing clients; POST is what the accounting screens use.
export const POST = handler;
export const PATCH = handler;
