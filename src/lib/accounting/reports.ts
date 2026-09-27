// Ledger reports. All figures come from posted journal lines (status POSTED or REVERSED —
// a reversed entry and its reversal both stay in the ledger and net to zero), aggregated in
// SQL numeric and returned as integer halalas for display. Nothing here reads a subledger
// balance as if it were the ledger; the reconciliation report compares the two explicitly.
import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { toMinor } from "./money";

const LEDGER_STATUSES = Prisma.sql`('POSTED', 'REVERSED')`;
const DEBIT_NORMAL = new Set(["ASSET", "EXPENSE"]);

type AccountRow = { id: string; code: string; nameEn: string; nameAr: string | null; type: string; parentId: string | null; controlKind: string };

function provisionalFilter(includeProvisional: boolean) {
  return includeProvisional ? Prisma.empty : Prisma.sql`AND e."isProvisional" = false`;
}

async function accountsById() {
  const rows = await prisma.account.findMany({ select: { id: true, code: true, nameEn: true, nameAr: true, type: true, parentId: true, controlKind: true } });
  return new Map<string, AccountRow>(rows.map((r) => [r.id, r as AccountRow]));
}

export async function provisionalCount(from: Date | null, to: Date) {
  const r = await prisma.journalEntry.count({ where: { isProvisional: true, status: { in: ["POSTED", "REVERSED"] }, entryDate: { lte: to, ...(from ? { gte: from } : {}) } } });
  return r;
}

export async function trialBalance(opts: { from: Date; to: Date; includeProvisional?: boolean }) {
  const inc = opts.includeProvisional ?? true;
  const rows = await prisma.$queryRaw<{ accountId: string; od: string; oc: string; pd: string; pc: string }[]>`
    SELECT l."accountId",
           COALESCE(SUM(CASE WHEN e."entryDate" <  ${opts.from} THEN l."debit"  END), 0)::text AS od,
           COALESCE(SUM(CASE WHEN e."entryDate" <  ${opts.from} THEN l."credit" END), 0)::text AS oc,
           COALESCE(SUM(CASE WHEN e."entryDate" >= ${opts.from} THEN l."debit"  END), 0)::text AS pd,
           COALESCE(SUM(CASE WHEN e."entryDate" >= ${opts.from} THEN l."credit" END), 0)::text AS pc
      FROM "JournalEntryLine" l JOIN "JournalEntry" e ON e."id" = l."journalEntryId"
     WHERE e."status" IN ${LEDGER_STATUSES} AND e."entryDate" <= ${opts.to} ${provisionalFilter(inc)}
     GROUP BY l."accountId"`;
  const accounts = await accountsById();
  const lines = rows.map((r) => {
    const a = accounts.get(r.accountId)!;
    const opening = new Prisma.Decimal(r.od).sub(r.oc);
    const closing = opening.add(r.pd).sub(r.pc);
    return {
      accountId: a.id, code: a.code, nameEn: a.nameEn, nameAr: a.nameAr, type: a.type,
      openingDebit: toMinor(opening.isPositive() ? opening : 0), openingCredit: toMinor(opening.isNegative() ? opening.neg() : 0),
      periodDebit: toMinor(r.pd), periodCredit: toMinor(r.pc),
      closingDebit: toMinor(closing.isPositive() ? closing : 0), closingCredit: toMinor(closing.isNegative() ? closing.neg() : 0),
    };
  }).filter((l) => l.openingDebit || l.openingCredit || l.periodDebit || l.periodCredit || l.closingDebit || l.closingCredit)
    .sort((a, b) => a.code.localeCompare(b.code));
  const sum = (k: keyof (typeof lines)[number]) => lines.reduce((s, l) => s + (l[k] as number), 0);
  const totals = {
    openingDebit: sum("openingDebit"), openingCredit: sum("openingCredit"), periodDebit: sum("periodDebit"),
    periodCredit: sum("periodCredit"), closingDebit: sum("closingDebit"), closingCredit: sum("closingCredit"),
  };
  return {
    from: opts.from, to: opts.to, includeProvisional: inc, lines, totals,
    balanced: totals.closingDebit === totals.closingCredit && totals.periodDebit === totals.periodCredit && totals.openingDebit === totals.openingCredit,
    provisionalEntries: await provisionalCount(opts.from, opts.to),
  };
}

export async function generalLedger(opts: { accountId: string; from: Date; to: Date; includeProvisional?: boolean; page?: number; pageSize?: number }) {
  const inc = opts.includeProvisional ?? true;
  const pageSize = Math.min(Math.max(opts.pageSize ?? 100, 10), 500);
  const page = Math.max(opts.page ?? 1, 1);
  const account = await prisma.account.findUnique({ where: { id: opts.accountId } });
  if (!account) return null;
  const debitNormal = DEBIT_NORMAL.has(account.type);
  const [open] = await prisma.$queryRaw<{ d: string; c: string }[]>`
    SELECT COALESCE(SUM(l."debit"), 0)::text AS d, COALESCE(SUM(l."credit"), 0)::text AS c
      FROM "JournalEntryLine" l JOIN "JournalEntry" e ON e."id" = l."journalEntryId"
     WHERE l."accountId" = ${opts.accountId} AND e."status" IN ${LEDGER_STATUSES} AND e."entryDate" < ${opts.from} ${provisionalFilter(inc)}`;
  const rows = await prisma.$queryRaw<{
    id: string; entryId: string; entryNo: number; entryDate: Date; type: string; status: string; description: string | null;
    lineDescription: string | null; debit: string; credit: string; sourceModule: string; sourceDocumentId: string | null;
    isProvisional: boolean; partyType: string | null; partyId: string | null; running: string; total: bigint;
  }[]>`
    SELECT l."id", e."id" AS "entryId", e."entryNo", e."entryDate", e."type"::text AS type, e."status"::text AS status, e."description",
           l."description" AS "lineDescription", l."debit"::text AS debit, l."credit"::text AS credit, e."sourceModule", e."sourceDocumentId",
           e."isProvisional", l."partyType", l."partyId",
           (SUM(l."debit" - l."credit") OVER (ORDER BY e."entryDate", e."entryNo", l."lineNo", l."id"))::text AS running,
           COUNT(*) OVER () AS total
      FROM "JournalEntryLine" l JOIN "JournalEntry" e ON e."id" = l."journalEntryId"
     WHERE l."accountId" = ${opts.accountId} AND e."status" IN ${LEDGER_STATUSES}
       AND e."entryDate" >= ${opts.from} AND e."entryDate" <= ${opts.to} ${provisionalFilter(inc)}
     ORDER BY e."entryDate", e."entryNo", l."lineNo", l."id"
     LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`;
  const opening = new Prisma.Decimal(open.d).sub(open.c);
  const [tot] = await prisma.$queryRaw<{ d: string; c: string }[]>`
    SELECT COALESCE(SUM(l."debit"), 0)::text AS d, COALESCE(SUM(l."credit"), 0)::text AS c
      FROM "JournalEntryLine" l JOIN "JournalEntry" e ON e."id" = l."journalEntryId"
     WHERE l."accountId" = ${opts.accountId} AND e."status" IN ${LEDGER_STATUSES}
       AND e."entryDate" >= ${opts.from} AND e."entryDate" <= ${opts.to} ${provisionalFilter(inc)}`;
  const sign = (v: Prisma.Decimal) => (debitNormal ? v : v.neg());
  return {
    account: { id: account.id, code: account.code, nameEn: account.nameEn, nameAr: account.nameAr, type: account.type, debitNormal },
    from: opts.from, to: opts.to, page, pageSize, total: Number(rows[0]?.total ?? 0),
    opening: toMinor(sign(opening)),
    periodDebit: toMinor(tot.d), periodCredit: toMinor(tot.c),
    closing: toMinor(sign(opening.add(tot.d).sub(tot.c))),
    lines: rows.map((r) => ({
      id: r.id, entryId: r.entryId, entryNo: r.entryNo, entryDate: r.entryDate, type: r.type, status: r.status,
      description: r.lineDescription ?? r.description, debit: toMinor(r.debit), credit: toMinor(r.credit),
      balance: toMinor(sign(opening.add(r.running))), sourceModule: r.sourceModule, sourceDocumentId: r.sourceDocumentId,
      isProvisional: r.isProvisional, partyType: r.partyType, partyId: r.partyId,
    })),
  };
}

type StatementLine = { accountId: string; code: string; nameEn: string; nameAr: string | null; amount: number };
type Section = { key: string; en: string; ar: string; lines: StatementLine[]; total: number };

async function balancesByAccount(where: Prisma.Sql, inc: boolean) {
  const rows = await prisma.$queryRaw<{ accountId: string; net: string }[]>`
    SELECT l."accountId", COALESCE(SUM(l."debit" - l."credit"), 0)::text AS net
      FROM "JournalEntryLine" l JOIN "JournalEntry" e ON e."id" = l."journalEntryId"
     WHERE e."status" IN ${LEDGER_STATUSES} ${where} ${provisionalFilter(inc)}
     GROUP BY l."accountId"`;
  return new Map(rows.map((r) => [r.accountId, new Prisma.Decimal(r.net)]));
}

function topParent(accounts: Map<string, AccountRow>, a: AccountRow): AccountRow {
  let cur = a;
  const seen = new Set<string>();
  while (cur.parentId && accounts.has(cur.parentId) && !seen.has(cur.id)) {
    seen.add(cur.id);
    const parent = accounts.get(cur.parentId)!;
    if (!parent.parentId) return cur; // group by the second level (e.g. "Current assets")
    cur = parent;
  }
  return cur;
}

function sections(accounts: Map<string, AccountRow>, nets: Map<string, Prisma.Decimal>, types: string[], flip: boolean): Section[] {
  const groups = new Map<string, Section>();
  for (const [accountId, net] of nets) {
    const a = accounts.get(accountId);
    if (!a || !types.includes(a.type) || net.isZero()) continue;
    const g = topParent(accounts, a);
    const key = g.id === a.id ? `type:${a.type}` : g.id;
    if (!groups.has(key)) groups.set(key, { key, en: g.id === a.id ? a.type : g.nameEn, ar: g.id === a.id ? a.type : g.nameAr ?? g.nameEn, lines: [], total: 0 });
    const amount = toMinor(flip ? net.neg() : net);
    const s = groups.get(key)!;
    s.lines.push({ accountId, code: a.code, nameEn: a.nameEn, nameAr: a.nameAr, amount });
    s.total += amount;
  }
  return [...groups.values()].map((s) => ({ ...s, lines: s.lines.sort((x, y) => x.code.localeCompare(y.code)) })).sort((x, y) => (x.lines[0]?.code ?? "").localeCompare(y.lines[0]?.code ?? ""));
}

export async function incomeStatement(opts: { from: Date; to: Date; includeProvisional?: boolean }) {
  const inc = opts.includeProvisional ?? true;
  const accounts = await accountsById();
  const nets = await balancesByAccount(Prisma.sql`AND e."entryDate" >= ${opts.from} AND e."entryDate" <= ${opts.to} AND e."type" <> 'CLOSING'`, inc);
  const revenue = sections(accounts, nets, ["REVENUE"], true);
  const expenses = sections(accounts, nets, ["EXPENSE"], false);
  const totalRevenue = revenue.reduce((s, x) => s + x.total, 0);
  const totalExpenses = expenses.reduce((s, x) => s + x.total, 0);
  return { from: opts.from, to: opts.to, includeProvisional: inc, revenue, expenses, totalRevenue, totalExpenses, netIncome: totalRevenue - totalExpenses, provisionalEntries: await provisionalCount(opts.from, opts.to) };
}

export async function balanceSheet(opts: { asOf: Date; includeProvisional?: boolean }) {
  const inc = opts.includeProvisional ?? true;
  const accounts = await accountsById();
  const nets = await balancesByAccount(Prisma.sql`AND e."entryDate" <= ${opts.asOf}`, inc);
  const assets = sections(accounts, nets, ["ASSET"], false);
  const liabilities = sections(accounts, nets, ["LIABILITY"], true);
  const equity = sections(accounts, nets, ["EQUITY"], true);
  // Revenue and expense not yet closed to retained earnings belong to equity as current earnings.
  let unclosed = new Prisma.Decimal(0);
  for (const [id, net] of nets) {
    const t = accounts.get(id)?.type;
    if (t === "REVENUE" || t === "EXPENSE") unclosed = unclosed.sub(net);
  }
  const totalAssets = assets.reduce((s, x) => s + x.total, 0);
  const totalLiabilities = liabilities.reduce((s, x) => s + x.total, 0);
  const totalEquityAccounts = equity.reduce((s, x) => s + x.total, 0);
  const currentEarnings = toMinor(unclosed);
  const totalEquity = totalEquityAccounts + currentEarnings;
  return {
    asOf: opts.asOf, includeProvisional: inc, assets, liabilities, equity, currentEarnings,
    totalAssets, totalLiabilities, totalEquity, balanced: totalAssets === totalLiabilities + totalEquity,
    provisionalEntries: await provisionalCount(null, opts.asOf),
  };
}

/**
 * Commissions payable in the ledger, per employee, against what the commission ledger says is
 * owed for the movements that have reached the ledger. Movements dated before the cutover are
 * carried by the opening balance and listed separately; movements still waiting (BLOCKED,
 * PENDING, FAILED) are counted so a difference is explained rather than hidden.
 */
export async function commissionReconciliation() {
  const mapping = await prisma.accountMapping.findUnique({ where: { role: "COMMISSION_PAYABLE" }, include: { account: true } });
  const gl = mapping
    ? await prisma.$queryRaw<{ partyId: string; bal: string }[]>`
        SELECT l."partyId", COALESCE(SUM(l."credit" - l."debit"), 0)::text AS bal
          FROM "JournalEntryLine" l JOIN "JournalEntry" e ON e."id" = l."journalEntryId"
         WHERE l."accountId" = ${mapping.accountId} AND e."status" IN ${LEDGER_STATUSES} AND l."partyType" = 'EMPLOYEE'
         GROUP BY l."partyId"`
    : [];
  const sub = await prisma.$queryRaw<{ employeeId: string; status: string; owed: string; n: bigint }[]>`
    SELECT c."employeeId", ev."status"::text AS status,
           COALESCE(SUM(CASE WHEN c."type" = 'PAYOUT' THEN -c."amount" ELSE c."amount" END), 0)::text AS owed, COUNT(*) AS n
      FROM "CommissionLedgerEntry" c
      LEFT JOIN "AccountingEvent" ev ON ev."sourceModule" = 'commissions' AND ev."sourceDocumentId" = c."id"
     GROUP BY c."employeeId", ev."status"`;
  const ids = [...new Set([...gl.map((g) => g.partyId), ...sub.map((s) => s.employeeId)])];
  const names = new Map((await prisma.employee.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } })).map((e) => [e.id, e.name]));
  const rows = ids.map((id) => {
    const ledger = toMinor(gl.find((g) => g.partyId === id)?.bal ?? 0);
    const part = (st: string | null) => sub.filter((s) => s.employeeId === id && (st === null ? s.status === null : s.status === st));
    const owedPosted = part("TRANSLATED").reduce((s, r) => s + toMinor(r.owed), 0);
    const waiting = ["PENDING", "BLOCKED", "FAILED"].flatMap((st) => part(st));
    const beforeCutover = part("SKIPPED").reduce((s, r) => s + toMinor(r.owed), 0);
    const noEvent = part(null);
    return {
      employeeId: id, name: names.get(id) ?? id, ledgerBalance: ledger, subledgerPosted: owedPosted, difference: ledger - owedPosted,
      waitingAmount: waiting.reduce((s, r) => s + toMinor(r.owed), 0), waitingCount: waiting.reduce((s, r) => s + Number(r.n), 0),
      beforeCutoverOrSkipped: beforeCutover,
      withoutEventCount: noEvent.reduce((s, r) => s + Number(r.n), 0),
    };
  }).sort((a, b) => a.name.localeCompare(b.name));
  return {
    account: mapping?.account ? { code: mapping.account.code, nameEn: mapping.account.nameEn, nameAr: mapping.account.nameAr } : null,
    rows,
    totals: {
      ledgerBalance: rows.reduce((s, r) => s + r.ledgerBalance, 0),
      subledgerPosted: rows.reduce((s, r) => s + r.subledgerPosted, 0),
      difference: rows.reduce((s, r) => s + r.difference, 0),
    },
    reconciled: rows.every((r) => r.difference === 0),
  };
}

export async function overview() {
  const [settings, pendingApproval, approvedUnposted, drafts, blocked, failed, pending, openPeriods, accounts, provisional, unmapped] = await Promise.all([
    prisma.accountingSettings.findUnique({ where: { id: "singleton" } }),
    prisma.journalEntry.count({ where: { status: "SUBMITTED" } }),
    prisma.journalEntry.count({ where: { status: "APPROVED" } }),
    prisma.journalEntry.count({ where: { status: "DRAFT" } }),
    prisma.accountingEvent.count({ where: { status: "BLOCKED" } }),
    prisma.accountingEvent.count({ where: { status: "FAILED" } }),
    prisma.accountingEvent.count({ where: { status: "PENDING" } }),
    prisma.fiscalPeriod.findMany({ where: { status: { in: ["OPEN", "LOCKED"] } }, orderBy: { startDate: "asc" } }),
    prisma.account.count(),
    prisma.journalEntry.count({ where: { isProvisional: true } }),
    prisma.accountMapping.count(),
  ]);
  const [billsPending, bankBlocked] = await Promise.all([
    prisma.supplierBill.count({ where: { status: { in: ["SUBMITTED", "APPROVED"] } } }),
    prisma.accountingEvent.count({ where: { sourceModule: "bank", status: { in: ["BLOCKED", "FAILED"] } } }),
  ]);
  return {
    setupComplete: settings?.setupComplete ?? false, ledgerCutoverDate: settings?.ledgerCutoverDate ?? null,
    accounts, mappings: unmapped, journals: { drafts, pendingApproval, approvedUnposted },
    events: { pending, blocked, failed }, periods: openPeriods, provisionalEntries: provisional,
    payables: { pendingApproval: billsPending }, bank: { blocked: bankBlocked },
  };
}
