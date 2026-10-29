// «الأصول الثابتة» at go-live — the opening-valuation tool's pattern (../ops/valuation.ts applyOpening): what the
// register holds that the general ledger does not (events SKIPPED before go-live — acquisitions, depreciation runs,
// additions, disposals recorded while accounting was off — and the OPENING assets: cost and accumulated depreciation
// carried in from the old books) goes into A1's opening-balance grid as one debit line per cost account and one credit
// line per accumulated-depreciation account (marked «أصول ثابتة (افتتاحي)»); the grid's other lines are kept. Only the
// balance-sheet side is carried: what was skipped on the P&L side (depreciation expense, gains / losses before go-live)
// is history of the old books, and the grid's difference closes to opening balance equity as for every opening line.
// Repeatable until the opening is posted; final after.
import { prisma, TX_OPTS } from "@/lib/db";
import { Decimal, ZERO } from "../money";
import { dayText } from "../dates";
import { setAuditContext, type AuditContext } from "../audit";
import { checkDimensions, checkLineAccount, loadAccounts, resolveRoles, type NormalLine } from "../posting-engine";
import { opsRefuse } from "../ops/refusals";
import { assertGoLiveFirstOfMonth, dec, FA_ROLES, type Tx } from "./common";

export const FA_OPENING_MARK = "أصول ثابتة (افتتاحي)";

type Db = Tx | typeof prisma;

/** Σ of the not-posted events (SKIPPED / OPENING) by account: cost slot and accumulated slot. */
async function notInBooks(db: Db) {
  const rows = await db.$queryRaw<{ slot: string; accountId: string | null; v: Decimal; n: bigint; after: Decimal }[]>`
    WITH r AS (SELECT (SELECT "accountId" FROM "AccountRole" WHERE "tenantId" = 'hiqbah' AND "role" = ${FA_ROLES.cost}) AS cost,
                      (SELECT "accountId" FROM "AccountRole" WHERE "tenantId" = 'hiqbah' AND "role" = ${FA_ROLES.accum}) AS accum),
         s AS (SELECT "goLiveDate" FROM "AccountingSettings" WHERE "id" = 'singleton')
    SELECT x.slot, x."accountId", coalesce(sum(x.v), 0) AS v, count(*) AS n, coalesce(sum(CASE WHEN x."eventDate" >= (SELECT "goLiveDate" FROM s) THEN x.v ELSE 0 END), 0) AS after FROM (
      SELECT 'cost' AS slot, coalesce(c."costAccountId", r.cost) AS "accountId", e."costDelta" AS v, e."eventDate" FROM "FixedAssetEvent" e JOIN "FixedAsset" a ON a."id" = e."assetId" JOIN "FixedAssetCategory" c ON c."id" = a."categoryId", r
       WHERE e."glState" IN ('SKIPPED', 'OPENING') AND e."costDelta" <> 0
      UNION ALL
      SELECT 'accum', coalesce(c."accumAccountId", r.accum), e."accumDelta", e."eventDate" FROM "FixedAssetEvent" e JOIN "FixedAsset" a ON a."id" = e."assetId" JOIN "FixedAssetCategory" c ON c."id" = a."categoryId", r
       WHERE e."glState" IN ('SKIPPED', 'OPENING') AND e."accumDelta" <> 0) x
    GROUP BY 1, 2`;
  return rows.map((r) => ({ slot: r.slot as "cost" | "accum", accountId: r.accountId, value: dec(r.v), events: Number(r.n), afterGoLive: dec(r.after) }));
}

export async function faOpeningPreview(db: Db = prisma) {
  const st = await db.accountingSettings.findUnique({ where: { id: "singleton" }, select: { goLiveDate: true, openingEntryId: true, accountingActive: true } });
  const sums = await notInBooks(db);
  const ids = [...new Set(sums.map((s) => s.accountId).filter((x): x is string => !!x))];
  const accounts = new Map((await db.account.findMany({ where: { id: { in: ids } }, select: { id: true, code: true, nameAr: true, nameEn: true } })).map((a) => [a.id, a]));
  // Cost lines are debits and accumulated lines credits; a negative sum (more taken out than carried in) flips the side.
  const lines = sums.filter((s) => !s.value.isZero()).map((s) => {
    const debit = s.slot === "cost" ? s.value : s.value.negated();
    const a = s.accountId ? accounts.get(s.accountId) : null;
    return { slot: s.slot, accountId: s.accountId, account: a ? { code: a.code, name: a.nameAr ?? a.nameEn } : null, debit: debit.gt(0) ? debit.toFixed(2) : "0.00", credit: debit.lt(0) ? debit.abs().toFixed(2) : "0.00", events: s.events, afterGoLive: s.afterGoLive.toFixed(2) };
  });
  const grid = await db.openingBalanceLine.findMany({ where: { description: FA_OPENING_MARK }, select: { accountId: true, debit: true, credit: true } });
  const key = (accountId: string | null, d: string, c: string) => `${accountId}|${d}|${c}`;
  const want = new Set(lines.map((l) => key(l.accountId, l.debit, l.credit)));
  const have = new Set(grid.map((g) => key(g.accountId, dec(g.debit).toFixed(2), dec(g.credit).toFixed(2))));
  const faAccountIds = [...new Set(lines.map((l) => l.accountId).filter((x): x is string => !!x))];
  const others = faAccountIds.length ? await db.openingBalanceLine.findMany({ where: { accountId: { in: faAccountIds }, NOT: { description: FA_OPENING_MARK } }, select: { accountId: true, debit: true, credit: true } }) : [];
  return {
    goLiveDate: st?.goLiveDate ? dayText(st.goLiveDate) : null, active: !!st?.accountingActive, openingPosted: !!st?.openingEntryId,
    goLiveFirstOfMonth: !st?.goLiveDate || st.goLiveDate.getUTCDate() === 1,
    lines, unmapped: lines.some((l) => !l.accountId),
    inGrid: lines.length === grid.length && [...want].every((k) => have.has(k)),
    otherGridLines: { count: others.length, debit: others.reduce((t, o) => t.plus(o.debit), ZERO).toFixed(2), credit: others.reduce((t, o) => t.plus(o.credit), ZERO).toFixed(2) },
    afterGoLive: sums.reduce((t, s) => t.plus(s.afterGoLive.abs()), ZERO).toFixed(2),
  };
}

/** Write the fixed-asset lines into the opening grid (replacing the tool's previous ones; every other line kept). */
export async function applyFaOpening(ctx: AuditContext) {
  return prisma.$transaction(async (tx) => {
    await setAuditContext(tx, { ...ctx, reason: ctx.reason ?? "opening fixed assets" });
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('accounting:opening', 0))`;
    const p = await faOpeningPreview(tx);
    if (p.openingPosted) throw opsRefuse("OPENING_ALREADY_POSTED");
    assertGoLiveFirstOfMonth(p.goLiveDate ? new Date(`${p.goLiveDate}T00:00:00Z`) : null);
    if (p.unmapped) await resolveRoles(tx, [FA_ROLES.cost, FA_ROLES.accum]);
    const grid = await tx.openingBalanceLine.findMany({ orderBy: { lineNo: "asc" } });
    const kept = grid.filter((l) => l.description !== FA_OPENING_MARK);
    const add = p.lines.map((l) => ({ accountId: l.accountId as string, debit: dec(l.debit), credit: dec(l.credit), partyType: null, partyId: null, branchId: null, costCenterId: null, description: FA_OPENING_MARK }));
    const all = [...kept.map((l) => ({ accountId: l.accountId, debit: dec(l.debit), credit: dec(l.credit), partyType: l.partyType, partyId: l.partyId, branchId: l.branchId, costCenterId: l.costCenterId, description: l.description })), ...add];
    const accounts = await loadAccounts(tx, all.map((l) => l.accountId));
    const dims = (l: (typeof all)[number]): NormalLine["dims"] => ({ branchId: l.branchId, costCenterId: l.costCenterId, partyType: (l.partyType as NormalLine["dims"]["partyType"]) ?? null, partyId: l.partyId, itemType: null, itemId: null });
    for (const l of all) checkLineAccount(accounts.get(l.accountId), { dims: dims(l) });
    await checkDimensions(tx, all.map((l) => ({ dims: dims(l) })));
    await tx.openingBalanceLine.deleteMany({});
    if (all.length) await tx.openingBalanceLine.createMany({ data: all.map((l, i) => ({ lineNo: i + 1, accountId: l.accountId, debit: l.debit, credit: l.credit, partyType: l.partyType, partyId: l.partyId, branchId: l.branchId, costCenterId: l.costCenterId, description: l.description, updatedBy: ctx.actorId })) });
    return { gridLines: add.length, lines: p.lines };
  }, TX_OPTS);
}
