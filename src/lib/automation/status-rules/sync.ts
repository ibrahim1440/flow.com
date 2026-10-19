/**
 * «تحديث الحالات» — read every status the system has right now and bring the catalogue
 * (WhatsAppStatusRule) up to date with it. The screen runs it on open and from its button.
 *
 * Idempotent and safe to run concurrently: the whole sync holds a transaction-scoped advisory
 * lock, creates with skipDuplicates on (source, statusKey), and a second run on an unchanged
 * system plans nothing but "seen". A status found for the first time arrives OFF; one that is
 * gone or hidden keeps its row and its saved choices, marked inactive (planSync in rules.ts).
 */
import type { Prisma } from "@/generated/prisma/client";
import { planSync, reportOf, type FoundStatus, type SyncReport } from "./rules";
import { knownLabel, STATUS_SOURCES, type Collector, type StatusSource } from "./sources";

type Tx = Prisma.TransactionClient;

/** pg_advisory_xact_lock key: "WAST" — one sync at a time across every server instance. */
const SYNC_LOCK = 0x57415354;

const ENUM_TYPES = new Set(["QuoteStatus", "ProductionOrderStatus", "OpportunityOutcome", "SalesCollectionStatus", "FinApprovalStatus"]);
const DISTINCT = new Set(["Order.status", "RoastingBatch.status", "Delivery.deliveryType"]);

/** The values a collector reads. Identifiers come from the fixed sets above, never from input. */
async function collect(tx: Tx, c: Collector): Promise<{ key: string; ar?: string; en?: string; visible?: boolean }[]> {
  if (c.kind === "static") return [];
  if (c.kind === "enum") {
    if (!ENUM_TYPES.has(c.type)) throw new Error(`Unknown enum ${c.type}`);
    const rows = await tx.$queryRawUnsafe<{ v: string }[]>(`SELECT unnest(enum_range(NULL::"${c.type}"))::text AS v`);
    return rows.map((r) => ({ key: r.v }));
  }
  if (c.kind === "distinct") {
    if (!DISTINCT.has(`${c.table}.${c.column}`)) throw new Error(`Unknown column ${c.table}.${c.column}`);
    const rows = await tx.$queryRawUnsafe<{ v: string }[]>(
      `SELECT DISTINCT "${c.column}" AS v FROM "${c.table}" WHERE "${c.column}" IS NOT NULL AND btrim("${c.column}") <> '' ORDER BY 1 LIMIT 200`,
    );
    return rows.map((r) => ({ key: r.v }));
  }
  const stages = await tx.pipelineStage.findMany({ orderBy: { position: "asc" }, select: { code: true, nameAr: true, nameEn: true, isActive: true } });
  return stages.map((st) => ({ key: st.code, ar: st.nameAr || st.nameEn, en: st.nameEn || st.nameAr, visible: st.isActive }));
}

/** Every status of one source: the ones code knows of first (in their order), then the database's. */
export async function statusesOfSource(tx: Tx, source: StatusSource): Promise<FoundStatus[]> {
  const fromDb = await collect(tx, source.collector);
  const out: FoundStatus[] = [];
  const seen = new Set<string>();
  const add = (key: string, ar: string, en: string, visible = true) => {
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ source: source.key, statusKey: key, labelAr: ar, labelEn: en, position: out.length, visible });
  };
  // An enum the database no longer has is gone, even if code still names it: the database wins.
  const enumKeys = source.collector.kind === "enum" ? new Set(fromDb.map((r) => r.key)) : null;
  for (const k of source.known) if (!enumKeys || enumKeys.has(k.value)) add(k.value, k.ar, k.en);
  for (const r of fromDb) {
    const label = knownLabel(source, r.key);
    add(r.key, r.ar ?? label.ar, r.en ?? label.en, r.visible ?? true);
  }
  return out;
}

export async function collectAllStatuses(tx: Tx): Promise<FoundStatus[]> {
  const all: FoundStatus[] = [];
  for (const source of STATUS_SOURCES) all.push(...(await statusesOfSource(tx, source)));
  return all;
}

export type SyncResult = SyncReport & { syncedAt: Date; firstSync: boolean };

/**
 * Run one sync inside `tx`. The first sync of a database (empty catalogue) marks what it
 * creates as already reviewed — the whole list is not "new" on the day the feature arrives;
 * statuses found by any later sync carry the «جديدة» chip until the owner saves them.
 */
export async function syncStatusCatalogue(tx: Tx, now = new Date()): Promise<SyncResult> {
  await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(${SYNC_LOCK})`);
  const stored = await tx.whatsAppStatusRule.findMany({
    select: { id: true, source: true, statusKey: true, labelAr: true, labelEn: true, position: true, active: true },
  });
  const firstSync = stored.length === 0;
  const found = await collectAllStatuses(tx);
  const plan = planSync(stored, found);

  if (plan.create.length) {
    await tx.whatsAppStatusRule.createMany({
      data: plan.create.map((c) => ({
        source: c.source,
        statusKey: c.statusKey,
        labelAr: c.labelAr,
        labelEn: c.labelEn,
        position: c.position,
        active: c.active,
        enabled: false,
        firstSeenAt: now,
        lastSeenAt: now,
        inactiveSince: c.active ? null : now,
        reviewedAt: firstSync ? now : null,
      })),
      skipDuplicates: true,
    });
  }
  for (const ch of plan.changes) {
    if (ch.kind === "deactivated") {
      await tx.whatsAppStatusRule.update({ where: { id: ch.id }, data: { active: false, inactiveSince: now } });
    } else if (ch.kind === "reactivated") {
      await tx.whatsAppStatusRule.update({ where: { id: ch.id }, data: { active: true, inactiveSince: null, labelAr: ch.labelAr, labelEn: ch.labelEn, position: ch.position } });
    } else {
      await tx.whatsAppStatusRule.update({ where: { id: ch.id }, data: { labelAr: ch.labelAr, labelEn: ch.labelEn, position: ch.position } });
    }
  }
  if (plan.seen.length) {
    await tx.whatsAppStatusRule.updateMany({ where: { id: { in: plan.seen } }, data: { lastSeenAt: now } });
  }
  return { ...reportOf(plan), syncedAt: now, firstSync };
}

/** When the catalogue was last brought up to date: the newest lastSeenAt. */
export async function lastSyncedAt(db: Tx): Promise<Date | null> {
  const r = await db.whatsAppStatusRule.aggregate({ _max: { lastSeenAt: true } });
  return r._max.lastSeenAt ?? null;
}
