import { NextResponse } from "@/lib/api-response";
import { prisma } from "@/lib/db";
import { requireEdit } from "@/lib/auth-server";
import { handleDomainError } from "@/lib/api-error";

/** POST /api/system/alerts/read — { ids?: string[] } marks those (or every unread alert) read. Shared read state. */
export async function POST(request: Request) {
  const { user, error } = await requireEdit("settings");
  if (error) return error;
  const b = (await request.json().catch(() => ({}))) as { ids?: unknown };
  const ids = Array.isArray(b.ids) ? b.ids.filter((x): x is string => typeof x === "string").slice(0, 100) : null;
  try {
    const r = await prisma.systemAlert.updateMany({ where: { readAt: null, ...(ids ? { id: { in: ids } } : {}) }, data: { readAt: new Date(), readById: user.id } });
    return NextResponse.json({ read: r.count });
  } catch (err) {
    return handleDomainError(err);
  }
}
