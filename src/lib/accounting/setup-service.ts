// Ledger set-up: chart-of-accounts template, posting-role mappings, cutover date and the
// "setup complete" switch. Every change is audited.
import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { AccountingError } from "./errors";
import { auditAccounting } from "./audit";
import { COA_TEMPLATE, TEMPLATE_MAPPINGS } from "./coa-template";
import { POSTING_ROLES, ROLE_SET } from "./catalog";
import { ledgerTx } from "./journal-service";

type Tx = Prisma.TransactionClient;

export async function getSettings(tx: Tx | typeof prisma = prisma) {
  return tx.accountingSettings.upsert({ where: { id: "singleton" }, update: {}, create: { id: "singleton" } });
}

/** Loads the template chart. Refused once any account exists — it never merges or overwrites. */
export async function applyChartTemplate(userId: string) {
  return ledgerTx(async (tx) => {
    const existing = await tx.account.count();
    if (existing > 0) throw new AccountingError(`The chart of accounts already has ${existing} accounts; the template only loads into an empty chart.`, 409);
    const idByCode = new Map<string, string>();
    for (const a of COA_TEMPLATE) {
      const row = await tx.account.create({
        data: {
          code: a.code, nameEn: a.en, nameAr: a.ar, type: a.type, parentId: a.parent ? idByCode.get(a.parent)! : null,
          allowPosting: !a.header, controlKind: a.control ?? "NONE", allowManualPosting: a.manual ?? true,
          createdBy: userId, updatedBy: userId,
        },
      });
      idByCode.set(a.code, row.id);
    }
    for (const [role, code] of Object.entries(TEMPLATE_MAPPINGS)) {
      await tx.accountMapping.upsert({ where: { role }, update: { accountId: idByCode.get(code)!, updatedBy: userId }, create: { role, accountId: idByCode.get(code)!, updatedBy: userId } });
    }
    await auditAccounting(tx, { action: "coa.apply_template", entityType: "coa", entityId: "template", userId, after: { accounts: COA_TEMPLATE.length, mappings: Object.keys(TEMPLATE_MAPPINGS).length } });
    return { accounts: COA_TEMPLATE.length };
  });
}

export async function listMappings() {
  const rows = await prisma.accountMapping.findMany({ include: { account: { select: { id: true, code: true, nameEn: true, nameAr: true } } } });
  const byRole = new Map(rows.map((r) => [r.role, r]));
  return POSTING_ROLES.map((r) => ({ ...r, account: byRole.get(r.role)?.account ?? null, updatedAt: byRole.get(r.role)?.updatedAt ?? null }));
}

export async function setMapping(role: string, accountId: string, userId: string) {
  if (!ROLE_SET.has(role)) throw new AccountingError("Unknown posting role.", 400);
  return ledgerTx(async (tx) => {
    const account = await tx.account.findUnique({ where: { id: accountId }, include: { _count: { select: { children: true } } } });
    if (!account) throw new AccountingError("Account not found.", 400);
    if (!account.isActive || !account.allowPosting || account._count.children > 0) throw new AccountingError(`${account.code} cannot receive postings.`, 400);
    const before = await tx.accountMapping.findUnique({ where: { role } });
    const row = await tx.accountMapping.upsert({ where: { role }, update: { accountId, updatedBy: userId }, create: { role, accountId, updatedBy: userId } });
    await auditAccounting(tx, { action: "mapping.set", entityType: "mapping", entityId: role, userId, before: before ? { accountId: before.accountId } : null, after: { accountId } });
    return row;
  });
}

export async function updateSettings(patch: { ledgerCutoverDate?: Date | null; setupComplete?: boolean }, userId: string) {
  return ledgerTx(async (tx) => {
    const before = await getSettings(tx);
    if (patch.ledgerCutoverDate !== undefined && before.ledgerCutoverDate && patch.ledgerCutoverDate?.getTime() !== before.ledgerCutoverDate.getTime()) {
      const posted = await tx.journalEntry.count({ where: { type: "AUTO" } });
      if (posted > 0) throw new AccountingError("The cutover date cannot change after automatic postings exist.", 409);
    }
    if (patch.setupComplete === true) {
      const [accounts, periods] = await Promise.all([tx.account.count({ where: { isActive: true, allowPosting: true } }), tx.fiscalPeriod.count({ where: { status: "OPEN" } })]);
      if (!accounts) throw new AccountingError("Set-up cannot be completed without postable accounts.", 409);
      if (!periods) throw new AccountingError("Set-up cannot be completed without an open fiscal period.", 409);
    }
    const after = await tx.accountingSettings.update({
      where: { id: "singleton" },
      data: { ...(patch.ledgerCutoverDate !== undefined ? { ledgerCutoverDate: patch.ledgerCutoverDate } : {}), ...(patch.setupComplete !== undefined ? { setupComplete: patch.setupComplete } : {}), updatedBy: userId },
    });
    await auditAccounting(tx, {
      action: "settings.update", entityType: "settings", entityId: "singleton", userId,
      before: { ledgerCutoverDate: before.ledgerCutoverDate, setupComplete: before.setupComplete },
      after: { ledgerCutoverDate: after.ledgerCutoverDate, setupComplete: after.setupComplete },
    });
    return after;
  });
}
