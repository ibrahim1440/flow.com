// «القيود السهلة» (feat/recurring-journals, 20261120090000_recurring_journals) — journal templates: list, read, save,
// archive / restore, delete (only while unused) and apply. A template is configuration, not a journal: using it opens
// the ordinary manual journal form prefilled (POST …/apply returns the lines), and the journal is created, approved and
// posted through the existing journal service — balanced, open period, immutable once posted. The database re-checks a
// template's balance at commit (journal_template_balanced) and writes the audit trail (ledger_audit_row).
import type { Prisma } from "@/generated/prisma/client";
import { prisma, TX_OPTS } from "@/lib/db";
import { setAuditContext, type AuditContext } from "../audit";
import { refuse } from "../refusals";
import { AccountingError } from "../errors";
import { ZERO } from "../money";
import { checkDimensions, checkLineAccount, loadAccounts, type NormalLine } from "../posting-engine";
import { AMOUNT_MODES, applyTemplate, checkTemplateLines, fixedTotal, TemplateApplyError, type AmountMode, type TemplateLine } from "./template-math";

type Tx = Prisma.TransactionClient;
const str = (v: unknown, max: number) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);

const dims = (l: TemplateLine): Pick<NormalLine, "dims"> => ({
  dims: { branchId: l.branchId ?? null, costCenterId: l.costCenterId ?? null, partyType: (l.partyType ?? null) as NormalLine["dims"]["partyType"], partyId: l.partyId ?? null, itemType: null, itemId: null },
});

/** A template's lines against the chart: active postable leaf accounts that take manual journals, AR / AP party, dimensions. */
export async function checkTemplateAccounts(tx: Tx, lines: TemplateLine[]): Promise<void> {
  const ids = [...new Set(lines.map((l) => l.accountId))];
  const accounts = await loadAccounts(tx, ids);
  for (const l of lines) checkLineAccount(accounts.get(l.accountId), dims(l), { manual: true });
  await checkDimensions(tx, lines.map(dims));
}

export type TemplateInput = { name?: unknown; description?: unknown; amountMode?: unknown; lines?: unknown; expectedUpdatedAt?: unknown };

function parseInput(input: TemplateInput) {
  const name = str(input?.name, 120);
  if (!name) throw refuse("TEMPLATE_INVALID", "(name)", "(اكتب اسم القالب)");
  const description = str(input?.description, 500);
  const mode = (AMOUNT_MODES as readonly string[]).includes(String(input?.amountMode)) ? (input.amountMode as AmountMode) : null;
  if (!mode) throw refuse("TEMPLATE_INVALID", "(amountMode: FIXED | PERCENT)", "(اختر: مبالغ ثابتة أو نسب)");
  const { lines, problems } = checkTemplateLines(mode, input?.lines);
  if (problems.length) {
    const e = refuse("TEMPLATE_INVALID", `(${problems.map((p) => (p.index >= 0 ? `line ${p.index + 1}: ` : "") + p.en).join("; ")})`, `(${problems.map((p) => (p.index >= 0 ? `السطر ${p.index + 1}: ` : "") + p.ar).join("؛ ")})`);
    (e as AccountingError & { problems?: unknown }).problems = problems;
    throw e;
  }
  return { name, description, mode, lines };
}

const lineRows = (lines: TemplateLine[]) => lines.map((l, i) => ({
  lineNo: i + 1, accountId: l.accountId, side: l.side, amount: l.amount ?? null, percent: l.percent ?? null,
  description: l.description ?? null, branchId: l.branchId ?? null, costCenterId: l.costCenterId ?? null, partyType: l.partyType ?? null, partyId: l.partyId ?? null,
}));

const LINES = { orderBy: { lineNo: "asc" as const }, include: { account: { select: { code: true, nameAr: true, nameEn: true } } } } satisfies Prisma.JournalTemplate$linesArgs;

type Loaded = Prisma.JournalTemplateGetPayload<{ include: { lines: typeof LINES; _count: { select: { schedules: true } } } }>;

/** The API shape: amounts as 2-dp text, percentages as 4-dp text, the FIXED total. */
export function templateView(t: Loaded) {
  const lines: TemplateLine[] = t.lines.map((l) => ({
    accountId: l.accountId, side: l.side as TemplateLine["side"], amount: l.amount ? l.amount.toFixed(2) : null, percent: l.percent ? l.percent.toFixed(4) : null,
    description: l.description, branchId: l.branchId, costCenterId: l.costCenterId, partyType: l.partyType, partyId: l.partyId,
  }));
  return {
    id: t.id, name: t.name, description: t.description, amountMode: t.amountMode as AmountMode, isActive: t.isActive, archivedAt: t.archivedAt,
    createdBy: t.createdBy, updatedBy: t.updatedBy, createdAt: t.createdAt, updatedAt: t.updatedAt, schedules: t._count.schedules,
    fixedTotal: t.amountMode === "FIXED" ? fixedTotal(lines).toFixed(2) : null,
    lines: t.lines.map((l, i) => ({ ...lines[i], lineNo: l.lineNo, account: l.account })),
  };
}
export type TemplateView = ReturnType<typeof templateView>;

async function load(db: Tx | typeof prisma, id: string) {
  return db.journalTemplate.findUnique({ where: { id }, include: { lines: LINES, _count: { select: { schedules: true } } } });
}

export async function listTemplates(opts: { includeArchived?: boolean; q?: string | null } = {}) {
  const q = (opts.q ?? "").trim().slice(0, 80);
  const rows = await prisma.journalTemplate.findMany({
    where: { ...(opts.includeArchived ? {} : { isActive: true }), ...(q ? { OR: [{ name: { contains: q, mode: "insensitive" } }, { description: { contains: q, mode: "insensitive" } }] } : {}) },
    orderBy: [{ isActive: "desc" }, { name: "asc" }],
    include: { lines: LINES, _count: { select: { schedules: true } } },
    take: 500,
  });
  return rows.map(templateView);
}

export async function getTemplate(id: string) {
  const t = await load(prisma, id);
  if (!t) throw refuse("NOT_FOUND");
  return templateView(t);
}

/** Create (id null) or replace a template — its lines are replaced as a whole; an edit names the version it read. */
export async function saveTemplate(input: TemplateInput, id: string | null, ctx: AuditContext) {
  const t = parseInput(input);
  return prisma.$transaction(async (tx) => {
    await setAuditContext(tx, ctx);
    await checkTemplateAccounts(tx, t.lines);
    let tid = id;
    if (id) {
      const cur = (await tx.$queryRaw<{ id: string; isActive: boolean; updatedAt: Date }[]>`SELECT "id", "isActive", "updatedAt" FROM "JournalTemplate" WHERE "id" = ${id} FOR UPDATE`)[0];
      if (!cur) throw refuse("NOT_FOUND");
      if (!cur.isActive) throw refuse("TEMPLATE_ARCHIVED");
      const expected = input.expectedUpdatedAt ? Date.parse(String(input.expectedUpdatedAt)) : NaN;
      if (Number.isFinite(expected) && expected !== cur.updatedAt.getTime()) throw refuse("RECURRING_STALE");
      await tx.journalTemplateLine.deleteMany({ where: { templateId: id } });
      await tx.journalTemplate.update({ where: { id }, data: { name: t.name, description: t.description, amountMode: t.mode, updatedBy: ctx.actorId, lines: { create: lineRows(t.lines) } } });
    } else {
      tid = (await tx.journalTemplate.create({ data: { name: t.name, description: t.description, amountMode: t.mode, createdBy: ctx.actorId, updatedBy: ctx.actorId, lines: { create: lineRows(t.lines) } }, select: { id: true } })).id;
    }
    return templateView((await load(tx, tid!))!);
  }, TX_OPTS);
}

/** Archive (hidden from «استخدام»; a recurring transaction that uses it keeps its own frozen lines) or restore. */
export async function setTemplateArchived(id: string, archived: boolean, ctx: AuditContext) {
  return prisma.$transaction(async (tx) => {
    await setAuditContext(tx, ctx);
    const cur = await tx.journalTemplate.findUnique({ where: { id }, select: { id: true } });
    if (!cur) throw refuse("NOT_FOUND");
    await tx.journalTemplate.update({ where: { id }, data: archived ? { isActive: false, archivedAt: new Date(), archivedBy: ctx.actorId, updatedBy: ctx.actorId } : { isActive: true, archivedAt: null, archivedBy: null, updatedBy: ctx.actorId } });
    return templateView((await load(tx, id))!);
  }, TX_OPTS);
}

/** Delete a template no recurring transaction names (otherwise TEMPLATE_IN_USE: archive it). */
export async function deleteTemplate(id: string, ctx: AuditContext) {
  return prisma.$transaction(async (tx) => {
    await setAuditContext(tx, ctx);
    const cur = await tx.journalTemplate.findUnique({ where: { id }, select: { id: true, _count: { select: { schedules: true } } } });
    if (!cur) throw refuse("NOT_FOUND");
    if (cur._count.schedules) throw refuse("TEMPLATE_IN_USE");
    await tx.journalTemplate.delete({ where: { id } });
    return { id, deleted: true };
  }, TX_OPTS);
}

/** A thrown TemplateApplyError as the accounting refusal it is. */
export function applyRefusal(e: unknown): never {
  if (e instanceof TemplateApplyError) throw new AccountingError(e.message, 400, e.code === "TOTAL_REQUIRED" ? "TEMPLATE_TOTAL" : "TEMPLATE_LINE_ZERO", e.ar);
  throw e;
}

/** «استخدام القالب»: the journal lines for a total (PERCENT) — the manual journal form is prefilled with them. */
export async function applyTemplateById(id: string, total: unknown) {
  const t = await getTemplate(id);
  if (!t.isActive) throw refuse("TEMPLATE_ARCHIVED");
  let lines;
  try {
    lines = applyTemplate(t.amountMode, t.lines, typeof total === "string" || typeof total === "number" ? String(total) : null);
  } catch (e) {
    applyRefusal(e);
  }
  const sum = lines.reduce((s, l) => s.plus(l.debit), ZERO);
  return { templateId: t.id, name: t.name, description: t.description ?? t.name, amountMode: t.amountMode, total: sum.toFixed(2), lines };
}
