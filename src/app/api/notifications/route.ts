import { after } from "next/server";
import { NextResponse } from "@/lib/api-response";
import { requireAuth } from "@/lib/auth-server";
import { handleDomainError } from "@/lib/api-error";
import { listNotifications, sweepNotifications } from "@/lib/notifications/service";

let lastDelivery = 0;

/**
 * GET /api/notifications — the signed-in person's OWN notifications (the bell and «التنبيهات»):
 * ?category=sales|production|quality|finance|hr|me|system · ?unread=1 · ?before=<ISO> · ?limit=1..100.
 * Returns { items, unread, unreadByCategory, next }. Every signed-in ERP account; a station session
 * is refused (401) like every ERP route. After the response: the 90-day retention (hourly per
 * instance) and any e-mail still waiting (at most once a minute per instance).
 */
export async function GET(request: Request) {
  const { user, error } = await requireAuth();
  if (error) return error;
  const u = new URL(request.url);
  try {
    const out = await listNotifications(user.id, {
      category: u.searchParams.get("category"),
      unread: u.searchParams.get("unread") === "1",
      before: u.searchParams.get("before"),
      limit: Number(u.searchParams.get("limit")) || 20,
    });
    try {
      after(async () => {
        await sweepNotifications();
        if (Date.now() - lastDelivery > 60_000) {
          lastDelivery = Date.now();
          const { deliverPendingEmails } = await import("@/lib/notifications/deliver");
          await deliverPendingEmails({ limit: 50 });
        }
      });
    } catch { /* outside a request */ }
    return NextResponse.json(out);
  } catch (err) {
    return handleDomainError(err);
  }
}
