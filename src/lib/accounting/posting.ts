// The posting engine's single write path: builds a balanced AUTO entry from roles/accounts
// and posts it in the caller's transaction. Everything it checks is re-checked by the
// database (ledger-core migration) — the checks here exist to produce a clear BLOCKED reason.
import type { Prisma } from "@/generated/prisma/client";
import { AccountingError, PostingBlocked } from "./errors";
import { ZERO, dec, round2 } from "./money";
import type { PostingMode } from "./policy";

type Tx = Prisma.TransactionClient;
export const ENGINE_ACTOR = "system:accounting-engine";

export type EngineLine = {
  role?: string;
  accountId?: string;
  debit?: Prisma.Decimal;
  credit?: Prisma.Decimal;
  description?: string;
  partyType?: "CUSTOMER" | "SUPPLIER" | "EMPLOYEE";
  partyId?: string;
  branchId?: string | null;
  costCenterId?: string | null;
};

const PARTY_CONTROLS = new Set(["RECEIVABLE", "PAYABLE", "COMMISSION_PAYABLE", "CUSTOMER_ADVANCES"]);

export async function resolveRoles(tx: Tx, roles: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(roles)];
  const rows = await tx.accountMapping.findMany({ where: { role: { in: unique } } });
  const map = new Map(rows.map((r) => [r.role, r.accountId]));
  const missing = unique.filter((r) => !map.has(r));
  if (missing.length) throw new PostingBlocked(`No account is mapped for: ${missing.join(", ")}.`, { missing });
  return map;
}

export async function createEngineEntry(
  tx: Tx,
  input: {
    entryDate: Date;
    description: string;
    sourceModule: string;
    sourceDocumentId: string;
    originEventId: string;
    lines: EngineLine[];
    mode: PostingMode;
  },
) {
  const roleMap = await resolveRoles(tx, input.lines.filter((l) => l.role).map((l) => l.role!));
  const lines = input.lines
    .map((l) => ({ ...l, accountId: l.accountId ?? roleMap.get(l.role!)!, debit: round2(dec(l.debit)), credit: round2(dec(l.credit)) }))
    .filter((l) => !(l.debit.isZero() && l.credit.isZero()));
  for (const l of lines) {
    if (l.debit.isNegative() || l.credit.isNegative() || (l.debit.gt(0) && l.credit.gt(0))) {
      throw new AccountingError("Engine produced an invalid line (negative or two-sided).", 500);
    }
  }
  const totalDebit = lines.reduce((s, l) => s.add(l.debit), ZERO);
  const totalCredit = lines.reduce((s, l) => s.add(l.credit), ZERO);
  if (lines.length < 2 || !totalDebit.equals(totalCredit)) {
    throw new AccountingError(`Engine produced an unbalanced entry (${totalDebit} / ${totalCredit}).`, 500);
  }

  const accounts = await tx.account.findMany({
    where: { id: { in: [...new Set(lines.map((l) => l.accountId))] } },
    include: { _count: { select: { children: true } } },
  });
  const byId = new Map(accounts.map((a) => [a.id, a]));
  for (const l of lines) {
    const a = byId.get(l.accountId);
    if (!a) throw new PostingBlocked("A mapped account no longer exists.");
    if (!a.isActive || !a.allowPosting || a._count.children > 0) {
      throw new PostingBlocked(`Account ${a.code} cannot receive postings (inactive, non-posting or a parent).`);
    }
    if (PARTY_CONTROLS.has(a.controlKind) && (!l.partyType || !l.partyId)) {
      throw new AccountingError(`Control account ${a.code} needs a party on every line.`, 500);
    }
  }

  const period = await tx.fiscalPeriod.findFirst({
    where: { startDate: { lte: input.entryDate }, endDate: { gte: input.entryDate } },
  });
  const day = input.entryDate.toISOString().slice(0, 10);
  if (!period) throw new PostingBlocked(`No fiscal period covers ${day}.`);
  if (period.status !== "OPEN") {
    throw new PostingBlocked(`Fiscal period ${period.year}-${String(period.periodNo).padStart(2, "0")} is ${period.status}; ${day} cannot be posted.`);
  }

  const now = new Date();
  const entry = await tx.journalEntry.create({
    data: {
      entryDate: input.entryDate,
      fiscalPeriodId: period.id,
      type: "AUTO",
      status: "APPROVED",
      sourceModule: input.sourceModule,
      sourceDocumentId: input.sourceDocumentId,
      description: input.description,
      totalDebit,
      totalCredit,
      createdBy: ENGINE_ACTOR,
      approvedBy: ENGINE_ACTOR,
      approvedAt: now,
      isProvisional: input.mode.provisional,
      policyKey: input.mode.policyKey,
      policyVersion: input.mode.policyVersion,
      originEventId: input.originEventId,
      lines: {
        create: lines.map((l, i) => ({
          lineNo: i + 1,
          accountId: l.accountId,
          debit: l.debit,
          credit: l.credit,
          description: l.description,
          partyType: l.partyType,
          partyId: l.partyId,
          branchId: l.branchId ?? null,
          costCenterId: l.costCenterId ?? null,
        })),
      },
    },
  });
  return tx.journalEntry.update({
    where: { id: entry.id },
    data: { status: "POSTED", postedAt: now, postedBy: ENGINE_ACTOR },
  });
}
