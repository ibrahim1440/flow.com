/**
 * What the «إشعارات الحالات» screen reads: every catalogue row with its source's facts, and
 * when the catalogue was last brought up to date. Shared by GET /api/automation/status-rules
 * and the sync route so both answer with the same shape.
 */
import type { Prisma } from "@/generated/prisma/client";
import { parseRecipients } from "./rules";
import { getStatusSource, STATUS_SOURCES, statusCanFire } from "./sources";
import { lastSyncedAt } from "./sync";

type Tx = Prisma.TransactionClient;

export type StatusRuleView = {
  id: string;
  source: string;
  statusKey: string;
  labelAr: string;
  labelEn: string;
  position: number;
  enabled: boolean;
  recipients: string[];
  template: string;
  renotify: boolean;
  active: boolean;
  canFire: boolean;
  isNew: boolean;
  firstSeenAt: string;
  lastSeenAt: string;
  inactiveSince: string | null;
  updatedAt: string;
  last30Days: Record<string, number>;
};

const ORDER = new Map(STATUS_SOURCES.map((s, i) => [s.key as string, i]));

export async function readStatusRules(db: Tx): Promise<{ rules: StatusRuleView[]; lastSyncedAt: string | null }> {
  const since = new Date(Date.now() - 30 * 86_400_000);
  const [rows, synced, counts] = await Promise.all([
    db.whatsAppStatusRule.findMany(),
    lastSyncedAt(db),
    db.$queryRaw<{ source: string; key: string; status: string; n: number }[]>`
      SELECT split_part("dedupeKey", ':', 2) AS source, split_part("dedupeKey", ':', 3) AS key, status::text AS status, count(*)::int AS n
        FROM "WhatsAppMessage"
       WHERE "dedupeKey" LIKE 'status:%' AND "createdAt" >= ${since}
       GROUP BY 1, 2, 3`,
  ]);
  const stats = new Map<string, Record<string, number>>();
  for (const c of counts) {
    const k = `${c.source}:${c.key}`;
    const row = stats.get(k) ?? {};
    row[c.status] = c.n;
    stats.set(k, row);
  }
  const rules = rows
    .map((r) => {
      const src = getStatusSource(r.source);
      return {
        id: r.id,
        source: r.source,
        statusKey: r.statusKey,
        labelAr: r.labelAr,
        labelEn: r.labelEn,
        position: r.position,
        enabled: r.enabled,
        recipients: parseRecipients(r.recipients),
        template: r.template,
        renotify: r.renotify,
        active: r.active && !!src,
        canFire: !!src && statusCanFire(src, r.statusKey),
        isNew: r.reviewedAt === null,
        firstSeenAt: r.firstSeenAt.toISOString(),
        lastSeenAt: r.lastSeenAt.toISOString(),
        inactiveSince: r.inactiveSince?.toISOString() ?? null,
        updatedAt: r.updatedAt.toISOString(),
        last30Days: stats.get(`${r.source}:${r.statusKey}`) ?? {},
      };
    })
    .sort((a, b) => (ORDER.get(a.source) ?? 99) - (ORDER.get(b.source) ?? 99) || Number(b.active) - Number(a.active) || a.position - b.position);
  return { rules, lastSyncedAt: synced?.toISOString() ?? null };
}
