// Chart of accounts writes. The database guard stops an account with postings changing type
// or becoming a parent; this adds the checks it cannot express cheaply (hierarchy cycles,
// parent/child type agreement, mapped accounts staying postable) and audits every change.
import type { AccountControlKind, AccountType, CashFlowClass, Prisma } from "@/generated/prisma/client";
import { AccountingError } from "./errors";
import { auditAccounting } from "./audit";
import { ledgerTx } from "./journal-service";

type Tx = Prisma.TransactionClient;
const TYPES = new Set(["ASSET", "LIABILITY", "EQUITY", "REVENUE", "EXPENSE"]);
const CASH_FLOW = new Set(["CASH", "OPERATING", "INVESTING", "FINANCING", "EXCLUDED"]);
const CONTROLS = new Set(["NONE", "RECEIVABLE", "PAYABLE", "INVENTORY", "TAX", "COMMISSION_PAYABLE", "CUSTOMER_ADVANCES", "CASH", "CLEARING"]);

export type AccountInput = {
  code?: unknown; nameEn?: unknown; nameAr?: unknown; type?: unknown; parentId?: unknown; allowPosting?: unknown;
  isActive?: unknown; controlKind?: unknown; allowManualPosting?: unknown; qoyodAccountId?: unknown;
  cashFlowClass?: unknown;
};

function text(v: unknown, field: string, required: boolean, max = 120): string | null | undefined {
  if (v === undefined) return required ? (() => { throw new AccountingError(`${field} is required.`, 400); })() : undefined;
  if (v === null || v === "") { if (required) throw new AccountingError(`${field} is required.`, 400); return null; }
  if (typeof v !== "string") throw new AccountingError(`${field} must be text.`, 400);
  const t = v.trim();
  if (required && !t) throw new AccountingError(`${field} is required.`, 400);
  if (t.length > max) throw new AccountingError(`${field} is too long.`, 400);
  return t;
}
function bool(v: unknown, field: string): boolean | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== "boolean") throw new AccountingError(`${field} must be true or false.`, 400);
  return v;
}

async function checkParent(tx: Tx, id: string | null, parentId: string, type: string) {
  const parent = await tx.account.findUnique({ where: { id: parentId } });
  if (!parent) throw new AccountingError("The parent account does not exist.", 400);
  if (parent.type !== type) throw new AccountingError(`A ${type} account cannot sit under a ${parent.type} parent.`, 400);
  let cur: string | null = parent.id;
  const seen = new Set<string>();
  while (cur) {
    if (cur === id) throw new AccountingError("That parent would put the account inside itself.", 400);
    if (seen.has(cur)) break;
    seen.add(cur);
    cur = (await tx.account.findUnique({ where: { id: cur }, select: { parentId: true } }))?.parentId ?? null;
  }
  if (parent.allowPosting) await tx.account.update({ where: { id: parent.id }, data: { allowPosting: false } });
}

/** Cash-flow class: null (or "") falls back to the template default (see cashflow-rules.ts). */
function cashFlow(v: unknown): CashFlowClass | null | undefined {
  if (v === undefined) return undefined;
  if (v === null || v === "") return null;
  if (!CASH_FLOW.has(String(v))) throw new AccountingError("Unknown cash-flow class.", 400);
  return String(v) as CashFlowClass;
}

export async function createAccount(input: AccountInput, userId: string) {
  const code = text(input.code, "Code", true, 20)!;
  if (!/^[0-9A-Za-z.-]+$/.test(code)) throw new AccountingError("Code may contain letters, digits, dots and dashes only.", 400);
  const type = String(input.type ?? "");
  if (!TYPES.has(type)) throw new AccountingError("Choose an account type.", 400);
  const controlKind = String(input.controlKind ?? "NONE");
  if (!CONTROLS.has(controlKind)) throw new AccountingError("Unknown control type.", 400);
  const cashFlowClass = cashFlow(input.cashFlowClass) ?? null;
  return ledgerTx(async (tx) => {
    const parentId = typeof input.parentId === "string" && input.parentId ? input.parentId : null;
    if (parentId) await checkParent(tx, null, parentId, type);
    const a = await tx.account.create({
      data: {
        code, nameEn: text(input.nameEn, "English name", true)!, nameAr: text(input.nameAr, "Arabic name", false) ?? null,
        type: type as AccountType, parentId, allowPosting: bool(input.allowPosting, "allowPosting") ?? true,
        isActive: bool(input.isActive, "isActive") ?? true, controlKind: controlKind as AccountControlKind,
        allowManualPosting: bool(input.allowManualPosting, "allowManualPosting") ?? controlKind === "NONE",
        qoyodAccountId: text(input.qoyodAccountId, "Qoyod id", false) ?? null, cashFlowClass, createdBy: userId, updatedBy: userId,
      },
    });
    await auditAccounting(tx, { action: "account.create", entityType: "account", entityId: a.id, userId, after: a });
    return a;
  });
}

export async function updateAccount(id: string, input: AccountInput, userId: string) {
  return ledgerTx(async (tx) => {
    const before = await tx.account.findUnique({ where: { id }, include: { _count: { select: { children: true, journalEntryLines: true, mappings: true } } } });
    if (!before) throw new AccountingError("Account not found.", 404);
    const data: Prisma.AccountUncheckedUpdateInput = { updatedBy: userId };
    const nameEn = text(input.nameEn, "English name", false);
    if (nameEn !== undefined) { if (!nameEn) throw new AccountingError("English name is required.", 400); data.nameEn = nameEn; }
    const nameAr = text(input.nameAr, "Arabic name", false);
    if (nameAr !== undefined) data.nameAr = nameAr;
    if (input.code !== undefined && input.code !== before.code) {
      if (before._count.journalEntryLines) throw new AccountingError("An account with postings keeps its code.", 409);
      data.code = text(input.code, "Code", true, 20)!;
    }
    const type = input.type === undefined ? before.type : String(input.type);
    if (!TYPES.has(type)) throw new AccountingError("Unknown account type.", 400);
    if (type !== before.type) {
      if (before._count.children) throw new AccountingError("Change the type of the child accounts first.", 409);
      data.type = type as AccountType;
    }
    if (input.parentId !== undefined) {
      const parentId = typeof input.parentId === "string" && input.parentId ? input.parentId : null;
      if (parentId === id) throw new AccountingError("An account cannot be its own parent.", 400);
      if (parentId) await checkParent(tx, id, parentId, type);
      data.parentId = parentId;
    }
    const allowPosting = bool(input.allowPosting, "allowPosting");
    const isActive = bool(input.isActive, "isActive");
    if ((allowPosting === false || isActive === false) && before._count.mappings) {
      throw new AccountingError("This account is mapped to a posting role; map the role elsewhere first.", 409);
    }
    if (allowPosting !== undefined) data.allowPosting = allowPosting;
    if (isActive !== undefined) data.isActive = isActive;
    if (input.controlKind !== undefined) {
      const k = String(input.controlKind);
      if (!CONTROLS.has(k)) throw new AccountingError("Unknown control type.", 400);
      if (k !== before.controlKind && before._count.journalEntryLines) throw new AccountingError("An account with postings keeps its control type.", 409);
      data.controlKind = k as AccountControlKind;
    }
    const manual = bool(input.allowManualPosting, "allowManualPosting");
    if (manual !== undefined) data.allowManualPosting = manual;
    const q = text(input.qoyodAccountId, "Qoyod id", false);
    if (q !== undefined) data.qoyodAccountId = q;
    const cf = cashFlow(input.cashFlowClass);
    if (cf !== undefined) data.cashFlowClass = cf;
    const after = await tx.account.update({ where: { id }, data });
    await auditAccounting(tx, { action: "account.update", entityType: "account", entityId: id, userId, before, after });
    return after;
  });
}
