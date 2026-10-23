// The signed-in person's own notifications (feat/notifications): the list, the unread count,
// marking read, the e-mail preferences, and the 90-day retention. Every read and write is keyed by
// the SESSION's account id — never an id the client sends — so nobody reaches another person's rows.
import { prisma } from "@/lib/db";
import { CATEGORIES, EMAIL_DEFAULT, isCategory, type Category } from "./catalog";

export const RETENTION_DAYS = 90;
const DAY = 86_400_000;

export type ListQuery = { category?: string | null; unread?: boolean; before?: string | null; limit?: number };

export async function listNotifications(employeeId: string, q: ListQuery) {
  const limit = Math.min(Math.max(Number(q.limit) || 20, 1), 100);
  const before = q.before ? new Date(q.before) : null;
  const where = {
    recipientId: employeeId,
    createdAt: { gte: new Date(Date.now() - RETENTION_DAYS * DAY), ...(before && !Number.isNaN(+before) ? { lt: before } : {}) },
    ...(isCategory(q.category) ? { category: q.category } : {}),
    ...(q.unread ? { readAt: null } : {}),
  };
  const [rows, unread, byCategory] = await Promise.all([
    prisma.notification.findMany({
      where, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: limit + 1,
      select: { id: true, kind: true, category: true, severity: true, titleAr: true, titleEn: true, bodyAr: true, bodyEn: true, link: true, createdAt: true, readAt: true, emailState: true },
    }),
    prisma.notification.count({ where: { recipientId: employeeId, readAt: null } }),
    prisma.notification.groupBy({ by: ["category"], where: { recipientId: employeeId, readAt: null }, _count: { _all: true } }),
  ]);
  const more = rows.length > limit;
  const items = more ? rows.slice(0, limit) : rows;
  return {
    items,
    unread,
    unreadByCategory: Object.fromEntries(byCategory.map((g) => [g.category, g._count._all])),
    next: more ? items[items.length - 1].createdAt.toISOString() : null,
  };
}

/** Mark the given ids (or every unread one, optionally of one category) read. Own rows only. */
export async function markRead(employeeId: string, b: { ids?: unknown; all?: unknown; category?: unknown }) {
  const ids = Array.isArray(b.ids) ? b.ids.filter((x): x is string => typeof x === "string").slice(0, 200) : null;
  if (!ids && b.all !== true) return { read: 0 };
  const r = await prisma.notification.updateMany({
    where: { recipientId: employeeId, readAt: null, ...(ids ? { id: { in: ids } } : {}), ...(isCategory(b.category) ? { category: b.category } : {}) },
    data: { readAt: new Date() },
  });
  return { read: r.count };
}

export async function preferences(employeeId: string) {
  const rows = await prisma.notificationPreference.findMany({ where: { employeeId } });
  const own = new Map(rows.map((r) => [r.category, r.email]));
  return CATEGORIES.map((c) => ({ category: c, email: own.get(c) ?? EMAIL_DEFAULT[c], default: EMAIL_DEFAULT[c], inApp: true as const }));
}

/** { email: { sales: true, … } } — unknown categories refused. */
export async function savePreferences(employeeId: string, b: { email?: unknown }) {
  const e = b.email;
  if (!e || typeof e !== "object" || Array.isArray(e)) throw { _appCode: 400, message: "أرسل اختيارات البريد لكل فئة.", errorEn: "Send the e-mail choice per category.", code: "PREFS_REQUIRED" };
  const entries = Object.entries(e as Record<string, unknown>);
  for (const [k, v] of entries) {
    if (!isCategory(k) || typeof v !== "boolean") throw { _appCode: 400, message: "فئة أو قيمة غير معروفة.", errorEn: `Unknown category or value: ${k}.`, code: "PREFS_INVALID" };
  }
  await prisma.$transaction(entries.map(([k, v]) => prisma.notificationPreference.upsert({
    where: { employeeId_category: { employeeId, category: k as Category } },
    create: { employeeId, category: k, email: v as boolean },
    update: { email: v as boolean },
  })));
  return preferences(employeeId);
}

let lastSweep = 0;
/** Delete rows older than 90 days. At most once an hour per server instance. Never throws. */
export async function sweepNotifications(now = Date.now(), force = false): Promise<number> {
  if (!force && now - lastSweep < 60 * 60_000) return 0;
  lastSweep = now;
  try {
    const r = await prisma.notification.deleteMany({ where: { createdAt: { lt: new Date(now - RETENTION_DAYS * DAY) } } });
    return r.count;
  } catch {
    return 0;
  }
}
