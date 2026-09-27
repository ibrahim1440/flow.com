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
      lines: { select: { accountId: true, debit: true, credit: true, partyType: true } } },
    orderBy: { entryNo: "asc" },
  });

  // Bank payments of supplier bills: the investing share of each bill (fixed-asset lines, net).
  const bankIds = entries.filter((e) => e.sourceModule === "bank" && e.sourceDocumentId).map((e) => e.sourceDocumentId!);
  const attribution = await billAttribution(bankIds, accounts);
  const cfEntries: CfEntry[] = entries.map((e) => ({
    id: e.id, entryNo: e.entryNo, entryDate: e.entryDate, description: e.description,
    lines: e.lines.map((l) => ({
      accountId: l.accountId, debit: l.debit, credit: l.credit,
      attribution: e.sourceModule === "bank" && l.partyType === "SUPPLIER" && accounts.get(l.accountId)?.cls === "OPERATING" ? attribution.get(e.sourceDocumentId!) : undefined,
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

/** bank transaction id → [{ accountId, share }]: the share of the payment that pays fixed-asset lines. */
async function billAttribution(bankIds: string[], accounts: Map<string, CfAccount>) {
  const out = new Map<string, { accountId: string; share: Prisma.Decimal }[]>();
  if (!bankIds.length) return out;
  const matches = await prisma.bankTransactionMatch.findMany({ where: { transactionId: { in: bankIds }, targetType: "OBLIGATION", active: true }, select: { transactionId: true, targetId: true, amount: true } });
  if (!matches.length) return out;
  const bills = await prisma.supplierBill.findMany({ where: { obligationId: { in: matches.map((m) => m.targetId) } }, select: { obligationId: true, totalGross: true, lines: { select: { accountId: true, net: true } } } });
  const byOb = new Map(bills.map((b) => [b.obligationId!, b]));
  const byTxn = new Map<string, typeof matches>();
  for (const m of matches) if (byOb.has(m.targetId)) byTxn.set(m.transactionId, [...(byTxn.get(m.transactionId) ?? []), m]);
  for (const [txn, ms] of byTxn) {
    const matched = ms.reduce((s, m) => s.add(m.amount), ZERO);
    if (matched.isZero()) continue;
    const share = new Map<string, Prisma.Decimal>();
    for (const m of ms) {
      const b = byOb.get(m.targetId)!;
      if (new Prisma.Decimal(b.totalGross).isZero()) continue;
      const w = new Prisma.Decimal(m.amount).div(matched);             // this bill's part of the payment
      for (const l of b.lines) {
        if (accounts.get(l.accountId)?.cls !== "INVESTING") continue;
        share.set(l.accountId, (share.get(l.accountId) ?? ZERO).add(w.mul(l.net).div(b.totalGross)));
      }
    }
    if (share.size) out.set(txn, [...share].map(([accountId, s]) => ({ accountId, share: s })));
  }
  return out;
}
