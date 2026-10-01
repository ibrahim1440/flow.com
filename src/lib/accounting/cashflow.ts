// Cash-flow statement from the ledger: loads the period's entries and hands them to the
// transaction-aware engine (cashflow-engine.ts, rules documented there and in DECISION_PACK §7).
// Opening entries (type OPENING) are opening balances; opening and closing entries are not flows.
import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { ZERO } from "./money";
import { provisionalCount } from "./reports";
import { effectiveClass, type Acc } from "./cashflow-rules";
import { buildCashFlow, type CfAccount, type CfEntry } from "./cashflow-engine";

export { defaultCashFlowClass } from "./cashflow-rules";

const POSTED = ["POSTED", "REVERSED"] as const;

export async function cashFlowStatement(opts: { from: Date; to: Date; includeProvisional?: boolean }) {
  const inc = opts.includeProvisional ?? true;
  const raw = await prisma.account.findMany({ select: { id: true, code: true, nameAr: true, nameEn: true, type: true, controlKind: true, cashFlowClass: true } });
  const accounts = new Map<string, CfAccount>(raw.map((a) => {
    const { cls, defaulted } = effectiveClass(a as Acc);
    return [a.id, { id: a.id, code: a.code, nameAr: a.nameAr, nameEn: a.nameEn, type: a.type, cls, defaulted }];
  }));

  const entries = await prisma.journalEntry.findMany({
    where: { status: { in: [...POSTED] }, type: { notIn: ["OPENING", "CLOSING"] }, entryDate: { gte: opts.from, lte: opts.to }, ...(inc ? {} : { isProvisional: false }) },
    select: { id: true, entryNo: true, entryDate: true, description: true, sourceModule: true, sourceDocumentId: true,
      lines: { select: { accountId: true, debit: true, credit: true, openItemType: true, openItemId: true } } },
    orderBy: { entryNo: "asc" },
  });

  // Payments of supplier bills: the investing share of the bill each payables line settles. The
  // bill is recorded on the posted line itself (open item, fixed at posting and copied by a void),
  // and a posted bill's lines never change — so this does not depend on today's bank matches.
  const billIds = [...new Set(entries.flatMap((e) => e.lines.filter((l) => l.openItemType === "SUPPLIER_BILL").map((l) => l.openItemId!)))];
  const attribution = await billAttribution(billIds, accounts);
  const cfEntries: CfEntry[] = entries.map((e) => ({
    id: e.id, entryNo: e.entryNo, entryDate: e.entryDate, description: e.description,
    lines: e.lines.map((l) => ({
      accountId: l.accountId, debit: l.debit, credit: l.credit,
      attribution: l.openItemType === "SUPPLIER_BILL" && accounts.get(l.accountId)?.cls === "OPERATING" ? attribution.get(l.openItemId!) : undefined,
    })),
  }));
  const cf = buildCashFlow(cfEntries, accounts);

  // Opening cash: everything before the period, plus opening entries up to its end.
  const cashIds = [...accounts.values()].filter((a) => a.cls === "CASH").map((a) => a.id);
  const opening = cashIds.length ? (await prisma.$queryRaw<{ net: string }[]>`
    SELECT COALESCE(SUM(l."debit" - l."credit"), 0)::text AS net
      FROM "JournalEntryLine" l JOIN "JournalEntry" e ON e."id" = l."journalEntryId"
     WHERE e."status" IN ('POSTED', 'REVERSED') AND l."accountId" IN (${Prisma.join(cashIds)})
       AND (e."entryDate" < ${opts.from} OR (e."type" = 'OPENING' AND e."entryDate" <= ${opts.to}))
       ${inc ? Prisma.empty : Prisma.sql`AND e."isProvisional" = false`}`)[0].net : "0";
  const cashOpening = new Prisma.Decimal(opening);

  const moved = new Set(cfEntries.flatMap((e) => e.lines.map((l) => l.accountId)));
  const defaultedAccounts = [...accounts.values()].filter((a) => a.defaulted && a.cls && moved.has(a.id)).map((a) => a.code).sort();
  return {
    from: opts.from, to: opts.to, includeProvisional: inc,
    ...cf,
    cashOpening: cashOpening.toFixed(2),
    cashClosing: cashOpening.add(cf.netChange).toFixed(2),
    defaultedAccounts,
    provisionalEntries: await provisionalCount(opts.from, opts.to),
  };
}

/** bill id → [{ accountId, share }]: the share of a payment of that bill that pays fixed-asset lines (net). */
async function billAttribution(billIds: string[], accounts: Map<string, CfAccount>) {
  const out = new Map<string, { accountId: string; share: Prisma.Decimal }[]>();
  if (!billIds.length) return out;
  const bills = await prisma.supplierBill.findMany({ where: { id: { in: billIds } }, select: { id: true, totalGross: true, lines: { select: { accountId: true, net: true } } } });
  for (const b of bills) {
    if (new Prisma.Decimal(b.totalGross).isZero()) continue;
    const share = new Map<string, Prisma.Decimal>();
    for (const l of b.lines) {
      if (accounts.get(l.accountId)?.cls !== "INVESTING") continue;
      share.set(l.accountId, (share.get(l.accountId) ?? ZERO).add(new Prisma.Decimal(l.net).div(b.totalGross)));
    }
    if (share.size) out.set(b.id, [...share].map(([accountId, s]) => ({ accountId, share: s })));
  }
  return out;
}
