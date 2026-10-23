import { NextResponse } from "@/lib/api-response";
import { requireAuth } from "@/lib/auth-server";
import { handleDomainError } from "@/lib/api-error";
import { markRead } from "@/lib/notifications/service";

/**
 * POST /api/notifications/read — { ids: string[] } marks those read, { all: true [, category] } marks
 * every unread one (of that category) read: «تعليم الكل كمقروء». Own rows only (an id of another
 * person's notification matches nothing). Read state is per person; nothing is deleted.
 */
export async function POST(request: Request) {
  const { user, error } = await requireAuth();
  if (error) return error;
  const b = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  try {
    return NextResponse.json(await markRead(user.id, b));
  } catch (err) {
    return handleDomainError(err);
  }
}
