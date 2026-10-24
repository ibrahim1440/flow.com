// Accounting core A1 — the editable chart of accounts (tree; type, normal balance, postable vs header, control
// kind, manual-journal flag, active). The database keeps what must never move (ledger_account_guard): an
// account with journal lines keeps its code, type and normal balance; a header never holds lines; no cycles.
import type { Prisma } from "@/generated/prisma/client";
import { REPORT_GROUPS, isReportGroup } from "./report-groups";
import { prisma, TX_OPTS } from "@/lib/db";
import { refuse } from "./refusals";
import { Decimal, ZERO, fix2 } from "./money";
import { setAuditContext, type AuditContext } from "./audit";

const TYPES = ["ASSET", "LIABILITY", "EQUITY", "REVENUE", "EXPENSE"] as const;
export const CONTROL_TYPES = ["AR", "AP", "INVENTORY", "VAT_INPUT", "VAT_OUTPUT", "CASH", "BANK", "FIXED_ASSET", "PAYROLL", "COMMISSION", "CLEARING"] as const;
const CODE_RE = /^[0-9A-Za-z][0-9A-Za-z.\-]{0,19}$/;

type Input = Record<string, unknown>;

function text(v: unknown, field: string, max: number, required = false): string | null | undefined {
  if (v === undefined) return undefined;
  if (v === null || (typeof v === "string" && !v.trim())) {
    if (required) throw refuse("BAD_INPUT", `${field} is required.`);
    return null;
  }
  if (typeof v !== "string") throw refuse("BAD_INPUT", `${field} is text.`);
  return v.trim().slice(0, max);
}

function bool(v: unknown, field: string): boolean | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== "boolean") throw refuse("BAD_INPUT", `${field} is true / false.`);
  return v;
}

/** Validate the fields an account may set (create: all required ones present). */
export function accountFields(body: Input, mode: "create" | "update") {
  const out: Record<string, unknown> = {};
  const code = text(body.code, "code", 20, mode === "create");
  if (code !== undefined) {
    if (!code || !CODE_RE.test(code)) throw refuse("BAD_INPUT", "code: letters, digits, dot or dash (≤ 20).");
    out.code = code;
  }
  const nameEn = text(body.nameEn, "nameEn", 120, mode === "create");
  if (nameEn !== undefined) { if (!nameEn) throw refuse("BAD_INPUT", "nameEn is required."); out.nameEn = nameEn; }
  const nameAr = text(body.nameAr, "nameAr", 120);
  if (nameAr !== undefined) out.nameAr = nameAr;
  const description = text(body.description, "description", 500);
  if (description !== undefined) out.description = description;
  if (body.type !== undefined || mode === "create") {
    if (typeof body.type !== "string" || !(TYPES as readonly string[]).includes(body.type)) throw refuse("BAD_INPUT", `type is one of ${TYPES.join(", ")}.`);
    out.type = body.type;
  }
  if (body.normalBalance !== undefined) {
    if (body.normalBalance !== "DEBIT" && body.normalBalance !== "CREDIT" && body.normalBalance !== "AUTO") throw refuse("BAD_INPUT", "normalBalance is DEBIT or CREDIT.");
    out.normalBalance = body.normalBalance;
  }
  if (body.controlType !== undefined) {
    if (body.controlType !== null && !(CONTROL_TYPES as readonly string[]).includes(String(body.controlType))) throw refuse("BAD_INPUT", `controlType is one of ${CONTROL_TYPES.join(", ")} or null.`);
    out.controlType = body.controlType;
  }
  for (const f of ["allowPosting", "isActive", "allowManualJournal"] as const) {
    const b = bool(body[f], f);
    if (b !== undefined) out[f] = b;
  }
  if (body.parentId !== undefined) {
    if (body.parentId !== null && typeof body.parentId !== "string") throw refuse("BAD_INPUT", "parentId is an account id or null.");
    out.parentId = body.parentId;
  }
  const q = text(body.qoyodAccountId, "qoyodAccountId", 64);
  if (q !== undefined) out.qoyodAccountId = q;
  // Accounting A5: the statement line (null = inferred from the chart; ./statements.ts reportGroupOf).
  if (body.reportGroup !== undefined) {
    if (body.reportGroup !== null && !isReportGroup(body.reportGroup)) throw refuse("BAD_INPUT", `reportGroup is one of ${REPORT_GROUPS.join(", ")} or null.`);
    out.reportGroup = body.reportGroup;
  }
  return out;
}

async function checkParent(tx: Prisma.TransactionClient, parentId: string | null | undefined, type: string, selfId?: string) {
  if (!parentId) return;
  if (parentId === selfId) throw refuse("PARENT_INVALID");
  const p = await tx.account.findUnique({ where: { id: parentId }, select: { type: true, allowPosting: true, _count: { select: { journalEntryLines: true } } } });
  if (!p) throw refuse("PARENT_INVALID", "(not found)");
  if (String(p.type) !== type || p.allowPosting || p._count.journalEntryLines > 0) throw refuse("PARENT_INVALID");
}

export async function createAccount(body: Input, ctx: AuditContext) {
  const data = accountFields(body, "create");
  return prisma.$transaction(async (tx) => {
    await setAuditContext(tx, ctx);
    if (await tx.account.findUnique({ where: { code: data.code as string }, select: { id: true } })) throw refuse("CODE_EXISTS");
    await checkParent(tx, data.parentId as string | null | undefined, data.type as string);
    return tx.account.create({ data: { ...(data as Prisma.AccountUncheckedCreateInput), createdBy: ctx.actorId, updatedBy: ctx.actorId } });
  }, TX_OPTS);
}

export async function updateAccount(id: string, body: Input, ctx: AuditContext) {
  const data = accountFields(body, "update");
  if (!Object.keys(data).length) throw refuse("BAD_INPUT", "No field to change.");
  return prisma.$transaction(async (tx) => {
    await setAuditContext(tx, ctx);
    const cur = await tx.account.findUnique({ where: { id }, select: { id: true, code: true, type: true, normalBalance: true, _count: { select: { journalEntryLines: true, roles: true, children: true } } } });
    if (!cur) throw refuse("NOT_FOUND");
    const used = cur._count.journalEntryLines > 0;
    if (used && ((data.code && data.code !== cur.code) || (data.type && data.type !== String(cur.type)) || (data.normalBalance && data.normalBalance !== cur.normalBalance))) throw refuse("ACCOUNT_LOCKED");
    if (data.code && data.code !== cur.code && (await tx.account.findUnique({ where: { code: data.code as string }, select: { id: true } }))) throw refuse("CODE_EXISTS");
    if (data.parentId !== undefined) await checkParent(tx, data.parentId as string | null, (data.type as string) ?? String(cur.type), id);
    // A mapped role keeps pointing at a postable account.
    if (cur._count.roles > 0 && (data.isActive === false || data.allowPosting === false)) throw refuse("ACCOUNT_IN_USE", "(a posting role)");
    // An account with sub-accounts is a header: it never becomes postable.
    if (cur._count.children > 0 && data.allowPosting === true) throw refuse("PARENT_INVALID", "(it has sub-accounts)");
    return tx.account.update({ where: { id }, data: { ...(data as Prisma.AccountUncheckedUpdateInput), updatedBy: ctx.actorId } });
  }, TX_OPTS);
}

/** Only an account nothing refers to (no lines, roles, opening lines, sub-accounts or HR mapping). */
export async function deleteAccount(id: string, ctx: AuditContext) {
  return prisma.$transaction(async (tx) => {
    await setAuditContext(tx, ctx);
    const cur = await tx.account.findUnique({ where: { id }, select: { _count: { select: { journalEntryLines: true, roles: true, children: true, openingLines: true, hrAccountMaps: true } } } });
    if (!cur) throw refuse("NOT_FOUND");
    const c = cur._count;
    if (c.journalEntryLines || c.roles || c.children || c.openingLines || c.hrAccountMaps) throw refuse("ACCOUNT_IN_USE");
    await tx.account.delete({ where: { id } });
    return { id, deleted: true };
  }, TX_OPTS);
}

/** The chart for the tree screen: each account with its usage, its roles and its balance (posted, all time). */
export async function chartWithUsage() {
  const [accounts, usage, roles] = await Promise.all([
    prisma.account.findMany({ orderBy: { code: "asc" }, take: 5000 }),
    prisma.$queryRaw<{ accountId: string; n: bigint; d: Prisma.Decimal; c: Prisma.Decimal }[]>`
      SELECT l."accountId", count(*) AS n, coalesce(sum(l."debit"), 0) AS d, coalesce(sum(l."credit"), 0) AS c
        FROM "JournalEntryLine" l JOIN "JournalEntry" j ON j."id" = l."journalEntryId"
       WHERE j."status" IN ('POSTED', 'REVERSED') GROUP BY l."accountId"`,
    prisma.accountRole.findMany({ select: { role: true, accountId: true } }),
  ]);
  const u = new Map(usage.map((x) => [x.accountId, x]));
  const r = new Map<string, string[]>();
  for (const m of roles) r.set(m.accountId, [...(r.get(m.accountId) ?? []), m.role]);
  const children = new Map<string, number>();
  for (const a of accounts) if (a.parentId) children.set(a.parentId, (children.get(a.parentId) ?? 0) + 1);
  return accounts.map((a) => {
    const x = u.get(a.id);
    const net = x ? new Decimal(x.d).minus(x.c) : ZERO;
    return { ...a, type: String(a.type), lines: x ? Number(x.n) : 0, balance: fix2(a.normalBalance === "CREDIT" ? net.negated() : net), roles: r.get(a.id) ?? [], children: children.get(a.id) ?? 0 };
  });
}
