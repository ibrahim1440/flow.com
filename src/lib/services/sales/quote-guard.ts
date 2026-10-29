// The server half of src/lib/services/sales/quote-access.ts (BATCH22 WP-E): the door of every quote route.
import { NextResponse } from "@/lib/api-response";
import { requireAuth, privilegedGate, forbidden } from "@/lib/auth-server";
import { hasSubPrivilege } from "@/lib/auth-shared";
import { canViewQuotes, canWriteQuotes } from "./quote-access";

/** GET: the sales module or the accounting module. */
export async function requireQuoteView() {
  const { user, error } = await requireAuth();
  if (error) return { user: null as never, error };
  if (!canViewQuotes(user.permissions)) return { user: null as never, error: forbidden() };
  return { user, error: null };
}

/** Writes: `canWriteQuotes`, through the central gate of the key exercised (the accounting module is privileged). */
export async function requireQuoteWrite() {
  const { user, error } = await requireAuth();
  if (error) return { user: null as never, error };
  if (!canWriteQuotes(user.permissions)) return { user: null as never, error: forbidden() };
  const viaSales = hasSubPrivilege(user.permissions, "sales", "quote_write");
  const refused = viaSales ? await privilegedGate(user, "sales", "quote_write") : await privilegedGate(user, "accounting", "quotes_issue");
  if (refused) return { user: null as never, error: refused };
  return { user, error: null };
}

/** The accountant's refusal when the deal is not open («لا توجد صفقة مفتوحة — اطلب من المبيعات فتح صفقة»). */
export function dealNotOpen() {
  return NextResponse.json({ error: "لا توجد صفقة مفتوحة — اطلب من المبيعات فتح صفقة.", errorEn: "There is no open deal — ask Sales to open one.", code: "DEAL_NOT_OPEN" }, { status: 409 });
}
