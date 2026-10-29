// «تسوية بيع الأصول الثابتة» (BATCH 22 WP-F) — the FA_DISPOSAL_CLEARING tie-out the close checks: the account's credit
// balance equals Σ of the issued «بيع أصل ثابت» lines (posted) less what credit notes reversed and what live disposals
// cleared. A difference is a FAIL; open lines are a WARN (dispose of the asset). Before go-live nothing posts: NA.
import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { Decimal, ZERO } from "../money";

type Db = Prisma.TransactionClient | typeof prisma;

export async function saleClearingTieOut(db: Db, toDay: Date) {
  const role = await db.accountRole.findUnique({ where: { tenantId_role: { tenantId: "hiqbah", role: "FA_DISPOSAL_CLEARING" } }, select: { accountId: true } });
  // The open part of each issued sale line whose invoice entry is in the books at the day (its net less the issued
  // credit notes on it); then what live, posted disposals cleared by the day — a disposal may precede the invoice's
  // issue (it is dated the supply, the invoice may follow by the 15th of the next month), so it counts on its own date.
  const rows = await db.$queryRaw<{ id: string; open: Prisma.Decimal; disposed: Prisma.Decimal; issued: boolean; inBooks: boolean; age: number }[]>`
    SELECT l."id",
           l."lineNet"
           - coalesce((SELECT sum(c."lineNet") FROM "SalesInvoiceLine" c JOIN "SalesInvoice" ci ON ci."id" = c."invoiceId"
                        WHERE c."originalLineId" = l."id" AND ci."kind" = 'CREDIT_NOTE' AND ci."status" = 'ISSUED' AND ci."issueDate" <= ${toDay}
                          AND EXISTS (SELECT 1 FROM "JournalEntry" j WHERE j."sourceModule" = 'sales' AND j."sourceId" = ci."id" AND j."sourceEvent" = 'ISSUED' AND j."status" IN ('POSTED', 'REVERSED'))), 0) AS open,
           coalesce((SELECT sum(d."proceedsNet") FROM "FixedAssetDisposal" d
                      WHERE d."salesInvoiceLineId" = l."id" AND d."status" = 'POSTED' AND d."glState" = 'POSTED' AND d."disposalDate" <= ${toDay}), 0) AS disposed,
           (i."issueDate" <= ${toDay} AND EXISTS (SELECT 1 FROM "JournalEntry" j WHERE j."sourceModule" = 'sales' AND j."sourceId" = i."id" AND j."sourceEvent" = 'ISSUED' AND j."status" IN ('POSTED', 'REVERSED'))) AS issued,
           EXISTS (SELECT 1 FROM "JournalEntry" j WHERE j."sourceModule" = 'sales' AND j."sourceId" = i."id" AND j."sourceEvent" = 'ISSUED' AND j."status" IN ('POSTED', 'REVERSED')) AS "inBooks",
           (${toDay}::date - i."issueDate")::int AS age
      FROM "SalesInvoiceLine" l JOIN "SalesInvoice" i ON i."id" = l."invoiceId"
     WHERE l."kind" = 'FIXED_ASSET_SALE' AND i."status" = 'ISSUED'`;
  const left = (r: (typeof rows)[number]) => (r.issued ? new Decimal(r.open) : ZERO).minus(new Decimal(r.disposed));
  const open = rows.filter((r) => r.issued && left(r).greaterThan(0));
  const expected = rows.reduce((t, r) => t.plus(left(r)), ZERO);
  let gl = ZERO;
  if (role) {
    const [b] = await db.$queryRaw<{ v: Prisma.Decimal | null }[]>`
      SELECT coalesce(sum(l."credit" - l."debit"), 0) AS v FROM "JournalEntryLine" l JOIN "JournalEntry" e ON e."id" = l."journalEntryId"
       WHERE l."accountId" = ${role.accountId} AND e."status" IN ('POSTED', 'REVERSED') AND e."entryDate" <= ${new Date(toDay.getTime() + 86_399_999)}`;
    gl = new Decimal(b?.v ?? 0);
  }
  const difference = gl.minus(expected);
  // BATCH22 gate S4: a posted disposal clearing a line whose invoice never reached the books (issued before go-live)
  // debited the clearing with nothing to clear — never "matched", whatever the figures say.
  const stranded = rows.filter((r) => !r.inBooks && new Decimal(r.disposed).greaterThan(0)).length;
  return {
    mapped: !!role, gl: gl.toFixed(2), open: expected.toFixed(2), openLines: open.length, staleLines: open.filter((r) => r.age > 30).length,
    difference: difference.toFixed(2), matched: difference.isZero() && stranded === 0, strandedLines: stranded,
  };
}
