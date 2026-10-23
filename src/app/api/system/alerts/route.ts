import { NextResponse } from "@/lib/api-response";
import { prisma } from "@/lib/db";
import { requireEdit } from "@/lib/auth-server";
import { handleDomainError } from "@/lib/api-error";

/**
 * GET /api/system/alerts — the in-app system alerts (the bell, feat/credit-hold): the latest 30, the
 * unread count and the storage incident in progress, if any. For the accounts that hold Settings at
 * edit (the administrator always) — the people the alerts are about and who can act on them.
 */
export async function GET() {
  const { error } = await requireEdit("settings");
  if (error) return error;
  try {
    const [alerts, unread, incident] = await Promise.all([
      prisma.systemAlert.findMany({ orderBy: { createdAt: "desc" }, take: 30 }),
      prisma.systemAlert.count({ where: { readAt: null } }),
      prisma.systemIncident.findFirst({ where: { status: "OPEN" }, select: { kind: true, cause: true, openedAt: true, occurrences: true, fallbackCount: true, refusedCount: true } }),
    ]);
    return NextResponse.json({ alerts, unread, incident });
  } catch (err) {
    return handleDomainError(err);
  }
}
