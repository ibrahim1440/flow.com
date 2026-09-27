// Cash-flow statement, indirect method, from the ledger (policy: see DECISION_PACK §1).
//   operating = net profit + Σ −movement of OPERATING balance-sheet accounts (working capital,
//               accumulated depreciation, provisions)
//   investing = Σ −movement of INVESTING accounts (fixed assets)
//   financing = Σ −movement of FINANCING accounts (capital, loans)
//   net change in cash = Σ movement of CASH accounts
// Because every entry balances, operating + investing + financing + excluded ≡ net change in
// cash; the statement shows that check and lists EXCLUDED movements (which should be zero
// outside opening/closing) and accounts whose class was defaulted rather than set.
// Opening entries (type OPENING) are treated as opening balances, not as period cash flows.
import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { ZERO } from "./money";
import { provisionalCount } from "./reports";
import { effectiveClass, type Acc } from "./cashflow-rules";

export { defaultCashFlowClass } from "./cashflow-rules";

export async function cashFlowStatement(opts: { from: Date; to: Date; includeProvisional?: boolean }) {
  const inc = opts.includeProvisional ?? true;
  const prov = inc ? Prisma.empty : Prisma.sql`AND e."isProvisional" = false`;
  const accounts = await prisma.account.findMany({ select: { id: true, code: true, nameAr: true, nameEn: true, type: true, controlKind: true, cashFlowClass: true } });
  const q = async (where: Prisma.Sql) => new Map((await prisma.$queryRaw<{ accountId: string; net: string }[]>`
    SELECT l."accountId", COALESCE(SUM(l."debit" - l."credit"), 0)::text AS net
      FROM "JournalEntryLine" l JOIN "JournalEntry" e ON e."id" = l."journalEntryId"
     WHERE e."status" IN ('POSTED', 'REVERSED') ${where} ${prov}
     GROUP BY l."accountId"`).map((r) => [r.accountId, new Prisma.Decimal(r.net)]));
  const moves = await q(Prisma.sql`AND e."entryDate" >= ${opts.from} AND e."entryDate" <= ${opts.to} AND e."type" NOT IN ('OPENING', 'CLOSING')`);
  const opening = await q(Prisma.sql`AND (e."entryDate" < ${opts.from} OR (e."type" = 'OPENING' AND e."entryDate" <= ${opts.to}))`);

  let profit = ZERO;
  type Line = { accountId: string; code: string; nameAr: string | null; nameEn: string; amount: string; defaulted: boolean };
  const sections: Record<"OPERATING" | "INVESTING" | "FINANCING" | "EXCLUDED", Line[]> = { OPERATING: [], INVESTING: [], FINANCING: [], EXCLUDED: [] };
  let cashChange = ZERO;
  let cashOpening = ZERO;
  const defaulted: string[] = [];
  for (const a of accounts) {
    const m = moves.get(a.id) ?? ZERO;
    const { cls, defaulted: d } = effectiveClass(a as Acc);
    if (a.type === "REVENUE" || a.type === "EXPENSE") { profit = profit.sub(m); continue; }
    if (cls === "CASH") { cashChange = cashChange.add(m); cashOpening = cashOpening.add(opening.get(a.id) ?? ZERO); continue; }
    if (!cls) continue;
    if (d && !m.isZero()) defaulted.push(a.code);
    if (m.isZero()) continue;
    sections[cls].push({ accountId: a.id, code: a.code, nameAr: a.nameAr, nameEn: a.nameEn, amount: m.neg().toFixed(2), defaulted: d });
  }
  const sum = (ls: Line[]) => ls.reduce((s, l) => s.add(l.amount), ZERO);
  const operating = profit.add(sum(sections.OPERATING));
  const investing = sum(sections.INVESTING);
  const financing = sum(sections.FINANCING);
  const excluded = sum(sections.EXCLUDED);
  const explained = operating.add(investing).add(financing).add(excluded);
  for (const k of Object.keys(sections) as (keyof typeof sections)[]) sections[k].sort((a, b) => a.code.localeCompare(b.code));
  return {
    from: opts.from, to: opts.to, includeProvisional: inc,
    netProfit: profit.toFixed(2),
    operating: { lines: sections.OPERATING, total: operating.toFixed(2) },
    investing: { lines: sections.INVESTING, total: investing.toFixed(2) },
    financing: { lines: sections.FINANCING, total: financing.toFixed(2) },
    excluded: { lines: sections.EXCLUDED, total: excluded.toFixed(2) },
    netChange: cashChange.toFixed(2),
    cashOpening: cashOpening.toFixed(2),
    cashClosing: cashOpening.add(cashChange).toFixed(2),
    reconciled: explained.equals(cashChange) && excluded.isZero(),
    defaultedAccounts: defaulted,
    provisionalEntries: await provisionalCount(opts.from, opts.to),
  };
}
