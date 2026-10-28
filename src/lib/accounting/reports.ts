// Accounting core A1 — the read models A5 builds on: trial balance (any date range), general ledger by account
// with a running balance, and the journal list / detail with the source link. One aggregate query each (no
// N+1); posted entries only (POSTED and REVERSED — a reversed entry and its reversal both stay in the books).
// Indexes: JournalEntry_posted_entryDate_idx (partial, posted), JournalEntryLine (accountId, journalEntryId).
import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { Decimal, ZERO, fix2 } from "./money";
import { dayText, parseBusinessDay } from "./dates";
import { refuse } from "./refusals";
import { postingRef } from "./posting-engine";
import { sourceDocHref } from "./source-links";

const POSTED = Prisma.sql`j."status" IN ('POSTED', 'REVERSED')`;

export function rangeOf(from: string | null, to: string | null): { from: Date; to: Date } {
  try {
    const f = parseBusinessDay(from ?? "");
    const t = parseBusinessDay(to ?? "");
    if (f > t) throw new RangeError("from after to");
    return { from: f, to: new Date(t.getTime() + 86_399_999) };
  } catch {
    throw refuse("BAD_INPUT", "from / to are YYYY-MM-DD, from ≤ to.");
  }
}

/** A signed amount (debit − credit) as a [debit, credit] pair. */
const split = (net: Decimal): [string, string] => (net.isZero() ? ["0.00", "0.00"] : net.isNegative() ? ["0.00", net.abs().toFixed(2)] : [net.toFixed(2), "0.00"]);

export type TbRow = {
  accountId: string; code: string; nameAr: string | null; nameEn: string; type: string; normalBalance: string; parentId: string | null; postable: boolean;
  openingDebit: string; openingCredit: string; periodDebit: string; periodCredit: string; closingDebit: string; closingCredit: string;
};

export async function trialBalance(from: Date, to: Date, opts: { includeZero?: boolean } = {}) {
  const rows = await prisma.$queryRaw<{ id: string; code: string; nameAr: string | null; nameEn: string; type: string; normalBalance: string; parentId: string | null; allowPosting: boolean; od: Prisma.Decimal; oc: Prisma.Decimal; pd: Prisma.Decimal; pc: Prisma.Decimal }[]>`
    WITH mv AS (
      SELECT l."accountId",
             coalesce(sum(l."debit")  FILTER (WHERE j."entryDate" < ${from}), 0) AS od,
             coalesce(sum(l."credit") FILTER (WHERE j."entryDate" < ${from}), 0) AS oc,
             coalesce(sum(l."debit")  FILTER (WHERE j."entryDate" >= ${from}), 0) AS pd,
             coalesce(sum(l."credit") FILTER (WHERE j."entryDate" >= ${from}), 0) AS pc
        FROM "JournalEntryLine" l JOIN "JournalEntry" j ON j."id" = l."journalEntryId"
       WHERE ${POSTED} AND j."entryDate" <= ${to}
       GROUP BY l."accountId")
    SELECT a."id", a."code", a."nameAr", a."nameEn", a."type"::text AS type, a."normalBalance", a."parentId", a."allowPosting",
           coalesce(mv.od, 0) AS od, coalesce(mv.oc, 0) AS oc, coalesce(mv.pd, 0) AS pd, coalesce(mv.pc, 0) AS pc
      FROM "Account" a LEFT JOIN mv ON mv."accountId" = a."id"
     ORDER BY a."code"`;
  const out: TbRow[] = [];
  const tot = { od: ZERO, oc: ZERO, pd: ZERO, pc: ZERO, cd: ZERO, cc: ZERO };
  for (const r of rows) {
    const od = new Decimal(r.od), oc = new Decimal(r.oc), pd = new Decimal(r.pd), pc = new Decimal(r.pc);
    const [o1, o2] = split(od.minus(oc));
    const [c1, c2] = split(od.minus(oc).plus(pd).minus(pc));
    const zero = od.isZero() && oc.isZero() && pd.isZero() && pc.isZero();
    if (zero && !opts.includeZero) continue;
    tot.od = tot.od.plus(o1); tot.oc = tot.oc.plus(o2); tot.pd = tot.pd.plus(pd); tot.pc = tot.pc.plus(pc); tot.cd = tot.cd.plus(c1); tot.cc = tot.cc.plus(c2);
    out.push({ accountId: r.id, code: r.code, nameAr: r.nameAr, nameEn: r.nameEn, type: r.type, normalBalance: r.normalBalance, parentId: r.parentId, postable: r.allowPosting,
      openingDebit: o1, openingCredit: o2, periodDebit: pd.toFixed(2), periodCredit: pc.toFixed(2), closingDebit: c1, closingCredit: c2 });
  }
  return {
    from: dayText(from), to: dayText(to), rows: out,
    totals: { openingDebit: tot.od.toFixed(2), openingCredit: tot.oc.toFixed(2), periodDebit: tot.pd.toFixed(2), periodCredit: tot.pc.toFixed(2), closingDebit: tot.cd.toFixed(2), closingCredit: tot.cc.toFixed(2) },
    balanced: tot.od.equals(tot.oc) && tot.pd.equals(tot.pc) && tot.cd.equals(tot.cc),
  };
}

/**
 * The general ledger of an account (a header account: all its descendants) between two days: the opening
 * balance, each posted line with a running balance, and the closing balance. Balances are shown on the account's
 * normal side (a debit-normal account's positive balance is a debit). Paged (`limit`, `offset`); the running
 * balance is computed over the whole range before paging, so every page is right.
 */
export async function generalLedger(accountId: string, from: Date, to: Date, page: { limit?: number; offset?: number } = {}) {
  const account = await prisma.account.findUnique({ where: { id: accountId }, select: { id: true, code: true, nameAr: true, nameEn: true, type: true, normalBalance: true, controlType: true, allowPosting: true } });
  if (!account) throw refuse("NOT_FOUND");
  const limit = Math.min(Math.max(page.limit ?? 500, 1), 2000);
  const offset = Math.max(page.offset ?? 0, 0);
  const sign = account.normalBalance === "CREDIT" ? -1 : 1;
  const ids = Prisma.sql`(WITH RECURSIVE t(id) AS (SELECT ${accountId}::text UNION SELECT a."id" FROM "Account" a JOIN t ON a."parentId" = t.id) SELECT id FROM t)`;
  const [open] = await prisma.$queryRaw<{ d: Prisma.Decimal; c: Prisma.Decimal; n: bigint }[]>`
    SELECT coalesce(sum(l."debit"), 0) AS d, coalesce(sum(l."credit"), 0) AS c, 0::bigint AS n
      FROM "JournalEntryLine" l JOIN "JournalEntry" j ON j."id" = l."journalEntryId"
     WHERE l."accountId" IN ${ids} AND ${POSTED} AND j."entryDate" < ${from}`;
  const opening = new Decimal(open.d).minus(open.c);
  const rows = await prisma.$queryRaw<{ entryId: string; entryNo: number; postingYear: number | null; postingSeq: number | null; entryDate: Date; type: string; status: string; memo: string | null; sourceModule: string; sourceType: string | null; sourceId: string | null; lineId: string; accountCode: string; debit: Prisma.Decimal; credit: Prisma.Decimal; lineMemo: string | null; partyType: string | null; partyId: string | null; run: Prisma.Decimal; total: bigint }[]>`
    SELECT * FROM (
      SELECT j."id" AS "entryId", j."entryNo", j."postingYear", j."postingSeq", j."entryDate", j."type"::text AS type, j."status"::text AS status,
             j."description" AS memo, j."sourceModule", j."sourceType", j."sourceId", l."id" AS "lineId", a."code" AS "accountCode",
             l."debit", l."credit", l."description" AS "lineMemo", l."partyType", l."partyId",
             sum(l."debit" - l."credit") OVER (ORDER BY j."entryDate", j."postingSeq" NULLS LAST, j."entryNo", l."lineNo" NULLS LAST, l."id") AS run,
             count(*) OVER () AS total
        FROM "JournalEntryLine" l JOIN "JournalEntry" j ON j."id" = l."journalEntryId" JOIN "Account" a ON a."id" = l."accountId"
       WHERE l."accountId" IN ${ids} AND ${POSTED} AND j."entryDate" >= ${from} AND j."entryDate" <= ${to}) x
     ORDER BY x."entryDate", x."postingSeq" NULLS LAST, x."entryNo", x."lineId"
     LIMIT ${limit} OFFSET ${offset}`;
  const [tot] = await prisma.$queryRaw<{ d: Prisma.Decimal; c: Prisma.Decimal }[]>`
    SELECT coalesce(sum(l."debit"), 0) AS d, coalesce(sum(l."credit"), 0) AS c
      FROM "JournalEntryLine" l JOIN "JournalEntry" j ON j."id" = l."journalEntryId"
     WHERE l."accountId" IN ${ids} AND ${POSTED} AND j."entryDate" >= ${from} AND j."entryDate" <= ${to}`;
  const closing = opening.plus(tot.d).minus(tot.c);
  return {
    account: { ...account, type: String(account.type) },
    from: dayText(from), to: dayText(to),
    opening: fix2(opening.times(sign)),
    periodDebit: new Decimal(tot.d).toFixed(2), periodCredit: new Decimal(tot.c).toFixed(2),
    closing: fix2(closing.times(sign)),
    total: rows.length ? Number(rows[0].total) : 0, limit, offset,
    lines: rows.map((r) => ({
      entryId: r.entryId, ref: postingRef(r) ?? `#${r.entryNo}`, entryDate: dayText(r.entryDate), type: r.type, status: r.status, memo: r.memo,
      sourceModule: r.sourceModule, sourceType: r.sourceType, sourceId: r.sourceId, lineId: r.lineId, accountCode: r.accountCode,
      debit: new Decimal(r.debit).toFixed(2), credit: new Decimal(r.credit).toFixed(2), lineMemo: r.lineMemo, partyType: r.partyType, partyId: r.partyId,
      balance: fix2(opening.plus(r.run).times(sign)),
    })),
  };
}

/**
 * Where a source document lives in the app (the journal → source link). Null when the module has no page. Phase 4: one
 * table for the journal, the statement and the cost-ledger drill-down (./source-links.ts) — the old `?tab=` targets of
 * the payables and inventory screens (which those pages never read) now name the view that holds the document.
 */
export function sourceHref(sourceType: string | null, sourceId: string | null, sourceModule?: string | null): string | null {
  return sourceDocHref(sourceType, sourceId, {}, sourceModule);
}
